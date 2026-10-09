import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProviderRuntime } from "../src/providers/runtime.js";
import { providerRegistry } from "../src/providers/registry.js";
import { probeProviderCapabilities } from "../src/providers/capability-probe.js";
import { classifyProviderErrorMessage, ModelProviderError } from "../src/agents/pi-runtime.js";
import { toDesktopError } from "../src/desktop/desktop-errors.js";
import { runBook } from "../src/fullbook/book-runner.js";
import { importSource } from "../src/source/source-importer.js";
import { bindTaskContext } from "../src/agents/task-context.js";
import { preflightProviderStream } from "../src/providers/preflight.js";
import net from "node:net";
import tls from "node:tls";

function certificateError() {
  return new TypeError("fetch failed", { cause: Object.assign(new Error("fixture-secret certificate failure"),
    { code: "SELF_SIGNED_CERT_IN_CHAIN" }) });
}
const profile = { providerId: "deepseek" as const, modelId: "deepseek-flash", reasoningEffort: "high" as const };

test("explicit classical TLS compatibility scopes supported groups and preserves certificate/version defaults", async () => {
  const originalCurve = tls.DEFAULT_ECDH_CURVE, originalMax = tls.DEFAULT_MAX_VERSION;
  let groups: number[] | undefined;
  let versions: number[] | undefined;
  const server = net.createServer(socket => {
    let data = Buffer.alloc(0);
    socket.on("data", chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.length < 5 || data.length < 5 + data.readUInt16BE(3)) return;
      // Inspect only the public supported_groups extension of this local ClientHello.
      let p = 5 + 4 + 2 + 32;
      p += 1 + data[p]!;
      p += 2 + data.readUInt16BE(p);
      p += 1 + data[p]!;
      const end = p + 2 + data.readUInt16BE(p); p += 2;
      while (p < end) {
        const type = data.readUInt16BE(p), size = data.readUInt16BE(p + 2); p += 4;
        if (type === 10) groups = Array.from({ length: data.readUInt16BE(p) / 2 }, (_, i) => data.readUInt16BE(p + 2 + 2 * i));
        if (type === 43) versions = Array.from({ length: data[p]! / 2 }, (_, i) => data.readUInt16BE(p + 1 + 2 * i));
        p += size;
      }
      socket.destroy();
    });
    socket.on("error", () => {});
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as net.AddressInfo).port;
    const runtime = createProviderRuntime(profile, "fixture-secret", {
      trustedBaseUrl: `https://127.0.0.1:${port}`, tlsCompatibility: "classical",
    });
    await assert.rejects(runtime.preflight(AbortSignal.timeout(2_000)));
    assert.deepEqual(groups, [29, 23, 24], "only X25519, P-256 and P-384 are offered for this runtime");
    assert.ok(versions?.includes(0x0304), "TLS 1.3 remains offered");
    assert.equal(tls.DEFAULT_ECDH_CURVE, originalCurve);
    assert.equal(tls.DEFAULT_MAX_VERSION, originalMax);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("TLS compatibility is isolated across concurrent streams and unrelated fetches", async () => {
  const original = globalThis.fetch;
  const routes: Array<{ selected: boolean; dispatcher: boolean }> = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    routes.push({ selected: body.messages?.at(-1)?.content === "selected", dispatcher: !!(init as any)?.dispatcher });
    return new Response(JSON.stringify({ error: { message: "fixture", type: "rate_limit" } }), { status: 429 });
  };
  try {
    await Promise.all([true, false].map(async selected => {
      const runtime = createProviderRuntime(profile, "fixture-secret", { tlsCompatibility: selected ? "classical" : "default" });
      const stream = await runtime.streamFn(runtime.model, { messages: [{ role: "user", content: selected ? "selected" : "default", timestamp: 0 }] });
      await stream.result();
    }));
    await fetch("https://unrelated.invalid");
    assert.deepEqual(routes.toSorted((a, b) => Number(b.selected) - Number(a.selected)), [
      { selected: true, dispatcher: true }, { selected: false, dispatcher: false }, { selected: false, dispatcher: false },
    ]);
  } finally { globalThis.fetch = original; }
});

