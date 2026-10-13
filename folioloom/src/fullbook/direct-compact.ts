import { readFileSync } from "node:fs";
import type { DirectName, DirectParagraph, DirectRecord } from "./direct-translation.js";
import { buildDirectPrompt, directSourceContains, relevantDirectNames, DirectOutputError } from "./direct-translation.js";
import { DIRECT_REVISION_SYSTEM_PROMPT, parseRevisionTranslation, versionedName } from "./direct-name-revisions.js";
import { stripEpubStructuralMarkers } from "../source/epub-structure.js";
import { hasInvalidUnicodeScalar, hasProhibitedFormatControl } from "../text/semantic-text.js";

export const DIRECT_COMPACT_VERSION = "direct-translation-5";
// Keep the protocol-four prompt immutable for exact resume identity.
export const DIRECT_COMPACT_SYSTEM_PROMPT = DIRECT_REVISION_SYSTEM_PROMPT.split("\n").filter(line =>
  !line.startsWith("Return JSON:") && !line.startsWith("nameUses records")).concat([
  'Return JSON: {"paragraphs":[["paragraph-id","translation"]],"names":[{"id":"new1","source":"literal source form","target":"rendering","kind":"person|place|organization|work|term","scope":"book|context","sense":"brief meaning","evidence":{"paragraphId":"id","quote":"literal source quote"}}],"nameUses":[["n0","paragraph-id"]],"nameChanges":[{"nameId":"n0","expectedRevision":1,"target":"proposed rendering","reason":"brief source-based reason","evidence":{"paragraphId":"id","quote":"literal source passage"}}]}.',
  "Only person/place/organization/work entities use scope=book. Distinctive terms MUST use kind=term, scope=context and a concise sense. Ordinary words are omitted.",
  "sharedNames use short request-local ids n0, n1, etc. New entries use new1, new2, etc. These identifiers are valid only in this request.",
  "Record each actual use as [nameId, paragraphId]. The program derives character positions; do not count characters or reproduce full objects. At most 256 uses.",
  "If the rendering differs or occurs more than once in the paragraph, use [nameId, paragraphId, exactTargetOrNull, zeroBasedOccurrence]. Null means the catalog target (or the proposed target for a nameChanges entry).",
  "If the same source spelling has distinct catalog referents, append a fifth field with a short literal source quote distinguishing this use. Omit uncertain associations; never assign an unrelated homonym.",
  "referenceNames are earlier model suggestions, not current catalog entries or user-owned rules. Consider only the matching sense. On first use return a new typed name attested to CURRENT source paragraphs; do not propose a revision to a reference with no shared id.",
]).join("\n");

export function normalizeNamingReferences(value: readonly DirectName[]): DirectName[] {
  if (!Array.isArray(value) || value.length > 10000) throw new Error("invalid naming reference list");
  const clean = (v: unknown, max: number): v is string => typeof v === "string" && !!v.trim() && v.length <= max
    && !/[\r\n\u0000-\u001f⟦⟧]/u.test(v) && !hasInvalidUnicodeScalar(v) && !hasProhibitedFormatControl(v);
  return value.map(n => {
    if (!n || !clean(n.source, 120) || !clean(n.target, 64)
      || (n.kind !== undefined && !["person", "place", "organization", "work", "term"].includes(n.kind))
      || (n.scope !== undefined && n.scope !== (n.kind === "term" ? "context" : "book"))
      || (n.kind === "term" && !clean(n.sense, 160))
      || (n.sense !== undefined && !clean(n.sense, 160))
      || (n.policy !== undefined && !["locked", "preferred"].includes(n.policy))) throw new Error("invalid naming reference entry");
    return { source: n.source.trim(), target: n.target.trim(), ...(n.kind ? { kind: n.kind } : {}),
      ...(n.scope ? { scope: n.scope } : {}), ...(n.sense ? { sense: n.sense.trim() } : {}), ...(n.policy ? { policy: n.policy } : {}) };
  });
}

export function loadNamingReferences(path: string): DirectName[] {
  const value = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/u, ""));
  if (value?.schema !== "folioloom-naming-reference-1" || !Array.isArray(value.names)
    || Object.keys(value).some(k => !["schema", "names"].includes(k))) throw new Error("invalid naming reference file");
  return normalizeNamingReferences(value.names);
}

