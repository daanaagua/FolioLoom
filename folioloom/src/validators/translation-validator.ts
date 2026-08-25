import type { V4Block } from "../domain/types.js";
import { getSourceLanguageProfile } from "../language/profiles.js";
import type { SourceLanguageProfile } from "../language/types.js";
import {
  doubleQuoteClosingBoundaryExcess,
  doubleQuoteClosingBoundaryExcessByText,
} from "../style/chinese-quote-normalization.js";
import {
  embeddedSceneSeparatorSpans,
  normalizeSourceSceneSeparators,
  sourceTextForTranslation,
} from "../source/layout-separators.js";
import {
  epubStructuralTranslationError,
  stripEpubStructuralMarkers,
} from "../source/epub-structure.js";
import {
  alignmentFingerprint,
  hanGraphemeLength,
  hasSemanticText,
  hasInvalidUnicodeScalar,
  hasProhibitedFormatControl,
  letterGraphemeLength,
  semanticCharacterLength,
} from "../text/semantic-text.js";
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

function semanticParagraphs(text: string, sourceLayout: boolean): string[] {
  const withoutEpubMarkers = stripEpubStructuralMarkers(text);
  return (sourceLayout ? normalizeSourceSceneSeparators(withoutEpubMarkers) : withoutEpubMarkers)
    .split(/(?:\r?\n)[\t ]*(?:\r?\n)+/u)
    .filter(hasSemanticText);
}

function paragraphCount(text: string, sourceLayout: boolean): number {
  return semanticParagraphs(text, sourceLayout).length;
}

function meaningfulLength(text: string): number {
  return semanticCharacterLength(text);
}

const MIN_CROSS_BLOCK_PARAGRAPH_CHARACTERS = 48;

function normalizedLongParagraphs(text: string, sourceLayout: boolean): Set<string> {
  return new Set(semanticParagraphs(text, sourceLayout)
    .map(alignmentFingerprint)
    .filter((paragraph) => (
      [...paragraph].length >= MIN_CROSS_BLOCK_PARAGRAPH_CHARACTERS
    )));
}

interface BoundaryOverlap {
  paragraphCount: number;
  averageContainment: number;
  minimumContainment: number;
  matchedCharacters: number;
}

function characterBigrams(text: string): Set<string> {
  const characters = [...alignmentFingerprint(text)];
  const grams = new Set<string>();
  for (let index = 0; index + 1 < characters.length; index += 1) {
    grams.add(`${characters[index]}${characters[index + 1]}`);
  }
  return grams;
}

function ngramContainment(left: string, right: string): number {
  const leftGrams = characterBigrams(left);
  const rightGrams = characterBigrams(right);
  const denominator = Math.min(leftGrams.size, rightGrams.size);
  if (denominator === 0) return 0;
  const smaller = leftGrams.size <= rightGrams.size ? leftGrams : rightGrams;
  const larger = smaller === leftGrams ? rightGrams : leftGrams;
  let matches = 0;
  for (const gram of smaller) {
    if (larger.has(gram)) matches += 1;
  }
  return matches / denominator;
}

function nearDuplicateBoundary(
  leftText: string,
  rightText: string,
  sourceLayout: boolean,
): BoundaryOverlap | undefined {
  const left = semanticParagraphs(leftText, sourceLayout).map(alignmentFingerprint);
  const right = semanticParagraphs(rightText, sourceLayout).map(alignmentFingerprint);
  const maximum = Math.min(12, left.length, right.length);
  let best: BoundaryOverlap | undefined;
  for (let count = 1; count <= maximum; count += 1) {
    const scores: number[] = [];
    let matchedCharacters = 0;
    for (let offset = 0; offset < count; offset += 1) {
      const leftParagraph = left[left.length - count + offset] ?? "";
      const rightParagraph = right[offset] ?? "";
      scores.push(ngramContainment(leftParagraph, rightParagraph));
      matchedCharacters += Math.min(
        [...leftParagraph].length,
        [...rightParagraph].length,
      );
    }
    const averageContainment = scores.reduce((sum, score) => sum + score, 0) / count;
    const minimumContainment = Math.min(...scores);
    const qualifies = count === 1
      ? matchedCharacters >= 120 && averageContainment >= 0.78
      : count >= 3
        && matchedCharacters >= 120
        && minimumContainment >= 0.28
        && averageContainment >= 0.5;
    if (qualifies && (best === undefined || count > best.paragraphCount)) {
      best = { paragraphCount: count, averageContainment, minimumContainment, matchedCharacters };
    }
  }
  return best;
}

