import { createHash } from "node:crypto";
import { evidenceReferences, type EvidenceReference } from "../domain/evidence-reference.js";
import type { SupervisorInput } from "./supervisor.js";

/** Wire version only. Durable decisions retain their canonical, content-bound form. */
export const SUPERVISOR_VALUES_PROTOCOL = "folioloom-supervisor-values-2";
export const SUPERVISOR_VALUES_TOOL_PROTOCOL = "folioloom-supervisor-values-tool-1";
export function usesSupervisorValueTool(input: Pick<SupervisorInput, "model" | "decisionProtocol">): boolean {
  return input.decisionProtocol === "ordered_values_tool"
    || (input.decisionProtocol === undefined && input.model.provider === "folioloom-deepseek");
}

function binding(input: SupervisorInput): string {
  return createHash("sha256").update(JSON.stringify({ event: input.event, windows: input.windows,
    sources: input.sources, candidate: input.candidate, priorCandidate: input.priorCandidate,
    priorIssues: input.priorIssues, terms: input.terms, conflicts: input.conflicts,
    reviewFocus: input.reviewFocus, surfaceEvidence: input.surfaceEvidence,
    qualityReviewStage: input.qualityReviewStage })).digest("hex");
}

function tuple(value: unknown, length: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length !== length) throw new Error(`${label} requires exactly ${length} values`);
  return value;
}
function rows(value: unknown, max: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`invalid ${label} rows`);
  return value;
}
function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`invalid ${label} number`);
  return value;
}
function text(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`invalid ${label} text`);
  return value;
}

/**
 * Request-local capability table: numbers are append-only and become usable only
 * after their exact evidence is exposed. No model-authored quote, hash or ID is
 * trusted. Decode against the same immutable request, then run canonical validation.
 */
export class SupervisorValueFrame {
  readonly #binding: string;
  readonly #references: ReadonlyMap<string, EvidenceReference>;
  readonly #handles = new Map<string, number>();
  readonly #entries: EvidenceReference[] = [];
  readonly #blocks: readonly string[];
  readonly #windows: readonly string[];
  readonly #issues: readonly string[];

  constructor(input: SupervisorInput, private readonly issuedIds: ReadonlySet<string>) {
    this.#binding = binding(input);
    this.#blocks = input.sources.map(b => b.blockId);
    this.#windows = input.windows.map(w => w.windowId);
    this.#issues = (input.priorIssues ?? []).map(p => p.issueId);
    if (new Set(this.#blocks).size !== this.#blocks.length) throw new Error("duplicate supervisor source block");
    this.#references = new Map([
      ...input.sources.flatMap(b => evidenceReferences("source", b.blockId, b.sourceText)),
      ...(input.candidate ?? []).flatMap(b => evidenceReferences("target", b.blockId, b.text)),
    ].map(r => [r.id, Object.freeze({ ...r })]));
    for (const id of issuedIds) this.#number(id);
  }

