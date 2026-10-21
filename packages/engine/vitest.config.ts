import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Per-user state (telemetry, availability) must never touch the real ~/.harnessorch.
    env: { HARNESS_HOME: mkdtempSync(join(tmpdir(), "harness-home-")) },
    // Several suites run real git and subprocesses; a loaded Windows machine needs headroom.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    exclude: [...configDefaults.exclude, "test/e2e/**"],
  },
});
