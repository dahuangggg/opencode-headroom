import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function object(value, label) {
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value;
}

function nonEmptyString(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.ok(value.trim(), `${label} must not be empty`);
  return value;
}

function collectExportTargets(value, label, targets) {
  if (typeof value === "string") {
    targets.push({ label, target: value });
    return;
  }
  const conditions = object(value, label);
  for (const [condition, target] of Object.entries(conditions)) {
    collectExportTargets(target, `${label}.${condition}`, targets);
  }
}

export function validatePackageManifest(manifest) {
  object(manifest, "package manifest");
  const name = nonEmptyString(manifest.name, "name");
  assert.match(name, /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i, "name is invalid");
  assert.match(
    nonEmptyString(manifest.version, "version"),
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
    "version must be valid semver",
  );
  nonEmptyString(manifest.description, "description");
  nonEmptyString(manifest.license, "license");
  assert.equal(manifest.type, "module", "type must be module");

  assert.ok(Array.isArray(manifest.files), "files must be an array");
  for (const required of ["dist", "README.md", "DESIGN.md", "LICENSE"]) {
    assert.ok(manifest.files.includes(required), `files must include ${required}`);
  }

  const main = nonEmptyString(manifest.main, "main");
  const types = nonEmptyString(manifest.types, "types");
  for (const [label, target] of [
    ["main", main],
    ["types", types],
  ]) {
    assert.match(target, /^\.\/dist\//, `${label} target must stay under dist`);
  }

  const exports = object(manifest.exports, "exports");
  assert.ok(exports["."], "exports must expose the package root");
  assert.ok(exports["./plugin"], "exports must expose ./plugin");
  const exportTargets = [];
  for (const [subpath, target] of Object.entries(exports)) {
    collectExportTargets(target, `exports.${subpath}`, exportTargets);
  }
  for (const { label, target } of exportTargets) {
    assert.match(target, /^\.\/dist\//, `export target ${label} must stay under dist`);
  }

  for (const dependencyKind of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const dependencies = manifest[dependencyKind];
    if (dependencies !== undefined) {
      object(dependencies, dependencyKind);
      assert.equal(
        dependencies[name],
        undefined,
        `package must not depend on itself through ${dependencyKind}`,
      );
    }
  }

  const scripts = object(manifest.scripts, "scripts");
  for (const required of [
    "build",
    "prepack",
    "typecheck",
    "test",
    "bench:check",
    "bench:perf",
    "lint:package",
    "test:package",
  ]) {
    nonEmptyString(scripts[required], `scripts.${required}`);
  }
}

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
  assert.notEqual(jsonStart, -1, "npm pack --dry-run did not return JSON metadata");
  const result = JSON.parse(output.slice(jsonStart));
  assert.equal(result.length, 1, "npm pack --dry-run must describe one package");
  return result[0];
}

function assertNpmNormalized(manifest) {
  const temporaryRoot = mkdtempSync(joinTemporary("opencode-headroom-manifest-"));
  try {
    writeFileSync(
      resolve(temporaryRoot, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    run(npm, ["pkg", "fix"], temporaryRoot);
    const fixed = JSON.parse(
      readFileSync(resolve(temporaryRoot, "package.json"), "utf8"),
    );
    assert.deepEqual(
      fixed,
      manifest,
      "npm pkg fix would rewrite package.json; commit the normalized manifest",
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function joinTemporary(prefix) {
  return resolve(tmpdir(), prefix);
}

function assertPackedManifest(manifest) {
  const packResult = parsePackResult(
    run(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], repositoryRoot),
  );
  const packedFiles = new Set(packResult.files.map(({ path }) => path));
  const exportTargets = [];
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    collectExportTargets(target, `exports.${subpath}`, exportTargets);
  }
  const targets = new Set([
    manifest.main,
    manifest.types,
    ...exportTargets.map(({ target }) => target),
  ]);
  for (const target of targets) {
    const packedPath = target.replace(/^\.\//, "");
    assert.ok(packedFiles.has(packedPath), `packed artifact is missing ${packedPath}`);
  }

  const conflictCopies = [...packedFiles].filter((path) =>
    /(?:^|\/)[^/]+ \d+(?:\.d)?\.[^.]+$/.test(path),
  );
  assert.deepEqual(
    conflictCopies,
    [],
    `packed artifact contains conflict-copy files: ${conflictCopies.join(", ")}`,
  );
}

function main() {
  const manifest = JSON.parse(
    readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
  );
  validatePackageManifest(manifest);
  assertNpmNormalized(manifest);
  assertPackedManifest(manifest);
  console.log("package lint passed: manifest is npm-normalized and export targets are packed");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
