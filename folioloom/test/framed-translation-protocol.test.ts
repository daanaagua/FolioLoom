import assert from "node:assert/strict";
import test from "node:test";

import {
  createFramedTranslationProtocol,
  parseFramedTranslationResponse,
} from "../src/agents/framed-translation-protocol.js";

const input = {
  requestId: "request-fixture",
  snapshotId: "snapshot-fixture",
  blockIds: ["block-0", "block-1"],
};

test("framed attempts use independent 128-bit random nonces", () => {
  const first = createFramedTranslationProtocol(input);
  const second = createFramedTranslationProtocol(input);

  assert.match(first.nonce, /^[0-9a-f]{32}$/u);
  assert.match(second.nonce, /^[0-9a-f]{32}$/u);
  assert.notEqual(first.nonce, second.nonce);
});

test("framed translation protocol round-trips raw Chinese quotes and newlines", () => {
  const protocol = createFramedTranslationProtocol(input);
  const [first, second] = protocol.frames;
  assert.ok(first && second);
  const response = [
    first.beginLine,
    "他说：“这不是 JSON 字符串。”",
    "",
    "第二段仍属于同一个文本块。",
    first.endLine,
    second.beginLine,
    "尾声。",
    second.endLine,
  ].join("\n");

  const parsed = parseFramedTranslationResponse(response, protocol);

  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.translations, [{
    blockId: "block-0",
    text: "他说：“这不是 JSON 字符串。”\n\n第二段仍属于同一个文本块。",
  }, {
    blockId: "block-1",
    text: "尾声。",
  }]);
});

test("a marker with the wrong request nonce cannot terminate a frame", () => {
  const protocol = createFramedTranslationProtocol(input);
  const first = protocol.frames[0]!;
  const response = [
    first.beginLine,
    "正文。",
    "@@FOLIOLOOM:framed-v1:deadbeefdeadbeef:END:block-0@@",
    first.endLine,
  ].join("\n");

  const parsed = parseFramedTranslationResponse(response, protocol);

  assert.ok(parsed.errors.some((error) => /unexpected FolioLoom marker/u.test(error)));
  assert.deepEqual(parsed.translations, []);
});

test("duplicate, unknown, and missing frames are rejected as structural errors", () => {
  const protocol = createFramedTranslationProtocol(input);
  const first = protocol.frames[0]!;
  const duplicate = [
    first.beginLine,
    "第一次。",
    first.endLine,
    first.beginLine,
    "第二次。",
    first.endLine,
  ].join("\n");

  const parsed = parseFramedTranslationResponse(duplicate, protocol);

  assert.ok(parsed.errors.some((error) => /duplicate frame/u.test(error)));
  assert.ok(parsed.errors.some((error) => /missing frame.*block-1/u.test(error)));
  assert.deepEqual(parsed.translations, []);
});

