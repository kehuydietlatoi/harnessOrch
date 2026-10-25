// Builds the desktop app into release/win-unpacked/harnessOrch.exe (run it with `npm run app`).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const exe = join(root, "release", "win-unpacked", "harnessOrch.exe");

// Windows locks a running exe, so a rebuild into it would fail halfway.
const tasks = spawnSync("tasklist", ["/FI", "IMAGENAME eq harnessOrch.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" });
if (tasks.stdout?.toLowerCase().includes("harnessorch.exe")) {
  console.error("harnessOrch.exe is running. Close it first, then build again.");
  process.exit(2);
}

// package.json says "^45", but electron-builder wants the exact version that is installed.
const electronPkg = createRequire(join(root, "apps", "desktop", "package.json")).resolve("electron/package.json");
const electronVersion = JSON.parse(readFileSync(electronPkg, "utf8")).version;

const started = Date.now();
const run = (label, cmd, args, cwd) => {
  console.log(`\n> ${label}`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error(`\nbuild failed at: ${label}`);
    process.exit(r.status ?? 1);
  }
};

run("npm run build", "npm", ["run", "build"], root);
run("electron-builder --dir", "npx", ["electron-builder", "--dir", `-c.electronVersion=${electronVersion}`], join(root, "apps", "desktop"));

if (!existsSync(exe)) {
  console.error(`build finished but ${exe} is missing`);
  process.exit(1);
}
console.log(`\nbuilt ${exe} in ${Math.round((Date.now() - started) / 1000)}s`);