test("direct preflight rejects before opening a store or spending an attempt", async () => {
  const root = mkdtempSync(join(tmpdir(), "folioloom-direct-preflight-"));
  const source = join(root, "source.txt"), storePath = join(root, "book.db");
  writeFileSync(source, "The visitor waited by the door.", "utf8");
  const imported = await importSource({ sourcePath: source, projectDirectory: join(root, "project"), sourceLanguage: "en" });
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw certificateError(); };
  try {
    const runtime = createProviderRuntime(profile, "fixture-secret");
    await assert.rejects(runBook({ workflow: "direct", manifestPath: imported.manifestPath, storePath,
      runMeta: { runId: "direct-preflight", protocolVersion: "fixture", modelId: profile.modelId },
      model: runtime.model, streamFn: runtime.streamFn }), (e: any) => e.code === "PROVIDER_TLS");
    assert.equal(calls, 1);
    assert.equal(existsSync(storePath), false);
    assert.equal(existsSync(storePath + ".run.lock"), false);
  } finally { globalThis.fetch = original; }
});

test("certificate failures are terminal and model discovery does not mask them with fallback", async () => {
  await assert.rejects(providerRegistry.discoverModels({ profile, credential: "fixture-secret",
    fetch: async () => { throw certificateError(); } }), (error: any) => {
    assert.equal(error.code, "PROVIDER_TLS");
    assert.equal(error.retryable, false);
    assert.match(error.message, /SELF_SIGNED_CERT_IN_CHAIN/);
    assert.ok(!JSON.stringify(error).includes("fixture-secret"));
    return true;
  });
});

test("capability probes report TLS configuration failure, not retryable provider unreachability", async () => {
  const report = await probeProviderCapabilities({ profile, credential: "fixture-secret",
    fetch: async () => { throw certificateError(); } });
  assert.equal(report.code, "PROVIDER_TLS");
  assert.equal(report.status, "failed");
  assert.match(report.technicalDetails ?? report.message, /SELF_SIGNED_CERT_IN_CHAIN/);
  assert.ok(!JSON.stringify(report).includes("fixture-secret"));
});

test("Pi and desktop classify preserved TLS evidence as a non-retryable configuration error", () => {
  const message = "PROVIDER_TLS: Connection error: SELF_SIGNED_CERT_IN_CHAIN";
  assert.equal(classifyProviderErrorMessage(message), "tls");
  const error = new ModelProviderError(message);
  assert.equal(error.retryable, false);
  const publicError = toDesktopError(error);
  assert.equal(publicError.code, "PROVIDER_TLS");
  assert.match(publicError.message, /证书/);
  assert.equal(publicError.retryable, false);
});

test("native Pi streaming retains fetch TLS cause without copying secrets or making another request", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw certificateError(); };
  try {
    const runtime = createProviderRuntime(profile, "fixture-secret");
    const stream = await runtime.streamFn(runtime.model, { messages: [{ role: "user", content: "fixture", timestamp: 0 }] }, { maxRetries: 2 });
    const response = await stream.result();
    assert.equal(calls, 1);
    assert.equal(response.stopReason, "error");
    assert.match(response.errorMessage ?? "", /SELF_SIGNED_CERT_IN_CHAIN/);
    assert.ok(!JSON.stringify(response).includes("fixture-secret"));
    assert.equal(response.usage.totalTokens, 0);
  } finally { globalThis.fetch = original; }
});

