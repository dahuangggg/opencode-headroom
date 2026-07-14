import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";

import { PARITY_FIXTURES } from "./fixtures.js";
import {
  fixtureSha256,
  HEADROOM_ORACLE_COMMIT,
  HEADROOM_ORACLE_PROFILE,
  validateParityOracle,
} from "./oracle.js";
import type { ParityOracleSnapshot } from "./types.js";

const ROUTER_CONFIG = {
  enable_code_aware: true,
  enable_cross_turn_dedup: true,
  lossless_then_lossy: true,
  min_chars_for_block_compression: 25,
  smart_crusher_max_items_after_crush: 15,
  smart_crusher_with_compaction: true,
  force_kompress_all: false,
  lossless: false,
  ccr_inject_marker: true,
} as const;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function commandText(command: string[]): string {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed:\n${result.stderr.toString().trim()}`,
    );
  }
  return result.stdout.toString().trim();
}

const checkout = argument("--headroom-checkout") ?? "headroom";
const output =
  argument("--output") ??
  fileURLToPath(new URL("./oracle.json", import.meta.url));
const checkoutCommit = commandText(["git", "-C", checkout, "rev-parse", "HEAD"]);

if (checkoutCommit !== HEADROOM_ORACLE_COMMIT) {
  throw new Error(
    `Headroom checkout must be ${HEADROOM_ORACLE_COMMIT}; got ${checkoutCommit}`,
  );
}

const request = JSON.stringify({
  commit: HEADROOM_ORACLE_COMMIT,
  profile: HEADROOM_ORACLE_PROFILE,
  routerConfig: ROUTER_CONFIG,
  fixtures: PARITY_FIXTURES.map((fixture) => ({
    ...fixture,
    fixtureSha256: fixtureSha256(fixture),
  })),
});

const pythonScript = fileURLToPath(
  new URL("./headroom_oracle.py", import.meta.url),
);
const processHandle = Bun.spawn(
  [
    "uv",
    "run",
    "--isolated",
    "--with",
    `${checkout}[code]`,
    "python",
    pythonScript,
  ],
  { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
);
processHandle.stdin.write(request);
processHandle.stdin.end();

const stdout = await new Response(processHandle.stdout).text();
const exitCode = await processHandle.exited;
if (exitCode !== 0) {
  throw new Error(`Headroom oracle process exited with ${exitCode}`);
}

const snapshot = JSON.parse(stdout) as ParityOracleSnapshot;
validateParityOracle(snapshot, PARITY_FIXTURES);
await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

console.log(
  `Wrote ${snapshot.fixtures.length} fixtures from Headroom ${snapshot.reference.version} (${snapshot.reference.commit}) to ${output}`,
);
