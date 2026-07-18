import assert from "node:assert/strict";
import test from "node:test";

import type { V4Block } from "../src/domain/types.js";
import { EvidenceIndex } from "../src/index/evidence-index.js";
import { BudgetExceeded, BudgetLedger } from "../src/kernel/budget.js";
import {
  CandidateCollector,
  type ResearchQuestion,
} from "../src/tools/candidate-collector.js";
import { RepairTools } from "../src/tools/repair-tools.js";
import { ResearchTools } from "../src/tools/research-tools.js";
import { TranslationTools } from "../src/tools/translation-tools.js";

function block(globalIndex: number, sourceText: string): V4Block {
  return {
    id: `block-${globalIndex}`,
    legacyId: null,
    chapterId: "chapter",
    chapterTitle: "Fixture",
    globalIndex,
    blockIndex: 0,
    sourceText,
    sourceHash: `hash-${globalIndex}`,
    tokenCount: 4,
  };
}

function question(): ResearchQuestion {
  return {
    questionId: "q1",
    kind: "entity_identity",
    prompt: "Is this the same Typhon?",
    subjectIds: ["typhon"],
    channel: "narrative_before_target",
  };
}

test("submit_resolution rejects evidence outside the question channel", async () => {
  const index = EvidenceIndex.fromBlocks([
    block(10, "Typhon spoke in the past."),
    block(30, "Typhon was explained in the future."),
  ]);
  const collector = new CandidateCollector();
  const tools = new ResearchTools({
    budget: new BudgetLedger(),
    evidenceIndex: index,
    targetGlobalIndex: 20,
    subjects: [{ subjectId: "typhon", forms: ["Typhon"] }],
    questions: [question()],
    collector,
  });
  try {
    const result = await tools.searchMentions({
      subjectIds: ["typhon"],
      channel: "translator_global",
      limit: 8,
    });
    const future = result.hits.find((hit) => hit.globalIndex === 30);
    assert.ok(future);

    await assert.rejects(
      tools.submitResolution({
        questionId: "q1",
        verdict: "same entity",
        confidence: 0.9,
        evidenceIds: [future.evidenceId],
        unresolved: "",
      }),
      /evidence visibility violation/,
    );
    assert.equal(collector.resolutions().length, 0);
  } finally {
    index.close();
  }
});

test("invented subject ids are rejected before search", async () => {
  const index = EvidenceIndex.fromBlocks([block(10, "Typhon spoke.")]);
  const tools = new ResearchTools({
    budget: new BudgetLedger(),
    evidenceIndex: index,
    targetGlobalIndex: 20,
    subjects: [{ subjectId: "typhon", forms: ["Typhon"] }],
    questions: [question()],
    collector: new CandidateCollector(),
  });
  try {
    await assert.rejects(
      tools.searchMentions({
        subjectIds: ["invented"],
        channel: "translator_global",
        limit: 8,
      }),
      /unknown subject: invented/,
    );
  } finally {
    index.close();
  }
});

test("question submission is capped at four translation-critical uncertainties", async () => {
  const index = EvidenceIndex.fromBlocks([block(10, "Typhon spoke.")]);
  const tools = new ResearchTools({
    budget: new BudgetLedger(),
    evidenceIndex: index,
    targetGlobalIndex: 20,
    subjects: [{ subjectId: "typhon", forms: ["Typhon"] }],
    collector: new CandidateCollector(),
  });
  try {
    await assert.rejects(
      tools.submitQuestions({
        questions: Array.from({ length: 5 }, (_, index) => ({
          ...question(),
          questionId: `q${index}`,
        })),
      }),
      /at most 4 entries/,
    );
  } finally {
    index.close();
  }
});

test("tool budgets are checked before a second research call executes", async () => {
  const index = EvidenceIndex.fromBlocks([block(10, "Typhon spoke.")]);
  const tools = new ResearchTools({
    budget: new BudgetLedger({ researchToolCalls: 1 }),
    evidenceIndex: index,
    targetGlobalIndex: 20,
    subjects: [{ subjectId: "typhon", forms: ["Typhon"] }],
    questions: [question()],
    collector: new CandidateCollector(),
  });
  try {
    await tools.lookupSubjects({ forms: ["Typhon"] });
    await assert.rejects(
      tools.lookupSubjects({ forms: ["Typhon"] }),
      BudgetExceeded,
    );
  } finally {
    index.close();
  }
});

test("finalize_translation records a candidate without committing active state", async () => {
  const collector = new CandidateCollector();
  let commits = 0;
  const tools = new TranslationTools({
    budget: new BudgetLedger(),
    targetBlocks: [block(20, "Typhon woke.")],
    collector,
    stableTerms: [],
    resolvedEvidence: [],
    styleState: { register: "literary", dialogueQuotes: "curly" },
    commitActiveState: () => {
      commits += 1;
    },
  });

  await tools.finalizeTranslation({
    translations: [{ blockId: "block-20", text: "提丰醒了。" }],
    notes: [],
  });

  assert.equal(collector.translations().length, 1);
  assert.equal(commits, 0);
});

test("only the sixteen designed typed capabilities are exposed", () => {
  const target = block(20, "Typhon woke.");
  const index = EvidenceIndex.fromBlocks([target]);
  const budget = new BudgetLedger();
  const collector = new CandidateCollector();
  const research = new ResearchTools({
    budget,
    evidenceIndex: index,
    targetGlobalIndex: 20,
    subjects: [{ subjectId: "typhon", forms: ["Typhon"] }],
    collector,
  });
  const translation = new TranslationTools({
    budget,
    targetBlocks: [target],
    collector,
    stableTerms: [],
    resolvedEvidence: [],
    styleState: {},
  });
  const repair = new RepairTools({
    budget,
    targetBlocks: [target],
    failures: [],
    collector,
  });
  try {
    assert.deepEqual(
      [...research.specs(), ...translation.specs(), ...repair.specs()]
        .map((spec) => spec.name),
      [
        "submit_questions",
        "lookup_subjects",
        "lookup_terms",
        "search_mentions",
        "search_cooccurrence",
        "get_evidence_context",
        "submit_resolution",
        "finish_research",
        "get_required_context",
        "inspect_local_continuity",
        "retrieve_resolved_evidence",
      "inspect_style_state",
      "request_translation_evidence",
      "finalize_translation",
        "inspect_validation_failures",
        "submit_repaired_translation",
      ],
    );
  } finally {
    index.close();
  }
});
