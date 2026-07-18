import type { AgentPhase } from "../domain/types.js";

const FORBIDDEN_CAPABILITIES = new Set([
  "bash",
  "shell",
  "read",
  "read_file",
  "write",
  "write_file",
  "edit",
  "execute_sql",
]);

export interface KernelTool<Args, Result> {
  readonly name: string;
  readonly phase: AgentPhase;
  execute(args: Args, signal: AbortSignal): Promise<Result>;
}

export class CapabilityRegistry {
  private readonly tools = new Map<string, KernelTool<unknown, unknown>>();

  public constructor(tools: ReadonlyArray<KernelTool<unknown, unknown>> = []) {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  public register<Args, Result>(tool: KernelTool<Args, Result>): void {
    if (FORBIDDEN_CAPABILITIES.has(tool.name)) {
      throw new Error(`forbidden capability: ${tool.name}`);
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`duplicate capability: ${tool.name}`);
    }
    this.tools.set(tool.name, tool as KernelTool<unknown, unknown>);
  }

  public names(): string[] {
    return [...this.tools.keys()].sort();
  }

  public get(name: string): KernelTool<unknown, unknown> {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      throw new Error(`unknown capability: ${name}`);
    }
    return tool;
  }
}
