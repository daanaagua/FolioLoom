import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createFolderPortableArchive,
  listZipEntries,
} from "../scripts/package-folder-portable.js";

test("folder portable archive rejects an incomplete unpacked application without replacing an old archive", async () => {
  const root = mkdtempSync(join(tmpdir(), "folioloom-folder-package-invalid-"));
  const sourceDir = join(root, "win-unpacked");
  const outputZip = join(root, "FolioLoom-portable-win-x64.zip");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(outputZip, "previous archive");

  try {
    await assert.rejects(
      createFolderPortableArchive({ sourceDir, outputZip }),
      /FolioLoom\.exe/,
    );
    assert.equal(readFileSync(outputZip, "utf8"), "previous archive");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "folder portable archive stores the unpacked contents at the ZIP root and replaces an old archive",
  { skip: process.platform !== "win32" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "folioloom-folder-package-valid-"));
    const sourceDir = join(root, "win-unpacked");
    const outputZip = join(root, "FolioLoom-portable-win-x64.zip");
    mkdirSync(join(sourceDir, "resources"), { recursive: true });
    writeFileSync(join(sourceDir, "FolioLoom.exe"), "exe");
    writeFileSync(join(sourceDir, "resources", "app.asar"), "asar");
    writeFileSync(outputZip, "obsolete archive");

    try {
      await createFolderPortableArchive({ sourceDir, outputZip });
      assert.deepEqual(
        (await listZipEntries(outputZip)).filter((entry) => !entry.endsWith("/")),
        ["FolioLoom.exe", "resources/app.asar"],
      );
      assert.notEqual(readFileSync(outputZip, "utf8"), "obsolete archive");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
