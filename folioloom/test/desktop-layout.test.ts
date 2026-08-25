import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const styles = readFileSync(
  join(projectRoot, "src", "desktop", "renderer", "src", "styles.css"),
  "utf8",
);

function declarationsFor(selector: RegExp): string {
  const match = styles.match(new RegExp(`${selector.source}\\s*\\{([^}]*)\\}`));
  assert.notEqual(match, null, `missing CSS rule for ${selector.source}`);
  return match![1]!;
}

test("desktop layout contains scrolling below the integrated titlebar", () => {
  const rootLayout = declarationsFor(/html,\s*body,\s*#root/);
  assert.match(rootLayout, /(?:^|\n)\s*height:\s*100%;/);
  assert.match(rootLayout, /(?:^|\n)\s*overflow:\s*hidden;/);

  const shell = declarationsFor(/\.workbench-shell/);
  assert.match(shell, /(?:^|\n)\s*height:\s*100vh;/);
  assert.match(shell, /(?:^|\n)\s*min-height:\s*0;/);
  assert.match(shell, /(?:^|\n)\s*overflow:\s*hidden;/);

  const main = declarationsFor(/\.workbench-main/);
  assert.match(main, /(?:^|\n)\s*min-height:\s*0;/);
  assert.match(main, /(?:^|\n)\s*overflow:\s*hidden;/);

  const onboarding = declarationsFor(/\.onboarding-scroll/);
  assert.match(onboarding, /(?:^|\n)\s*height:\s*100%;/);
  assert.match(onboarding, /(?:^|\n)\s*overflow-y:\s*auto;/);
  assert.match(onboarding, /(?:^|\n)\s*scrollbar-width:\s*none;/);

  const contentColumn = declarationsFor(/\.content-column/);
  assert.doesNotMatch(contentColumn, /100vh/);
});
