import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dependencyViolations, isManifest, packageManager } from "../src/engine/deps.js";

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
