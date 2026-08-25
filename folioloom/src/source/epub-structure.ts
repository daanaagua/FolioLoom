const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "caption", "dd", "details", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tbody", "td",
  "tfoot", "th", "thead", "tr", "ul",
]);
const IGNORED_TAGS = new Set(["script", "style", "template"]);
const BREAK_TAGS = new Set(["br"]);

interface XmlTextNode {
  readonly kind: "text";
  readonly start: number;
  readonly end: number;
  readonly parent: XmlElementNode;
}

interface XmlElementNode {
  readonly kind: "element";
  readonly name: string;
  readonly localName: string;
  readonly openStart: number;
  readonly openEnd: number;
  closeStart: number;
  closeEnd: number;
  readonly parent?: XmlElementNode;
  readonly children: Array<XmlElementNode | XmlTextNode>;
}

interface TextRange {
  readonly start: number;
  readonly end: number;
}

export interface EpubXhtmlSlot {
  readonly id: string;
  readonly kind: "text" | "break";
  readonly openMarker: string;
  readonly closeMarker: string;
  readonly sourceText: string;
  /** Offsets are internal rewrite coordinates and deliberately contain no EPUB link data. */
  readonly range?: TextRange;
}

export interface EpubXhtmlBlock {
  readonly ordinal: number;
  readonly sourceText: string;
  readonly slots: readonly EpubXhtmlSlot[];
  readonly plainTextRange?: TextRange;
}

export interface EpubXhtmlAnalysis {
  readonly schema: "folioloom-epub-xhtml-slots-v1";
  readonly documentOrdinal: number;
  readonly canonicalText: string;
  readonly blocks: readonly EpubXhtmlBlock[];
}

function structuralError(message: string): never {
  throw new Error(`EPUB_STRUCTURAL_SLOT_MISMATCH: ${message}`);
}

function xmlError(message: string): never {
  throw new Error(`EPUB_XHTML_UNSUPPORTED: ${message}`);
}

function localName(name: string): string {
  const separator = name.lastIndexOf(":");
  return (separator < 0 ? name : name.slice(separator + 1)).toLocaleLowerCase("en");
}

function scanTagEnd(xml: string, start: number): number {
  let quote: "'" | "\"" | undefined;
  for (let index = start + 1; index < xml.length; index += 1) {
    const character = xml[index]!;
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
    } else if (character === ">") {
      return index + 1;
    }
  }
  return xmlError("unterminated XML tag");
}

function scanDeclarationEnd(xml: string, start: number): number {
  let quote: "'" | "\"" | undefined;
  let bracketDepth = 0;
  for (let index = start + 2; index < xml.length; index += 1) {
    const character = xml[index]!;
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
    } else if (character === "[") {
      bracketDepth += 1;
    } else if (character === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (character === ">" && bracketDepth === 0) {
      return index + 1;
    }
  }
  return xmlError("unterminated XML declaration");
}

function elementName(tag: string): string {
  const match = /^<\s*([^\s/>]+)/u.exec(tag);
  return match?.[1] ?? xmlError("element has no name");
}

function closingName(tag: string): string {
  const match = /^<\s*\/\s*([^\s>]+)/u.exec(tag);
  return match?.[1] ?? xmlError("closing element has no name");
}

function parseXmlTree(xml: string): XmlElementNode {
  const document: XmlElementNode = {
    kind: "element",
    name: "#document",
    localName: "#document",
    openStart: 0,
    openEnd: 0,
    closeStart: xml.length,
    closeEnd: xml.length,
    children: [],
  };
  const stack: XmlElementNode[] = [document];
  let cursor = 0;
  while (cursor < xml.length) {
    const open = xml.indexOf("<", cursor);
    const textEnd = open < 0 ? xml.length : open;
    if (textEnd > cursor) {
      const parent = stack.at(-1)!;
      parent.children.push({
        kind: "text",
        start: cursor,
        end: textEnd,
        parent,
      });
    }
    if (open < 0) break;
    if (xml.startsWith("<!--", open)) {
      const end = xml.indexOf("-->", open + 4);
      if (end < 0) xmlError("unterminated XML comment");
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", open)) {
      return xmlError("CDATA in translatable XHTML is unsupported");
    }
    if (xml.startsWith("<?", open)) {
      const end = xml.indexOf("?>", open + 2);
      if (end < 0) xmlError("unterminated processing instruction");
      cursor = end + 2;
      continue;
    }
    if (xml.startsWith("<!", open)) {
      cursor = scanDeclarationEnd(xml, open);
      continue;
    }
    const end = scanTagEnd(xml, open);
    const tag = xml.slice(open, end);
    if (/^<\s*\//u.test(tag)) {
      const name = closingName(tag);
      const node = stack.pop();
      if (node === undefined || node === document || node.name !== name) {
        return xmlError(`unbalanced closing tag ${name}`);
      }
      node.closeStart = open;
      node.closeEnd = end;
    } else {
      const name = elementName(tag);
      const parent = stack.at(-1)!;
      const node: XmlElementNode = {
        kind: "element",
        name,
        localName: localName(name),
        openStart: open,
        openEnd: end,
        closeStart: end,
        closeEnd: end,
        parent,
        children: [],
      };
      parent.children.push(node);
      if (!/\/\s*>$/u.test(tag)) stack.push(node);
    }
    cursor = end;
  }
  if (stack.length !== 1) {
    return xmlError(`unclosed element ${stack.at(-1)?.name ?? "(unknown)"}`);
  }
  return document;
}

