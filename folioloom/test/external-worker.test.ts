import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs, runMetadataForExecutionBackend } from "../src/cli.js";
import {
  parseWorkerProfile, workerRunMetadata, createExternalWorkerRuntime, externalUsage,
} from "../src/agents/external-worker.js";

const raw = {
  schema: "folioloom-worker-profile-v1", id: "test-framework", modelId: "vendor/自由模型",
  command: process.execPath, args: [], contextWindow: 64000, maxOutputTokens: 8000,
};

test("external worker flags require a profile and prohibit mixed backends", () => {
  const args = ["book", "run", "--manifest", "source.json", "--store", "book.db"];
  assert.equal(parseArgs([...args, "--worker", "external", "--worker-profile", "worker.json"]).worker, "external");
  assert.throws(() => parseArgs([...args, "--worker", "external"]), /worker-profile/);
  assert.throws(() => parseArgs([...args, "--worker-profile", "worker.json", "--config", "config.json"]), /worker-profile/);
  assert.throws(() => parseArgs([...args, "--worker", "external", "--worker-profile", "worker.json", "--config", "config.json"]), /cannot be combined/);
});

test("worker profiles accept opaque model IDs but validate capabilities and identity", () => {
  const profile = parseWorkerProfile(raw);
  assert.equal(profile.modelId, raw.modelId);
  assert.throws(() => parseWorkerProfile({ ...raw, maxOutputTokens: 64000 }), /maxOutputTokens/);
  assert.throws(() => parseWorkerProfile({ ...raw, command: "worker.cmd" }), /shell|executable/);
  const metadata = workerRunMetadata({}, profile, false);
  assert.deepEqual(workerRunMetadata(metadata, profile, true), metadata);
  assert.throws(() => workerRunMetadata(metadata, parseWorkerProfile({ ...raw, modelId: "different" }), true), /identity/);
  assert.throws(() => workerRunMetadata(metadata, parseWorkerProfile({ ...raw, args: ["different"] }), true), /identity/);
  assert.throws(() => runMetadataForExecutionBackend(metadata, "provider-api", true), /worker/);
  assert.throws(() => runMetadataForExecutionBackend({}, "external-worker", true), /resume/);
});

test("external worker sends context via stdin and maps real usage and tool output", async () => {
  const profile = parseWorkerProfile({ ...raw, args: ["-e", `
    let input = ''; process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => input += chunk);
    process.stdin.on('end', () => { const job = JSON.parse(input);
      process.stdout.write(JSON.stringify({schema: job.schema, requestId: job.requestId,
        modelId: job.modelId, output: {answer: job.messages[0].text},
        usage: {input: 100, output: 20, cacheRead: 5, cacheWrite: 0, reasoning: 3}}));
    });
  `] });
  const runtime = createExternalWorkerRuntime(profile);
  const stream = await runtime.streamFn(runtime.model, {
    messages: [{role: "user", content: "测试 ; $secret", timestamp: Date.now()}],
    tools: [{name: "submit", description: "answer", parameters: {type: "object", properties: {answer: {type: "string"}}, required: ["answer"]} as any}],
  }, {});
  const result = await stream.result();
  assert.equal(result.stopReason, "toolUse");
  assert.deepEqual(result.content[0], {type: "toolCall", id: "external-worker-tool-1", name: "submit", arguments: {answer: "测试 ; $secret"}});
  assert.equal(result.usage.totalTokens, 125);
  assert.equal(result.usage.reasoning, 3);
});

test("worker transport rejects identity mismatch, bounds output, timeout, and cancellation", async () => {
  for (const [script, timeoutMs, pattern] of [
    ["process.stdout.write(JSON.stringify({schema:'folioloom-worker-v1',requestId:'wrong'}))", 5000, /identity/],
    ["process.stdout.write('x'.repeat(9000000))", 5000, /limit/],
    ["setInterval(()=>{},1000)", 100, /timeout/],
  ] as const) {
    const runtime = createExternalWorkerRuntime(parseWorkerProfile({...raw, args: ["-e", script], timeoutMs}));
    const message = await (await runtime.streamFn(runtime.model, {messages: []}, {})).result();
    assert.equal(message.stopReason, "error");
    assert.match(message.errorMessage ?? "", pattern);
  }
  const runtime = createExternalWorkerRuntime(parseWorkerProfile(raw));
  const controller = new AbortController(); controller.abort();
  assert.equal((await (await runtime.streamFn(runtime.model, {messages: []}, {signal: controller.signal})).result()).stopReason, "aborted");
});

test("missing usage stays incomplete instead of fabricating token counts", async () => {
  const runtime = createExternalWorkerRuntime(parseWorkerProfile({...raw, args: ["-e", `
    let s=''; process.stdin.on('data',c=>s+=c); process.stdin.on('end',()=>{
      const j=JSON.parse(s); process.stdout.write(JSON.stringify({...j, output:{text:'ok'}}));
    });
  `]}));
  const message = await (await runtime.streamFn(runtime.model, {messages: []}, {})).result();
  assert.equal(message.stopReason, "stop");
  assert.equal(message.usage.totalTokens, 0);
});

test("failed model output still accounts provider usage without surfacing raw diagnostics", async () => {
  const runtime = createExternalWorkerRuntime(parseWorkerProfile({...raw, args: ["-e", `
    let s=''; process.stdin.on('data',c=>s+=c); process.stdin.on('end',()=>{
      const j=JSON.parse(s); process.stdout.write(JSON.stringify({schema:j.schema,requestId:j.requestId,modelId:j.modelId,
        error:{code:'output',message:'private manuscript and credential'},usage:{input:10,output:5,cacheRead:0,cacheWrite:0,reasoning:1}}));
    });
  `]}));
  const result = await (await runtime.streamFn(runtime.model, {messages: []}, {})).result();
  assert.equal(result.stopReason, 'error');
  assert.equal(result.usage.totalTokens, 15);
  assert.doesNotMatch(result.errorMessage ?? '', /private|credential/);
  assert.equal(externalUsage({input:10,output:5,cacheRead:0,cacheWrite:0,reasoning:20}).totalTokens, 0);
});
