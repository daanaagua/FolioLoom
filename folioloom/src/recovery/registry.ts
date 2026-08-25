import type {
  IncidentCode,
  RecoveryParameterPolicy,
  RecoveryRule,
  RecoveryStrategy,
} from "./types.js";

export const INCIDENT_CODES = Object.freeze([
  "SOURCE_SPAN_GAP",
  "SOURCE_SPAN_OVERLAP",
  "SOURCE_HASH_MISMATCH",
  "BLOCK_MEMBERSHIP_INVALID",
  "WINDOW_OVERSIZED",
  "SOURCE_VERSION_CHANGED",
  "RUN_VERSION_MISMATCH",
  "ENCODING_AMBIGUOUS",
  "RUNNING_AFTER_CRASH",
  "STORAGE_LOCKED",
  "STORAGE_CORRUPT",
  "EXPORT_INCOMPLETE",
] as const satisfies readonly IncidentCode[]);

function rule(
  deterministic: RecoveryStrategy | null,
  allowed: readonly RecoveryStrategy[],
  requiredAudits: readonly string[],
  options: {
    maxAttempts?: 0 | 1;
    requiresHuman?: boolean;
    parameterPolicies?: Readonly<Partial<Record<RecoveryStrategy, RecoveryParameterPolicy>>>;
  } = {},
): RecoveryRule {
  const policies = Object.fromEntries(allowed.map((strategy) => {
    const configured = options.parameterPolicies?.[strategy];
    return [strategy, Object.freeze({
      properties: Object.freeze({ ...(configured?.properties ?? {}) }),
    })];
  })) as Partial<Record<RecoveryStrategy, RecoveryParameterPolicy>>;
  return Object.freeze({
    deterministic,
    allowed: Object.freeze([...allowed]),
    maxAttempts: options.maxAttempts ?? (allowed.length === 0 ? 0 : 1),
    requiredAudits: Object.freeze([...requiredAudits]),
    parameterPolicies: Object.freeze(policies),
    ...(options.requiresHuman === undefined
      ? {}
      : { requiresHuman: options.requiresHuman }),
  });
}

export const RECOVERY_RULES: Readonly<Record<IncidentCode, RecoveryRule>> =
  Object.freeze({
    SOURCE_SPAN_GAP: rule(
      "flat_partition_rebuild",
      ["rebuild_affected_span", "flat_partition_rebuild"],
      ["source_coverage", "block_membership", "raw_hash"],
    ),
    SOURCE_SPAN_OVERLAP: rule(
      "flat_partition_rebuild",
      ["rebuild_affected_span", "flat_partition_rebuild"],
      ["source_coverage", "block_membership", "raw_hash"],
    ),
    SOURCE_HASH_MISMATCH: rule(
      "quarantine_old_run",
      ["quarantine_old_run"],
      ["raw_hash", "source_lineage", "run_isolation"],
    ),
    BLOCK_MEMBERSHIP_INVALID: rule(
      null,
      ["rebuild_window_membership", "replan_affected_windows"],
      ["source_coverage", "block_membership", "window_membership", "raw_hash"],
      {
        parameterPolicies: {
          replan_affected_windows: {
            properties: {
              maxWindowBlocks: { type: "integer", minimum: 1, maximum: 64 },
            },
          },
        },
      },
    ),
    WINDOW_OVERSIZED: rule(
      "split_window_boundaries",
      ["split_window_boundaries"],
      ["block_membership", "window_membership", "window_budget"],
    ),
    SOURCE_VERSION_CHANGED: rule(
      "quarantine_old_run",
      ["quarantine_old_run"],
      ["raw_hash", "source_lineage", "run_isolation"],
    ),
    RUN_VERSION_MISMATCH: rule(
      "quarantine_old_run",
      ["quarantine_old_run"],
      ["run_lineage", "run_isolation"],
    ),
    ENCODING_AMBIGUOUS: rule(
      null,
      [],
      ["raw_hash"],
      { maxAttempts: 0, requiresHuman: true },
    ),
    RUNNING_AFTER_CRASH: rule(
      "reset_interrupted_windows",
      ["reset_interrupted_windows"],
      ["run_state", "staged_rows_absent", "completed_translations_unchanged"],
    ),
    STORAGE_LOCKED: rule(
      null,
      [],
      ["store_integrity"],
      { maxAttempts: 0, requiresHuman: true },
    ),
    STORAGE_CORRUPT: rule(
      null,
      [],
      ["store_integrity", "raw_hash"],
      { maxAttempts: 0, requiresHuman: true },
    ),
    EXPORT_INCOMPLETE: rule(
      "reset_missing_windows",
      ["reset_missing_windows"],
      ["block_membership", "missing_windows_pending", "run_lineage"],
    ),
  });

export function isIncidentCode(value: string): value is IncidentCode {
  return (INCIDENT_CODES as readonly string[]).includes(value);
}

export function projectRecoveryRule(
  code: IncidentCode,
  attemptedStrategies: readonly RecoveryStrategy[] = [],
): RecoveryRule {
  const registered = RECOVERY_RULES[code];
  const attempted = new Set(attemptedStrategies);
  const exhausted = attempted.size > 0;
  const allowed = exhausted ? [] : [...registered.allowed];
  return Object.freeze({
    ...registered,
    deterministic: exhausted ? null : registered.deterministic,
    allowed: Object.freeze(allowed),
    maxAttempts: exhausted ? 0 : registered.maxAttempts,
    parameterPolicies: Object.freeze(Object.fromEntries(
      allowed.map((strategy) => [strategy, registered.parameterPolicies[strategy]]),
    )),
  });
}

export function validateRecoveryParameters(
  rule: RecoveryRule,
  strategy: RecoveryStrategy,
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("recovery parameters must be an object");
  }
  const parameters = value as Record<string, unknown>;
  const policy = rule.parameterPolicies[strategy];
  if (policy === undefined) {
    throw new Error(`no parameter policy registered for ${strategy}`);
  }
  for (const key of Object.keys(parameters)) {
    const constraint = policy.properties[key];
    if (constraint === undefined) {
      throw new Error(`recovery parameter ${key} is not allowed for ${strategy}`);
    }
    const parameter = parameters[key];
    if (!Number.isSafeInteger(parameter)
      || (parameter as number) < constraint.minimum
      || (parameter as number) > constraint.maximum) {
      throw new RangeError(
        `${key} must be an integer between ${constraint.minimum} and ${constraint.maximum}`,
      );
    }
  }
  for (const key of Object.keys(policy.properties)) {
    if (!(key in parameters)) {
      throw new Error(`missing recovery parameter ${key} for ${strategy}`);
    }
  }
  return structuredClone(parameters);
}
