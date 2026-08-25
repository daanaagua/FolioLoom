import {
  chooseEffectiveField,
  normalizeKnowledgeAuthority,
  type EffectiveKnowledgeField,
  type KnowledgeAuthority,
} from "./knowledge-authority.js";
import type { KnowledgeRevision } from "./knowledge-store.js";
import type { StyleState } from "../tools/translation-tools.js";

export const PERSISTED_STYLE_FIELDS = [
  "register",
  "sentencePolicy",
  "explicitation",
  "imagery",
  "dialogue",
  "technicalProse",
  "typography",
  "narratorVoice",
  "additionalInstruction",
  "narrativeDistance",
  "dialogueRegister",
] as const;

type PersistedStyleField = typeof PERSISTED_STYLE_FIELDS[number];

const FIELD_SET = new Set<string>(PERSISTED_STYLE_FIELDS);
const STYLE_KINDS = new Set(["style_directive", "style_profile"]);
const STANDARD_FIELD_LIMIT = 180;
const ADDITIONAL_INSTRUCTION_LIMIT = 600;

function unicodeScalars(value: string): number {
  return [...value].length;
}

function record(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function defaultAuthority(): KnowledgeAuthority {
  return normalizeKnowledgeAuthority({
    origin: "model",
    scope: "book",
    ownedFields: [],
  });
}

function styleValue(
  field: PersistedStyleField,
  value: unknown,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`PERSISTED_STYLE_INVALID: ${field} must be nonempty text`);
  }
  const normalized = value.trim();
  const limit = field === "additionalInstruction"
    ? ADDITIONAL_INSTRUCTION_LIMIT
    : STANDARD_FIELD_LIMIT;
  if (unicodeScalars(normalized) > limit) {
    throw new RangeError(
      `PERSISTED_STYLE_INVALID: ${field} exceeds ${limit} Unicode scalars`,
    );
  }
  return normalized;
}

/**
 * Builds the user-editable style overlay from active durable knowledge.
 * Translation protocol, tool schemas and safety instructions are deliberately
 * not representable in this projection.
 */
export function persistedStyleFromKnowledge(
  revisions: readonly KnowledgeRevision[],
): StyleState {
  if (!Array.isArray(revisions)) {
    throw new TypeError("knowledge revisions must be an array");
  }
  const candidates = new Map<
    PersistedStyleField,
    EffectiveKnowledgeField<string>[]
  >();
  for (const revision of revisions) {
    // `style_profile` was emitted by older importers. Keep reading it so an
    // upgraded project does not silently lose an already accepted style.
    if (!STYLE_KINDS.has(revision.kind) || revision.status !== "active") {
      continue;
    }
    const payload = record(revision.payload);
    if (payload === undefined) {
      throw new TypeError("PERSISTED_STYLE_INVALID: payload must be an object");
    }
    const authority = revision.authority === undefined
      ? defaultAuthority()
      : normalizeKnowledgeAuthority(revision.authority);
    for (const [key, rawValue] of Object.entries(payload)) {
      if (!FIELD_SET.has(key)) {
        continue;
      }
      const field = key as PersistedStyleField;
      const values = candidates.get(field) ?? [];
      values.push({ authority, value: styleValue(field, rawValue) });
      candidates.set(field, values);
    }
  }

  const result: StyleState = {};
  for (const field of PERSISTED_STYLE_FIELDS) {
    const values = candidates.get(field);
    if (values === undefined || values.length === 0) {
      continue;
    }
    try {
      const value = chooseEffectiveField(values);
      if (value !== undefined) {
        result[field] = value;
      }
    } catch (error) {
      if (error instanceof Error
        && error.message.includes("KNOWLEDGE_AUTHORITY_CONFLICT")) {
        throw new Error(
          `PERSISTED_STYLE_CONFLICT: same-rank values differ for ${field}`,
          { cause: error },
        );
      }
      throw error;
    }
  }
  return result;
}

export function mergeStyleState(
  base: Readonly<StyleState> | undefined,
  persisted: Readonly<StyleState>,
): StyleState {
  if (persisted === null || typeof persisted !== "object" || Array.isArray(persisted)) {
    throw new TypeError("persisted style must be an object");
  }
  return { ...(base ?? {}), ...persisted };
}
