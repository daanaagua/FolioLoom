import type { KnowledgeRevision } from "./knowledge-store.js";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function appendString(value: unknown, target: Set<string>): void {
  if (typeof value === "string" && value.trim().length > 0) {
    target.add(value.trim());
  }
}

function appendStrings(value: unknown, target: Set<string>): void {
  if (!Array.isArray(value)) return;
  for (const item of value) appendString(item, target);
}

function appendExplicitForms(value: unknown, target: Set<string>): void {
  const raw = record(value);
  if (raw === undefined) return;
  appendString(raw.sourceForm, target);
  appendString(raw.canonicalSource, target);
  appendStrings(raw.sourceForms, target);
  appendStrings(raw.subjectForms, target);
  appendStrings(raw.normalizedForms, target);
}

/**
 * Return only fields that explicitly denote literal forms in the source text.
 * Descriptive facts, notes, translations and relationship prose are
 * intentionally ignored so they cannot create false prompt matches or impacts.
 */
export function sourceFormsFromRevision(
  revision: KnowledgeRevision,
): readonly string[];
export function sourceFormsFromRevision(
  revision: Pick<KnowledgeRevision, "payload" | "alternatives">,
): readonly string[];
export function sourceFormsFromRevision(
  revision: Pick<KnowledgeRevision, "payload" | "alternatives">,
): readonly string[] {
  const forms = new Set<string>();
  appendExplicitForms(revision.payload, forms);
  for (const alternative of revision.alternatives) {
    appendExplicitForms(alternative, forms);
  }
  return Object.freeze([...forms].sort(compareText));
}
