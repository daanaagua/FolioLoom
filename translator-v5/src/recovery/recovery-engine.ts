import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { planBookWindows, type WindowPlanOptions } from "../fullbook/window-planner.js";
import type { BookWindowPlan } from "../fullbook/types.js";
import { createKnowledgeSnapshot, type KnowledgeSnapshot } from "../knowledge/snapshot.js";
import { auditLosslessBookStore } from "../report.js";
import { auditSourceCoverage } from "../source/auditor.js";
import { buildLosslessBlocks } from "../source/block-builder.js";
import type { LosslessBlock, StructureAnnotation } from "../source/types.js";
import type { CertifiedSourceInput, StoredTranslationRun } from "../storage/lossless-book-store.js";
import { type LosslessAuditState, LosslessBookStore } from "../storage/lossless-book-store.js";
import {
  projectRecoveryRule,
  RECOVERY_RULES,
  validateRecoveryParameters,
} from "./registry.js";
import type {
  IncidentCode,
  RecoveryAudit,
  RecoveryIncident,
  RecoveryKernel,
  RecoveryPlanner,
  RecoveryResult,
  RecoveryRule,
  RecoveryShadow,
  RecoveryStrategy,
} from "./types.js";

interface RecoveryEngineOptions {
  readonly kernel: RecoveryKernel;
  readonly planner?: RecoveryPlanner;
}

interface StoreShadowState {
  readonly state: LosslessAuditState;
  readonly affectedWindowIds: readonly string[];
  readonly protectedHash: string;
  readonly newPlan?: RecoveryPlanShadow;
}

export interface RecoverySourceCandidate {
  readonly sourceText: string;
  readonly certifiedSource: CertifiedSourceInput;
  readonly annotations: readonly StructureAnnotation[];
  readonly rawHashVerified: boolean;
}

interface RecoveryPlanShadow {
  readonly recoveryOfRunId: string;
  readonly source: CertifiedSourceInput;
  readonly annotations: readonly StructureAnnotation[];
  readonly blocks: readonly LosslessBlock[];
  readonly windows: readonly BookWindowPlan[];
  readonly run: StoredTranslationRun;
  readonly initialSnapshot: KnowledgeSnapshot;
  readonly sourceAuditOk: boolean;
  readonly hash: string;
}

interface StoreRecoveryRecord {
  readonly incidentId: string;
  readonly execution: Readonly<Record<string, unknown>>;
  audit?: RecoveryAudit;
}

function stateHash(state: LosslessAuditState): string {
  return createHash("sha256").update(JSON.stringify({
    runId: state.runId,
    sourceVersion: state.sourceVersion,
    canonicalSha256: state.canonicalSha256,
    runStatus: state.runStatus,
    windows: state.windows.map((window) => ({
      windowId: window.windowId,
      ordinal: window.ordinal,
      status: window.status,
      snapshotId: window.snapshotId,
    })),
    memberships: state.memberships,
    translations: state.translations,
    snapshots: state.snapshots,
  }), "utf8").digest("hex");
}

function protectedStateHash(state: LosslessAuditState): string {
  return createHash("sha256").update(JSON.stringify({
    sourceVersion: state.sourceVersion,
    canonicalSha256: state.canonicalSha256,
    canonicalChars: state.canonicalChars,
    completedTranslations: state.translations
      .filter((translation) => translation.active)
      .map((translation) => ({ ...translation })),
  }), "utf8").digest("hex");
}

function cloneAuditState(state: LosslessAuditState): LosslessAuditState {
  return structuredClone(state);
}

function sqliteJson(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

function shadowPlanHash(value: Omit<RecoveryPlanShadow, "hash">): string {
  return createHash("sha256").update(sqliteJson({
    source: value.source,
    annotations: value.annotations,
    blocks: value.blocks,
    windows: value.windows,
    run: value.run,
    initialSnapshot: value.initialSnapshot,
  }), "utf8").digest("hex");
}

export function createStoreRecoveryIncident(
  store: LosslessBookStore,
  runId: string,
  code: IncidentCode,
  attemptedStrategies: readonly RecoveryStrategy[] = [],
): RecoveryIncident {
  const state = store.auditState(runId);
  const sourceExcerpt = state.blocks
    .map((block) => block.sourceText)
    .join("")
    .slice(0, 2_000);
  return {
    incidentId: randomUUID(),
    code,
    runId,
    stage: "preflight_blocked",
    range: { start: 0, end: Math.min(state.canonicalChars, 2_000) },
    invariant: `${code} prevents proof of lossless source or run lineage`,
    sourceExcerpt,
    structureAnnotations: [],
    attemptedStrategies: [...attemptedStrategies],
    suggestedAction: "apply only a registered shadow recovery policy",
  };
}

export function loadAttemptedRecoveryStrategies(
  databasePath: string,
  runId: string,
  code: IncidentCode,
): readonly RecoveryStrategy[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database.prepare(`
      SELECT parameters_json FROM recovery_runs WHERE run_id=? ORDER BY created_at
    `).all(runId) as Array<{ parameters_json: string }>;
    const attempted = rows.some((row) => {
      try {
        const parameters = JSON.parse(row.parameters_json) as { incidentCode?: unknown };
        return parameters.incidentCode === code;
      } catch {
        return false;
      }
    });
    return attempted ? [...RECOVERY_RULES[code].allowed] : [];
  } finally {
    database.close();
  }
}

