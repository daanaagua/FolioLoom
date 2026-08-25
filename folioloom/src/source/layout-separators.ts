/**
 * Some text extractions encode a scene break as the literal token `[[]]`.
 * It is source layout, not prose: keep it in the certified source ledger, but
 * force the following scene into a fresh translation block and never expose
 * the extraction token in Chinese output.
 */
const EMBEDDED_SCENE_SEPARATOR = /\[\[\]\]/gu;

export interface EmbeddedSceneSeparatorSpan {
  utf16Start: number;
  utf16End: number;
}

export function embeddedSceneSeparatorSpans(
  text: string,
): EmbeddedSceneSeparatorSpan[] {
  return [...text.matchAll(EMBEDDED_SCENE_SEPARATOR)].flatMap((match) => (
    match.index === undefined
      ? []
      : [{ utf16Start: match.index, utf16End: match.index + match[0].length }]
  ));
}

export function embeddedSceneSeparatorEndOffsets(text: string): number[] {
  return embeddedSceneSeparatorSpans(text).map((span) => span.utf16End);
}

export function normalizeSourceSceneSeparators(text: string): string {
  return text.replace(/\[\[\]\]/gu, "\n\n");
}

/**
 * Project certified source into the exact prose visible to a model. Extraction
 * layout tokens remain in the lossless ledger and hashes, while internal scene
 * breaks become paragraphs and edge-only breaks disappear from the prompt.
 */
export function sourceTextForTranslation(text: string): string {
  return normalizeSourceSceneSeparators(text).trim();
}

export function normalizeTranslatedSceneSeparators(
  text: string,
  _sourceText: string | undefined,
): string {
  // Source layout is projected before every model call. A bracket token in a
  // response is therefore ambiguous user content, never safe to delete by
  // position. The validator reports source-shaped extraction-token leakage so
  // the model can repair it from the projected paragraph boundary instead.
  return text;
}
