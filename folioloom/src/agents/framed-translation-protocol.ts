import { randomBytes } from "node:crypto";

import { hasSemanticText } from "../text/semantic-text.js";

export const FRAMED_TRANSLATION_PROTOCOL_VERSION = "framed-v1";

const MARKER_PREFIX = "@@FOLIOLOOM:";

export interface FramedTranslationFrame {
  readonly blockId: string;
  readonly beginLine: string;
  readonly endLine: string;
}

export interface FramedTranslationProtocol {
  readonly version: typeof FRAMED_TRANSLATION_PROTOCOL_VERSION;
  readonly nonce: string;
  readonly frames: readonly FramedTranslationFrame[];
}

export interface FramedTranslationProtocolInput {
  readonly requestId: string;
  readonly snapshotId: string;
  readonly blockIds: readonly string[];
  readonly nonce?: string;
}

export interface FramedTranslationParseResult {
  readonly translations: Array<{ blockId: string; text: string }>;
  readonly errors: string[];
}

function requireNonempty(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be nonempty`);
  }
  return value;
}

function protocolNonce(input: FramedTranslationProtocolInput): string {
  if (input.nonce !== undefined) {
    if (!/^[0-9a-f]{32}$/u.test(input.nonce)) {
      throw new TypeError("framed nonce must be 128-bit lowercase hexadecimal");
    }
    return input.nonce;
  }
  return randomBytes(16).toString("hex");
}

function marker(
  nonce: string,
  direction: "BEGIN" | "END",
  blockId: string,
): string {
  return `${MARKER_PREFIX}${FRAMED_TRANSLATION_PROTOCOL_VERSION}:${nonce}:${direction}:${blockId}@@`;
}

export function createFramedTranslationProtocol(
  input: FramedTranslationProtocolInput,
): FramedTranslationProtocol {
  requireNonempty(input.requestId, "requestId");
  requireNonempty(input.snapshotId, "snapshotId");
  const seen = new Set<string>();
  for (const blockId of input.blockIds) {
    requireNonempty(blockId, "blockId");
    if (blockId.includes("\n") || blockId.includes("\r") || blockId.includes("@@")) {
      throw new TypeError(`blockId cannot be represented in a frame marker: ${blockId}`);
    }
    if (seen.has(blockId)) {
      throw new TypeError(`duplicate framed blockId: ${blockId}`);
    }
    seen.add(blockId);
  }
  const nonce = protocolNonce(input);
  return {
    version: FRAMED_TRANSLATION_PROTOCOL_VERSION,
    nonce,
    frames: input.blockIds.map((blockId) => ({
      blockId,
      beginLine: marker(nonce, "BEGIN", blockId),
      endLine: marker(nonce, "END", blockId),
    })),
  };
}

export function framedTranslationInstructions(protocol: FramedTranslationProtocol): string {
  const pairs = protocol.frames.flatMap((frame, index) => [
    `${index + 1}. ${frame.beginLine}`,
    `   ${frame.endLine}`,
  ]);
  return [
    "Translate every source block and return one raw Simplified-Chinese text frame per block.",
    "For each pair below, emit the BEGIN line exactly, then that block's complete translation, then the END line exactly.",
    "Keep the listed frame order. Marker lines must occupy whole lines and must not appear inside a translation.",
    "Return no prose, Markdown, or code fences outside those frames.",
    "EXACT FRAME PAIRS",
    ...pairs,
  ].join("\n");
}

export function parseFramedTranslationResponse(
  response: string,
  protocol: FramedTranslationProtocol,
): FramedTranslationParseResult {
  const beginByLine = new Map(protocol.frames.map((frame) => [frame.beginLine, frame]));
  const endByLine = new Map(protocol.frames.map((frame) => [frame.endLine, frame]));
  const completed = new Map<string, string>();
  const errors: string[] = [];
  let active: { frame: FramedTranslationFrame; lines: string[]; duplicate: boolean } | undefined;
  const lines = response.replace(/\r\n?/gu, "\n").split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (active === undefined) {
      const opening = beginByLine.get(line);
      if (opening !== undefined) {
        const duplicate = completed.has(opening.blockId);
        if (duplicate) {
          errors.push(`duplicate frame for block ${opening.blockId}`);
        }
        active = { frame: opening, lines: [], duplicate };
        continue;
      }
      const closing = endByLine.get(line);
      if (closing !== undefined) {
        errors.push(`unexpected closing frame for block ${closing.blockId} at line ${index + 1}`);
        continue;
      }
      if (line.startsWith(MARKER_PREFIX)) {
        errors.push(`unexpected FolioLoom marker at line ${index + 1}`);
        continue;
      }
      if (line.trim().length > 0) {
        errors.push(`text outside translation frames at line ${index + 1}`);
      }
      continue;
    }

    if (line === active.frame.endLine) {
      const text = active.lines.join("\n");
      if (!hasSemanticText(text)) {
        errors.push(`empty frame for block ${active.frame.blockId}`);
      } else if (!active.duplicate) {
        completed.set(active.frame.blockId, text);
      }
      active = undefined;
      continue;
    }
    if (beginByLine.has(line) || endByLine.has(line)) {
      errors.push(`mismatched or nested frame marker at line ${index + 1}`);
      continue;
    }
    if (line.startsWith(MARKER_PREFIX)) {
      errors.push(`unexpected FolioLoom marker at line ${index + 1}`);
      continue;
    }
    active.lines.push(line);
  }

  if (active !== undefined) {
    errors.push(`missing closing frame for block ${active.frame.blockId}`);
  }
  for (const frame of protocol.frames) {
    if (!completed.has(frame.blockId)) {
      errors.push(`missing frame for block ${frame.blockId}`);
    }
  }

  return {
    translations: errors.length > 0
      ? []
      : protocol.frames.map((frame) => ({
        blockId: frame.blockId,
        text: completed.get(frame.blockId) as string,
      })),
    errors,
  };
}
