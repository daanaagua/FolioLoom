import { createHash } from "node:crypto";

import { getSourceLanguageProfile } from "../language/profiles.js";
import type { SourceLanguageProfile } from "../language/types.js";
import type { SourceInput, StructureAnnotation, StructureKind } from "./types.js";
import { coordinatesFor, sourceTextFor } from "./types.js";

const AMBIGUOUS_JAPANESE_NUMERAL_HEADING = /^(?:[一二三四五六七八九十百千〇零]+|\d{1,4})$/u;
const AMBIGUOUS_STANDALONE_LATIN_NUMERAL_HEADING =
  /^(?:\d{1,4}|[IVXLCDM]+)\.?$/iu;

function hasStrongLayoutEvidence(
  lines: readonly RegExpMatchArray[],
  index: number,
): boolean {
  const previousIsBlank = index === 0 || lines[index - 1]?.[0].trim().length === 0;
  const nextIsBlank = index === lines.length - 1 || lines[index + 1]?.[0].trim().length === 0;
  return previousIsBlank && nextIsBlank;
}

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
  const lines = [...text.matchAll(/^.*$/gmu)];
  for (const [lineIndex, match] of lines.entries()) {
    if (match.index === undefined || match[0].length === 0) {
      continue;
    }
    const heading = profile.detectStructureHeading(match[0]);
    if (heading === null) {
      continue;
    }
    const title = match[0].trim();
    if (((profile.id === "ja"
      && AMBIGUOUS_JAPANESE_NUMERAL_HEADING.test(title))
      || (profile.scripts.includes("latin")
        && AMBIGUOUS_STANDALONE_LATIN_NUMERAL_HEADING.test(title)))
      && !hasStrongLayoutEvidence(lines, lineIndex)) {
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