  #number(id: string): number {
    const ref = this.#references.get(id);
    if (!ref || !this.issuedIds.has(id)) throw new Error("unissued supervisor evidence");
    const existing = this.#handles.get(id);
    if (existing !== undefined) return existing;
    const number = this.#entries.push(ref);
    this.#handles.set(id, number);
    return number;
  }

  blockId(number: unknown): string {
    return this.#blocks[integer(number, 1, this.#blocks.length, "block") - 1]!;
  }

  #reference(number: unknown, side: "source" | "target", nullable = false): EvidenceReference | undefined {
    if (number === null && nullable) return undefined;
    const ref = this.#entries[integer(number, 1, this.#entries.length, `${side} evidence`) - 1]!;
    if (ref.side !== side || !this.issuedIds.has(ref.id)) throw new Error(`wrong-side or unissued ${side} evidence`);
    return ref;
  }

  /** Present host metadata as short numbers; quoted source/target text is unchanged. */
  present(value: unknown): any {
    if (Array.isArray(value)) return value.map(v => this.present(v));
    if (!value || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    if (typeof object.id === "string" && typeof object.text === "string" && this.#references.has(object.id)) {
      if (this.#references.get(object.id)!.text !== object.text) throw new Error("supervisor evidence text changed");
      return { id: this.#number(object.id), text: object.text };
    }
    const local = (id: unknown, ids: readonly string[]) => typeof id === "string" && ids.includes(id) ? ids.indexOf(id) + 1 : id;
    return Object.fromEntries(Object.entries(object).map(([key, item]) => [key,
      key === "blockId" ? local(item, this.#blocks)
        : key === "windowId" ? local(item, this.#windows)
        : key === "issueId" ? local(item, this.#issues)
        : (key === "blockIds" || key === "applicableBlockIds") && Array.isArray(item) ? item.map(id => local(id, this.#blocks))
        : key === "reviewFocus" ? { policy: "paragraph-delta-1" }
        : this.present(item),
    ]));
  }

  decodeResponse(raw: unknown, input: SupervisorInput): Record<string, unknown> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || Object.keys(raw).length !== 1 || !Object.hasOwn(raw, "values"))
      throw new Error("supervisor response requires only the fixed values envelope");
    return this.decode((raw as { values: unknown }).values, input);
  }

  decode(raw: unknown, input: SupervisorInput): Record<string, unknown> {
    if (binding(input) !== this.#binding) throw new Error("stale supervisor value frame");
    const [first, second, third, reason] = tuple(raw, 4, "supervisor decision");
    if (input.event === "plan") {
      const count = integer(first, 0, input.windows.length, "prefix count");
      return { action: count === 0 ? "pause" : "translate", windowIds: this.#windows.slice(0, count),
        reviewBlockIds: rows(second, 32, "review blocks").map(n => this.blockId(n)),
        guidance: rows(third, 8, "guidance").map(value => {
          const [number, instruction] = tuple(value, 2, "guidance");
          const ref = this.#reference(number, "source")!;
          return { blockId: ref.blockId, sourceRef: ref.id, instruction: text(instruction, 1200, "instruction") };
        }), issues: [], reason: text(reason, 1200, "reason") };
    }
    const dispositions = tuple(third, input.priorIssues?.length ?? 0, "dispositions").map((value, index) => {
      const [status, sourceNumber, targetNumber, note] = tuple(value, 4, "disposition");
      const source = this.#reference(sourceNumber, "source", status === "unresolved");
      const target = this.#reference(targetNumber, "target", status === "unresolved");
      return { issueId: this.#issues[index], status: text(status, 16, "disposition status"),
        sourceRef: source?.id ?? "", targetRef: target?.id ?? "", note: text(note, 160, "disposition note") };
    });
    return { action: text(first, 16, "action"), windowIds: [...this.#windows], reviewBlockIds: [], guidance: [],
      issues: rows(second, 8, "issues").map(value => {
        const [sourceNumber, targetNumber, problem] = tuple(value, 3, "issue");
        const source = this.#reference(sourceNumber, "source")!;
        const target = this.#reference(targetNumber, "target", true);
        if (target && target.blockId !== source.blockId) throw new Error("issue evidence crosses blocks");
        return { blockId: source.blockId, sourceRef: source.id, targetRef: target?.id ?? "", problem: text(problem, 1200, "problem") };
      }), ...(input.priorIssues?.length ? { dispositions } : {}), reason: text(reason, input.priorIssues?.length ? 160 : 1200, "reason") };
  }
}

export function supervisorValueInstructions(input: SupervisorInput): string {
  const native = usesSupervisorValueTool(input);
  return [
    native
      ? `输出协议 ${SUPERVISOR_VALUES_TOOL_PROTOCOL}：最终调用 submit_supervisor_values，唯一参数为 values，其值是恰好四格的数组。不得在普通文本中输出决定；不增加其他参数、ID、引文、偏移或解释。提交工具后结束。`
      : `输出协议 ${SUPERVISOR_VALUES_PROTOCOL}：最终只输出一个 JSON 对象，唯一字段为 values，其值是恰好四格的数组。固定外壳为 {"values":[...]}，不增加其他字段、ID、引文、偏移、代码围栏或解释。对象闭合后立即结束。`,
    "输入中的 evidence.id 是程序签发的短整数；只能选择已经展示的数字，不能猜测。不同数字代表不同原文或译文片段。blockId 也是本次请求内的短整数。",
    "程序保管窗口、块、问题身份、精确引文与版本。问题定位只选择证据号，不抄写或改写引文，不输出 sourceFocus/targetFocus。",
    input.event === "plan"
      ? "四格依次为：[批准的连续前缀窗口数, 需要审校的块号数组, 翻译指导数组, 简短理由]。窗口数为0表示暂停，其余两数组必须为空；正数不得超过所给窗口数。指导每行恰好两格：[原文证据号, 指导文字]，最多8行。"
      : "四格依次为：[判断, 问题数组, 既有问题结案数组, 简短理由]。判断仅为 accept/revise/pause。每个问题恰好三格：[原文证据号, 同一块的译文证据号或null, 问题说明]，最多8行。仅确实漏译才可用null。无问题用[]，不要留占位问题。",
    ...(input.event === "review" ? [
      `结案数组必须按 priorIssues 原顺序填写，恰好${input.priorIssues?.length ?? 0}行。每行恰好四格：[fixed/dismissed/variant/unresolved, 原文证据号, 译文证据号, 至多160字说明]。只有unresolved可用null证据号。不得重排、漏行或返回问题ID。`,
      "同一问题涉及多处时，为需要修正的各处选择相应证据行，不以一处证据授权改动其他位置。结案理由不复述引文。",
    ] : []),
    `结构示例（不是本题结论）：${JSON.stringify({ values: input.event === "plan" ? [input.windows.length, [], [], "已核对"]
      : ["accept", [], (input.priorIssues ?? []).map(() => ["unresolved", null, null, "证据不足"]), "已核对"] })}`,
  ].join("\n");
}
