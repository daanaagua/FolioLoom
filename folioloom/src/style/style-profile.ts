import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { parse } from "yaml";

import type { StyleState } from "../tools/translation-tools.js";

const STYLE_FIELDS = [
  "register",
  "sentencePolicy",
  "explicitation",
  "imagery",
  "dialogue",
  "technicalProse",
  "typography",
  "narratorVoice",
  "additionalInstruction",
] as const;

type StyleField = typeof STYLE_FIELDS[number];

const STYLE_FIELD_SET = new Set<string>(STYLE_FIELDS);
const STANDARD_FIELD_LIMIT = 180;
const ADDITIONAL_INSTRUCTION_LIMIT = 600;
const COMBINED_ADDITIONAL_INSTRUCTION_LIMIT = 600;

export interface StyleProfileInput {
  readonly profilePath?: string;
  readonly cliPrompt?: string;
}

export interface StyleProfileSource {
  readonly profile: boolean;
  readonly cliPrompt: boolean;
}

export interface LoadedStyleProfile {
  readonly styleState: StyleState;
  readonly profileHash?: string;
  readonly source: StyleProfileSource;
}

function unicodeScalars(value: string): number {
  return [...value].length;
}

function nonemptyText(value: unknown, label: string, maxScalars: number): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  if (unicodeScalars(normalized) > maxScalars) {
    throw new RangeError(`${label} exceeds ${maxScalars} Unicode scalars`);
  }
  return normalized;
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readProfile(profilePath: string): StyleState {
  let parsed: unknown;
  try {
    parsed = parse(readFileSync(profilePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read style profile ${profilePath}: ${message}`);
  }
  const root = plainObject(parsed, "style profile");
  for (const key of Object.keys(root)) {
    if (key !== "style") {
      throw new TypeError(`unknown style profile field: ${key}`);
    }
  }
  const style = plainObject(root.style, "style");
  const state: StyleState = {};
  for (const key of Object.keys(style)) {
    if (!STYLE_FIELD_SET.has(key)) {
      throw new TypeError(`unknown style field: ${key}`);
    }
  }
  for (const field of STYLE_FIELDS) {
    if (style[field] === undefined) {
      continue;
    }
    state[field] = nonemptyText(
      style[field],
      `style.${field}`,
      field === "additionalInstruction"
        ? ADDITIONAL_INSTRUCTION_LIMIT
        : STANDARD_FIELD_LIMIT,
    );
  }
  return state;
}

function joinAdditionalInstruction(
  fromProfile: string | undefined,
  cliPrompt: string | undefined,
): string | undefined {
  const values = [fromProfile, cliPrompt].filter((value): value is string => value !== undefined);
  if (values.length === 0) {
    return undefined;
  }
  const combined = values.join("\n");
  if (unicodeScalars(combined) > COMBINED_ADDITIONAL_INSTRUCTION_LIMIT) {
    throw new RangeError(
      `combined additional instruction exceeds ${COMBINED_ADDITIONAL_INSTRUCTION_LIMIT} Unicode scalars`,
    );
  }
  return combined;
}

function canonicalStyleState(styleState: StyleState): string {
  const ordered: Record<string, string> = {};
  for (const field of STYLE_FIELDS) {
    const value = styleState[field];
    if (value !== undefined) {
      ordered[field] = value;
    }
  }
  return JSON.stringify(ordered);
}

function profileHash(styleState: StyleState): string {
  return createHash("sha256").update(canonicalStyleState(styleState), "utf8").digest("hex");
}

/**
 * Loads only user-controlled style guidance. The fixed translation protocol is
 * deliberately outside this module and cannot be replaced through this API.
 */
export function loadStyleProfile(input: StyleProfileInput): LoadedStyleProfile {
  const source: StyleProfileSource = {
    profile: input.profilePath !== undefined,
    cliPrompt: input.cliPrompt !== undefined,
  };
  const fromProfile = input.profilePath === undefined ? {} : readProfile(input.profilePath);
  const cliPrompt = input.cliPrompt === undefined
    ? undefined
    : nonemptyText(input.cliPrompt, "--prompt", ADDITIONAL_INSTRUCTION_LIMIT);
  const additionalInstruction = joinAdditionalInstruction(
    fromProfile.additionalInstruction,
    cliPrompt,
  );
  const styleState: StyleState = { ...fromProfile };
  if (additionalInstruction === undefined) {
    delete styleState.additionalInstruction;
  } else {
    styleState.additionalInstruction = additionalInstruction;
  }
  return {
    styleState,
    ...(source.profile || source.cliPrompt ? { profileHash: profileHash(styleState) } : {}),
    source,
  };
}
