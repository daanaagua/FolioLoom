import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { StableTerm, V4Block } from "../domain/types.js";
import { EvidenceIndex } from "../index/evidence-index.js";
import { getSourceLanguageProfile } from "../language/profiles.js";
import type { SourceLanguageProfile } from "../language/types.js";
import { auditSourceCoverage } from "../source/auditor.js";
import { buildLosslessBlocks } from "../source/block-builder.js";
import { SourceLedger } from "../source/source-ledger.js";
import { annotateStructure } from "../source/structure-annotator.js";
import type { LosslessBlock, StructureAnnotation } from "../source/types.js";
import type { CertifiedSourceInput } from "../storage/lossless-book-store.js";
import { V4ReadAdapter } from "../storage/v4-read-adapter.js";

export interface OpenLosslessBookContextOptions {
  manifestPath: string;
  legacyV4DbPath?: string;
}

type SourceManifest = {
  raw_sha256: string;
  canonical_sha256: string;
  source_format: string;
  encoding: string;
  extractor: string;
};

export class BookContext {
  readonly sourceDbPath: string;
  readonly sourceFingerprint: string;
  readonly evidenceIndex: EvidenceIndex;
  readonly certifiedSource: CertifiedSourceInput | null;
  readonly languageProfile: SourceLanguageProfile;
  readonly #adapter: V4ReadAdapter | undefined;
  readonly #blocks: V4Block[];
  readonly #losslessBlocks: LosslessBlock[];
  readonly #annotations: StructureAnnotation[];
  readonly #ledger: SourceLedger | undefined;
  readonly #stableTerms: StableTerm[];
  #closed = false;

  private constructor(options: {
    sourceDbPath: string;
    sourceFingerprint: string;
    adapter?: V4ReadAdapter;
    blocks?: V4Block[];
    losslessBlocks?: LosslessBlock[];
    annotations?: StructureAnnotation[];
    ledger?: SourceLedger;
    stableTerms: StableTerm[];
    certifiedSource?: CertifiedSourceInput;
    languageProfile?: SourceLanguageProfile;
  }) {
    this.sourceDbPath = options.sourceDbPath;
    this.sourceFingerprint = options.sourceFingerprint;
    this.#adapter = options.adapter;
    this.#blocks = options.blocks ?? [];
    this.#losslessBlocks = options.losslessBlocks ?? [];
    this.#annotations = options.annotations ?? [];
    this.#ledger = options.ledger;
    this.#stableTerms = options.stableTerms;
    this.certifiedSource = options.certifiedSource ?? null;
    this.languageProfile = options.languageProfile ?? getSourceLanguageProfile("en");
    this.evidenceIndex = EvidenceIndex.fromBlocks(
      options.losslessBlocks ?? options.blocks ?? [],
    );
  }

  static open(databasePath: string): BookContext {
    const sourceDbPath = resolve(databasePath);
    const adapter = new V4ReadAdapter(sourceDbPath);
    try {
      const blocks = adapter.loadBlocks();
      if (blocks.length === 0) {
        throw new Error("source database contains no blocks");
      }
      const stableTerms = adapter.loadStableTerms();
      const digest = createHash("sha256");
      for (const block of blocks) {
        digest.update(block.id);
        digest.update("\0");
        digest.update(block.sourceHash);
        digest.update("\0");
        digest.update(String(block.globalIndex));
        digest.update("\n");
      }
      return new BookContext({
        sourceDbPath,
        sourceFingerprint: digest.digest("hex"),
        adapter,
        blocks,
        stableTerms,
      });
    } catch (error) {
      adapter.close();
      throw error;
    }
  }

  static openLossless(options: OpenLosslessBookContextOptions): BookContext {
    const ledger = SourceLedger.open(options.manifestPath);
    const annotations = annotateStructure(
      ledger,
      ledger.sourceVersion,
      ledger.languageProfile,
    );
    const blocks = buildLosslessBlocks(ledger, annotations, {
      sourceVersion: ledger.sourceVersion,
    });
    const audit = auditSourceCoverage(ledger, blocks, {
      sourceVersion: ledger.sourceVersion,
    });
    if (!audit.ok) {
      const incident = audit.incidents[0];
      throw new Error(
        `${incident?.code ?? "SOURCE_AUDIT_FAILED"}: lossless source coverage audit failed`,
      );
    }
    const manifest = JSON.parse(
      readFileSync(ledger.manifestPath, "utf8"),
    ) as SourceManifest;
    const certifiedSource: CertifiedSourceInput = {
      sourceVersion: ledger.sourceVersion,
      rawSha256: manifest.raw_sha256,
      canonicalSha256: manifest.canonical_sha256,
      canonicalChars: ledger.canonicalChars,
      coordinateUnit: "unicode_scalar",
      sourceFormat: manifest.source_format,
      encoding: manifest.encoding,
      extractor: manifest.extractor,
      sourceLanguage: ledger.sourceLanguage,
      sourceLanguageProfileVersion: ledger.languageProfile.version,
      sourceLanguageCompatibilityMode: ledger.sourceLanguageCompatibilityMode,
      ranges: ledger.canonicalSegments.map((range, index) => ({
        rangeId: `range-${index}`,
        canonicalStart: range.canonicalStart,
        canonicalEnd: range.canonicalEnd,
        originKind: range.originKind,
        originRef: range.originRef,
        transformation: range.transformation,
        ...(range.rawStart === undefined ? {} : { rawStart: range.rawStart }),
        ...(range.rawEnd === undefined ? {} : { rawEnd: range.rawEnd }),
      })),
    };
    let adapter: V4ReadAdapter | undefined;
    try {
      adapter = options.legacyV4DbPath === undefined
        ? undefined
        : new V4ReadAdapter(resolve(options.legacyV4DbPath));
      const stableTerms = adapter?.loadStableTerms() ?? [];
      return new BookContext({
        sourceDbPath: options.legacyV4DbPath === undefined
          ? ledger.manifestPath
          : resolve(options.legacyV4DbPath),
        sourceFingerprint: ledger.sourceVersion,
        adapter,
        losslessBlocks: blocks,
        annotations,
        ledger,
        stableTerms,
        certifiedSource,
        languageProfile: ledger.languageProfile,
      });
    } catch (error) {
      adapter?.close();
      throw error;
    }
  }

  get blocks(): V4Block[] {
    this.#assertOpen();
    return this.#blocks.map((block) => ({ ...block }));
  }

  get losslessBlocks(): LosslessBlock[] {
    this.#assertOpen();
    if (this.#ledger === undefined) {
      throw new Error("lossless blocks are unavailable in preview context");
    }
    return this.#losslessBlocks.map((block) => ({ ...block }));
  }

  get annotations(): StructureAnnotation[] {
    this.#assertOpen();
    return this.#annotations.map((annotation) => ({ ...annotation }));
  }

  get sourceLedger(): SourceLedger {
    this.#assertOpen();
    if (this.#ledger === undefined) {
      throw new Error("source ledger is unavailable in preview context");
    }
    return this.#ledger;
  }

  get stableTerms(): StableTerm[] {
    this.#assertOpen();
    return this.#stableTerms.map((term) => ({ ...term }));
  }

  blocksForIndexes(globalIndexes: readonly number[]): V4Block[] {
    this.#assertOpen();
    const requested = new Set(globalIndexes);
    return this.#blocks
      .filter((block) => requested.has(block.globalIndex))
      .map((block) => ({ ...block }));
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.evidenceIndex.close();
    this.#adapter?.close();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("book context is closed");
    }
  }
}
