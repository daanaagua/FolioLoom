export type BudgetCounter =
  | "modelCalls"
  | "researchTurns"
  | "researchToolCalls"
  | "evidenceChars"
  | "translationTurns"
  | "translationToolCalls"
  | "repairTurns"
  | "recoveryTurns"
  | "recoveryToolCalls";

export const DEFAULT_BUDGET_LIMITS: Readonly<Record<BudgetCounter, number>> = {
  modelCalls: 20,
  researchTurns: 7,
  researchToolCalls: 10,
  evidenceChars: 12_000,
  translationTurns: 10,
  translationToolCalls: 18,
  repairTurns: 3,
  recoveryTurns: 1,
  recoveryToolCalls: 5,
};

export class BudgetExceeded extends Error {
  public constructor(
    public readonly counter: BudgetCounter,
    public readonly limit: number,
    public readonly requestedTotal: number,
  ) {
    super(
      `budget exceeded for ${counter}: requested ${requestedTotal}, limit ${limit}`,
    );
    this.name = "BudgetExceeded";
  }
}

export class BudgetLedger {
  private readonly limits: Record<BudgetCounter, number>;
  private readonly consumed: Record<BudgetCounter, number>;

  public constructor(overrides: Partial<Record<BudgetCounter, number>> = {}) {
    this.limits = { ...DEFAULT_BUDGET_LIMITS, ...overrides };
    this.consumed = Object.fromEntries(
      Object.keys(DEFAULT_BUDGET_LIMITS).map((counter) => [counter, 0]),
    ) as Record<BudgetCounter, number>;

    for (const [counter, limit] of Object.entries(this.limits)) {
      if (!Number.isFinite(limit) || limit < 0) {
        throw new Error(`invalid budget limit for ${counter}: ${limit}`);
      }
    }
  }

  public consume(counter: BudgetCounter, amount: number): void {
    this.consumeMany({ [counter]: amount });
  }

  public consumeMany(
    amounts: Partial<Record<BudgetCounter, number>>,
  ): void {
    const reservations: Array<[BudgetCounter, number]> = [];
    for (const [rawCounter, amount] of Object.entries(amounts)) {
      const counter = rawCounter as BudgetCounter;
      if (!Number.isFinite(amount) || (amount as number) < 0) {
        throw new Error(`invalid budget amount for ${counter}: ${amount}`);
      }
      reservations.push([counter, amount as number]);
    }
    for (const [counter, amount] of reservations) {
      const requestedTotal = this.consumed[counter] + amount;
      if (requestedTotal > this.limits[counter]) {
        throw new BudgetExceeded(counter, this.limits[counter], requestedTotal);
      }
    }
    for (const [counter, amount] of reservations) {
      this.consumed[counter] += amount;
    }
  }

  public remaining(counter: BudgetCounter): number {
    return this.limits[counter] - this.consumed[counter];
  }

  public snapshot(): Readonly<Record<BudgetCounter, number>> {
    return { ...this.consumed };
  }
}
