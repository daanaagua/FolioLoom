import { directHash, mergeDirectNames, type DirectName, type DirectRecord } from "./direct-translation.js";

/** Durable generation barrier. One immutable naming plan governs all repairs in a wave. */
export class DirectNameWave {
  readonly windowIds: readonly string[];
  readonly baseNames: readonly DirectName[];
  private readonly decision: Promise<DirectName[]>;
  private resolve!: (names: DirectName[]) => void;
  private reject!: (error: unknown) => void;
  private failed = false;

  constructor(readonly record: DirectRecord, private readonly records: readonly DirectRecord[],
    private readonly append: (record: DirectRecord) => void) {
    this.windowIds = [...record.payload.windowIds as string[]];
    this.baseNames = structuredClone(record.payload.names as DirectName[]);
    this.decision = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    void this.decision.catch(() => {}); // A failure may precede a peer reaching the barrier.
    this.decide();
  }

  collect(windowId: string, names: readonly DirectName[]): Promise<DirectName[]> {
    if (!this.windowIds.includes(windowId)) throw new Error("window outside naming wave");
    const key = directHash([this.record.key, windowId, "draft"]);
    if (!this.records.some(r => r.id === `name_draft:${key}`)) this.append({ id: `name_draft:${key}`, kind: "name_draft",
      key, windowId, at: Date.now(), payload: { waveKey: this.record.key, names } });
    this.decide();
    return this.decision;
  }

  fail(error: unknown): void { this.failed = true; this.reject(error); }

  private decide(): void {
    if (this.failed) return;
    const saved = this.records.find(r => r.kind === "name_plan" && r.payload.waveKey === this.record.key);
    if (saved) { this.resolve(saved.payload.names as DirectName[]); return; }
    const drafts = this.windowIds.map(id => this.records.find(r => r.kind === "name_draft" && r.windowId === id && r.payload.waveKey === this.record.key));
    if (drafts.some(d => !d)) return;
    const names = mergeDirectNames(this.baseNames, drafts.flatMap(d => d!.payload.names as DirectName[]));
    const key = directHash([this.record.key, "plan"]);
    this.append({ id: `name_plan:${key}`, kind: "name_plan", key, windowId: this.windowIds[0]!, at: Date.now(), payload: { waveKey: this.record.key, names } });
    this.resolve(names);
  }
}
