import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(projectRoot, "..");

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

test("desktop package scripts and portable metadata stay explicit", () => {
  const packageJson = JSON.parse(readText(join(projectRoot, "package.json"))) as {
    main?: string;
    scripts: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  const scripts = packageJson.scripts;
  assert.equal(packageJson.main, "out/main/index.js");
  assert.equal(scripts["desktop:dev"], "electron-vite dev");
  assert.match(scripts["desktop:build"] ?? "", /electron-vite build/);
  assert.match(scripts["desktop:build"] ?? "", /verify-desktop-build\.test\.ts/);
  assert.match(scripts["desktop:test"] ?? "", /node --test --import tsx test\/desktop-\*\.test\.ts/);
  assert.match(scripts["desktop:test"] ?? "", /vitest run/);
  assert.match(scripts["desktop:test"] ?? "", /--passWithNoTests/);
  assert.equal(
    scripts["desktop:dist:exe"],
    "npm run desktop:build && electron-builder --win portable --x64",
  );
  assert.equal(
    scripts["desktop:dist:folder"],
    "npm run desktop:build && electron-builder --win --dir --x64 && tsx scripts/package-folder-portable.ts",
  );
  assert.equal(
    scripts["desktop:dist"],
    "npm run desktop:build && electron-builder --win portable --x64 && tsx scripts/package-folder-portable.ts",
  );
  for (const dependency of [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "fast-xml-parser",
    "yauzl",
  ]) {
    assert.equal(typeof packageJson.dependencies?.[dependency], "string", `missing runtime dependency ${dependency}`);
  }

  const builder = readText(join(projectRoot, "electron-builder.yml"));
  assert.match(builder, /^appId: io\.folioloom\.desktop$/m);
  assert.match(builder, /^productName: FolioLoom$/m);
  assert.match(builder, /directories:\r?\n\s+output: release/);
  assert.match(builder, /files:\r?\n\s+- out\/\*\*\/\*\r?\n\s+- package\.json/);
  assert.doesNotMatch(builder, /^\s+-\s+(?:src|test|fixtures|projects|config)\//m);
  assert.match(builder, /extraResources:\r?\n\s+- from: desktop\/resources\r?\n\s+to: folioloom/);
  assert.match(builder, /target:\r?\n\s+- target: portable\r?\n\s+arch:\r?\n\s+- x64/);
  assert.match(builder, /^artifactName: FolioLoom-portable-win-x64\.\$\{ext\}$/m);

  const resource = JSON.parse(readText(join(projectRoot, "desktop", "resources", "app-info.json"))) as {
    schema: string;
    version: string;
    apiKeyPolicy: string;
    projectDataPolicy: string;
    translationWritePolicy: string;
    exportPolicy: string;
  };
  assert.deepEqual(resource, {
    schema: "folioloom-desktop-resource-1",
    version: "1.5.3",
    apiKeyPolicy: "never-packaged",
    projectDataPolicy: "user-selected",
    translationWritePolicy: "single-window-trial-and-durable-fullbook",
    exportPolicy: "strict-txt-bilingual-epub",
  });

  const gitignore = readText(join(repositoryRoot, ".gitignore"));
  assert.match(gitignore, /^folioloom\/out\/$/m);
  assert.match(gitignore, /^folioloom\/release\/$/m);
});