/**
 * A store adapter whose model-visible surface is only the RecoveryKernel interface.
 * Proposed mutations live in cloned state until the engine accepts every required audit.
 */
export class StoreRecoveryKernel implements RecoveryKernel {
  readonly #shadows = new Map<string, StoreShadowState>();
  readonly #records = new Map<string, StoreRecoveryRecord>();
  readonly #recoveryByIncident = new Map<string, string>();

  constructor(
    private readonly store: LosslessBookStore,
    private readonly databasePath: string,
    private readonly sourceCandidate?: RecoverySourceCandidate,
  ) {}

  async createShadow(
    incident: RecoveryIncident,
    strategy: RecoveryStrategy,
    parameters: Readonly<Record<string, unknown>>,
  ): Promise<RecoveryShadow> {
    const before = this.store.auditState(incident.runId);
    const recoveryId = randomUUID();
    const shadow: RecoveryShadow = {
      recoveryId,
      shadowId: `shadow:${recoveryId}`,
      runId: incident.runId,
      beforeHash: stateHash(before),
      strategy,
      parameters: structuredClone(parameters),
    };
    this.#shadows.set(shadow.shadowId, {
      state: cloneAuditState(before),
      affectedWindowIds: [],
      protectedHash: protectedStateHash(before),
    });
    this.#records.set(recoveryId, { incidentId: incident.incidentId, execution: {} });
    this.#recoveryByIncident.set(incident.incidentId, recoveryId);
    this.#insertRecovery(incident, shadow);
    this.#transition(recoveryId, incident.runId, "recovery_planning", {
      incidentCode: incident.code,
    });
    return shadow;
  }

  async applyStrategy(shadow: RecoveryShadow): Promise<{
    afterHash: string;
    result: Readonly<Record<string, unknown>>;
  }> {
    const current = this.#shadow(shadow);
    const proposed = cloneAuditState(current.state);
    let affectedWindowIds: string[] = [];
    switch (shadow.strategy) {
      case "reset_interrupted_windows": {
        affectedWindowIds = proposed.windows
          .filter((window) => window.status === "running" || window.status === "staged")
          .map((window) => window.windowId);
        const affected = new Set(affectedWindowIds);
        proposed.windows = proposed.windows.map((window) => affected.has(window.windowId)
          ? { ...window, status: "pending", snapshotId: null }
          : window);
        proposed.translations = proposed.translations.filter((translation) =>
          translation.active || !affected.has(translation.windowId));
        break;
      }
      case "reset_missing_windows": {
        const translated = new Set(
          proposed.translations.filter((item) => item.active).map((item) => item.blockId),
        );
        const missing = new Set(
          proposed.blocks.filter((block) => !translated.has(block.blockId))
            .map((block) => block.blockId),
        );
        affectedWindowIds = [...new Set(proposed.memberships
          .filter((membership) => missing.has(membership.blockId))
          .map((membership) => membership.windowId))];
        const affected = new Set(affectedWindowIds);
        proposed.windows = proposed.windows.map((window) => affected.has(window.windowId)
          ? { ...window, status: "pending", snapshotId: null }
          : window);
        break;
      }
      case "quarantine_old_run":
        proposed.runStatus = "quarantined";
        break;
      case "flat_partition_rebuild":
      case "rebuild_affected_span":
      case "rebuild_window_membership":
      case "replan_affected_windows":
      case "split_window_boundaries": {
        const newPlan = this.#buildPlanShadow(shadow);
        const execution = Object.freeze({
          recoveredRunId: newPlan.run.runId,
          recoveredSourceVersion: newPlan.source.sourceVersion,
          blockCount: newPlan.blocks.length,
          windowCount: newPlan.windows.length,
        });
        this.#shadows.set(shadow.shadowId, {
          ...current,
          newPlan,
        });
        this.#records.set(shadow.recoveryId, {
          incidentId: this.#record(shadow.recoveryId).incidentId,
          execution,
        });
        this.#transition(
          shadow.recoveryId,
          shadow.runId,
          "recovery_trial",
          execution,
          newPlan.hash,
        );
        return { afterHash: newPlan.hash, result: execution };
      }
    }
    const execution = Object.freeze({ affectedWindowIds: [...affectedWindowIds] });
    this.#shadows.set(shadow.shadowId, {
      state: proposed,
      affectedWindowIds,
      protectedHash: current.protectedHash,
    });
    this.#records.set(shadow.recoveryId, {
      incidentId: this.#record(shadow.recoveryId).incidentId,
      execution,
    });
    const afterHash = stateHash(proposed);
    this.#transition(shadow.recoveryId, shadow.runId, "recovery_trial", execution, afterHash);
    return { afterHash, result: execution };
  }

  async auditShadow(
    shadow: RecoveryShadow,
    requiredAudits: readonly string[],
  ): Promise<RecoveryAudit> {
    const proposed = this.#shadow(shadow);
    if (proposed.newPlan !== undefined) {
      const plan = proposed.newPlan;
      const sourceOrder = plan.windows.flatMap((window) => window.blockIds);
      const blockOrder = plan.blocks.map((block) => block.id);
      const membershipOk = sourceOrder.length === blockOrder.length
        && sourceOrder.every((blockId, index) => blockId === blockOrder[index]);
      const checks = Object.fromEntries(requiredAudits.map((name) => [name, ({
        source_coverage: plan.sourceAuditOk,
        block_membership: membershipOk,
        window_membership: membershipOk,
        raw_hash: this.sourceCandidate?.rawHashVerified === true
          && plan.source.canonicalSha256 === createHash("sha256")
          .update(this.sourceCandidate?.sourceText ?? "", "utf8").digest("hex"),
        window_budget: plan.windows.every((window) => !window.oversized),
      } as Record<string, boolean>)[name] === true]));
      const audit: RecoveryAudit = {
        ok: requiredAudits.every((name) => checks[name] === true),
        checks,
        incidentCodes: [],
      };
      const record = this.#record(shadow.recoveryId);
      this.#records.set(shadow.recoveryId, { ...record, audit });
      this.#transition(shadow.recoveryId, shadow.runId, "auditing", {
        execution: record.execution,
        audit,
      }, plan.hash);
      return audit;
    }
    const report = auditLosslessBookStore(this.store, shadow.runId);
    const membershipIncidents = new Set([
      "BLOCK_MEMBERSHIP_INVALID", "WINDOW_MEMBERSHIP_INVALID",
    ]);
    const missingBlocks = new Set(report.missingBlockIds);
    const windowsForMissing = new Set(proposed.state.memberships
      .filter((membership) => missingBlocks.has(membership.blockId))
      .map((membership) => membership.windowId));
    const checks: Record<string, boolean> = {
      raw_hash: protectedStateHash(proposed.state) === proposed.protectedHash,
      source_lineage: proposed.state.sourceVersion === this.store.auditState(shadow.runId).sourceVersion,
      run_isolation: proposed.state.runStatus === "quarantined",
      run_lineage: !report.incidentCodes.includes("RUN_LINEAGE_INVALID"),
      run_state: proposed.state.windows.every((window) =>
        window.status !== "running" && window.status !== "staged"),
      staged_rows_absent: proposed.state.translations.every((translation) =>
        translation.active || !proposed.affectedWindowIds.includes(translation.windowId)),
      completed_translations_unchanged:
        protectedStateHash(proposed.state) === proposed.protectedHash,
      block_membership: report.incidentCodes.every((code) => !membershipIncidents.has(code)),
      missing_windows_pending: proposed.state.windows
        .filter((window) => windowsForMissing.has(window.windowId))
        .every((window) => window.status === "pending"),
    };
    const audit: RecoveryAudit = {
      ok: requiredAudits.every((name) => checks[name] === true),
      checks: Object.fromEntries(requiredAudits.map((name) => [name, checks[name] === true])),
      incidentCodes: report.incidentCodes,
    };
    const record = this.#record(shadow.recoveryId);
    this.#records.set(shadow.recoveryId, { ...record, audit });
    this.#transition(shadow.recoveryId, shadow.runId, "auditing", {
      execution: record.execution,
      audit,
    }, stateHash(proposed.state));
    return audit;
  }

  async promoteRecovery(shadow: RecoveryShadow): Promise<void> {
    const proposed = this.#shadow(shadow);
    if (proposed.newPlan !== undefined) {
      const record = this.#record(shadow.recoveryId);
      this.#promotePlan(proposed.newPlan, shadow.recoveryId, shadow.beforeHash, {
        execution: record.execution,
        audit: record.audit,
      });
      this.#shadows.delete(shadow.shadowId);
      return;
    }
    const expectedHash = stateHash(proposed.state);
    if (shadow.strategy === "reset_interrupted_windows"
      || shadow.strategy === "reset_missing_windows"
      || shadow.strategy === "quarantine_old_run") {
      this.store.promoteRecoveryMutation({
        recoveryId: shadow.recoveryId,
        runId: shadow.runId,
        kind: shadow.strategy,
        affectedWindowIds: proposed.affectedWindowIds,
        expectedBeforeHash: shadow.beforeHash,
        expectedAfterHash: expectedHash,
        result: {
          execution: this.#record(shadow.recoveryId).execution,
          audit: this.#record(shadow.recoveryId).audit,
        },
      });
    } else {
      throw new Error(`store promotion is unavailable for ${shadow.strategy}`);
    }
    this.#shadows.delete(shadow.shadowId);
  }

  async discardRecovery(shadow: RecoveryShadow, reason: string): Promise<void> {
    this.#shadows.delete(shadow.shadowId);
    const record = this.#record(shadow.recoveryId);
    this.#transition(shadow.recoveryId, shadow.runId, "quarantined", {
      execution: record.execution,
      audit: record.audit,
      reason,
    });
  }

  async quarantineRecovery(incident: RecoveryIncident, reason: string): Promise<void> {
    const existingId = this.#recoveryByIncident.get(incident.incidentId);
    const state = this.store.auditState(incident.runId);
    const recoveryId = existingId ?? randomUUID();
    const record = existingId === undefined ? undefined : this.#record(existingId);
    const database = new DatabaseSync(this.databasePath);
    try {
      database.exec("BEGIN IMMEDIATE");
      database.prepare(`
        UPDATE translation_runs SET status='quarantined' WHERE run_id=?
      `).run(incident.runId);
      if (existingId === undefined) {
        database.prepare(`
          INSERT INTO recovery_runs(
            recovery_id, run_id, state, before_hash, after_hash, strategy,
            parameters_json, result_json
          ) VALUES(?, ?, 'quarantined', ?, NULL, 'none', ?, ?)
        `).run(
          recoveryId,
          incident.runId,
          stateHash(state),
          sqliteJson({ incidentCode: incident.code, attempted: incident.attemptedStrategies }),
          sqliteJson({ reason }),
        );
      } else {
        database.prepare(`
          UPDATE recovery_runs SET state='quarantined', result_json=?
          WHERE recovery_id=? AND run_id=?
        `).run(sqliteJson({
          execution: record?.execution,
          audit: record?.audit,
          reason,
        }), recoveryId, incident.runId);
      }
      database.prepare(`
        INSERT INTO events(run_id, kind, payload_json) VALUES(?, ?, ?)
      `).run(incident.runId, "recovery_quarantined", sqliteJson({
        recoveryId,
        incidentCode: incident.code,
        reason,
      }));
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {}
      throw error;
    } finally {
      database.close();
    }
  }

  #shadow(shadow: RecoveryShadow): StoreShadowState {
    const found = this.#shadows.get(shadow.shadowId);
    if (found === undefined) {
      throw new Error(`unknown recovery shadow ${shadow.shadowId}`);
    }
    return found;
  }

  #record(recoveryId: string): StoreRecoveryRecord {
    const found = this.#records.get(recoveryId);
    if (found === undefined) {
      throw new Error(`unknown recovery record ${recoveryId}`);
    }
    return found;
  }

  #buildPlanShadow(shadow: RecoveryShadow): RecoveryPlanShadow {
    const candidate = this.sourceCandidate;
    if (candidate === undefined) {
      throw new Error(`${shadow.strategy} requires --manifest for certified source recovery`);
    }
    const oldState = this.store.auditState(shadow.runId);
    if (candidate.certifiedSource.sourceVersion !== oldState.sourceVersion
      || candidate.certifiedSource.canonicalSha256 !== oldState.canonicalSha256) {
      throw new Error("recovery manifest does not certify the blocked run source version");
    }
    const planSeed = createHash("sha256").update(sqliteJson({
      recoveryId: shadow.recoveryId,
      strategy: shadow.strategy,
      parameters: shadow.parameters,
      canonicalSha256: candidate.certifiedSource.canonicalSha256,
    }), "utf8").digest("hex").slice(0, 24);
    const sourceVersion = `${oldState.sourceVersion}:recovery:${planSeed}`;
    const annotations = shadow.strategy === "flat_partition_rebuild"
      || shadow.strategy === "rebuild_affected_span"
      ? []
      : candidate.annotations.map((annotation) => ({ ...annotation }));
    const blockOptions = shadow.strategy === "split_window_boundaries"
      ? { sourceVersion, maxSourceTokens: 1_000 }
      : { sourceVersion };
    const blocks = buildLosslessBlocks(candidate.sourceText, annotations, blockOptions);
    const sourceAudit = auditSourceCoverage(candidate.sourceText, blocks, { sourceVersion });
    const oldRun = this.store.listTranslationRuns().find((run) => run.runId === shadow.runId);
    if (oldRun === undefined) {
      throw new Error(`unknown blocked run ${shadow.runId}`);
    }
    const recoveredRunId = `recovery-run-${planSeed}`;
    const windowOptions: WindowPlanOptions = {
      protocolVersion: oldRun.protocolVersion,
      ...(shadow.strategy === "replan_affected_windows"
        ? { maxBlocks: Number(shadow.parameters.maxWindowBlocks) }
        : {}),
    };
    const windows = planBookWindows(blocks, windowOptions);
    const run: StoredTranslationRun = {
      runId: recoveredRunId,
      sourceVersion,
      protocolVersion: oldRun.protocolVersion,
      modelId: oldRun.modelId,
      status: "running",
      metadata: {
        ...(oldRun.metadata !== null && typeof oldRun.metadata === "object"
          && !Array.isArray(oldRun.metadata) ? oldRun.metadata : {}),
        recoveryOfRunId: oldRun.runId,
        recoveryStrategy: shadow.strategy,
      },
    };
    const initialSnapshot = createKnowledgeSnapshot(recoveredRunId, []);
    const source: CertifiedSourceInput = {
      ...candidate.certifiedSource,
      sourceVersion,
      ranges: candidate.certifiedSource.ranges.map((range) => ({ ...range })),
    };
    const withoutHash = {
      recoveryOfRunId: oldRun.runId,
      source,
      annotations,
      blocks,
      windows,
      run,
      initialSnapshot,
      sourceAuditOk: sourceAudit.ok,
    };
    return { ...withoutHash, hash: shadowPlanHash(withoutHash) };
  }

  #promotePlan(
    plan: RecoveryPlanShadow,
    recoveryId: string,
    expectedBeforeHash: string,
    result: unknown,
  ): void {
    const database = new DatabaseSync(this.databasePath);
    try {
      database.exec("BEGIN IMMEDIATE");
      if (this.store.recoveryProjectionHash(plan.recoveryOfRunId) !== expectedBeforeHash) {
        throw new Error("recovery promotion precondition changed after shadow audit");
      }
      const sourcePayload = sqliteJson(plan.source);
      const sourceFingerprint = createHash("sha256")
        .update(sourcePayload, "utf8").digest("hex");
      const planFingerprint = createHash("sha256").update(sqliteJson({
        annotations: plan.annotations,
        blocks: plan.blocks,
      }), "utf8").digest("hex");
      database.prepare(`
        INSERT INTO source_versions(
          source_version, raw_sha256, canonical_sha256, canonical_chars,
          coordinate_unit, source_format, encoding, extractor,
          source_fingerprint, plan_fingerprint, source_payload_json
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        plan.source.sourceVersion,
        plan.source.rawSha256,
        plan.source.canonicalSha256,
        plan.source.canonicalChars,
        plan.source.coordinateUnit,
        plan.source.sourceFormat,
        plan.source.encoding,
        plan.source.extractor,
        sourceFingerprint,
        planFingerprint,
        sourcePayload,
      );
      const insertRange = database.prepare(`
        INSERT INTO source_ranges(
          source_version, range_id, canonical_start, canonical_end,
          origin_kind, origin_ref, transformation, raw_start, raw_end
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const range of plan.source.ranges) {
        insertRange.run(
          plan.source.sourceVersion,
          range.rangeId,
          range.canonicalStart,
          range.canonicalEnd,
          range.originKind,
          range.originRef,
          range.transformation,
          range.rawStart ?? null,
          range.rawEnd ?? null,
        );
      }
      const insertAnnotation = database.prepare(`
        INSERT INTO structure_annotations(
          source_version, annotation_id, kind, canonical_start, canonical_end,
          title, boundary_weight
        ) VALUES(?, ?, ?, ?, ?, ?, ?)
      `);
      for (const annotation of plan.annotations) {
        insertAnnotation.run(
          plan.source.sourceVersion,
          annotation.id,
          annotation.kind,
          annotation.start,
          annotation.end,
          annotation.title,
          annotation.boundaryWeight,
        );
      }
      const insertBlock = database.prepare(`
        INSERT INTO logical_blocks(
          source_version, block_id, canonical_start, canonical_end, source_text,
          source_hash, global_index, token_count, structure_id, structure_title
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const block of plan.blocks) {
        insertBlock.run(
          plan.source.sourceVersion,
          block.id,
          block.canonicalStart,
          block.canonicalEnd,
          block.sourceText,
          block.sourceHash,
          block.globalIndex,
          block.tokenCount,
          block.structureId,
          block.structureTitle,
        );
      }
      database.prepare(`
        INSERT INTO translation_runs(
          run_id, source_version, protocol_version, model_id, metadata_json, status
        ) VALUES(?, ?, ?, ?, ?, 'running')
      `).run(
        plan.run.runId,
        plan.run.sourceVersion,
        plan.run.protocolVersion,
        plan.run.modelId,
        sqliteJson(plan.run.metadata),
      );
      database.prepare(`
        UPDATE translation_runs SET status='quarantined' WHERE run_id=?
      `).run(plan.recoveryOfRunId);
      database.prepare(`
        INSERT INTO knowledge_snapshots(
          run_id, snapshot_id, content_hash, payload_json
        ) VALUES(?, ?, ?, ?)
      `).run(
        plan.run.runId,
        plan.initialSnapshot.id,
        plan.initialSnapshot.contentHash,
        sqliteJson(plan.initialSnapshot),
      );
      const insertWindow = database.prepare(`
        INSERT INTO window_plans(
          run_id, window_id, source_version, ordinal, chapter_id, chapter_title,
          source_tokens, source_chars, oversized
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertMembership = database.prepare(`
        INSERT INTO window_membership(
          run_id, window_id, source_version, block_id, position
        ) VALUES(?, ?, ?, ?, ?)
      `);
      for (const window of plan.windows) {
        insertWindow.run(
          plan.run.runId,
          window.windowId,
          plan.source.sourceVersion,
          window.ordinal,
          window.chapterId,
          window.chapterTitle,
          window.sourceTokens,
          window.sourceChars,
          window.oversized ? 1 : 0,
        );
        for (let position = 0; position < window.blockIds.length; position += 1) {
          insertMembership.run(
            plan.run.runId,
            window.windowId,
            plan.source.sourceVersion,
            window.blockIds[position],
            position,
          );
        }
      }
      const counts = database.prepare(`
        SELECT
          (SELECT COUNT(*) FROM logical_blocks WHERE source_version=?) AS blocks,
          (SELECT COUNT(*) FROM window_plans WHERE run_id=?) AS windows,
          (SELECT COUNT(*) FROM window_membership WHERE run_id=?) AS memberships
      `).get(
        plan.source.sourceVersion,
        plan.run.runId,
        plan.run.runId,
      ) as { blocks: number; windows: number; memberships: number };
      if (Number(counts.blocks) !== plan.blocks.length
        || Number(counts.windows) !== plan.windows.length
        || Number(counts.memberships) !== plan.blocks.length) {
        throw new Error("promoted recovery plan row counts differ from audited shadow");
      }
      const recovery = database.prepare(`
        UPDATE recovery_runs
        SET state='resumed', after_hash=?, result_json=?
        WHERE recovery_id=? AND run_id=? AND state='auditing'
      `).run(plan.hash, sqliteJson(result), recoveryId, plan.recoveryOfRunId);
      if (Number(recovery.changes) !== 1) {
        throw new Error("recovery state changed before atomic plan promotion");
      }
      database.prepare(`
        INSERT INTO events(run_id, kind, payload_json) VALUES(?, ?, ?)
      `).run(plan.run.runId, "recovery_plan_promoted", sqliteJson({
        recoveryId,
        sourceVersion: plan.source.sourceVersion,
        shadowHash: plan.hash,
      }));
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {}
      throw error;
    } finally {
      database.close();
    }
  }

  #insertRecovery(incident: RecoveryIncident, shadow: RecoveryShadow): void {
    const database = new DatabaseSync(this.databasePath);
    try {
      database.exec("BEGIN IMMEDIATE");
      database.prepare(`
        INSERT INTO recovery_runs(
          recovery_id, run_id, state, before_hash, after_hash, strategy,
          parameters_json, result_json
        ) VALUES(?, ?, 'preflight_blocked', ?, NULL, ?, ?, NULL)
      `).run(
        shadow.recoveryId,
        shadow.runId,
        shadow.beforeHash,
        shadow.strategy,
        sqliteJson({
          incidentCode: incident.code,
          range: incident.range,
          attempted: incident.attemptedStrategies,
          strategyParameters: shadow.parameters,
        }),
      );
      database.prepare(`
        INSERT INTO events(run_id, kind, payload_json) VALUES(?, ?, ?)
      `).run(shadow.runId, "recovery_state_changed", sqliteJson({
        recoveryId: shadow.recoveryId,
        state: "preflight_blocked",
      }));
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {}
      throw error;
    } finally {
      database.close();
    }
  }

  #transition(
    recoveryId: string,
    runId: string,
    state: string,
    result: unknown,
    afterHash?: string,
  ): void {
    const database = new DatabaseSync(this.databasePath);
    try {
      database.exec("BEGIN IMMEDIATE");
      database.prepare(`
        UPDATE recovery_runs SET state=?, after_hash=COALESCE(?, after_hash), result_json=?
        WHERE recovery_id=?
      `).run(state, afterHash ?? null, sqliteJson(result), recoveryId);
      database.prepare(`
        INSERT INTO events(run_id, kind, payload_json) VALUES(?, ?, ?)
      `).run(runId, "recovery_state_changed", sqliteJson({ recoveryId, state }));
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {}
      throw error;
    } finally {
      database.close();
    }
  }

}

