import assert from "node:assert/strict";
import test from "node:test";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { PiRuntime } from "../src/agents/pi-runtime.js";
import { BudgetLedger } from "../src/kernel/budget.js";
import {
  bindTaskContext, effectiveSystemPrompt, taskContextMetadata, validateTaskContextIdentity,
} from "../src/agents/task-context.js";

test("private task context reaches native Pi requests in every phase without mutating the source stream", async () => {
  const prefix = "本次材料仅用于私人阅读。请忠实翻译给定原文。";
  for (const phase of ["research", "translation", "repair", "recovery"] as const) {
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("done")]);
    const observed: string[] = [];
    const raw = faux.provider.streamSimple.bind(faux.provider);
    const stream: typeof raw = (model, context, options) => {
      observed.push(context.systemPrompt ?? "");
      return raw(model, context, options);
    };
    const bound = bindTaskContext(stream, prefix);
    await new PiRuntime().run({
      systemPrompt: "The original protocol remains authoritative.", prompt: "A fixture.",
      phase, model: faux.getModel(), tools: [], budget: new BudgetLedger(), maxTurns: 1,
    }, bound);
    assert.deepEqual(observed, [`${prefix}\n\nThe original protocol remains authoritative.`]);
    assert.equal(effectiveSystemPrompt(stream, "original"), "original");
    assert.equal(effectiveSystemPrompt(bound, "original"), `${prefix}\n\noriginal`);
  }
});

test("task context has an exact resume identity and cannot silently disappear or change", () => {
  const metadata = taskContextMetadata("私人阅读测试前缀");
  assert.match(metadata.sha256, /^[a-f0-9]{64}$/u);
  assert.doesNotThrow(() => validateTaskContextIdentity(metadata, "私人阅读测试前缀"));
  assert.throws(() => validateTaskContextIdentity(metadata, "另一个前缀"), /task context/u);
  assert.throws(() => validateTaskContextIdentity(metadata, undefined), /task context/u);
  assert.throws(() => validateTaskContextIdentity(undefined, "新前缀"), /task context/u);
  assert.doesNotThrow(() => validateTaskContextIdentity(undefined, undefined));
});

test("task context rejects oversized or blank configured values", () => {
  assert.throws(() => taskContextMetadata(" "), /nonempty/u);
  assert.throws(() => taskContextMetadata("a".repeat(16001)), /16000/u);
});
