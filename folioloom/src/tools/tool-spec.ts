import { Type } from "@earendil-works/pi-ai";

import type { AgentPhase } from "../domain/types.js";
import type { KernelTool } from "../kernel/capabilities.js";

export { Type };

export interface TypedToolSpec<Args = unknown, Result = unknown> {
  name: string;
  label: string;
  description: string;
  phase: AgentPhase;
  parameters: ReturnType<typeof Type.Object>;
  execute: (args: Args, signal: AbortSignal) => Promise<Result>;
}

export function asKernelTools(
  specs: readonly TypedToolSpec[],
): KernelTool<unknown, unknown>[] {
  return specs.map((spec) => ({
    name: spec.name,
    phase: spec.phase,
    execute: spec.execute,
  }));
}

export function assertNotAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}
