import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePackage = JSON.parse(
  readFileSync(join(repositoryRoot, "package.json"), "utf8"),
);
const packageName = sourcePackage.name;
const pluginPackageSpecifier = `${packageName}/plugin`;
const temporaryRoot = mkdtempSync(join(tmpdir(), "opencode-headroom-package-"));
const packDirectory = join(temporaryRoot, "pack");
const consumerDirectory = join(temporaryRoot, "consumer");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const bun = process.platform === "win32" ? "bun.exe" : "bun";

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_package_lock: "false",
    },
  });

  if (result.error || result.status !== 0) {
    const detail = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(
      `${command} ${args.join(" ")} failed${
        result.status === null ? "" : ` with exit code ${result.status}`
      }${detail ? `\n${detail}` : ""}`,
      { cause: result.error },
    );
  }

  return result.stdout;
}

function parsePackResult(output) {
  const lineStart = output.lastIndexOf("\n[");
  const jsonStart = lineStart >= 0 ? lineStart + 1 : output.indexOf("[");
  assert.notEqual(jsonStart, -1, "npm pack did not return JSON metadata");
  const result = JSON.parse(output.slice(jsonStart));
  assert.equal(result.length, 1, "npm pack must produce exactly one tarball");
  return result[0];
}

try {
  mkdirSync(packDirectory);
  mkdirSync(consumerDirectory);

  run(npm, ["run", "clean"], repositoryRoot);
  assert.equal(
    readdirSync(repositoryRoot).includes("dist"),
    false,
    "clean must remove dist before the package is built",
  );

  const packResult = parsePackResult(
    run(
      npm,
      ["pack", "--json", "--pack-destination", packDirectory],
      repositoryRoot,
    ),
  );
  const packedFiles = packResult.files.map(({ path }) => path).sort();
  const requiredFiles = [
    "DESIGN.md",
    "LICENSE",
    "README.md",
    "dist/index.d.ts",
    "dist/index.js",
    "dist/plugin.d.ts",
    "dist/plugin.js",
    "opencode.json.example",
    "package.json",
  ];

  for (const requiredFile of requiredFiles) {
    assert.ok(
      packedFiles.includes(requiredFile),
      `packed artifact is missing ${requiredFile}`,
    );
  }

  const allowedTopLevelFiles = new Set([
    "DESIGN.md",
    "LICENSE",
    "README.md",
    "opencode.json.example",
    "package.json",
  ]);
  const unexpectedFiles = packedFiles.filter(
    (path) => !path.startsWith("dist/") && !allowedTopLevelFiles.has(path),
  );
  assert.deepEqual(
    unexpectedFiles,
    [],
    `unexpected files in package: ${unexpectedFiles.join(", ")}`,
  );

  const tarball = join(packDirectory, packResult.filename);
  writeFileSync(
    join(consumerDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "opencode-headroom-package-smoke-consumer",
        private: true,
        type: "module",
      },
      null,
      2,
    )}\n`,
  );

  run(
    npm,
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      tarball,
    ],
    consumerDirectory,
  );
  run(npm, ["ls", "--all"], consumerDirectory);

  writeFileSync(
    join(consumerDirectory, "smoke.ts"),
    `import type { HeadroomPluginOptions } from "${packageName}";

const options: HeadroomPluginOptions = {
  storage: { kind: "memory", maxEntries: 100, busyTimeoutMs: 0 },
  toolPolicy: {
    default: { action: "compress", strength: "balanced" },
    rules: [{ id: "logs", tools: ["Bash"], action: "compress", retrieve: { defaultMode: "tail", maxChars: 1000 } }],
  },
  outputFiles: { allowedRoots: ["."], trustedTools: ["Bash"] },
};
void options;
`,
  );
  writeFileSync(
    join(consumerDirectory, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ["smoke.ts"],
      },
      null,
      2,
    )}\n`,
  );
  run(
    process.execPath,
    [join(repositoryRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
    consumerDirectory,
  );

  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        const root = await import(${JSON.stringify(packageName)});
        const plugin = await import(${JSON.stringify(pluginPackageSpecifier)});
        if (typeof root.default !== "function") throw new Error("missing root default export");
        if (typeof root.server !== "function") throw new Error("missing root server export");
        if (typeof root.HeadroomNativePlugin !== "function") throw new Error("missing named plugin export");
        if (typeof plugin.default !== "function") throw new Error("missing plugin default export");
        if (typeof plugin.HeadroomNativePlugin !== "function") throw new Error("missing plugin named export");
        const hooks = await plugin.default(
          { directory: process.cwd(), worktree: process.cwd() },
          { storage: { kind: "auto", path: ".headroom/node-smoke.sqlite" } },
        );
        const stats = await hooks.tool.headroom_stats.execute(
          { sessionOnly: false },
          { sessionID: "node-smoke" },
        );
        if (!stats.includes("storage adapter: auto -> memory")) throw new Error("Node auto fallback is not observable");
        if (!stats.includes("storage fallback: unsupported_runtime")) throw new Error("Node fallback reason is missing");
        await hooks.dispose?.();
      `,
    ],
    consumerDirectory,
  );

  run(
    bun,
    [
      "--eval",
      `
        const plugin = await import(${JSON.stringify(pluginPackageSpecifier)});
        const hooks = await plugin.default(
          { directory: process.cwd(), worktree: process.cwd() },
          { storage: { kind: "memory" } },
        );
        if (typeof hooks["tool.execute.after"] !== "function") throw new Error("missing after hook");
        if (!hooks.tool?.headroom_retrieve) throw new Error("missing retrieve tool");
        if (!hooks.tool?.headroom_stats) throw new Error("missing stats tool");
      `,
    ],
    consumerDirectory,
  );

  const packedPackage = JSON.parse(
    readFileSync(
      join(
        consumerDirectory,
        "node_modules",
        ...packageName.split("/"),
        "package.json",
      ),
    ),
  );
  assert.equal(
    packedPackage.dependencies?.[packageName],
    undefined,
    "published package must not depend on itself",
  );

  console.log(
    `package smoke passed: ${packResult.filename} (${packedFiles.length} files)`,
  );
  console.log("consumer checks passed: npm ls --all, TypeScript, Node imports, Bun initialization");
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
