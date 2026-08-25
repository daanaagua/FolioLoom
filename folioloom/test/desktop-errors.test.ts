import assert from "node:assert/strict";
import test from "node:test";

import { toDesktopError } from "../src/desktop/desktop-errors.js";

test("desktop errors turn provider failures into actionable Chinese messages", () => {
  const error = Object.assign(new Error("request failed"), { code: "AUTH_INVALID" });

  assert.deepEqual(toDesktopError(error), {
    code: "AUTH_INVALID",
    message: "API Key 无效或已失效",
    nextAction: "请检查密钥是否完整，并确认它属于当前选择的服务商。",
    retryable: false,
    technicalDetails: "request failed",
  });
});

test("desktop errors redact credentials and URL queries from technical details", () => {
  const apiKey = "sk-sensitive-desktop-key";
  const error = Object.assign(new Error(
    `Authorization: Bearer ${apiKey}; https://gateway.example/v1?api_key=${apiKey}`,
  ), { code: "RATE_LIMITED" });

  const result = toDesktopError(error);
  assert.equal(result.code, "RATE_LIMITED");
  assert.equal(result.retryable, true);
  assert.match(result.message, /请求过于频繁/u);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(apiKey));
  assert.doesNotMatch(result.technicalDetails ?? "", /api_key=/u);
});

test("desktop errors redact JSON and header-style API key fields", () => {
  const secrets = ["json-header-secret-123", "camel-case-secret-456", "authorization-secret-789"];
  const error = new Error([
    `headers={"x-api-key":"${secrets[0]}","apiKey":"${secrets[1]}"}`,
    `{"Authorization":"Bearer ${secrets[2]}"}`,
  ].join(" "));

  const result = toDesktopError(error);
  for (const secret of secrets) {
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  }
  assert.match(result.technicalDetails ?? "", /\[REDACTED\]/u);
});

test("unknown desktop errors keep a stable public code and sanitized details", () => {
  const result = toDesktopError(new Error("unexpected internal failure"));

  assert.equal(result.code, "DESKTOP_ERROR");
  assert.equal(result.message, "操作没有完成");
  assert.equal(result.retryable, false);
  assert.equal(result.technicalDetails, "unexpected internal failure");
});

test("known knowledge import failures remain actionable across the IPC boundary", () => {
  assert.deepEqual(
    toDesktopError(new Error("KNOWLEDGE_IMPORT_ALREADY_COMMITTED")),
    {
      code: "KNOWLEDGE_IMPORT_ALREADY_COMMITTED",
      message: "这份知识已经导入",
      nextAction: "如需再次导入，请先撤销上一次导入，或修改文件内容。",
      retryable: false,
      technicalDetails: "KNOWLEDGE_IMPORT_ALREADY_COMMITTED",
    },
  );
  assert.deepEqual(
    toDesktopError(new Error("KNOWLEDGE_IMPORT_BATCH_NOT_STAGED")),
    {
      code: "KNOWLEDGE_IMPORT_BATCH_NOT_STAGED",
      message: "这项暂存导入已经失效",
      nextAction: "请重新选择知识文件开始导入。",
      retryable: false,
      technicalDetails: "KNOWLEDGE_IMPORT_BATCH_NOT_STAGED",
    },
  );
});

test("retired DeepSeek routes receive a current-model recovery action", () => {
  const error = Object.assign(new Error("DEEPSEEK_MODEL_RETIRED"), {
    code: "DEEPSEEK_MODEL_RETIRED",
  });
  const result = toDesktopError(error);
  assert.equal(result.code, "DEEPSEEK_MODEL_RETIRED");
  assert.match(result.message, /旧模型路由/u);
  assert.match(result.nextAction ?? "", /deepseek-v4-flash/u);
  assert.match(result.nextAction ?? "", /deepseek-v4-pro/u);
});
