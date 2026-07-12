import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { compileToolPattern } from "../policy.js";

export interface OutputFilesConfig {
  allowedRoots?: string[];
  trustedTools?: string[];
}

export interface NormalizedOutputFilesConfig {
  allowedRoots: string[];
  trustedTools: string[];
}

export interface TrustedOutputFileReadResult {
  ok: boolean;
  path: string;
  content?: string;
  reason?:
    | "untrusted_output_path"
    | "output_path_not_regular"
    | "output_path_too_large"
    | "output_path_read_error";
  tooLarge?: boolean;
}

export const DEFAULT_OUTPUT_FILES_CONFIG: NormalizedOutputFilesConfig = {
  allowedRoots: ["."],
  trustedTools: ["Bash"],
};

const OUTPUT_FILE_READ_CHUNK_BYTES = 64 * 1024;

async function readWithinByteLimit(
  handle: {
    read(
      buffer: Buffer,
      offset: number,
      length: number,
      position: null,
    ): Promise<{ bytesRead: number }>;
  },
  maxBytes: number,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  while (totalBytes <= maxBytes) {
    const remainingWithSentinel = maxBytes - totalBytes + 1;
    const chunk = Buffer.allocUnsafe(
      Math.min(OUTPUT_FILE_READ_CHUNK_BYTES, remainingWithSentinel),
    );
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) {
      return Buffer.concat(chunks, totalBytes);
    }
    chunks.push(chunk.subarray(0, bytesRead));
    totalBytes += bytesRead;
    if (totalBytes > maxBytes) {
      return null;
    }
  }

  return null;
}

function assertStringList(values: unknown[], label: string): asserts values is string[] {
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`${label} entries must be non-empty strings`);
    }
  }
}

export function normalizeOutputFilesConfig(
  input: OutputFilesConfig | undefined,
): NormalizedOutputFilesConfig {
  if (
    input !== undefined &&
    (!input || typeof input !== "object" || Array.isArray(input))
  ) {
    throw new Error("outputFiles must be an object");
  }
  if (input?.allowedRoots !== undefined && !Array.isArray(input.allowedRoots)) {
    throw new Error("outputFiles.allowedRoots must be an array");
  }
  if (input?.trustedTools !== undefined && !Array.isArray(input.trustedTools)) {
    throw new Error("outputFiles.trustedTools must be an array");
  }
  const allowedRoots = input?.allowedRoots
    ? [...input.allowedRoots]
    : [...DEFAULT_OUTPUT_FILES_CONFIG.allowedRoots];
  const trustedTools = input?.trustedTools
    ? [...input.trustedTools]
    : [...DEFAULT_OUTPUT_FILES_CONFIG.trustedTools];

  assertStringList(allowedRoots, "outputFiles.allowedRoots");
  assertStringList(trustedTools, "outputFiles.trustedTools");
  for (const pattern of trustedTools) {
    compileToolPattern(pattern);
  }

  return { allowedRoots, trustedTools };
}

function isWithinRoot(path: string, root: string): boolean {
  const relativePath = relative(root, path);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

function resolvedPath(path: string, basePath: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(basePath, path);
}

export function createTrustedOutputFileSource(
  config: NormalizedOutputFilesConfig,
  basePath: string,
): {
  read(input: {
    tool: string;
    pathRef: string;
    maxOutputChars: number;
  }): Promise<TrustedOutputFileReadResult>;
} {
  const allowedRoots = config.allowedRoots.map((root) =>
    resolvedPath(root, basePath),
  );
  const trustedToolMatchers = config.trustedTools.map(compileToolPattern);

  return {
    async read(input): Promise<TrustedOutputFileReadResult> {
      const candidatePath = resolvedPath(input.pathRef, basePath);
      if (!trustedToolMatchers.some((matches) => matches(input.tool))) {
        return {
          ok: false,
          path: candidatePath,
          reason: "untrusted_output_path",
        };
      }

      let canonicalPath: string;
      try {
        canonicalPath = await realpath(candidatePath);
      } catch {
        return {
          ok: false,
          path: candidatePath,
          reason: "output_path_read_error",
        };
      }
      const canonicalRoots = (
        await Promise.allSettled(allowedRoots.map((root) => realpath(root)))
      ).flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );

      if (!canonicalRoots.some((root) => isWithinRoot(canonicalPath, root))) {
        return {
          ok: false,
          path: candidatePath,
          reason: "untrusted_output_path",
        };
      }

      let handle;
      try {
        handle = await open(
          canonicalPath,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        const descriptorInfo = await handle.stat();
        if (!descriptorInfo.isFile()) {
          return {
            ok: false,
            path: candidatePath,
            reason: "output_path_not_regular",
          };
        }

        // For file-backed sources, maxOutputChars is also a conservative byte
        // cap. This lets the descriptor size gate run before any content read.
        if (descriptorInfo.size > input.maxOutputChars) {
          return {
            ok: false,
            path: candidatePath,
            reason: "output_path_too_large",
            tooLarge: true,
          };
        }

        // Re-resolve after opening and compare the path entry with the opened
        // descriptor. This closes the common symlink/path-swap race window.
        const currentCanonicalPath = await realpath(canonicalPath);
        if (
          !canonicalRoots.some((root) =>
            isWithinRoot(currentCanonicalPath, root),
          )
        ) {
          return {
            ok: false,
            path: candidatePath,
            reason: "untrusted_output_path",
          };
        }
        const currentInfo = await stat(currentCanonicalPath);
        if (
          currentInfo.dev !== descriptorInfo.dev ||
          currentInfo.ino !== descriptorInfo.ino
        ) {
          return {
            ok: false,
            path: candidatePath,
            reason: "untrusted_output_path",
          };
        }

        const contentBuffer = await readWithinByteLimit(
          handle,
          input.maxOutputChars,
        );
        if (!contentBuffer) {
          return {
            ok: false,
            path: candidatePath,
            reason: "output_path_too_large",
            tooLarge: true,
          };
        }
        const content = contentBuffer.toString("utf8");
        if (content.length > input.maxOutputChars) {
          return {
            ok: false,
            path: candidatePath,
            reason: "output_path_too_large",
            tooLarge: true,
          };
        }

        return { ok: true, path: candidatePath, content };
      } catch {
        return {
          ok: false,
          path: candidatePath,
          reason: "output_path_read_error",
        };
      } finally {
        await handle?.close().catch(() => undefined);
      }
    },
  };
}
