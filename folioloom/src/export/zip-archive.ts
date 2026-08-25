import * as yauzl from "yauzl";
import type { Entry, ZipFile } from "yauzl";

export interface ZipArchiveEntry {
  readonly name: string;
  readonly data: Buffer;
}

const MAX_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 768 * 1024 * 1024;

function safeName(name: string): boolean {
  return name.length > 0
    && !name.startsWith("/")
    && !name.includes("\\")
    && !name.includes("\0")
    && !name.split("/").some((part) => part === "." || part === "..");
}

function openZip(payload: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(payload, {
      decodeStrings: true,
      lazyEntries: true,
      strictFileNames: false,
      validateEntrySizes: true,
    }, (error, zip) => {
      if (error !== null || zip === undefined) {
        reject(error ?? new Error("cannot open ZIP archive"));
      } else {
        resolve(zip);
      }
    });
  });
}

function readEntry(zip: ZipFile, entry: Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error !== null || stream === undefined) {
        reject(error ?? new Error(`cannot read ZIP entry ${entry.fileName}`));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_ENTRY_BYTES) {
          stream.destroy(new Error(`ZIP entry exceeds limit: ${entry.fileName}`));
        } else {
          chunks.push(chunk);
        }
      });
      stream.on("error", reject);
      stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
  });
}

export async function readZipArchive(payload: Buffer): Promise<ZipArchiveEntry[]> {
  const zip = await openZip(payload);
  return new Promise((resolve, reject) => {
    const entries: ZipArchiveEntry[] = [];
    const names = new Set<string>();
    let totalBytes = 0;
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      try {
        zip.close();
      } catch {
        // yauzl may already have closed the archive.
      }
      reject(error);
    };
    zip.on("error", fail);
    zip.on("entry", (entry: Entry) => {
      void (async () => {
        const name = entry.fileName;
        if (!safeName(name)) throw new Error(`invalid ZIP entry name: ${name}`);
        if (name.endsWith("/")) {
          zip.readEntry();
          return;
        }
        if (names.has(name)) throw new Error(`duplicate ZIP entry: ${name}`);
        if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
          throw new Error(`ZIP entry exceeds limit: ${name}`);
        }
        totalBytes += entry.uncompressedSize;
        if (totalBytes > MAX_ARCHIVE_BYTES) {
          throw new Error("ZIP archive exceeds expanded-size limit");
        }
        const data = await readEntry(zip, entry);
        names.add(name);
        entries.push({ name, data });
        zip.readEntry();
      })().catch(fail);
    });
    zip.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(entries);
    });
    zip.readEntry();
  });
}
