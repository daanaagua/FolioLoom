import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("desktop:test runs task-three Node tests and tolerates an empty renderer suite", () => {
  const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts["desktop:test"],
    "node --test --import tsx test/desktop-*.test.ts && vitest run --config vitest.desktop.config.ts --passWithNoTests",
  );
});
