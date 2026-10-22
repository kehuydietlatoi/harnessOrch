import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dependencyViolations, isManifest, packageManager, staleDeps } from "../src/engine/deps.js";

const pkg = (o: object): string => JSON.stringify(o, null, 2);
const base = pkg({ name: "g", scripts: { test: "x" }, dependencies: { three: "^0.180.0" }, devDependencies: { vite: "^7.0.0" } });

describe("dependency rule", () => {
  it("lets agents add dev dependencies and scripts", () => {
    const after = pkg({ name: "g", scripts: { test: "x", e2e: "node --test tests/e2e/" }, dependencies: { three: "^0.180.0" },
      devDependencies: { vite: "^7.0.0", playwright: "^1.55.0" } });
    expect(dependencyViolations(base, after)).toEqual([]);
  });

  it("flags production dependency changes and upgrading or removing existing dev dependencies", () => {
    const after = pkg({ name: "g", dependencies: { three: "^0.181.0", lodash: "^4" }, devDependencies: {} });
    expect(dependencyViolations(base, after)).toEqual([
      "dependencies.three: changed", "dependencies.lodash: added", "devDependencies.vite: removed",
    ]);
    expect(dependencyViolations(base, pkg({ name: "g", dependencies: { three: "^0.180.0" }, devDependencies: { vite: "^8.0.0" } })))
      .toEqual(["devDependencies.vite: changed ^7.0.0 → ^8.0.0"]);
  });

  it("allows a production dependency the plan listed, but only as a new addition", () => {
    const after = pkg({ name: "g", dependencies: { three: "^0.180.0", "three-stdlib": "^2" }, devDependencies: { vite: "^7.0.0" } });
    expect(dependencyViolations(base, after, ["three-stdlib"])).toEqual([]);
    expect(dependencyViolations(base, after)).toEqual(["dependencies.three-stdlib: added"]);
    const bumped = pkg({ name: "g", dependencies: { three: "^0.181.0" }, devDependencies: { vite: "^7.0.0" } });
    expect(dependencyViolations(base, bumped, ["three"])).toEqual(["dependencies.three: changed"]);
  });

  it("treats a new package.json like an empty one", () => {
    expect(dependencyViolations(null, pkg({ devDependencies: { a: "1" } }))).toEqual([]);
    expect(dependencyViolations(null, pkg({ dependencies: { a: "1" } }))).toEqual(["dependencies.a: added"]);
  });

  it("recognises manifests and picks an install that never rewrites the lockfile", () => {
    expect(["package.json", "apps/web/package.json", "package-lock.json", "pnpm-lock.yaml"].every(isManifest)).toBe(true);
    expect(isManifest("src/package.ts")).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), "harness-pm-"));
    expect(packageManager(dir)).toBeNull();
    writeFileSync(join(dir, "package.json"), "{}");
    expect(packageManager(dir)?.args).toContain("--no-package-lock");
    writeFileSync(join(dir, "package-lock.json"), "{}");
    expect(packageManager(dir)).toEqual({ cmd: "npm", args: ["ci", "--no-audit", "--no-fund"] });
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    expect(packageManager(dir)?.cmd).toBe("pnpm");
  });
});

describe("staleDeps", () => {
  const install = (dir: string, name: string, version: string): void => {
    mkdirSync(join(dir, "node_modules", name), { recursive: true });
    writeFileSync(join(dir, "node_modules", name, "package.json"), pkg({ name, version }));
  };

  it("checks every locked package's installed version, not npm's own record", () => {
    const dir = mkdtempSync(join(tmpdir(), "stale-"));
    writeFileSync(join(dir, "package.json"), base);
    writeFileSync(join(dir, "package-lock.json"), pkg({ lockfileVersion: 3, packages: {
      "": { name: "g" },
      "node_modules/three": { version: "0.180.0" },
      "node_modules/playwright": { version: "1.64.1", dev: true },
      "node_modules/fsevents": { version: "2.3.3", optional: true },
    } }));
    install(dir, "three", "0.180.0");
    // npm's record claims playwright, as after an install through a shared hard link.
    writeFileSync(join(dir, "node_modules", ".package-lock.json"), pkg({ packages: { "node_modules/playwright": { version: "1.64.1" } } }));
    expect(staleDeps(dir)).toBe("playwright is not installed");
    install(dir, "playwright", "1.63.0");
    expect(staleDeps(dir)).toBe("playwright is 1.63.0, locked at 1.64.1");
    install(dir, "playwright", "1.64.1");
    expect(staleDeps(dir)).toBeNull(); // the optional, platform-specific fsevents may be absent
  });

  it("without an npm lockfile, checks the direct dependencies; without a manifest, nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "stale-"));
    expect(staleDeps(dir)).toBeNull();
    writeFileSync(join(dir, "package.json"), base);
    install(dir, "three", "0.180.0");
    expect(staleDeps(dir)).toBe("vite is not installed");
    install(dir, "vite", "7.0.0");
    expect(staleDeps(dir)).toBeNull();
  });
});
