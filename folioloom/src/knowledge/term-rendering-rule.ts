import type {
  StableTermPolicy,
  TermApplicability,
} from "../domain/types.js";

export type TermRuleSelector = TermApplicability;
type BlockRangeTermSelector = Extract<TermApplicability, { kind: "block_range" }>;

export interface TermRuleBlockPosition {
  readonly sourceVersion: string;
  readonly blockId: string;
  readonly globalIndex: number;
}

export interface TermRenderingRuleInput {
  readonly ruleId: string;
  readonly conceptId: string;
  readonly entityId?: string;
  readonly sourceForms: readonly string[];
  readonly target: string;
  readonly allowedTargets?: readonly string[];
  readonly policy: StableTermPolicy;
  readonly selector: TermRuleSelector;
  readonly priority: number;
  readonly authorityRank: number;
}

export interface TermRenderingRule extends TermRenderingRuleInput {
  readonly sourceForms: readonly string[];
  readonly allowedTargets: readonly string[];
  readonly selector: TermRuleSelector;
}

const POLICIES = new Set<StableTermPolicy>([
  "locked",
  "preferred",
  "contextual",
]);

function text(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0
    || [...normalized].length > maximum
    || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError(`${label} is invalid`);
  }
  return normalized;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

export function validateTermRuleSelector(value: unknown): TermRuleSelector {
  if (value === null || typeof value !== "object") {
    throw new TypeError("selector must be an object");
  }
  const candidate = value as Readonly<Record<string, unknown>>;
  if (candidate.kind === "whole_book") {
    return Object.freeze({ kind: "whole_book" });
  }
  if (candidate.kind !== "block_range") {
    throw new TypeError("selector.kind is invalid");
  }
  const startGlobalIndex = integer(
    candidate.startGlobalIndex,
    "selector.startGlobalIndex",
  );
  const endGlobalIndex = integer(
    candidate.endGlobalIndex,
    "selector.endGlobalIndex",
  );
  if (startGlobalIndex > endGlobalIndex) {
    throw new RangeError(
      "selector.startGlobalIndex must not exceed selector.endGlobalIndex",
    );
  }
  return Object.freeze({
    kind: "block_range",
    sourceVersion: text(candidate.sourceVersion, "selector.sourceVersion"),
    startBlockId: text(candidate.startBlockId, "selector.startBlockId"),
    endBlockId: text(candidate.endBlockId, "selector.endBlockId"),
    startGlobalIndex,
    endGlobalIndex,
  });
}

function stringList(
  values: readonly string[] | undefined,
  label: string,
): string[] {
  if (!Array.isArray(values)) {
    throw new TypeError(`${label} must be an array`);
  }
  return [...new Set(values.map((value, index) =>
    text(value, `${label}[${index}]`, 128)))];
}

export function createTermRenderingRule(
  input: TermRenderingRuleInput,
): TermRenderingRule {
  if (input === null || typeof input !== "object") {
    throw new TypeError("term rendering rule must be an object");
  }
  const sourceForms = stringList(input.sourceForms, "sourceForms");
  if (sourceForms.length === 0) {
    throw new TypeError("sourceForms must contain at least one form");
  }
  const target = text(input.target, "target", 128);
  const allowedTargets = stringList(
    input.allowedTargets ?? [target],
    "allowedTargets",
  );
  if (!allowedTargets.includes(target)) allowedTargets.unshift(target);
  if (!POLICIES.has(input.policy)) {
    throw new TypeError("policy is invalid");
  }
  return Object.freeze({
    ruleId: text(input.ruleId, "ruleId"),
    conceptId: text(input.conceptId, "conceptId"),
    ...(input.entityId === undefined
      ? {}
      : { entityId: text(input.entityId, "entityId") }),
    sourceForms: Object.freeze(sourceForms),
    target,
    allowedTargets: Object.freeze(allowedTargets),
    policy: input.policy,
    selector: validateTermRuleSelector(input.selector),
    priority: integer(input.priority, "priority"),
    authorityRank: integer(input.authorityRank, "authorityRank"),
  });
}

export function ruleAppliesToBlock(
  rule: Pick<TermRenderingRule, "selector">,
  block: TermRuleBlockPosition,
): boolean {
  if (!Number.isSafeInteger(block.globalIndex) || block.globalIndex < 0) {
    throw new TypeError("block.globalIndex must be a non-negative safe integer");
  }
  if (rule.selector.kind === "whole_book") return true;
  return block.sourceVersion === rule.selector.sourceVersion
    && block.globalIndex >= rule.selector.startGlobalIndex
    && block.globalIndex <= rule.selector.endGlobalIndex;
}

function normalizedForm(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("und");
}

function compareSpecificity(
  left: TermRenderingRule,
  right: TermRenderingRule,
): number {
  if (left.selector.kind !== right.selector.kind) {
    return left.selector.kind === "block_range" ? -1 : 1;
  }
  if (left.selector.kind === "block_range"
    && right.selector.kind === "block_range") {
    const leftLength = left.selector.endGlobalIndex
      - left.selector.startGlobalIndex;
    const rightLength = right.selector.endGlobalIndex
      - right.selector.startGlobalIndex;
    if (leftLength !== rightLength) return leftLength - rightLength;
  }
  return 0;
}

function sameRendering(
  left: TermRenderingRule,
  right: TermRenderingRule,
): boolean {
  return left.target === right.target
    && left.policy === right.policy
    && [...left.allowedTargets].sort().join("\0")
      === [...right.allowedTargets].sort().join("\0");
}

export function resolveTermRenderingRule(
  rules: readonly TermRenderingRule[],
  sourceForm: string,
  block: TermRuleBlockPosition,
): TermRenderingRule | undefined {
  const normalized = normalizedForm(text(sourceForm, "sourceForm", 128));
  const candidates = rules.filter((rule) =>
    rule.sourceForms.some((form) => normalizedForm(form) === normalized)
    && ruleAppliesToBlock(rule, block));
  candidates.sort((left, right) =>
    right.authorityRank - left.authorityRank
    || compareSpecificity(left, right)
    || right.priority - left.priority
    || left.ruleId.localeCompare(right.ruleId, "und"));
  const winner = candidates[0];
  const runnerUp = candidates[1];
  if (winner !== undefined
    && runnerUp !== undefined
    && winner.authorityRank === runnerUp.authorityRank
    && compareSpecificity(winner, runnerUp) === 0
    && winner.priority === runnerUp.priority
    && !sameRendering(winner, runnerUp)) {
    throw new Error(
      `TERM_RULE_CONFLICT: ${winner.ruleId} conflicts with ${runnerUp.ruleId}`,
    );
  }
  return winner;
}
