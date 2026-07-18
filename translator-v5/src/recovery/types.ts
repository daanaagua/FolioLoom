export type IncidentCode =
  | "SOURCE_SPAN_GAP"
  | "SOURCE_SPAN_OVERLAP"
  | "SOURCE_HASH_MISMATCH"
  | "BLOCK_MEMBERSHIP_INVALID"
  | "WINDOW_OVERSIZED"
  | "SOURCE_VERSION_CHANGED"
  | "RUN_VERSION_MISMATCH"
  | "ENCODING_AMBIGUOUS"
  | "RUNNING_AFTER_CRASH"
  | "STORAGE_LOCKED"
  | "STORAGE_CORRUPT"
  | "EXPORT_INCOMPLETE";

export type RecoveryStrategy =
  | "flat_partition_rebuild"
  | "rebuild_affected_span"
  | "rebuild_window_membership"
  | "replan_affected_windows"
  | "split_window_boundaries"
  | "quarantine_old_run"
  | "reset_interrupted_windows"
  | "reset_missing_windows";

export interface RecoveryIntegerParameter {
  readonly type: "integer";
  readonly minimum: number;
  readonly maximum: number;
}

export interface RecoveryParameterPolicy {
  readonly properties: Readonly<Record<string, RecoveryIntegerParameter>>;
}

export interface RecoveryRule {
  readonly deterministic: RecoveryStrategy | null;
  readonly allowed: readonly RecoveryStrategy[];
  readonly maxAttempts: 0 | 1;
  readonly requiredAudits: readonly string[];
  readonly parameterPolicies: Readonly<Partial<Record<RecoveryStrategy, RecoveryParameterPolicy>>>;
  readonly requiresHuman?: boolean;
}

export interface RecoveryRange {
  readonly start: number;
  readonly end: number;
}

export interface RecoveryStructureAnnotation {
  readonly kind: string;
  readonly start: number;
  readonly end: number;
  readonly title?: string;
}

export interface RecoveryIncident {
  readonly incidentId: string;
  readonly code: IncidentCode;
  readonly runId: string;
  readonly stage:
    | "preflight_blocked"
    | "recovery_planning"
    | "recovery_trial"
    | "auditing";
  readonly range: RecoveryRange;
  readonly invariant: string;
  readonly sourceExcerpt: string;
  readonly structureAnnotations: readonly RecoveryStructureAnnotation[];
  readonly attemptedStrategies: readonly RecoveryStrategy[];
  readonly suggestedAction: string;
}

export interface RecoveryAudit {
  readonly ok: boolean;
  readonly checks: Readonly<Record<string, boolean>>;
  readonly incidentCodes: readonly string[];
}

export interface RecoveryShadow {
  readonly recoveryId: string;
  readonly shadowId: string;
  readonly runId: string;
  readonly beforeHash: string;
  readonly strategy: RecoveryStrategy;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface RecoveryTrialResult {
  readonly afterHash: string;
  readonly result: Readonly<Record<string, unknown>>;
}

export interface RecoveryKernel {
  createShadow(
    incident: RecoveryIncident,
    strategy: RecoveryStrategy,
    parameters: Readonly<Record<string, unknown>>,
  ): Promise<RecoveryShadow>;
  applyStrategy(shadow: RecoveryShadow): Promise<RecoveryTrialResult>;
  auditShadow(
    shadow: RecoveryShadow,
    requiredAudits: readonly string[],
  ): Promise<RecoveryAudit>;
  promoteRecovery(shadow: RecoveryShadow): Promise<void>;
  discardRecovery(shadow: RecoveryShadow, reason: string): Promise<void>;
  quarantineRecovery(incident: RecoveryIncident, reason: string): Promise<void>;
}

export interface RecoveryPlanningInput {
  readonly incident: RecoveryIncident;
  readonly rule: RecoveryRule;
}

export interface RecoveryPlanResult {
  readonly terminal: boolean;
  readonly strategy?: RecoveryStrategy;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly modelCalls: number;
  readonly toolNames: readonly string[];
}

export interface RecoveryPlanner {
  plan(input: RecoveryPlanningInput): Promise<RecoveryPlanResult>;
}

export interface RecoveryResult {
  readonly schema: "v5-book-recovery-1";
  readonly incidentCode: IncidentCode;
  readonly runId: string;
  readonly recoveredFromRunId: string;
  readonly replacementRunId: string | null;
  readonly replacementSourceVersion: string | null;
  readonly status: "resumed" | "quarantined";
  readonly strategy: RecoveryStrategy | null;
  readonly attempts: 0 | 1;
  readonly modelCalls: number;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly audit: RecoveryAudit;
  readonly details: Readonly<Record<string, unknown>> | null;
  readonly reason: string | null;
}