function findElement(node: XmlElementNode, target: string): XmlElementNode | undefined {
  for (const child of node.children) {
    if (child.kind !== "element") continue;
    if (child.localName === target) return child;
    const nested = findElement(child, target);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function hasBlockDescendant(node: XmlElementNode): boolean {
  return node.children.some((child) =>
    child.kind === "element"
    && (BLOCK_TAGS.has(child.localName) || hasBlockDescendant(child)));
}

function visibleCore(xml: string, range: TextRange): {
  readonly sourceText: string;
  readonly range: TextRange;
} | undefined {
  const lexical = xml.slice(range.start, range.end);
  const leading = /^\s*/u.exec(lexical)?.[0].length ?? 0;
  const trailing = /\s*$/u.exec(lexical)?.[0].length ?? 0;
  const end = Math.max(leading, lexical.length - trailing);
  if (end <= leading) return undefined;
  const core = lexical.slice(leading, end);
  return {
    sourceText: decodeXmlText(core),
    range: { start: range.start + leading, end: range.start + end },
  };
}

function textPart(
  xml: string,
  range: TextRange,
): { readonly kind: "text"; readonly sourceText: string; readonly range: TextRange } {
  return {
    kind: "text",
    sourceText: decodeXmlText(xml.slice(range.start, range.end)),
    range: { start: range.start, end: range.end },
  };
}

function decodeXmlText(value: string): string {
  const decoded = value.replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z][\da-z]+));/giu, (
    entity,
    decimal: string | undefined,
    hexadecimal: string | undefined,
    named: string | undefined,
  ) => {
    if (decimal !== undefined) return String.fromCodePoint(Number.parseInt(decimal, 10));
    if (hexadecimal !== undefined) return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
    switch (named?.toLocaleLowerCase("en")) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return "\"";
      case "apos": return "'";
      case "nbsp": return "\u00A0";
      default: return xmlError(`unsupported named entity ${entity}`);
    }
  });
  if (/&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);/iu.test(decoded)) {
    return xmlError("unresolved entity in XHTML text");
  }
  return decoded;
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function collectLeafBlocks(node: XmlElementNode, target: XmlElementNode[]): void {
  for (const child of node.children) {
    if (child.kind !== "element" || IGNORED_TAGS.has(child.localName)) continue;
    if (BLOCK_TAGS.has(child.localName) && !hasBlockDescendant(child)) {
      target.push(child);
    } else {
      collectLeafBlocks(child, target);
    }
  }
}

function collectSlotParts(
  xml: string,
  node: XmlElementNode,
  parts: Array<
    | { readonly kind: "text"; readonly sourceText: string; readonly range: TextRange }
    | { readonly kind: "break"; readonly sourceText: "\n" }
  >,
): void {
  for (const child of node.children) {
    if (child.kind === "text") {
      parts.push(textPart(xml, child));
      continue;
    }
    if (IGNORED_TAGS.has(child.localName)) continue;
    if (BREAK_TAGS.has(child.localName)) {
      parts.push({ kind: "break", sourceText: "\n" });
      continue;
    }
    collectSlotParts(xml, child, parts);
  }
}

