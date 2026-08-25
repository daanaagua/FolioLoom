import type { Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

import {
  buildProvisionalSnapshot,
  type ProvisionalSnapshot,
} from "../domain/provisional-snapshot.js";
import type { V4Block } from "../domain/types.js";
import { BudgetLedger } from "../kernel/budget.js";
import type { CandidateCollector } from "../tools/candidate-collector.js";
import type { ResearchTools } from "../tools/research-tools.js";
import type { TypedToolSpec } from "../tools/tool-spec.js";
import type { PiRunResult } from "./pi-runtime.js";
import { PiRuntime } from "./pi-runtime.js";
import type { QuestionScout } from "./question-scout.js";

interface EvidenceResolverInput {
  scout: QuestionScout;
  tools: ResearchTools;
  collector: CandidateCollector;
  budget: BudgetLedger;
  model: Model<any>;
  streamFn: StreamFn;
  targetBlocks: readonly V4Block[];
  protocolVersion: string;
  signal?: AbortSignal;
  deadlineMs?: number;
}

export interface ResearchOutcome {
  snapshot: ProvisionalSnapshot;
  run: PiRunResult;
  metrics: {
    offTargetEvidenceChars: number;
    researchToolCalls: number;
    modelCalls: number;
    unresolvedQuestions: number;
    questionGatePassed: boolean;
  };
}

export class EvidenceResolver {
  constructor(private readonly runtime: PiRuntime) {}

  async run(input: EvidenceResolverInput): Promise<ResearchOutcome> {
    const mandatory = input.scout.mandatoryQuestions();
    const existing = new Set(input.collector.questions().map((item) => item.questionId));
    if (mandatory.some((item) => !existing.has(item.questionId))) {
      throw new Error("mandatory questions must be registered before resolver execution");
    }

    const systemPrompt = input.scout.systemPrompt();
    const scoutRun = await this.runtime.run({
      systemPrompt,
      prompt: input.scout.prompt(),
      phase: "research",
      model: input.model,
      tools: input.tools.specs().filter((tool) => tool.name === "submit_questions"),
      budget: input.budget,
      terminateTools: ["submit_questions"],
      maxTurns: 3,
      signal: input.signal,
      deadlineMs: input.deadlineMs,
    }, input.streamFn);

    const questions = input.collector.questions();
    const questionGatePassed = input.scout.assertSubmissionGate(
      scoutRun.toolNames,
      questions,
    );
    let resolverRun: PiRunResult | undefined;
    if (questions.length > 0 && input.budget.remaining("researchTurns") > 0) {
      const resolverTools = capToolExecutions(
        input.tools.specs().filter((tool) =>
          tool.name !== "submit_questions"
          && tool.name !== "submit_resolution"
          && tool.name !== "finish_research"),
        6,
      );
      resolverRun = await this.runtime.run({
        systemPrompt: [
          "You are the bounded evidence-search worker for a literary translation.",
          "Use only typed lookup and evidence tools. Never invent IDs or raw queries.",
          "Retrieve only evidence capable of changing Chinese wording.",
          "translator_global evidence guides translation but is not narrator-visible knowledge.",
        ].join("\n"),
        prompt: input.scout.resolverSearchPrompt(
          questions,
          Math.min(6, input.budget.remaining("researchToolCalls") - 1),
          input.budget.remaining("evidenceChars"),
        ),
        phase: "research",
        model: input.model,
        tools: resolverTools,
        budget: input.budget,
        terminateTools: [],
        maxTurns: 2,
        signal: input.signal,
        deadlineMs: input.deadlineMs,
      }, input.streamFn);
    }
    let finalizerRun: PiRunResult | undefined;
    if (questions.length > 0
      && input.budget.remaining("researchTurns") > 0
      && input.budget.remaining("researchToolCalls") > 0) {
      const finishTool = input.tools.specs().filter((tool) =>
        tool.name === "finish_research");
      finalizerRun = await this.runtime.run({
        systemPrompt: [
          "You are the evidence finalizer for a literary translation.",
          "Use only evidence IDs and quotes supplied below; never infer unsupported facts.",
          "Call finish_research exactly once. Resolve a question only when issued evidence directly supports the verdict.",
          "Otherwise include its exact ID in unresolvedQuestionIds.",
        ].join("\n"),
        prompt: finalizerPrompt(questions, input.tools.issuedEvidence()),
        phase: "research",
        model: input.model,
        tools: finishTool,
        budget: input.budget,
        terminateTools: ["finish_research"],
        maxTurns: 2,
        signal: input.signal,
        deadlineMs: input.deadlineMs,
      }, input.streamFn);
    }
    const run = mergeRuns([
      scoutRun,
      ...(resolverRun === undefined ? [] : [resolverRun]),
      ...(finalizerRun === undefined ? [] : [finalizerRun]),
    ]);
    const resolvedIds = new Set(
      input.collector.resolutions().map((resolution) => resolution.questionId),
    );
    const reported = input.collector.researchStatus();
    const unresolvedIds = new Set(reported.unresolvedQuestionIds);
    for (const questionId of resolvedIds) {
      unresolvedIds.delete(questionId);
    }
    for (const question of questions) {
      if (!resolvedIds.has(question.questionId)) {
        unresolvedIds.add(question.questionId);
      }
    }
    input.collector.finishResearch([...unresolvedIds]);

    const snapshot = buildProvisionalSnapshot({
      protocolVersion: input.protocolVersion,
      systemPrompt,
      model: input.model,
      targetBlocks: input.targetBlocks,
      questions,
      resolutions: input.collector.resolutions(),
      unresolvedQuestionIds: [...unresolvedIds],
      evidence: input.tools.issuedEvidence(),
    });
    const consumed = input.budget.snapshot();
    return {
      snapshot,
      run,
      metrics: {
        offTargetEvidenceChars: consumed.evidenceChars,
        researchToolCalls: consumed.researchToolCalls,
        modelCalls: run.modelCalls,
        unresolvedQuestions: snapshot.unresolved.length,
        questionGatePassed,
      },
    };
  }
}

function capToolExecutions(
  tools: readonly TypedToolSpec[],
  limit: number,
): TypedToolSpec[] {
  let attempted = 0;
  return tools.map((tool) => ({
    ...tool,
    execute: async (args: unknown, signal: AbortSignal) => {
      if (attempted >= limit) {
        throw new Error(`search phase tool cap reached: ${limit}`);
      }
      attempted += 1;
      return tool.execute(args, signal);
    },
  }));
}

function finalizerPrompt(
  questions: ReturnType<QuestionScout["mandatoryQuestions"]>,
  evidence: ReturnType<ResearchTools["issuedEvidence"]>,
): string {
  return [
    "REGISTERED QUESTIONS",
    JSON.stringify(questions),
    "ISSUED EVIDENCE",
    evidence.length === 0 ? "(none)" : JSON.stringify(evidence),
    "Return every question exactly once: either as an evidence-bound resolution or in unresolvedQuestionIds.",
  ].join("\n\n");
}

function mergeRuns(runs: readonly PiRunResult[]): PiRunResult {
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  for (const run of runs) {
    usage.input += run.usage.input;
    usage.output += run.usage.output;
    usage.cacheRead += run.usage.cacheRead;
    usage.cacheWrite += run.usage.cacheWrite;
    usage.reasoning += run.usage.reasoning ?? 0;
    usage.totalTokens += run.usage.totalTokens;
    usage.cost.input += run.usage.cost.input;
    usage.cost.output += run.usage.cost.output;
    usage.cost.cacheRead += run.usage.cost.cacheRead;
    usage.cost.cacheWrite += run.usage.cost.cacheWrite;
    usage.cost.total += run.usage.cost.total;
  }
  const last = runs.at(-1);
  return {
    modelCalls: runs.reduce((total, run) => total + run.modelCalls, 0),
    toolNames: runs.flatMap((run) => run.toolNames),
    toolErrors: runs.flatMap((run) => run.toolErrors),
    usage,
    durationMs: runs.reduce((total, run) => total + run.durationMs, 0),
    stopReason: last?.stopReason ?? "stop",
    messages: runs.flatMap((run) => run.messages),
    deadlineExceeded: runs.some((run) => run.deadlineExceeded),
    turnLimitReached: runs.some((run) => run.turnLimitReached),
  };
}
