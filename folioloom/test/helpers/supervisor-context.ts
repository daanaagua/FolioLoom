import type { Context } from "@earendil-works/pi-ai";

/** Test readers support query turns and the readonly final-decision packet. */
export function supervisorQueryResults(context: Context): { isError: boolean; result: any }[] {
  const text = (m: Context["messages"][number]) => typeof m.content === "string" ? m.content
    : m.content.filter(c => c.type === "text").map(c => c.text).join("\n");
  const handoff = context.messages.filter(m => m.role === "user").map(m => {
    try { return JSON.parse(text(m)); } catch { return undefined; }
  }).find(p => p?.protocol === "supervisor-decision-handoff-1");
  return handoff?.queries ?? context.messages.flatMap(m => m.role === "toolResult"
    ? [{ isError: m.isError, result: JSON.parse(text(m)) }] : []);
}
