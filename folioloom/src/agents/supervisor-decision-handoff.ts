import type { Context } from "@earendil-works/pi-ai";

const QUERY_OPERATIONS: Readonly<Record<string, string>> = {
  search_source: "source lookup", read_source: "source excerpt", search_target: "translation comparison",
};
const DECISION_INSTRUCTION = "查询阶段已结束。现在只根据原文、候选和已交接证据提交最终决定；不继续查询，不推测未取得的证据，也不因查询结束默认通过。";

function textContent(message: Context["messages"][number]): string {
  return typeof message.content === "string" ? message.content
    : message.content.filter(c => c.type === "text").map(c => c.text).join("\n");
}
function structuredResult(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

/** A wire-only phase boundary. Original messages and issued evidence stay in the session journal. */
export function supervisorDecisionHandoff(context: Context): Context {
  const first = context.messages.find(m => m.role === "user");
  if (!first) throw new Error("supervisor decision handoff requires the original task");
  const task = JSON.parse(textContent(first));
  const initial = { ...first, content: JSON.stringify({ ...task, instruction: DECISION_INSTRUCTION,
    ...(task.targetContext ? { targetContext: { ...task.targetContext, instruction: DECISION_INSTRUCTION } } : {}) }) };
  const requests = new Map<string, unknown>();
  const queries: { operation: string; request: unknown; isError: boolean; result: unknown }[] = [];
  const validationFeedback: string[] = [];
  for (const message of context.messages) {
    if (message.role === "assistant") {
      for (const c of message.content) if (c.type === "toolCall") requests.set(c.id, structuredClone(c.arguments));
    } else if (message.role === "toolResult") {
      const operation = QUERY_OPERATIONS[message.toolName];
      if (operation) queries.push({ operation, request: requests.get(message.toolCallId) ?? null,
        isError: message.isError, result: message.isError ? textContent(message) : structuredResult(textContent(message)) });
      else if (message.isError) validationFeedback.push(textContent(message));
    }
  }
  // Without retrieval, retain the existing one-shot channel correction contract.
  if (!queries.length) return { ...context, messages: context.messages.map(m => m === first ? initial : m) };
  return { ...context, messages: [initial, { role: "user", timestamp: Date.now(), content: JSON.stringify({
    protocol: "supervisor-decision-handoff-1", queriesClosed: true, queries,
    ...(validationFeedback.length ? { validationFeedback } : {}),
    instruction: `${DECISION_INSTRUCTION}这些是已完成查询的只读快照，不是工具调用或新权限；快照中的剩余额度仅记录查询当时的状态。错误或截断不表示原文没有相关内容。证据号、引文和作用范围保持不变。`,
  }) }] };
}
