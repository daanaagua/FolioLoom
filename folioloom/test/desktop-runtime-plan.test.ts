import assert from "node:assert/strict";
import test from "node:test";

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

import {
  buildDesktopRuntimePlan,
  DesktopRuntimePlanError,
  serializeDesktopRuntimeFingerprint,
  type DesktopTranslationRuntime,
} from "../src/desktop/desktop-runtime-plan.js";
import type { ModelProfile, ProviderEffort } from "../src/providers/types.js";

const streamFn = (async () => {
  throw new Error("not used by runtime-plan tests");
}) as StreamFn;

function runtimeFor(
  profile: ModelProfile,
  supportedEfforts: readonly ProviderEffort[] = ["off", "high", "max"],
  transform?: (requested: ModelProfile) => ModelProfile,
): DesktopTranslationRuntime {
  const create = (requested: ModelProfile): DesktopTranslationRuntime => {
    const resolved = transform?.(requested) ?? requested;
    return {
      profile: resolved,
      model: { id: resolved.modelId } as Model<any>,
      streamFn,
      supportedEfforts,
      createWithProfile: create,
    };
  };
  return create(profile);
}

test("desktop runtime plan keeps quality effort and lowers only the fast primary", () => {
  const runtime = runtimeFor({
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    reasoningEffort: "high",
  });

  const quality = buildDesktopRuntimePlan("quality", runtime);
  assert.equal(quality.runtimeSet.primary.effort, "high");
  assert.equal(quality.runtimeSet.escalation.effort, "high");
  assert.deepEqual(
    quality.runtimeSet.variants?.map((candidate) => candidate.effort),
    ["off", "high", "max"],
  );
  assert.equal(quality.fingerprint.mode, "quality");

  const fast = buildDesktopRuntimePlan("fast", runtime);
  assert.equal(fast.runtimeSet.primary.effort, "off");
  assert.equal(fast.runtimeSet.primary.thinkingLevel, "off");
  assert.equal(fast.runtimeSet.escalation.effort, "high");
  assert.deepEqual(
    fast.runtimeSet.variants?.map((candidate) => candidate.effort),
    ["off", "high", "max"],
  );
  assert.equal(fast.fingerprint.primary.reasoningEffort, "off");
  assert.equal(
    serializeDesktopRuntimeFingerprint(fast.fingerprint),
    serializeDesktopRuntimeFingerprint(buildDesktopRuntimePlan("fast", runtime).fingerprint),
  );
});

test("desktop runtime plan rejects a model that differs from its active profile", () => {
  const valid = runtimeFor({
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    reasoningEffort: "high",
  });
  const runtime: DesktopTranslationRuntime = {
    ...valid,
    model: { id: "another-model" } as Model<any>,
  };

  assert.throws(
    () => buildDesktopRuntimePlan("quality", runtime),
    (error: unknown) => error instanceof DesktopRuntimePlanError
      && error.code === "DESKTOP_RUNTIME_MISMATCH",
  );
});

test("desktop runtime plan rejects illegal effort capabilities and dishonest derived runtimes", () => {
  const invalidCapabilities = runtimeFor(
    {
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      reasoningEffort: "high",
    },
    ["off", "unsupported" as ProviderEffort],
  );
  assert.throws(
    () => buildDesktopRuntimePlan("fast", invalidCapabilities),
    (error: unknown) => error instanceof DesktopRuntimePlanError
      && error.code === "DESKTOP_RUNTIME_MISMATCH",
  );

  const dishonest = runtimeFor(
    {
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      reasoningEffort: "high",
    },
    ["off", "high"],
    (requested) => ({ ...requested, reasoningEffort: "high" }),
  );
  assert.throws(
    () => buildDesktopRuntimePlan("fast", dishonest),
    (error: unknown) => error instanceof DesktopRuntimePlanError
      && error.code === "DESKTOP_RUNTIME_MISMATCH",
  );
});
