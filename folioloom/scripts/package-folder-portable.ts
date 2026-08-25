import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { open } from "yauzl";

const REQUIRED_ARCHIVE_ENTRIES = [
  "FolioLoom.exe",
  "resources/app.asar",
] as const;

export interface FolderPortableArchiveOptions {
  sourceDir: string;
  outputZip: string;
}

function requireRegularFile(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Folder portable source is missing ${label}: ${path}`);
  }
}

function validateArchiveEntry(entry: string): void {
  const segments = entry.split("/");
  if (
    entry.includes("\\")
    || entry.startsWith("/")
    || /^[A-Za-z]:/.test(entry)
    || segments.includes("..")
  ) {
    throw new Error(`Folder portable archive contains an unsafe path: ${entry}`);
  }
}

export function listZipEntries(zipPath: string): Promise<string[]> {
  return new Promise((resolveEntries, reject) => {
    open(
      zipPath,
      {
        lazyEntries: true,
        autoClose: true,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: true,
      },
      (openError, zipFile) => {
        if (openError) {
          reject(openError);
          return;
        }

        const entries: string[] = [];
        let settled = false;
        const fail = (error: Error): void => {
          if (settled) return;
          settled = true;
          zipFile.close();
          reject(error);
        };

        zipFile.on("error", fail);
        zipFile.on("entry", (entry) => {
          try {
            validateArchiveEntry(entry.fileName);
            entries.push(entry.fileName);
            zipFile.readEntry();
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        });
        zipFile.on("end", () => {
          if (settled) return;
          settled = true;
          resolveEntries(entries.sort((left, right) => left.localeCompare(right, "en")));
        });
        zipFile.readEntry();
      },
    );
  });
}

function createZipWithPowerShell(sourceDir: string, outputZip: string): void {
  if (process.platform !== "win32") {
    throw new Error("Folder portable ZIP packaging currently requires Windows.");
  }

  const command = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.IO.Compression",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "$source = [System.IO.Path]::GetFullPath($env:FOLIOLOOM_PORTABLE_SOURCE)",
    "$destination = [System.IO.Path]::GetFullPath($env:FOLIOLOOM_PORTABLE_OUTPUT)",
    "$prefix = $source.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar",
    "$archive = [System.IO.Compression.ZipFile]::Open($destination, [System.IO.Compression.ZipArchiveMode]::Create)",
    "try {",
    "  Get-ChildItem -LiteralPath $source -Recurse -Force -File | ForEach-Object {",
    "    $entryName = $_.FullName.Substring($prefix.Length).Replace('\\', '/')",
    "    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null",
    "  }",
    "} finally {",
    "  $archive.Dispose()",
    "}",
  ].join("\r\n");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FOLIOLOOM_PORTABLE_SOURCE: sourceDir,
        FOLIOLOOM_PORTABLE_OUTPUT: outputZip,
      },
      windowsHide: true,
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${String(result.status)}`;
    throw new Error(`Could not create folder portable ZIP: ${detail}`);
  }
}

function replaceArchive(tempZip: string, outputZip: string): void {
  const previousZip = `${outputZip}.previous-${randomUUID()}`;
  const hadPrevious = existsSync(outputZip);

  try {
    if (hadPrevious) {
      renameSync(outputZip, previousZip);
    }
    renameSync(tempZip, outputZip);
    if (hadPrevious) {
      rmSync(previousZip, { force: true, maxRetries: 5, retryDelay: 50 });
    }
  } catch (error) {
    if (hadPrevious && existsSync(previousZip) && !existsSync(outputZip)) {
      renameSync(previousZip, outputZip);
    }
    throw error;
  }
}

export async function createFolderPortableArchive(
  options: FolderPortableArchiveOptions,
): Promise<void> {
  const sourceDir = realpathSync(resolve(options.sourceDir));
  const outputZip = resolve(options.outputZip);
  const outputRelativeToSource = relative(sourceDir, outputZip);
  if (!outputRelativeToSource.startsWith("..") && !isAbsolute(outputRelativeToSource)) {
    throw new Error("Folder portable ZIP must be written outside win-unpacked.");
  }

  for (const entry of REQUIRED_ARCHIVE_ENTRIES) {
    requireRegularFile(resolve(sourceDir, ...entry.split("/")), entry);
  }

  mkdirSync(dirname(outputZip), { recursive: true });
  const tempZip = `${outputZip}.tmp-${process.pid}-${randomUUID()}`;
  try {
    createZipWithPowerShell(sourceDir, tempZip);
    const entries = await listZipEntries(tempZip);
    for (const requiredEntry of REQUIRED_ARCHIVE_ENTRIES) {
      if (!entries.includes(requiredEntry)) {
        throw new Error(`Folder portable ZIP is missing ${requiredEntry}.`);
      }
    }
    replaceArchive(tempZip, outputZip);
  } finally {
    rmSync(tempZip, { force: true, maxRetries: 5, retryDelay: 50 });
  }
}

async function main(): Promise<void> {
  const sourceDir = resolve("release", "win-unpacked");
  const outputZip = resolve("release", "FolioLoom-portable-win-x64.zip");
  await createFolderPortableArchive({ sourceDir, outputZip });
  const size = statSync(outputZip).size;
  if (size <= 0) {
    throw new Error(`Folder portable ZIP is empty: ${outputZip}`);
  }
  process.stdout.write(`Created ${outputZip} (${size} bytes)\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