function trimOuterSlotWhitespace(
  parts: Array<
    | { readonly kind: "text"; sourceText: string; range: TextRange }
    | { readonly kind: "break"; readonly sourceText: "\n" }
  >,
): void {
  const textIndexes = parts.flatMap((part, index) => part.kind === "text" ? [index] : []);
  const firstIndex = textIndexes[0];
  const lastIndex = textIndexes.at(-1);
  if (firstIndex !== undefined) {
    const first = parts[firstIndex]!;
    if (first.kind === "text") {
      const leading = /^\s*/u.exec(first.sourceText)?.[0].length ?? 0;
      first.sourceText = first.sourceText.slice(leading);
      first.range = { start: first.range.start + leading, end: first.range.end };
    }
  }
  if (lastIndex !== undefined) {
    const last = parts[lastIndex]!;
    if (last.kind === "text") {
      const trailing = /\s*$/u.exec(last.sourceText)?.[0].length ?? 0;
      last.sourceText = last.sourceText.slice(0, last.sourceText.length - trailing);
      last.range = { start: last.range.start, end: last.range.end - trailing };
    }
  }
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]!;
    if (part.kind === "text" && part.sourceText.length === 0) {
      parts.splice(index, 1);
    }
  }
}

function directVisibleTextOutsideNestedBlocks(xml: string, node: XmlElementNode): boolean {
  return node.children.some((child) => {
    if (child.kind === "text") return visibleCore(xml, child) !== undefined;
    return child.kind === "element"
      && !IGNORED_TAGS.has(child.localName)
      && !BLOCK_TAGS.has(child.localName)
      && directVisibleTextOutsideNestedBlocks(xml, child);
  });
}

function validateContainerShape(xml: string, node: XmlElementNode): void {
  if (BLOCK_TAGS.has(node.localName)
    && hasBlockDescendant(node)
    && directVisibleTextOutsideNestedBlocks(xml, node)) {
    xmlError(`mixed direct text and nested blocks in <${node.name}>`);
  }
  for (const child of node.children) {
    if (child.kind === "element" && !IGNORED_TAGS.has(child.localName)) {
      validateContainerShape(xml, child);
    }
  }
}

function marker(id: string, closing: boolean): string {
  return `⟦${closing ? "/" : ""}${id}⟧`;
}

export function stripEpubStructuralMarkers(text: string): string {
  return text.replace(/⟦\/?E\d+\.\d+\.\d+⟧/gu, "");
}

function structuralMarkers(text: string): string[] {
  return [...text.matchAll(/⟦\/?E\d+\.\d+\.\d+⟧/gu)].map((match) => match[0]);
}

function paragraphs(text: string): string[] {
  return text.split(/(?:\r?\n)[\t ]*(?:\r?\n)+/u);
}

export function epubStructuralTranslationError(
  sourceText: string,
  targetText: string,
): string | undefined {
  const sourceMarkers = structuralMarkers(sourceText);
  const targetMarkers = structuralMarkers(targetText);
  if (sourceMarkers.length !== targetMarkers.length
    || sourceMarkers.some((item, index) => item !== targetMarkers[index])) {
    return `expected markers ${sourceMarkers.join(" ")}; received ${targetMarkers.join(" ")}`;
  }
  if (sourceMarkers.length === 0) return undefined;
  const sourceParagraphs = paragraphs(sourceText);
  const targetParagraphs = paragraphs(targetText);
  if (sourceParagraphs.length !== targetParagraphs.length) {
    return "source and target paragraph counts differ around structural slots";
  }
  for (let paragraphIndex = 0; paragraphIndex < sourceParagraphs.length; paragraphIndex += 1) {
    const sourceParagraph = sourceParagraphs[paragraphIndex] ?? "";
    const expected = structuralMarkers(sourceParagraph);
    if (expected.length === 0) continue;
    if (expected.length % 2 !== 0) {
      return `source paragraph ${paragraphIndex + 1} has an incomplete slot pair`;
    }
    const targetParagraph = targetParagraphs[paragraphIndex] ?? "";
    let cursor = 0;
    for (let index = 0; index < expected.length; index += 2) {
      const open = expected[index]!;
      const close = expected[index + 1]!;
      if (!close.startsWith("⟦/") || close !== open.replace("⟦", "⟦/")) {
        return `source paragraph ${paragraphIndex + 1} has a malformed slot pair`;
      }
      if (!targetParagraph.startsWith(open, cursor)) {
        return `target paragraph ${paragraphIndex + 1} has text outside or before ${open}`;
      }
      const closeAt = targetParagraph.indexOf(close, cursor + open.length);
      if (closeAt < 0) {
        return `target paragraph ${paragraphIndex + 1} is missing ${close}`;
      }
      cursor = closeAt + close.length;
    }
    if (cursor !== targetParagraph.length) {
      return `target paragraph ${paragraphIndex + 1} has text outside its structural slots`;
    }
  }
  return undefined;
}

