import type { SourceLanguageProfile } from "../language/types.js";

export interface KnowledgeImpactRevisionForms {
  readonly revisionId: string;
  readonly forms: readonly string[];
}

export interface KnowledgeImpactSourceBlock {
  readonly sourceVersion: string;
  readonly blockId: string;
  readonly sourceText: string;
}

export interface MatchedKnowledgeImpact {
  readonly revisionId: string;
  readonly sourceVersion: string;
  readonly blockId: string;
}

interface FormEntry {
  readonly form: string;
  readonly revisionIds: readonly string[];
}

interface MatcherNode {
  readonly next: Map<string, number>;
  fail: number;
  readonly outputs: number[];
}

function identifierCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}]/u.test(value);
}

function formEntries(
  revisions: readonly KnowledgeImpactRevisionForms[],
  profile: SourceLanguageProfile,
): readonly FormEntry[] {
  const revisionIdsByForm = new Map<string, Set<string>>();
  for (const revision of revisions) {
    for (const raw of revision.forms) {
      const form = profile.normalizeSourceLiteral(raw.trim());
      if ([...form].length < 2) continue;
      const revisionIds = revisionIdsByForm.get(form) ?? new Set<string>();
      revisionIds.add(revision.revisionId);
      revisionIdsByForm.set(form, revisionIds);
    }
  }
  return Object.freeze([...revisionIdsByForm].map(([form, revisionIds]) =>
    Object.freeze({
      form,
      revisionIds: Object.freeze([...revisionIds]),
    })));
}

function matcher(entries: readonly FormEntry[]): readonly MatcherNode[] {
  const nodes: MatcherNode[] = [{
    next: new Map<string, number>(),
    fail: 0,
    outputs: [],
  }];
  for (let output = 0; output < entries.length; output += 1) {
    let state = 0;
    for (const character of entries[output]!.form) {
      let next = nodes[state]!.next.get(character);
      if (next === undefined) {
        next = nodes.length;
        nodes[state]!.next.set(character, next);
        nodes.push({
          next: new Map<string, number>(),
          fail: 0,
          outputs: [],
        });
      }
      state = next;
    }
    nodes[state]!.outputs.push(output);
  }

  const queue: number[] = [];
  for (const child of nodes[0]!.next.values()) {
    queue.push(child);
  }
  for (let index = 0; index < queue.length; index += 1) {
    const state = queue[index]!;
    for (const [character, child] of nodes[state]!.next) {
      queue.push(child);
      let fallback = nodes[state]!.fail;
      while (fallback !== 0
        && !nodes[fallback]!.next.has(character)) {
        fallback = nodes[fallback]!.fail;
      }
      nodes[child]!.fail = nodes[fallback]!.next.get(character) ?? 0;
      nodes[child]!.outputs.push(
        ...nodes[nodes[child]!.fail]!.outputs,
      );
    }
  }
  return nodes;
}

/**
 * Match a whole revision batch against translated blocks in one block pass.
 *
 * Explicit source forms are compiled into an Aho-Corasick automaton, so block
 * text is normalized/segmented once and matching cost is proportional to text
 * plus emitted matches instead of revisions multiplied by blocks.
 */
export function matchKnowledgeImpacts(
  revisions: readonly KnowledgeImpactRevisionForms[],
  blocks: readonly KnowledgeImpactSourceBlock[],
  profile: SourceLanguageProfile,
): readonly MatchedKnowledgeImpact[] {
  const entries = formEntries(revisions, profile);
  if (entries.length === 0 || blocks.length === 0) return Object.freeze([]);
  const nodes = matcher(entries);
  const cjk = profile.scripts.some((script) =>
    script === "kana" || script === "hangul" || script === "han");
  const matches: MatchedKnowledgeImpact[] = [];

  for (const block of blocks) {
    const source = profile.normalizeSourceLiteral(block.sourceText);
    const sourceTokens = new Set(profile.segment(block.sourceText)
      .filter((token) => token.isWordLike)
      .map((token) => token.normalized));
    const revisionIds = new Set<string>();
    let state = 0;
    let offset = 0;
    for (const character of source) {
      while (state !== 0 && !nodes[state]!.next.has(character)) {
        state = nodes[state]!.fail;
      }
      state = nodes[state]!.next.get(character) ?? 0;
      const end = offset + character.length;
      for (const output of nodes[state]!.outputs) {
        const entry = entries[output]!;
        const start = end - entry.form.length;
        const hasBoundary = cjk
          || sourceTokens.has(entry.form)
          || (!identifierCharacter(source.at(start - 1))
            && !identifierCharacter(source.at(end)));
        if (!hasBoundary) continue;
        for (const revisionId of entry.revisionIds) {
          revisionIds.add(revisionId);
        }
      }
      offset = end;
    }
    for (const revision of revisions) {
      if (!revisionIds.has(revision.revisionId)) continue;
      matches.push(Object.freeze({
        revisionId: revision.revisionId,
        sourceVersion: block.sourceVersion,
        blockId: block.blockId,
      }));
    }
  }
  return Object.freeze(matches);
}
