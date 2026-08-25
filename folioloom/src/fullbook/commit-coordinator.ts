import {
  canonicalClone,
  deepFreeze,
  KnowledgeStore,
  type KnowledgeCandidate,
  type KnowledgeRevision,
} from "../knowledge/knowledge-store.js";
import {
  createKnowledgeSnapshot,
  type KnowledgeSnapshot,
} from "../knowledge/snapshot.js";

export interface WindowKnowledgeBinding {
  readonly ordinal: number;
  readonly windowId: string;
  readonly snapshot: KnowledgeSnapshot;
}

export interface StagedKnowledgeWindow {
  readonly runId: string;
  readonly windowId: string;
  readonly ordinal: number;
  readonly snapshotId: string;
  readonly candidates: readonly KnowledgeCandidate[];
}

export interface CommitPromotion {
  readonly runId: string;
  readonly windowId: string;
  readonly ordinal: number;
  readonly snapshotId: string;
  readonly candidates: readonly KnowledgeCandidate[];
  readonly appendedRevisions: readonly KnowledgeRevision[];
  readonly nextSnapshot: KnowledgeSnapshot;
}

export interface CommitCoordinatorHooks {
  /** Persist the whole promotion atomically in the existing book ledger. */
  commitPromotion(
    promotion: CommitPromotion,
  ): void | "promoted" | "retry_latest_snapshot";
}

interface BoundWindow {
  readonly ordinal: number;
  readonly windowId: string;
  snapshotId: string;
  staged?: StagedKnowledgeWindow;
  promoted: boolean;
}

function requireIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be nonempty`);
  }
  return value;
}

function requireOrdinal(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("ordinal must be a non-negative safe integer");
  }
  return value;
}

export class CommitCoordinator {
  readonly runId: string;
  readonly knowledge: KnowledgeStore;
  readonly #hooks: CommitCoordinatorHooks | undefined;
  readonly #windowsByOrdinal = new Map<number, BoundWindow>();
  readonly #windowIds = new Set<string>();
  readonly #snapshots = new Map<string, KnowledgeSnapshot>();
  readonly #retryWindowIds = new Set<string>();
  #currentSnapshot: KnowledgeSnapshot;
  #nextOrdinal = 0;

  constructor(
    runId: string,
    knowledge: KnowledgeStore = new KnowledgeStore(),
    hooks?: CommitCoordinatorHooks,
    initialSnapshot?: KnowledgeSnapshot,
  ) {
    this.runId = requireIdentifier(runId, "runId");
    this.knowledge = knowledge;
    this.#hooks = hooks;
    const rebuilt = createKnowledgeSnapshot(
      this.runId,
      this.knowledge.projectableRevisions(),
      initialSnapshot?.parentSnapshotId ?? null,
    );
    if (initialSnapshot !== undefined) {
      if (initialSnapshot.runId !== this.runId) {
        throw new Error(`snapshot ${initialSnapshot.id} belongs to another run`);
      }
      if (rebuilt.id !== initialSnapshot.id) {
        throw new Error(`snapshot ${initialSnapshot.id} does not match knowledge state`);
      }
    }
    this.#currentSnapshot = initialSnapshot ?? rebuilt;
    this.#snapshots.set(this.#currentSnapshot.id, this.#currentSnapshot);
  }

  snapshotForNextWave(): KnowledgeSnapshot {
    return this.#currentSnapshot;
  }

  snapshot(snapshotId: string): KnowledgeSnapshot | undefined {
    return this.#snapshots.get(snapshotId);
  }

  bindWindow(input: WindowKnowledgeBinding): void {
    const ordinal = requireOrdinal(input.ordinal);
    const windowId = requireIdentifier(input.windowId, "windowId");
    if (ordinal !== this.#windowsByOrdinal.size) {
      throw new Error(
        `windows require a continuous ordinal: expected ${this.#windowsByOrdinal.size}, got ${ordinal}`,
      );
    }
    if (this.#windowIds.has(windowId)) {
      throw new Error(`duplicate windowId: ${windowId}`);
    }
    if (input.snapshot.runId !== this.runId) {
      throw new Error(`snapshot ${input.snapshot.id} belongs to another run`);
    }
    if (!this.#snapshots.has(input.snapshot.id)) {
      throw new Error(`unknown snapshot: ${input.snapshot.id}`);
    }
    this.#windowsByOrdinal.set(ordinal, {
      ordinal,
      windowId,
      snapshotId: input.snapshot.id,
      promoted: false,
    });
    this.#windowIds.add(windowId);
  }

  stage(input: StagedKnowledgeWindow): void {
    if (input.runId !== this.runId) {
      throw new Error(`run mismatch: expected ${this.runId}, got ${input.runId}`);
    }
    const windowId = requireIdentifier(input.windowId, "windowId");
    const ordinal = requireOrdinal(input.ordinal);
    const snapshotId = requireIdentifier(input.snapshotId, "snapshotId");
    if (!this.#snapshots.has(snapshotId)) {
      throw new Error(`unknown snapshot: ${snapshotId}`);
    }
    const bound = this.#windowsByOrdinal.get(ordinal);
    if (bound === undefined) {
      throw new Error(`unknown window ordinal: ${ordinal}`);
    }
    if (bound.windowId !== windowId) {
      throw new Error(
        `window identity mismatch at ordinal ${ordinal}: expected ${bound.windowId}, got ${windowId}`,
      );
    }
    if (bound.ordinal !== ordinal) {
      throw new Error(`ordinal mismatch for ${windowId}`);
    }
    if (bound.snapshotId !== snapshotId) {
      throw new Error(
        `snapshot mismatch for ${windowId}: expected ${bound.snapshotId}, got ${snapshotId}`,
      );
    }
    if (bound.promoted) {
      throw new Error(`window already promoted: ${windowId}`);
    }
    if (bound.staged !== undefined) {
      throw new Error(`window already staged: ${windowId}`);
    }
    const candidates = input.candidates.map((candidate) => canonicalClone(candidate));
    // Validate before staging so persistence cannot succeed before a domain error.
    this.knowledge.fork().reconcileCandidates(candidates, windowId);
    bound.staged = deepFreeze({
      runId: this.runId,
      windowId,
      ordinal,
      snapshotId,
      candidates,
    });
  }

  promoteReady(): string[] {
    const promoted: string[] = [];
    while (true) {
      const bound = this.#windowsByOrdinal.get(this.#nextOrdinal);
      if (bound === undefined || bound.staged === undefined || bound.promoted) {
        break;
      }
      const staged = bound.staged;
      const nextKnowledge = this.knowledge.fork();
      const appendedRevisions = nextKnowledge.reconcileCandidates(
        staged.candidates,
        staged.windowId,
      );
      const nextSnapshot = createKnowledgeSnapshot(
        this.runId,
        nextKnowledge.projectableRevisions(),
        this.#currentSnapshot.id,
      );
      const promotion = deepFreeze<CommitPromotion>({
        runId: this.runId,
        windowId: staged.windowId,
        ordinal: staged.ordinal,
        snapshotId: staged.snapshotId,
        candidates: staged.candidates,
        appendedRevisions,
        nextSnapshot,
      });

      // The hook is the transaction boundary. Failure leaves domain state staged.
      const outcome = this.#hooks?.commitPromotion(promotion);
      if (outcome === "retry_latest_snapshot") {
        bound.staged = undefined;
        bound.snapshotId = this.#currentSnapshot.id;
        this.#retryWindowIds.add(bound.windowId);
        break;
      }
      this.knowledge.replaceWith(nextKnowledge);
      this.#snapshots.set(nextSnapshot.id, nextSnapshot);
      this.#currentSnapshot = nextSnapshot;
      bound.promoted = true;
      promoted.push(bound.windowId);
      this.#nextOrdinal += 1;
    }
    return promoted;
  }

  takeRetryWindowIds(): string[] {
    const retryWindowIds = [...this.#retryWindowIds];
    this.#retryWindowIds.clear();
    return retryWindowIds;
  }

  activeKnowledge(
    normalizedSubject: string,
    kind: string,
  ): KnowledgeRevision | undefined {
    return this.knowledge.activeKnowledge(normalizedSubject, kind);
  }
}