export function analyzeEpubXhtml(
  xml: string,
  documentOrdinal: number,
): EpubXhtmlAnalysis {
  if (!Number.isSafeInteger(documentOrdinal) || documentOrdinal < 0) {
    throw new TypeError("documentOrdinal must be a non-negative safe integer");
  }
  const tree = parseXmlTree(xml);
  const body = findElement(tree, "body") ?? xmlError("XHTML has no body");
  validateContainerShape(xml, body);
  const elements: XmlElementNode[] = [];
  collectLeafBlocks(body, elements);
  if (elements.length === 0) {
    elements.push(body);
  }
  const blocks: EpubXhtmlBlock[] = [];
  for (const element of elements) {
    const parts: Array<
      | { readonly kind: "text"; readonly sourceText: string; readonly range: TextRange }
      | { readonly kind: "break"; readonly sourceText: "\n" }
    > = [];
    collectSlotParts(xml, element, parts);
    trimOuterSlotWhitespace(parts);
    if (parts.length === 0) continue;
    const hasInlineStructure = element.children.some((child) => child.kind === "element");
    const ordinal = blocks.length;
    if (!hasInlineStructure && parts.length === 1 && parts[0]!.kind === "text") {
      const plain = parts[0]!;
      blocks.push({
        ordinal,
        sourceText: plain.sourceText,
        slots: [],
        plainTextRange: plain.range,
      });
      continue;
    }
    const slots = parts.map((part, slotOrdinal): EpubXhtmlSlot => {
      const id = `E${documentOrdinal}.${ordinal}.${slotOrdinal}`;
      return {
        id,
        kind: part.kind,
        openMarker: marker(id, false),
        closeMarker: marker(id, true),
        sourceText: part.sourceText,
        ...(part.kind === "text" ? { range: part.range } : {}),
      };
    });
    blocks.push({
      ordinal,
      sourceText: slots.map((slot) =>
        `${slot.openMarker}${slot.sourceText}${slot.closeMarker}`).join(""),
      slots,
    });
  }
  return {
    schema: "folioloom-epub-xhtml-slots-v1",
    documentOrdinal,
    canonicalText: blocks.map((block) => block.sourceText).join("\n\n"),
    blocks,
  };
}

function translatedSlots(block: EpubXhtmlBlock, translated: string): readonly string[] {
  if (block.slots.length === 0) {
    if (/⟦\/?E\d+\.\d+\.\d+⟧/u.test(translated)) {
      return structuralError(`plain block ${block.ordinal} contains a slot marker`);
    }
    return [translated];
  }
  const values: string[] = [];
  let cursor = 0;
  for (const slot of block.slots) {
    const open = translated.indexOf(slot.openMarker, cursor);
    if (open !== cursor) {
      return structuralError(`block ${block.ordinal} is missing or reorders ${slot.openMarker}`);
    }
    const contentStart = open + slot.openMarker.length;
    const close = translated.indexOf(slot.closeMarker, contentStart);
    if (close < 0) {
      return structuralError(`block ${block.ordinal} is missing ${slot.closeMarker}`);
    }
    values.push(translated.slice(contentStart, close));
    cursor = close + slot.closeMarker.length;
  }
  if (cursor !== translated.length) {
    return structuralError(`block ${block.ordinal} has text or markers outside its slots`);
  }
  return values;
}

export function rewriteEpubXhtml(
  xml: string,
  analysis: EpubXhtmlAnalysis,
  translatedBlocks: readonly string[],
): string {
  if (translatedBlocks.length !== analysis.blocks.length) {
    return structuralError(
      `expected ${analysis.blocks.length} blocks, received ${translatedBlocks.length}`,
    );
  }
  const replacements: Array<{ readonly start: number; readonly end: number; readonly text: string }> = [];
  for (const [index, block] of analysis.blocks.entries()) {
    const values = translatedSlots(block, translatedBlocks[index] ?? "");
    if (block.slots.length === 0) {
      const range = block.plainTextRange
        ?? structuralError(`plain block ${block.ordinal} has no source range`);
      replacements.push({
        ...range,
        text: escapeXmlText(values[0] ?? ""),
      });
      continue;
    }
    for (const [slotIndex, slot] of block.slots.entries()) {
      const value = values[slotIndex] ?? "";
      if (slot.kind === "break") {
        if (value.trim().length > 0) {
          return structuralError(`fixed break slot ${slot.id} contains translated text`);
        }
        continue;
      }
      const range = slot.range ?? structuralError(`text slot ${slot.id} has no source range`);
      replacements.push({
        ...range,
        text: escapeXmlText(value),
      });
    }
  }
  let rewritten = xml;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    rewritten = `${rewritten.slice(0, replacement.start)}${replacement.text}${rewritten.slice(replacement.end)}`;
  }
  return rewritten;
}
