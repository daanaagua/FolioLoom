import type { V4Block } from "../domain/types.js";
import { getSourceLanguageProfile } from "../language/profiles.js";
import type { SourceLanguageProfile } from "../language/types.js";
import type { TranslationCandidate } from "../tools/candidate-collector.js";
import type { ValidationFailure } from "../tools/repair-tools.js";

export interface TranslationValidation {
  valid: boolean;
  failures: ValidationFailure[];
}

export interface TranslationValidationPolicy {
  allowedLatinTokens?: readonly string[];
  requiredTerms?: readonly { sourceForm: string; target: string }[];
  sourceLanguageProfile?: SourceLanguageProfile;
}

function paragraphCount(text: string): number {
  return text
    .split(/(?:\r?\n)[\t ]*(?:\r?\n)+/u)
    .map((item) => item.trim())
    .filter(Boolean)
    .length;
}

function meaningfulLength(text: string): number {
  return text.replace(/\s+/gu, "").length;
}

const SYSTEM_LEAK_PATTERNS = [
  /["']systemPrompt["']\s*:/iu,
  /["']reasoning_content["']\s*:/iu,
  /<\/?tool_call>/iu,
  /["']toolCallId["']\s*:/iu,
  /\{\s*["']translations["']\s*:/iu,
];

function isolatedSourceIdentifiers(sourceText: string): string[] {
  return sourceText.split(/\r?\n/u).flatMap((line) => {
    const value = line.trim();
    if (!/^[\p{L}\p{N}_@.+-]{2,64}$/u.test(value)) {
      return [];
    }
    const looksIdentifierLike = /\p{Ll}\p{Lu}/u.test(value)
      || /[\p{N}_@.+-]/u.test(value);
    return looksIdentifierLike ? [value] : [];
  });
}

export class TranslationValidator {
  validate(
    blocks: readonly V4Block[],
    candidate: TranslationCandidate,
    policy: TranslationValidationPolicy = {},
  ): TranslationValidation {
    const failures: ValidationFailure[] = [];
    const expectedIds = blocks.map((block) => block.id);
    const actualIds = candidate.translations.map((item) => item.blockId);
    const actualSet = new Set(actualIds);
    const duplicates = actualIds.filter((id, index) => actualIds.indexOf(id) !== index);
    const missing = expectedIds.filter((id) => !actualSet.has(id));
    const extra = [...actualSet].filter((id) => !expectedIds.includes(id));
    if (duplicates.length > 0 || missing.length > 0 || extra.length > 0) {
      failures.push({
        code: "block_set_mismatch",
        message: `expected exact block set; missing=${missing.join(",") || "none"}; extra=${extra.join(",") || "none"}; duplicates=${[...new Set(duplicates)].join(",") || "none"}`,
        repairable: true,
      });
    }

    const sourceText = blocks.map((block) => block.sourceText).join("\n");
    const targetText = candidate.translations.map((item) => item.text).join("\n");
    const sourceClosingExcess = Math.max(
      0,
      [...sourceText.matchAll(/”/gu)].length - [...sourceText.matchAll(/“/gu)].length,
    );
    const targetClosingExcess = Math.max(
      0,
      [...targetText.matchAll(/”/gu)].length - [...targetText.matchAll(/“/gu)].length,
    );
    if (targetClosingExcess > sourceClosingExcess) {
      failures.push({
        code: "quote_boundary_mismatch",
        message: `target has ${targetClosingExcess} excess closing double quotes; source boundary allowance is ${sourceClosingExcess}`,
        repairable: true,
      });
    }
    if (/["‛‟〝〞„]/u.test(targetText)) {
      failures.push({
        code: "nonstandard_quote_glyph",
        message: "translation contains nonstandard double-quote glyphs",
        repairable: true,
      });
    }

    const blockById = new Map(blocks.map((block) => [block.id, block]));
    const profile = policy.sourceLanguageProfile ?? getSourceLanguageProfile("en");
    let sourceLength = 0;
    let targetLength = 0;
    for (const translation of candidate.translations) {
      const source = blockById.get(translation.blockId);
      if (typeof translation.text !== "string" || translation.text.trim().length === 0) {
        failures.push({
          code: "empty_translation",
          blockId: translation.blockId,
          message: "translation is empty",
          repairable: true,
        });
        continue;
      }
      if (SYSTEM_LEAK_PATTERNS.some((pattern) => pattern.test(translation.text))) {
        failures.push({
          code: "system_json_leak",
          blockId: translation.blockId,
          message: "translation contains system/tool protocol material",
          repairable: true,
        });
      }
      const untranslated = profile.detectSourceResidue(translation.text, {
        preservedSourceForms: [
          ...(policy.allowedLatinTokens ?? []),
          ...(source === undefined ? [] : isolatedSourceIdentifiers(source.sourceText)),
        ],
      });
      if (untranslated.length > 0) {
        failures.push({
          code: "untranslated_latin",
          blockId: translation.blockId,
          message: `unexpected source-language prose tokens: ${[
            ...new Set(untranslated.map((finding) => finding.form)),
          ].join(", ")}`,
          repairable: true,
        });
      }
      if (source === undefined) {
        continue;
      }
      for (const term of policy.requiredTerms ?? []) {
        if (source.sourceText.toLocaleLowerCase().includes(
          term.sourceForm.toLocaleLowerCase(),
        ) && !translation.text.includes(term.target)) {
          failures.push({
            code: "stable_term_mismatch",
            blockId: translation.blockId,
            message: `source form ${term.sourceForm} requires run-local target ${term.target}`,
            repairable: true,
          });
        }
      }
      const sourceParagraphs = paragraphCount(source.sourceText);
      const targetParagraphs = paragraphCount(translation.text);
      const minimumParagraphs = Math.max(1, Math.ceil(sourceParagraphs * 0.5));
      const maximumParagraphs = Math.max(2, sourceParagraphs * 2);
      if (targetParagraphs < minimumParagraphs || targetParagraphs > maximumParagraphs) {
        failures.push({
          code: "paragraph_count_incompatible",
          blockId: translation.blockId,
          message: `source paragraphs=${sourceParagraphs}, target paragraphs=${targetParagraphs}`,
          repairable: true,
        });
      }
      sourceLength += meaningfulLength(source.sourceText);
      targetLength += meaningfulLength(translation.text);
    }

    if (sourceLength > 0 && targetLength / sourceLength < 0.15) {
      failures.push({
        code: "abnormal_shortening",
        message: `target/source character ratio ${(targetLength / sourceLength).toFixed(3)} is below 0.15`,
        repairable: true,
      });
    }
    if (sourceLength > 0 && targetLength / sourceLength > 2) {
      failures.push({
        code: "abnormal_expansion",
        message: `target/source character ratio ${(targetLength / sourceLength).toFixed(3)} exceeds 2.0`,
        repairable: true,
      });
    }
    return { valid: failures.length === 0, failures };
  }
}
