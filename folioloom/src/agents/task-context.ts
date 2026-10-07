import { createHash } from "node:crypto";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { inheritProviderPreflight } from "../providers/preflight.js";

/** Caller-supplied purpose/context, independent of literary style instructions. */
export interface TaskContextMetadata {
  readonly schema: "folioloom-task-context-1";
  readonly sha256: string;
  readonly characters: number;
}

const contexts = new WeakMap<StreamFn, string>();

export function taskContextMetadata(text: string): TaskContextMetadata {
  if (typeof text !== "string" || !text.trim()) {
    throw new TypeError("task context must be nonempty");
  }
  if (text.length > 16_000) throw new RangeError("task context exceeds 16000 characters");
  return {
    schema: "folioloom-task-context-1",
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
    characters: text.length,
  };
}

export function validateTaskContextIdentity(stored: unknown, text: string | undefined): void {
  const expected = text === undefined ? undefined : taskContextMetadata(text);
  if (stored === undefined && expected === undefined) return;
  const value = stored as Partial<TaskContextMetadata> | undefined;
  if (value?.schema !== expected?.schema || value?.sha256 !== expected?.sha256
    || value?.characters !== expected?.characters || value === undefined || expected === undefined) {
    throw new Error("task context mismatch; resume requires the original task context file");
  }
}

export function bindTaskContext(streamFn: StreamFn, text: string | undefined): StreamFn {
  if (text === undefined) return streamFn;
  taskContextMetadata(text);
  const bound: StreamFn = (model, context, options) => streamFn(model, context, options);
  contexts.set(bound, text);
  return inheritProviderPreflight(streamFn, bound);
}

export function effectiveSystemPrompt(streamFn: StreamFn | undefined, prompt: string): string {
  const context = streamFn === undefined ? undefined : contexts.get(streamFn);
  return context === undefined ? prompt : `${context}\n\n${prompt}`;
}

export function inheritedTaskContext(from: StreamFn, to: StreamFn): StreamFn {
  return inheritProviderPreflight(from, bindTaskContext(to, contexts.get(from)));
}
