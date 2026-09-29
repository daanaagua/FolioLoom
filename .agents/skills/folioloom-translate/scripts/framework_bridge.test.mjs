import assert from 'node:assert/strict';
import test from 'node:test';
import {decodeResponse, buildInvocation} from './framework_bridge.mjs';

test('OpenCode JSONL retains output and sums provider usage across steps', () => {
  const result = decodeResponse('opencode', [
    {type:'text', part:{text:'{"text":"中文"}'}},
    {type:'step_finish', part:{tokens:{input:100,output:20,reasoning:4,cache:{read:7,write:3}}}},
    {type:'step_finish', part:{tokens:{input:10,output:2,reasoning:0,cache:{read:0,write:0}}}},
  ].map(JSON.stringify).join('\n'));
  assert.deepEqual(result.output, {text:'中文'});
  assert.deepEqual(result.usage,{input:110,output:26,reasoning:4,cacheRead:7,cacheWrite:3});
});
test('Claude JSON uses provider counters and structured output', () => {
  assert.deepEqual(decodeResponse('claude', JSON.stringify({structured_output:{text:'ok'},usage:{input_tokens:10,output_tokens:5,cache_read_input_tokens:4,cache_creation_input_tokens:2}})), {
    output:{text:'ok'}, usage:{input:10,output:5,cacheRead:4,cacheWrite:2,reasoning:0},
  });
});
test('missing usage is not estimated; malformed output and framework errors fail closed', () => {
  assert.equal(decodeResponse('claude', '{"result":"{\\"text\\":\\"ok\\"}"}').usage, undefined);
  assert.throws(()=>decodeResponse('opencode', '{"type":"error","error":{"message":"secret"}}'), /execution/);
  assert.throws(()=>decodeResponse('claude', '{"result":"not JSON"}'), /output/);
  assert.throws(()=>decodeResponse('claude', JSON.stringify({result:'not JSON',usage:{input_tokens:10,output_tokens:5}})), error=>error.usage?.input === 10 && error.usage?.output === 5);
});
test('built-in invocations disable tools without changing global configuration', () => {
  const request = {modelId:'provider/model',maxOutputTokens:8000};
  const opencode = buildInvocation('opencode', request);
  assert.ok(opencode.args.includes('--pure'));
  assert.equal(JSON.parse(opencode.env.OPENCODE_CONFIG_CONTENT).agent['folioloom-worker'].permission, 'deny');
  assert.ok(buildInvocation('claude',request).args.includes('--no-session-persistence'));
  assert.throws(()=>buildInvocation('unknown',request),/framework/);
});

test('OpenCode recovers only a single matching DSML envelope around complete JSON arguments', () => {
  const encode = text => JSON.stringify({type:'text',part:{text}});
  const prefix = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="submit">\n';
  const payload = '{"text":"完整译文"}';
  assert.deepEqual(decodeResponse('opencode',encode(prefix+payload),'submit').output,{text:'完整译文'});
  assert.deepEqual(decodeResponse('opencode',encode(prefix+payload+'\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>'),'submit').output,{text:'完整译文'});
  assert.throws(()=>decodeResponse('opencode',encode(prefix+payload),'other-tool'),/output/);
  assert.throws(()=>decodeResponse('opencode',encode(prefix+payload)),/output/);
  assert.throws(()=>decodeResponse('opencode',encode(prefix+'{"text":'),'submit'),/output/);
  assert.throws(()=>decodeResponse('opencode',encode(prefix+payload+prefix+payload),'submit'),/output/);
  assert.throws(()=>decodeResponse('opencode',encode('explanation\n'+payload),'submit'),/output/);
});
