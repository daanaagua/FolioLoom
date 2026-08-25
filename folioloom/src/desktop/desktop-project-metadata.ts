import { readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

export const DESKTOP_PROJECT_METADATA_FILE = "desktop_project.json";

interface DesktopProjectMetadata {
  schema: "folioloom-desktop-project-1";
  title: string;
  sourceFileName: string;
}

function validLabel(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= 500
    && !/[\u0000-\u001f]/u.test(value);
}

export function createDesktopProjectMetadata(
  sourcePath: string,
): DesktopProjectMetadata {
  const sourceFileName = basename(sourcePath).normalize("NFC");
  const title = basename(sourceFileName, extname(sourceFileName)).normalize("NFC");
  return {
    schema: "folioloom-desktop-project-1",
    title: validLabel(title) ? title : "Untitled",
    sourceFileName: validLabel(sourceFileName) ? sourceFileName : "Untitled",
  };
}

export function desktopProjectMetadataPath(projectDirectory: string): string {
  return join(projectDirectory, DESKTOP_PROJECT_METADATA_FILE);
}

export function desktopProjectTitle(
  manifestPath: string,
  rawPath: string,
): string {
  try {
    const parsed = JSON.parse(readFileSync(
      desktopProjectMetadataPath(dirname(manifestPath)),
      "utf8",
    )) as Partial<DesktopProjectMetadata>;
    if (parsed.schema === "folioloom-desktop-project-1"
      && validLabel(parsed.title)
      && validLabel(parsed.sourceFileName)) {
      return parsed.title.normalize("NFC");
    }
  } catch {
    // Older and CLI-created projects have no desktop metadata.
  }
  return basename(rawPath, extname(rawPath));
}
