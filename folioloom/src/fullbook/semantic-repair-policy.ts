import { createHash } from "node:crypto";
import type { ValidationFailure } from "../tools/repair-tools.js";

export const MAX_SEMANTIC_REPAIR_PASSES = 2;

export function repairIssueKeys(failures: readonly ValidationFailure[]): string[] {
  return [...new Set(failures.map(f => createHash("sha256").update(JSON.stringify([
    f.code, f.blockId ?? "", f.issueKey ?? f.message.trim().normalize("NFKC"),
  ])).digest("hex")))].sort();
}

/** Only grounded new findings can consume the second, pre-reserved credit. */
export function hasOnlyNovelSemanticIssues(previousKeys: readonly string[], failures: readonly ValidationFailure[]): boolean {
  return previousKeys.length > 0 && failures.length > 0
    && failures.every(f => f.code === "SUPERVISOR_SEMANTIC_REVIEW" && f.repairable && !!f.issueKey)
    && repairIssueKeys(failures).every(key => !previousKeys.includes(key));
}