test("provider startup activates environment proxies once without changing environment or trusting certificates", () => {
  const script = `
    import assert from 'node:assert/strict';
    import http from 'node:http';
    let configurations = [];
    http.setGlobalProxyFromEnv = env => { configurations.push(env); return () => {}; };
    const before = JSON.stringify(process.env);
    const { createProviderRuntime } = await import('./src/providers/runtime.ts');
    for (let i = 0; i < 2; i++) {
      const runtime = createProviderRuntime({providerId:'deepseek',modelId:'deepseek-flash'}, 'fixture-secret');
      const stream = await runtime.streamFn(runtime.model, {messages:[]}, {onPayload(){throw new Error('offline');}});
      await stream.result();
    }
    assert.equal(configurations.length, 1);
    assert.equal(configurations[0].HTTPS_PROXY, 'http://127.0.0.1:43219');
    assert.ok(configurations[0].NO_PROXY.includes('localhost'));
    assert.equal(JSON.stringify(process.env), before);
    console.log('ok');
  `;
  assert.equal(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(), env: { ...process.env, HTTP_PROXY: "http://127.0.0.1:43219", HTTPS_PROXY: "http://127.0.0.1:43219" },
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim(), "ok");
});

test("book preflight rejects TLS before creating a store, reserving tokens or dispatching a model", async () => {
  const root = mkdtempSync(join(tmpdir(), "folioloom-network-preflight-"));
  const source = join(root, "source.txt"), storePath = join(root, "book.db");
  writeFileSync(source, "the visitor waited by the door.", "utf8");
  const imported = await importSource({ sourcePath: source, projectDirectory: join(root, "project"), sourceLanguage: "en" });
  const original = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = async (_url, init) => { methods.push(init?.method ?? "GET"); throw certificateError(); };
  try {
    const runtime = createProviderRuntime(profile, "fixture-secret");
    await assert.rejects(runBook({ manifestPath: imported.manifestPath, storePath,
      runMeta: { runId: "network-preflight-fixture", protocolVersion: "v5-lossless-book-1", modelId: profile.modelId },
      model: runtime.model, streamFn: runtime.streamFn }), (error: any) => error.code === "PROVIDER_TLS");
    assert.deepEqual(methods, ["GET"]);
    assert.equal(existsSync(storePath), false);
    assert.equal(existsSync(storePath + ".run.lock"), false);
  } finally { globalThis.fetch = original; }
});

test("read-only provider preflight shares concurrent requests, rejects auth and permits unsupported catalogs", async () => {
  const original = globalThis.fetch;
  const statuses = [401, 200];
  const requests: string[] = [];
  globalThis.fetch = async (url, init) => {
    requests.push(String(url));
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    return new Response("", { status: statuses.shift() ?? 404 });
  };
  try {
    const runtime = createProviderRuntime(profile, "fixture-secret") as ReturnType<typeof createProviderRuntime> & {
      preflight(signal?: AbortSignal): Promise<{ httpStatus: number }>;
    };
    assert.equal(typeof runtime.preflight, "function");
    await assert.rejects(runtime.preflight(), (error: any) => error.code === "AUTH_INVALID");
    const results = await Promise.all([runtime.preflight(), runtime.preflight()]);
    assert.ok(results.every(r => r.httpStatus === 200));
    assert.equal(requests.length, 2);
    const custom = createProviderRuntime({ providerId: "openai-compatible", modelId: "fixture",
      customBaseUrl: "http://localhost:43219/v1" }, "fixture-secret") as typeof runtime;
    assert.equal((await custom.preflight()).httpStatus, 404);
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(runtime.preflight(cancelled.signal), { name: "AbortError" });
    assert.equal(requests.length, 3);
  } finally { globalThis.fetch = original; }
});

test("parallel native streams do not attach another request's TLS failure", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    await Promise.resolve();
    if (body.messages.at(-1).content === "tls") throw certificateError();
    return new Response(JSON.stringify({ error: { message: "fixture rate limit", type: "rate_limit" } }), { status: 429 });
  };
  try {
    const runtime = createProviderRuntime(profile, "fixture-secret");
    const responses = await Promise.all(["tls", "rate"].map(async content => {
      const stream = await runtime.streamFn(runtime.model, { messages: [{ role: "user", content, timestamp: 0 }] });
      return stream.result();
    }));
    assert.match(responses[0]!.errorMessage ?? "", /SELF_SIGNED_CERT_IN_CHAIN/);
    assert.match(responses[1]!.errorMessage ?? "", /429/);
    assert.doesNotMatch(responses[1]!.errorMessage ?? "", /SELF_SIGNED|PROVIDER_TLS/);
  } finally { globalThis.fetch = original; }
});