function failedAudit(rule: RecoveryRule): RecoveryAudit {
  return {
    ok: false,
    checks: Object.fromEntries(rule.requiredAudits.map((name) => [name, false])),
    incidentCodes: [],
  };
}

function auditPassed(audit: RecoveryAudit, rule: RecoveryRule): boolean {
  return audit.ok && rule.requiredAudits.every((name) => audit.checks[name] === true);
}

function quarantined(
  incident: RecoveryIncident,
  rule: RecoveryRule,
  options: {
    strategy?: RecoveryStrategy | null;
    attempts?: 0 | 1;
    modelCalls?: number;
    beforeHash?: string | null;
    afterHash?: string | null;
    audit?: RecoveryAudit;
    details?: Readonly<Record<string, unknown>> | null;
    reason: string;
  },
): RecoveryResult {
  return {
    schema: "v5-book-recovery-1",
    incidentCode: incident.code,
    runId: incident.runId,
    recoveredFromRunId: incident.runId,
    replacementRunId: null,
    replacementSourceVersion: null,
    status: "quarantined",
    strategy: options.strategy ?? null,
    attempts: options.attempts ?? 0,
    modelCalls: options.modelCalls ?? 0,
    beforeHash: options.beforeHash ?? null,
    afterHash: options.afterHash ?? null,
    audit: options.audit ?? failedAudit(rule),
    details: options.details ?? null,
    reason: options.reason,
  };
}