export function buildCompactPrompt(p: DirectParagraph[], n: DirectName[], neighbors: string[], style: unknown, refs: DirectName[]): string {
  const names = n.map((name, i) => ({ ...versionedName(name), nameId: `n${i}` }));
  const result = JSON.parse(buildDirectPrompt({ paragraphs: p, names, neighbors, style, candidates: [], seed: false, typed: true, revisioned: true }));
  result.referenceNames = relevantDirectNames(refs, p).filter(r => !n.some(name => name.source === r.source));
  return JSON.stringify(result);
}

/** Expand semantic associations, then reuse the evidence/coordinate validator. No global text matching. */
export function parseCompactTranslation(raw: string, source: DirectParagraph[], shared: DirectName[]) {
  let data: any;
  try { data = JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/u, "$1")); }
  catch { throw new DirectOutputError("response is not complete JSON"); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new DirectOutputError("response is not an object");
  const catalog = shared.map(versionedName);
  const byAlias = new Map(catalog.map((n, i) => [`n${i}`, n]));
  const fullId = (id: unknown) => typeof id === "string" ? byAlias.get(id)?.nameId ?? id : id;
  const declared = Array.isArray(data.names) ? data.names : [];
  const changes = (Array.isArray(data.nameChanges) ? data.nameChanges : []).map((c: any) => ({ ...c, nameId: fullId(c?.nameId) }));
  const uses = (Array.isArray(data.nameUses) ? data.nameUses : []).map((use: any) => {
    if (!Array.isArray(use)) return { ...use, nameId: fullId(use?.nameId) };
    if (use.length < 2 || use.length > 5) return {};
    const [id, paragraphId, rendered, ordinal, quote] = use;
    const name = byAlias.get(id) ?? catalog.find(n => n.nameId === id) ?? declared.find((n: any) => n?.id === id);
    const target = rendered ?? changes.find((c: any) => c.nameId === fullId(id))?.target ?? name?.target;
    const row = Array.isArray(data.paragraphs) ? data.paragraphs.find((r: any) => Array.isArray(r) && r[0] === paragraphId) : undefined;
    let occurrence = ordinal;
    if (occurrence === undefined && typeof target === "string" && target.length && typeof row?.[1] === "string") {
      const at = row[1].indexOf(target);
      if (at >= 0 && row[1].indexOf(target, at + target.length) < 0) occurrence = 0;
    }
    const homonyms = [...catalog, ...declared].filter(n => n?.source === name?.source);
    const attestation = quote ?? (homonyms.length === 1 ? name?.source : undefined);
    return { nameId: fullId(id), paragraphId, target, occurrence, quote: attestation };
  });
  return parseRevisionTranslation(JSON.stringify({ ...data, nameUses: uses, nameChanges: changes }), source, shared);
}

/** Visible JSON estimate plus a conservative reasoning reserve; never split an original paragraph. */
export function planDirectFragments(p: DirectParagraph[], names: DirectName[], maxOutputTokens: number): DirectParagraph[][] {
  const budget = Math.max(1, Math.min(6000, Math.floor(maxOutputTokens / 4)));
  const result: DirectParagraph[][] = []; let batch: DirectParagraph[] = [], cost = 0;
  const forms = [...new Set(names.map(n => n.source))];
  for (const paragraph of p) {
    const plain = stripEpubStructuralMarkers(paragraph.source);
    const knownUses = forms.reduce((n, form) => n + (directSourceContains(plain, form) ? plain.split(form).length - 1 : 0), 0);
    const candidates = plain.match(/\b[A-Z][a-z]+\b/gu)?.length ?? 0;
    const markers = paragraph.source.length - plain.length;
    const estimate = Math.ceil(plain.length * .6 + markers / 2 + 32 + Math.max(knownUses, candidates) * 18);
    if (batch.length && (batch.length >= 24 || cost + estimate > budget)) { result.push(batch); batch = []; cost = 0; }
    batch.push(paragraph); cost += estimate;
  }
  if (batch.length) result.push(batch);
  return result;
}

export function directGenerationUsage(records: readonly DirectRecord[], windowId: string) {
  const requests = records.filter(r => r.kind === "request" && r.windowId === windowId);
  const successes = requests.filter(r => records.some(v => v.kind === "fragment_result" && v.payload.requestId === r.id && v.payload.accepted === true)).length;
  const chargedTokens = requests.reduce((n, r) => {
    const response = records.find(v => v.kind === "response" && v.payload.requestId === r.id);
    const actual = Number(response?.payload.totalTokens ?? 0), predicted = Number(r.payload.predictedTokens ?? 0);
    return n + (response?.payload.usageComplete === true ? actual : Math.max(actual, predicted));
  }, 0);
  return { requests: requests.length, successes, failures: requests.length - successes, chargedTokens };
}
