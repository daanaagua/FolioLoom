import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { deflateRawSync } from "node:zlib";

export interface StoredZipInput {
  name: string;
  data: Buffer | string;
  method?: 0 | 8;
}

export interface StoredZipEntry {
  name: string;
  method: number;
  data: Buffer;
}

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const UTF8_FLAG = 0x0800;

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0
        ? 0xedb88320 ^ (value >>> 1)
        : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(payload: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validateEntryName(name: string): void {
  const segments = name.split("/");
  if (name.length === 0
    || name.startsWith("/")
    || name.includes("\\")
    || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`invalid ZIP entry name: ${name}`);
  }
}

export function writeStoredZip(
  outputPath: string,
  inputs: readonly StoredZipInput[],
): void {
  if (inputs.length > 0xffff) {
    throw new Error("stored ZIP has too many entries");
  }
  const seen = new Set<string>();
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const input of inputs) {
    validateEntryName(input.name);
    if (seen.has(input.name)) {
      throw new Error(`duplicate ZIP entry: ${input.name}`);
    }
    seen.add(input.name);
    const name = Buffer.from(input.name, "utf8");
    const payload = Buffer.isBuffer(input.data)
      ? input.data
      : Buffer.from(input.data, "utf8");
    if (name.length > 0xffff || payload.length > 0xffffffff) {
      throw new Error(`stored ZIP entry is too large: ${input.name}`);
    }
    const method = input.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(payload) : payload;
    const checksum = crc32(payload);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_FILE_HEADER, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(payload.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_DIRECTORY_HEADER, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(payload.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);

    localOffset += local.length + name.length + compressed.length;
    if (localOffset > 0xffffffff) {
      throw new Error("stored ZIP is too large for ZIP32");
    }
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(inputs.length, 8);
  end.writeUInt16LE(inputs.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, Buffer.concat([...localParts, centralDirectory, end]));
}

export function readStoredZipEntries(path: string): StoredZipEntry[] {
  const zip = readFileSync(path);
  const entries: StoredZipEntry[] = [];
  let offset = 0;
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === LOCAL_FILE_HEADER) {
    const flags = zip.readUInt16LE(offset + 6);
    const method = zip.readUInt16LE(offset + 8);
    const compressedSize = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    if ((flags & 0x08) !== 0) {
      throw new Error("ZIP data descriptors are not supported");
    }
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > zip.length) {
      throw new Error("truncated ZIP entry");
    }
    entries.push({
      name: zip.subarray(nameStart, nameStart + nameLength).toString("utf8"),
      method,
      data: Buffer.from(zip.subarray(dataStart, dataEnd)),
    });
    offset = dataEnd;
  }
  return entries;
}