export class RecoveryEngine {
  readonly #kernel: RecoveryKernel;
  readonly #planner?: RecoveryPlanner;

  constructor(options: RecoveryEngineOptions) {
    this.#kernel = options.kernel;
    this.#planner = options.planner;
  }

  async recover(incident: RecoveryIncident): Promise<RecoveryResult> {
    const rule = projectRecoveryRule(incident.code, incident.attemptedStrategies);
    if (rule.deterministic !== null) {
      return this.#trial(incident, rule, rule.deterministic, {}, 0);
    }
    if (rule.allowed.length === 0 || rule.maxAttempts === 0) {
      const reason = rule.requiresHuman === true
        ? "human_certification_required"
        : "no_untried_recovery_strategy";
      await this.#kernel.quarantineRecovery(incident, reason);
      return quarantined(incident, rule, { reason });
    }
    if (this.#planner === undefined) {
      const reason = "recovery_pi_unavailable";
      await this.#kernel.quarantineRecovery(incident, reason);
      return quarantined(incident, rule, { reason });
    }

    let plan;
    try {
      plan = await this.#planner.plan({ incident, rule });
    } catch (error) {
      const reason = error instanceof Error
        ? `recovery_pi_failed:${error.message}`
        : `recovery_pi_failed:${String(error)}`;
      await this.#kernel.quarantineRecovery(incident, reason);
      return quarantined(incident, rule, {
        attempts: 1,
        modelCalls: 1,
        reason,
      });
    }
    if (plan.modelCalls > 1) {
      const reason = "recovery_pi_call_limit_exceeded";
      await this.#kernel.quarantineRecovery(incident, reason);
      return quarantined(incident, rule, {
        attempts: 1,
        modelCalls: plan.modelCalls,
        reason,
      });
    }
    if (!plan.terminal || plan.strategy === undefined) {
      const reason = "recovery_pi_non_terminating_response";
      await this.#kernel.quarantineRecovery(incident, reason);
      return quarantined(incident, rule, {
        attempts: 1,
        modelCalls: plan.modelCalls,
        reason,
      });
    }
    if (!rule.allowed.includes(plan.strategy)) {
      const reason = "recovery_pi_strategy_not_allowed";
      await this.#kernel.quarantineRecovery(incident, reason);
      return quarantined(incident, rule, {
        strategy: plan.strategy,
        attempts: 1,
        modelCalls: plan.modelCalls,
        reason,
      });
    }
    let validatedParameters: Readonly<Record<string, unknown>>;
    try {
      validatedParameters = validateRecoveryParameters(rule, plan.strategy, plan.parameters);
    } catch (error) {
      const reason = error instanceof Error
        ? `recovery_pi_parameters_invalid:${error.message}`
        : `recovery_pi_parameters_invalid:${String(error)}`;
      await this.#kernel.quarantineRecovery(incident, reason);
      return quarantined(incident, rule, {
        strategy: plan.strategy,
        attempts: 1,
        modelCalls: plan.modelCalls,
        reason,
      });
    }
    return this.#trial(
      incident,
      rule,
      plan.strategy,
      validatedParameters,
      plan.modelCalls,
    );
  }

  async #trial(
    incident: RecoveryIncident,
    rule: RecoveryRule,
    strategy: RecoveryStrategy,
    parameters: Readonly<Record<string, unknown>>,
    modelCalls: number,
  ): Promise<RecoveryResult> {
    let shadow: RecoveryShadow;
    try {
      shadow = await this.#kernel.createShadow(
        incident,
        strategy,
        structuredClone(parameters),
      );
    } catch (error) {
      const reason = error instanceof Error
        ? `recovery_shadow_failed:${error.message}`
        : `recovery_shadow_failed:${String(error)}`;
      await this.#kernel.quarantineRecovery(incident, reason);
      return quarantined(incident, rule, {
        strategy,
        attempts: 1,
        modelCalls,
        reason,
      });
    }
    let trialAfterHash: string | null = null;
    try {
      const trial = await this.#kernel.applyStrategy(shadow);
      trialAfterHash = trial.afterHash;
      const audit = await this.#kernel.auditShadow(shadow, rule.requiredAudits);
      if (!auditPassed(audit, rule)) {
        const reason = "shadow_audit_failed";
        await this.#kernel.discardRecovery(shadow, reason);
        await this.#kernel.quarantineRecovery(incident, reason);
        return quarantined(incident, rule, {
          strategy,
          attempts: 1,
          modelCalls,
          beforeHash: shadow.beforeHash,
          afterHash: trial.afterHash,
          audit,
          details: trial.result,
          reason,
        });
      }
      await this.#kernel.promoteRecovery(shadow);
      return {
        schema: "v5-book-recovery-1",
        incidentCode: incident.code,
        runId: typeof trial.result.recoveredRunId === "string"
          ? trial.result.recoveredRunId
          : incident.runId,
        recoveredFromRunId: incident.runId,
        replacementRunId: typeof trial.result.recoveredRunId === "string"
          ? trial.result.recoveredRunId
          : null,
        replacementSourceVersion: typeof trial.result.recoveredSourceVersion === "string"
          ? trial.result.recoveredSourceVersion
          : null,
        status: "resumed",
        strategy,
        attempts: 1,
        modelCalls,
        beforeHash: shadow.beforeHash,
        afterHash: trial.afterHash,
        audit,
        details: trial.result,
        reason: null,
      };
    } catch (error) {
      const reason = error instanceof Error
        ? `recovery_trial_failed:${error.message}`
        : `recovery_trial_failed:${String(error)}`;
      await this.#kernel.discardRecovery(shadow, reason);
      await this.#kernel.quarantineRecovery(incident, reason);
      return quarantined(incident, rule, {
        strategy,
        attempts: 1,
        modelCalls,
        beforeHash: shadow.beforeHash,
        afterHash: trialAfterHash,
        details: null,
        reason,
      });
    }
  }
}
