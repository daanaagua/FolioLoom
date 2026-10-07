import type { BudgetLedger } from "../kernel/budget.js";

/** Query exhaustion is a bounded result, not a failure of the final decision. */
export class SupervisorEvidenceBudget {
  #characterCapacityReached = false;
  constructor(private readonly budget: BudgetLedger) {}

  get closed(): boolean {
    return this.#characterCapacityReached || this.budget.remaining("evidenceChars") === 0
      || this.budget.remaining("supervisionToolCalls") <= 1;
  }

  begin(finalTurn: boolean): boolean {
    // Preserve the last tool credit even for already-queued query calls. Calls
    // within the query allowance can receive a closed result without evidence.
    if (finalTurn || this.budget.remaining("supervisionToolCalls") <= 1)
      throw new Error("Evidence queries are closed; the final decision retains the final tool credit.");
    this.budget.consume("supervisionToolCalls", 1);
    return !this.#characterCapacityReached && this.budget.remaining("evidenceChars") > 0;
  }

  /** Keep an ordered prefix of whole evidence units; never rewrite their IDs/text. */
  select<T>(units: readonly T[], size: (unit: T) => number): { units: T[]; truncated: boolean } {
    const selected: T[] = [];
    const remaining = this.budget.remaining("evidenceChars");
    let used = 0;
    for (const unit of units) {
      const cost = size(unit);
      if (!Number.isSafeInteger(cost) || cost < 0) throw new Error("invalid evidence unit size");
      if (used + cost > remaining) break;
      selected.push(unit); used += cost;
    }
    this.budget.consume("evidenceChars", used);
    const truncated = selected.length !== units.length;
    if (truncated) this.#characterCapacityReached = true;
    return { units: selected, truncated };
  }

  result<T extends object>(data: T, truncated: boolean) {
    return { ...data, truncated, evidenceBudget: {
      remainingChars: this.budget.remaining("evidenceChars"),
      remainingQueryCalls: this.closed ? 0 : Math.max(0, this.budget.remaining("supervisionToolCalls") - 1),
      queryState: this.closed ? "closed" : "open",
    }, ...(this.closed ? {
      instruction: "检索额度已耗尽或不足以容纳完整证据；空结果或截断不代表没有相关内容。查询现在关闭；根据已有证据提交最终决定，证据不足保留unresolved或pause，不默认通过。",
    } : {}) };
  }
}