test("context wrappers preserve preflight, and a new run does not reuse a stale successful check", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { if (++calls === 1) return new Response("", { status: 200 }); throw certificateError(); };
  try {
    const runtime = createProviderRuntime(profile, "fixture-secret");
    await runtime.preflight();
    const bound = bindTaskContext(runtime.streamFn, "Fixture context.");
    await preflightProviderStream(bound);
    assert.equal(calls, 1);
    await assert.rejects(preflightProviderStream(bound, undefined, true), (error: any) => error.code === "PROVIDER_TLS");
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test("cancelling one preflight caller does not abort a different caller's connection check", async () => {
  const original = globalThis.fetch;
  const first = new AbortController(), second = new AbortController();
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    if (++calls === 1) return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
    return new Response("", { status: 200 });
  };
  try {
    const runtime = createProviderRuntime(profile, "fixture-secret");
    const cancelled = runtime.preflight(first.signal), successful = runtime.preflight(second.signal);
    first.abort();
    await assert.rejects(cancelled, { name: "AbortError" });
    assert.equal((await successful).httpStatus, 200);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test("preflight and native generation use the same configured proxy while loopback stays local", () => {
  const script = `
    import assert from 'node:assert/strict';
    import http from 'node:http';
    import net from 'node:net';
    const sockets = new Set(), methods = []; let tunnels = 0;
    const origin = http.createServer((req, res) => {
      methods.push(req.method + ' ' + req.url);
      if (req.method === 'GET') { res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[]}));return; }
      req.resume();
      res.setHeader('content-type','text/event-stream');
      res.end('data: ' + JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:0,model:'fixture',
        choices:[{index:0,delta:{content:'OK'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}) + '\\n\\ndata: [DONE]\\n\\n');
    });
    const proxy = http.createServer();
    const listen = server => new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    await listen(origin); await listen(proxy);
    const originPort = origin.address().port, proxyPort = proxy.address().port;
    proxy.on('connect',(req, downstream, head) => {
      tunnels++; sockets.add(downstream);
      assert.equal(req.url,'provider.invalid:' + originPort);
      const upstream = net.connect(originPort,'127.0.0.1',()=>{
        downstream.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');
        if(head.length)upstream.write(head); downstream.pipe(upstream).pipe(downstream);
      });
      sockets.add(upstream);
      upstream.on('error',()=>downstream.destroy());downstream.on('error',()=>upstream.destroy());
    });
    process.env.HTTP_PROXY = process.env.HTTPS_PROXY = 'http://127.0.0.1:' + proxyPort;
    process.env.NO_PROXY = '';
    try {
      const {createProviderRuntime}=await import('./src/providers/runtime.ts');
      const {providerFetch}=await import('./src/providers/network.ts');
      const runtime=createProviderRuntime({providerId:'openai-compatible',modelId:'fixture',
        customBaseUrl:'http://localhost:' + originPort + '/v1'},'fixture-secret',
        {trustedBaseUrl:'http://provider.invalid:' + originPort + '/v1'});
      await runtime.preflight();
      const stream=await runtime.streamFn(runtime.model,{messages:[{role:'user',content:'fixture',timestamp:0}]});
      const response=await stream.result();
      assert.equal(response.stopReason,'stop');assert.equal(response.usage.totalTokens,2);
      assert.ok(tunnels>0);const before=tunnels;
      const local=await providerFetch('http://127.0.0.1:' + originPort + '/models');await local.body.cancel();
      assert.equal(tunnels,before);
      assert.deepEqual(methods,['GET /v1/models','POST /v1/chat/completions','GET /models']);
      console.log('ok');
    } finally {
      for(const socket of sockets)socket.destroy();
      origin.closeAllConnections();proxy.closeAllConnections();origin.close();proxy.close();
    }
  `;
  assert.equal(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(), env: { ...process.env }, encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"],
  }).trim(), "ok");
});
