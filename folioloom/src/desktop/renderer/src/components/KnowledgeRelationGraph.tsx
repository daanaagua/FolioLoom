import { useMemo, type JSX } from "react";

import type { DesktopKnowledgeDetail } from "../../../knowledge-contracts.js";

interface KnowledgeRelationGraphProps {
  rootId: string;
  relations: DesktopKnowledgeDetail["relations"];
  expanded: boolean;
  onExpandedChange(expanded: boolean): void;
  onSelect(id: string): void;
}
interface GraphView {
  readonly nodes: readonly string[];
  readonly edges: DesktopKnowledgeDetail["relations"];
  readonly truncated: boolean;
}

const MAX_RELATION_DEPTH = 2;
const MAX_RELATION_NODES = 40;

function boundedRelations(
  rootId: string,
  relations: DesktopKnowledgeDetail["relations"],
  depth: number,
): GraphView {
  const seen = new Set<string>([rootId]);
  const queue: { id: string; depth: number }[] = [{ id: rootId, depth: 0 }];
  const edges: DesktopKnowledgeDetail["relations"][number][] = [];
  let truncated = false;

  while (queue.length > 0) {
    const current = queue.shift() as { id: string; depth: number };
    if (current.depth >= depth) continue;
    for (const relation of relations) {
      if (relation.subjectId !== current.id && relation.objectId !== current.id) continue;
      const neighbor = relation.subjectId === current.id
        ? relation.objectId
        : relation.subjectId;
      if (!edges.some((edge) =>
        edge.subjectId === relation.subjectId
        && edge.predicate === relation.predicate
        && edge.objectId === relation.objectId)) {
        edges.push(relation);
      }
      if (!seen.has(neighbor)) {
        if (seen.size >= MAX_RELATION_NODES) {
          truncated = true;
          continue;
        }
        seen.add(neighbor);
        queue.push({ id: neighbor, depth: current.depth + 1 });
      }
    }
  }

  if (relations.length > edges.length) truncated = true;
  return { nodes: [...seen], edges, truncated };
}

export function KnowledgeRelationGraph({
  rootId,
  relations,
  expanded,
  onExpandedChange,
  onSelect,
}: KnowledgeRelationGraphProps): JSX.Element {
  const graph = useMemo(
    () => boundedRelations(rootId, relations, expanded ? MAX_RELATION_DEPTH : 1),
    [expanded, relations, rootId],
  );

  if (relations.length === 0) {
    return <p className="knowledge-empty-copy">没有已记录的局部关系。</p>;
  }

  return (
    <div className="relation-neighborhood">
      <div className="relation-nodes" aria-label="局部关系节点">
        {graph.nodes.map((node) => (
          <button
            className={`relation-node${node === rootId ? " is-root" : ""}`}
            type="button"
            key={node}
            disabled={node === rootId}
            onClick={() => onSelect(node)}
          >
            {node}
          </button>
        ))}
      </div>
      <ul className="relation-edges">
        {graph.edges.map((edge, index) => (
          <li key={`${edge.subjectId}:${edge.predicate}:${edge.objectId}:${index}`}>
            <button type="button" onClick={() => onSelect(edge.subjectId)}>
              {edge.subjectId}
            </button>
            <span>{edge.predicate}</span>
            <button type="button" onClick={() => onSelect(edge.objectId)}>
              {edge.objectId}
            </button>
          </li>
        ))}
      </ul>
      {graph.truncated && !expanded ? (
        <button
          className="text-button"
          type="button"
          onClick={() => onExpandedChange(true)}
        >
          展开两层关系
        </button>
      ) : null}
      {graph.truncated && expanded ? (
        <p className="knowledge-empty-copy">还有更多关系，请用表格筛选查看。</p>
      ) : null}
    </div>
  );
}