function ratioBoundsForLength(
  profile: SourceLanguageProfile,
  sourceLength: number,
): { min: number; max: number } | undefined {
  return [...(profile.translationLengthRatioBands ?? [])]
    .filter((band) => sourceLength >= band.minSourceCharacters)
    .sort((left, right) => right.minSourceCharacters - left.minSourceCharacters)[0];
}

const SYSTEM_LEAK_PATTERNS = [
  /["']systemPrompt["']\s*:/iu,
  /["']reasoning_content["']\s*:/iu,
  /<\/?tool_call>/iu,
  /["']toolCallId["']\s*:/iu,
  /\{\s*["']translations["']\s*:/iu,
];
const SOURCE_LAYOUT_TOKEN_PATTERN = /(?:\[[ \t]*\[[ \t]*\][ \t]*\]|［[ \t]*［[ \t]*］[ \t]*］)/u;

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

const SCIENTIFIC_EPITHET_ENDING =
  /(?:a|us|um|is|ae|ii|ensis|ense|oides|opsis|ella|iana|ianus|ianae|icus|ica|icum)$/u;

function scientificBinomialSourceForms(
  sourceText: string,
  translationText: string,
): string[] {
  const forms = new Set<string>();
  const pattern =
    /\b(?:\p{Lu}[\p{Ll}\p{M}]{2,}|\p{Lu}\.)[ \t]+\p{Ll}[\p{Ll}\p{M}-]{2,}\b/gu;
  for (const match of sourceText.matchAll(pattern)) {
    const form = match[0];
    const epithet = form.split(/[ \t]+/u).at(-1);
    if (epithet !== undefined
      && SCIENTIFIC_EPITHET_ENDING.test(epithet)
      && translationText.includes(form)) {
      forms.add(form);
    }
  }
  return [...forms];
}

export class TranslationValidator {
  validateCrossBlockAlignment(
    blocks: readonly V4Block[],
    candidate: TranslationCandidate,
  ): TranslationValidation {
    const sourceParagraphs = new Map(blocks.map((block) => [
      block.id,
      normalizedLongParagraphs(block.sourceText, true),
    ]));
    const targetParagraphs = new Map(candidate.translations.map((translation) => [
      translation.blockId,
      normalizedLongParagraphs(translation.text, false),
    ]));
    const signatureCounts = (
      paragraphsByBlock: ReadonlyMap<string, Set<string>>,
    ): Map<string, { blockIds: string[]; count: number }> => {
      const blockIdsByParagraph = new Map<string, string[]>();
      for (const [blockId, paragraphs] of paragraphsByBlock) {
        for (const paragraph of paragraphs) {
          const blockIds = blockIdsByParagraph.get(paragraph) ?? [];
          blockIds.push(blockId);
          blockIdsByParagraph.set(paragraph, blockIds);
        }
      }
      const counts = new Map<string, { blockIds: string[]; count: number }>();
      for (const blockIds of blockIdsByParagraph.values()) {
        const ordered = [...new Set(blockIds)].sort();
        if (ordered.length < 2) {
          continue;
        }
        const signature = ordered.join("\u0000");
        const previous = counts.get(signature);
        counts.set(signature, {
          blockIds: ordered,
          count: (previous?.count ?? 0) + 1,
        });
      }
      return counts;
    };
    const sourceSignatures = signatureCounts(sourceParagraphs);
    const targetSignatures = signatureCounts(targetParagraphs);
    const overlaps = new Map<string, { groups: number; maximumGroupSize: number }>();
    for (const [signature, target] of targetSignatures) {
      const groundedCount = sourceSignatures.get(signature)?.count ?? 0;
      if (target.count <= groundedCount) {
        continue;
      }
      for (const blockId of target.blockIds) {
        const previous = overlaps.get(blockId);
        overlaps.set(blockId, {
          groups: (previous?.groups ?? 0) + (target.count - groundedCount),
          maximumGroupSize: Math.max(previous?.maximumGroupSize ?? 0, target.blockIds.length),
        });
      }
    }
    const failures = [...overlaps.entries()].map(([blockId, summary]): ValidationFailure => ({
      code: "cross_block_translation_overlap",
      blockId,
      message: `target contains ${summary.groups} ungrounded repeated long paragraph group(s) spanning up to ${summary.maximumGroupSize} blocks`,
      repairable: true,
    }));
    const sourceById = new Map(blocks.map((block) => [block.id, block.sourceText]));
    const targetById = new Map(candidate.translations.map((item) => [item.blockId, item.text]));
    const orderedBlocks = [...blocks].sort((left, right) =>
      left.globalIndex - right.globalIndex || left.id.localeCompare(right.id));
    const alreadyFailed = new Set(failures.map((failure) => failure.blockId));
    for (let index = 0; index + 1 < orderedBlocks.length; index += 1) {
      const left = orderedBlocks[index] as V4Block;
      const right = orderedBlocks[index + 1] as V4Block;
      const leftTarget = targetById.get(left.id);
      const rightTarget = targetById.get(right.id);
      if (leftTarget === undefined || rightTarget === undefined) continue;
      const targetOverlap = nearDuplicateBoundary(leftTarget, rightTarget, false);
      if (targetOverlap === undefined) continue;
      const sourceOverlap = nearDuplicateBoundary(
        sourceById.get(left.id) ?? "",
        sourceById.get(right.id) ?? "",
        true,
      );
      if (sourceOverlap !== undefined
        && sourceOverlap.paragraphCount >= targetOverlap.paragraphCount
        && sourceOverlap.averageContainment >= targetOverlap.averageContainment * 0.8) {
        continue;
      }
      for (const blockId of [left.id, right.id]) {
        if (alreadyFailed.has(blockId)) continue;
        failures.push({
          code: "cross_block_translation_overlap",
          blockId,
          message: `target has an ungrounded near-duplicate boundary run spanning ${targetOverlap.paragraphCount} paragraph(s)`,
          repairable: true,
        });
        alreadyFailed.add(blockId);
      }
    }
    return { valid: failures.length === 0, failures };
  }

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
    if (/["‛‟〝〞„]/u.test(targetText)) {
      failures.push({
        code: "nonstandard_quote_glyph",
        message: "translation contains nonstandard double-quote glyphs",
        repairable: true,
      });
    }

    const blockById = new Map(blocks.map((block) => [block.id, block]));
    const orderedQuoteBlocks = [...blocks].sort((left, right) =>
      left.globalIndex - right.globalIndex || left.id.localeCompare(right.id));
    const sourceClosingExcessByBlock = new Map(
      doubleQuoteClosingBoundaryExcessByText(orderedQuoteBlocks.map((block) => block.sourceText))
        .map((excess, index) => [orderedQuoteBlocks[index]?.id ?? "", excess] as const),
    );
    const sourceWindowContainsLayoutToken = blocks.some((block) =>
      embeddedSceneSeparatorSpans(block.sourceText).length > 0);
    const profile = policy.sourceLanguageProfile ?? getSourceLanguageProfile("en");
    let sourceLength = 0;
    let targetLength = 0;
    for (const translation of candidate.translations) {
      const source = blockById.get(translation.blockId);
      if (typeof translation.text !== "string" || !hasSemanticText(translation.text)) {
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
      const semanticTargetText = stripEpubStructuralMarkers(translation.text);
      const untranslated = profile.detectSourceResidue(semanticTargetText, {
        preservedSourceForms: [
          ...(policy.allowedLatinTokens ?? []),
          ...(source === undefined ? [] : isolatedSourceIdentifiers(source.sourceText)),
          ...(source === undefined
            ? []
            : scientificBinomialSourceForms(
                stripEpubStructuralMarkers(source.sourceText),
                semanticTargetText,
              )),
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
      const epubSlotError = epubStructuralTranslationError(
        source.sourceText,
        translation.text,
      );
      if (epubSlotError !== undefined) {
        failures.push({
          code: "epub_structural_slot_mismatch",
          blockId: translation.blockId,
          message: epubSlotError,
          repairable: true,
        });
      }
      const sourceClosingExcess = sourceClosingExcessByBlock.get(source.id) ?? 0;
      const targetClosingExcess = doubleQuoteClosingBoundaryExcess([translation.text]);
      if (targetClosingExcess > sourceClosingExcess) {
        failures.push({
          code: "quote_boundary_mismatch",
          blockId: translation.blockId,
          message: `target has ${targetClosingExcess} excess closing double quotes; source boundary allowance is ${sourceClosingExcess}`,
          repairable: true,
        });
      }
      for (const term of policy.requiredTerms ?? []) {
        if (stripEpubStructuralMarkers(source.sourceText).toLocaleLowerCase().includes(
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
      const sourceParagraphItems = semanticParagraphs(source.sourceText, true);
      const targetParagraphItems = semanticParagraphs(translation.text, false);
      const sourceParagraphCount = sourceParagraphItems.length;
      const targetParagraphCount = targetParagraphItems.length;
      if (targetParagraphCount !== sourceParagraphCount) {
        failures.push({
          code: "paragraph_count_incompatible",
          blockId: translation.blockId,
          message: `source paragraphs=${sourceParagraphCount}, target paragraphs=${targetParagraphCount}; preserve one target paragraph for each source paragraph`,
          repairable: true,
        });
      } else {
        for (let paragraphIndex = 0; paragraphIndex < sourceParagraphCount; paragraphIndex += 1) {
          const paragraphSourceLength = meaningfulLength(
            sourceParagraphItems[paragraphIndex] ?? "",
          );
          const paragraphTargetLength = meaningfulLength(
            targetParagraphItems[paragraphIndex] ?? "",
          );
          const paragraphBounds = ratioBoundsForLength(profile, paragraphSourceLength);
          if (paragraphBounds === undefined || paragraphSourceLength === 0) continue;
          const paragraphRatio = paragraphTargetLength / paragraphSourceLength;
          if (paragraphRatio < paragraphBounds.min || paragraphRatio > paragraphBounds.max) {
            failures.push({
              code: "paragraph_length_incompatible",
              blockId: translation.blockId,
              message: `paragraph ${paragraphIndex + 1} target/source character ratio ${paragraphRatio.toFixed(3)} is outside ${paragraphBounds.min.toFixed(2)}-${paragraphBounds.max.toFixed(2)} for ${profile.id}`,
              repairable: true,
            });
            break;
          }
        }
      }
      if (sourceWindowContainsLayoutToken
        && SOURCE_LAYOUT_TOKEN_PATTERN.test(translation.text)) {
        failures.push({
          code: "source_layout_token_leak",
          blockId: translation.blockId,
          message: "translation contains an extraction-only source layout token; preserve the scene break as an ordinary paragraph boundary",
          repairable: true,
        });
      }
      if (translation.text.includes("\uFFFD")) {
        failures.push({
          code: "invalid_unicode_output",
          blockId: translation.blockId,
          message: "translation contains the Unicode replacement character",
          repairable: true,
        });
      }
      if (hasInvalidUnicodeScalar(translation.text)) {
        failures.push({
          code: "invalid_unicode_output",
          blockId: translation.blockId,
          message: "translation contains invalid, noncharacter, or private-use Unicode scalars",
          repairable: true,
        });
      }
      if (hasProhibitedFormatControl(translation.text)) {
        failures.push({
          code: "invalid_unicode_output",
          blockId: translation.blockId,
          message: "translation contains prohibited invisible or bidirectional format controls",
          repairable: true,
        });
      }
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(translation.text)) {
        failures.push({
          code: "invalid_unicode_output",
          blockId: translation.blockId,
          message: "translation contains prohibited Unicode control characters",
          repairable: true,
        });
      }
      const semanticSourceText = stripEpubStructuralMarkers(
        sourceTextForTranslation(source.sourceText),
      );
      const blockSourceLength = meaningfulLength(semanticSourceText);
      const blockTargetLength = meaningfulLength(semanticTargetText);
      const ratioBounds = ratioBoundsForLength(profile, blockSourceLength);
      if (ratioBounds !== undefined) {
        const ratio = blockTargetLength / blockSourceLength;
        if (ratio < ratioBounds.min) {
          failures.push({
            code: "abnormal_block_shortening",
            blockId: translation.blockId,
            message: `target/source character ratio ${ratio.toFixed(3)} is below ${ratioBounds.min.toFixed(2)} for ${profile.id}`,
            repairable: true,
          });
        } else if (ratio > ratioBounds.max) {
          failures.push({
            code: "abnormal_block_expansion",
            blockId: translation.blockId,
            message: `target/source character ratio ${ratio.toFixed(3)} exceeds ${ratioBounds.max.toFixed(2)} for ${profile.id}`,
            repairable: true,
          });
        }
        const sourceLetterLength = letterGraphemeLength(semanticSourceText);
        const targetLetterLength = letterGraphemeLength(semanticTargetText);
        if (sourceLetterLength >= 1
          && targetLetterLength / sourceLetterLength < ratioBounds.min * 0.5) {
          failures.push({
            code: "insufficient_lexical_content",
            blockId: translation.blockId,
            message: `target readable-letter ratio ${(targetLetterLength / sourceLetterLength).toFixed(3)} is below ${(ratioBounds.min * 0.5).toFixed(2)} for ${profile.id}`,
            repairable: true,
          });
        }
        const semanticOriginalSource = stripEpubStructuralMarkers(source.sourceText);
        const isolatedIdentifiers = isolatedSourceIdentifiers(semanticOriginalSource);
        const sourceIsIdentifierOnly = isolatedIdentifiers.includes(semanticOriginalSource.trim());
        if (sourceLetterLength >= 8
          && !sourceIsIdentifierOnly
          && targetLetterLength > 0
          && hanGraphemeLength(semanticTargetText) / targetLetterLength < 0.5) {
          failures.push({
            code: "target_script_mismatch",
            blockId: translation.blockId,
            message: "translation has insufficient Chinese-script prose for a zh-Hans target",
            repairable: true,
          });
        }
      }
      sourceLength += blockSourceLength;
      targetLength += blockTargetLength;
    }

    failures.push(...this.validateCrossBlockAlignment(blocks, candidate).failures);

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
