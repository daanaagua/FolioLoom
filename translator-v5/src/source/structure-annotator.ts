import { createHash } from "node:crypto";

import { getSourceLanguageProfile } from "../language/profiles.js";
import type { SourceLanguageProfile } from "../language/types.js";
import type { SourceInput, StructureAnnotation, StructureKind } from "./types.js";
import { coordinatesFor, sourceTextFor } from "./types.js";

function annotationId(
  sourceVersion: string,
  kind: StructureKind,
  start: number,
  end: number,
): string {
  return `structure-${createHash("sha256")
    .update(`${sourceVersion}\0${kind}\0${start}\0${end}`)
    .digest("hex")
    .slice(0, 20)}`;
}

export function annotateStructure(
  source: SourceInput,
  sourceVersion: string,
  profile: SourceLanguageProfile = getSourceLanguageProfile("en"),
): StructureAnnotation[] {
  if (sourceVersion.trim().length === 0) {
    throw new TypeError("sourceVersion must not be empty");
  }
  const text = sourceTextFor(source);
  const coordinates = coordinatesFor(source);
  const annotations: StructureAnnotation[] = [];
  for (const match of text.matchAll(/^.*$/gmu)) {
    if (match.index === undefined || match[0].length === 0) {
      continue;
    }
    const heading = profile.detectStructureHeading(match[0]);
    if (heading === null) {
      continue;
    }
    const start = coordinates.toScalarIndex(match.index);
    const end = coordinates.toScalarIndex(match.index + match[0].length);
    annotations.push({
      id: annotationId(sourceVersion, heading.kind, start, end),
      kind: heading.kind,
      start,
      end,
      title: heading.title,
      boundaryWeight: heading.boundaryWeight,
    });
  }
  return annotations.sort((left, right) => (
    left.start - right.start
    || left.end - right.end
    || left.kind.localeCompare(right.kind)
  ));
}
