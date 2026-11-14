#!/usr/bin/env node
/**
 * Build + pack @neverdown/core and @neverdown/sdk for integrator install.
 * Copies tarballs to dist/sdk-packs and examples/minimal-sdk-app/packs.
 */
import { execSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORE_DIR = join(ROOT, "packages/core");
const SDK_DIR = join(ROOT, "packages/sdk");
const OUT_DIRS = [join(ROOT, "dist/sdk-packs"), join(ROOT, "examples/minimal-sdk-app/packs")];

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function packPackage(dir) {
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".tgz")) rmSync(join(dir, name), { force: true });
  }
  run("pnpm", ["pack"], dir);
  const tgz = readdirSync(dir).find((name) => name.endsWith(".tgz"));
  if (!tgz) throw new Error(`pnpm pack produced no tarball in ${dir}`);
  return join(dir, tgz);
}

function assertSdkCoreDep(tgzPath, coreVersion) {
  const listing = execSync(`tar -tzf "${tgzPath}"`, { encoding: "utf8", cwd: ROOT });
  const pkgEntry = listing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line === "package/package.json" || /(^|\/)package\.json$/.test(line));
  if (!pkgEntry) throw new Error(`Could not find package.json inside ${tgzPath}`);
  const extracted = execSync(`tar -xOf "${tgzPath}" "${pkgEntry}"`, { encoding: "utf8", cwd: ROOT });
  const pkg = JSON.parse(extracted);
  const dep = pkg.dependencies?.["@neverdown/core"];
  if (!dep || String(dep).includes("workspace:") || dep === "*") {
    throw new Error(
      `Packed @neverdown/sdk depends on @neverdown/core as "${dep ?? "(missing)"}". ` +
        `Expected a semver version (e.g. ${coreVersion}).`,
    );
  }
  console.log(`Verified packed SDK depends on @neverdown/core@${dep}`);
}

console.log("Building @neverdown/core …");
run("pnpm", ["--filter", "@neverdown/core", "build"], ROOT);
console.log("Building @neverdown/sdk …");
run("pnpm", ["--filter", "@neverdown/sdk", "build"], ROOT);

const corePkg = JSON.parse(readFileSync(join(CORE_DIR, "package.json"), "utf8"));
const sdkPkg = JSON.parse(readFileSync(join(SDK_DIR, "package.json"), "utf8"));

console.log("Packing @neverdown/core …");
const coreTgz = packPackage(CORE_DIR);
console.log("Packing @neverdown/sdk …");
const sdkTgz = packPackage(SDK_DIR);

assertSdkCoreDep(sdkTgz, corePkg.version);

const coreName = `neverdown-core-${corePkg.version}.tgz`;
const sdkName = `neverdown-sdk-${sdkPkg.version}.tgz`;

for (const out of OUT_DIRS) {
  mkdirSync(out, { recursive: true });
  copyFileSync(coreTgz, join(out, coreName));
  copyFileSync(sdkTgz, join(out, sdkName));
  writeFileSync(
    join(out, "INSTALL.txt"),
    [
      "NeverDown SDK tarball install",
      "",
      `npm install ./${coreName} ./${sdkName}`,
      "# or",
      `pnpm add ./${coreName} ./${sdkName}`,
      "",
      "Node.js >= 22.13.0 required.",
      "See docs/SDK-QUICKSTART.md and examples/minimal-sdk-app/README.md",
      "",
    ].join("\n"),
  );
}

rmSync(coreTgz, { force: true });
rmSync(sdkTgz, { force: true });

console.log("");
console.log("SDK packs ready:");
for (const out of OUT_DIRS) {
  console.log(`  ${out}`);
  console.log(`    npm install ./${coreName} ./${sdkName}`);
}
console.log("");
console.log("Next: cd examples/minimal-sdk-app && pnpm install && pnpm smoke");
