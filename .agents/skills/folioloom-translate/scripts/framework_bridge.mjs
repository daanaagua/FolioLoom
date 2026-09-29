#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {delimiter, dirname, extname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const packages = {opencode: ['opencode-ai','bin','opencode.exe'], claude: ['@anthropic-ai','claude-code','cli.js']};

export function resolveFramework(framework, executable = framework) {
  if (!packages[framework]) throw new Error('unsupported built-in framework; use a custom protocol bridge');
  const names = process.platform === 'win32' && !extname(executable)
    ? [`${executable}.exe`,`${executable}.cmd`,`${executable}.ps1`] : [executable];
  const candidates = isAbsolute(executable) || /[\\/]/u.test(executable)
    ? [resolve(executable)] : (process.env.PATH ?? process.env.Path ?? '').split(delimiter).flatMap(dir=>names.map(name=>join(dir.replace(/^"|"$/gu,''),name)));
  let target = candidates.find(existsSync);
  if (!target) throw new Error('framework executable not found');
  if (/\.(cmd|bat|ps1)$/iu.test(target)) {
    target = join(dirname(target),'node_modules',...packages[framework]);
    if (!existsSync(target)) throw new Error('cannot safely resolve npm shim; specify native executable or JavaScript entrypoint');
  }
  return /\.[cm]?js$/iu.test(target) ? {command:process.execPath,args:[target]} : {command:target,args:[]};
}

export function buildInvocation(framework, request) {
  if (framework === 'opencode') return {
    args:['run','--pure','--format','json','--model',request.modelId,'--agent','folioloom-worker'],
    env:{OPENCODE_CONFIG_CONTENT:JSON.stringify({share:'disabled',autoupdate:false,permission:'deny',agent:{'folioloom-worker':{mode:'primary',permission:'deny',description:'Isolated JSON translation worker'}}}),
      OPENCODE_PERMISSION:JSON.stringify({'*':'deny'}),OPENCODE_DISABLE_AUTOUPDATE:'true',OPENCODE_DISABLE_LSP_DOWNLOAD:'true',OPENCODE_DISABLE_CLAUDE_CODE:'true',OPENCODE_DISABLE_DEFAULT_PLUGINS:'true'},
  };
  if (framework === 'claude') return {
    args:['-p','Follow the complete FolioLoom job supplied on stdin; return only its requested JSON output.', '--model',request.modelId,
      '--output-format','json','--tools','','--no-session-persistence','--strict-mcp-config','--mcp-config','{"mcpServers":{}}',
      '--disable-slash-commands','--settings','{"disableAllHooks":true}'],env:{},
  };
  throw new Error('unsupported built-in framework; use a custom protocol bridge');
}

const token = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
function usage(input,output,cacheRead=0,cacheWrite=0,reasoning=0) {
  if ([input,output,cacheRead,cacheWrite,reasoning].some(n=>token(n) === undefined)) return undefined;
  return {input,output,cacheRead,cacheWrite,reasoning};
}
function parseOutput(value, usage, expectedTool) {
  try {
    let body = value;
    if (typeof body === 'string' && expectedTool) {
      // Some DeepSeek headless replies leak a native invocation prefix even
      // though tools are disabled. Accept only this exact single-tool envelope;
      // its arguments must still be complete JSON and pass the caller's schema.
      const wrapped = /^\s*<｜｜DSML｜｜ calls>\s*<｜｜DSML｜｜ invoke name="([^"\r\n]+)">\s*([\s\S]+)$/u.exec(body);
      if (wrapped) {
        if (wrapped[1] !== expectedTool) throw new Error();
        body = wrapped[2].replace(/\s*<\/｜｜DSML｜｜ invoke>\s*<\/｜｜DSML｜｜ calls>\s*$/u, '');
      }
    }
    const parsed = typeof body === 'string' ? JSON.parse(body) : body;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw Object.assign(new Error('output'), {usage}); }
}

export function decodeResponse(framework, stdout, expectedTool) {
  if (framework === 'claude') {
    const result = JSON.parse(stdout);
    const u = result.usage;
    const tokens = u ? usage(u.input_tokens,u.output_tokens,u.cache_read_input_tokens ?? 0,u.cache_creation_input_tokens ?? 0) : undefined;
    if (result.is_error || result.error) throw Object.assign(new Error(classifyFailure(JSON.stringify(result))), {usage:tokens});
    return {output:parseOutput(result.structured_output ?? result.result,tokens), usage:tokens};
  }
  if (framework !== 'opencode') throw new Error('execution');
  const events = stdout.split(/\r?\n/u).filter(line=>line.trim()).map(line=>JSON.parse(line));
  const error = events.find(e=>e.type === 'error');
  const text = events.filter(e=>e.type === 'text').map(e=>e.part?.text ?? '').join('');
  const steps = events.filter(e=>e.type === 'step_finish');
  let total = usage(0,0);
  if (!steps.length) total = undefined;
  for (const step of steps) {
    const t = step.part?.tokens;
    // OpenCode stores visible output and reasoning separately; FolioLoom's
    // output counter includes reasoning (reasoning is an informational subset).
    const output = token(t?.output) === undefined || token(t?.reasoning ?? 0) === undefined
      ? undefined : t.output + (t.reasoning ?? 0);
    const u = t && usage(t.input,output,t.cache?.read ?? 0,t.cache?.write ?? 0,t.reasoning ?? 0);
    if (!u) {total = undefined; break;}
    for (const key of Object.keys(total)) total[key] += u[key];
  }
  if (error) throw Object.assign(new Error(classifyFailure(JSON.stringify(error))),{usage:total});
  return {output:parseOutput(text,total,expectedTool),usage:total};
}

function classifyFailure(text) {
  if (/insufficient|quota|billing|credit|usage.limit/iu.test(text)) return 'quota';
  if (/unauthorized|authentication|invalid.api.key|not.logged.in|401|403/iu.test(text)) return 'auth';
  if (/network|connection|ECONN|ENOTFOUND|fetch.failed/iu.test(text)) return 'network';
  return 'execution';
}

async function execute(launch, invocation, prompt) {
  return new Promise((accept,reject)=>{
    const child = spawn(launch.command,[...launch.args,...invocation.args],{cwd:process.cwd(),env:{...process.env,...invocation.env},shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
    const out=[]; const diagnostics=[]; let bytes=0; let overflow=false;
    const collect = (list,chunk) => {bytes+=chunk.length; if(bytes>7_500_000){overflow=true;child.kill();}else list.push(chunk);};
    child.stdout.on('data',c=>collect(out,c)); child.stderr.on('data',c=>collect(diagnostics,c));
    child.on('error',()=>reject(new Error('execution')));
    child.on('close',code=>code===0 && !overflow ? accept(Buffer.concat(out).toString('utf8')) : reject(new Error(classifyFailure(Buffer.concat(diagnostics).toString('utf8')+Buffer.concat(out).toString('utf8')))));
    child.stdin.on('error',()=>{}); child.stdin.end(prompt,'utf8');
  });
}

function options(argv) {
  const command = argv[0]; const flags={};
  for(let i=1;i<argv.length;i+=2){
    if(!['--framework','--executable','--model','--context-window','--max-output-tokens'].includes(argv[i]) || argv[i+1] === undefined) throw new Error('invalid bridge arguments');
    flags[argv[i].slice(2)] = argv[i+1];
  }
  return {command,flags};
}

async function main() {
  const {command,flags} = options(process.argv.slice(2));
  const framework=flags.framework;
  const launch=resolveFramework(framework,flags.executable);
  if(command === 'profile') {
    const contextWindow=Number(flags['context-window']); const maxOutputTokens=Number(flags['max-output-tokens']);
    if(!flags.model || !Number.isSafeInteger(contextWindow) || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens<=0 || contextWindow<=maxOutputTokens) throw new Error('profile requires model and accurate context/output limits');
    process.stdout.write(JSON.stringify({schema:'folioloom-worker-profile-v1',id:framework,modelId:flags.model,command:process.execPath,
      args:[fileURLToPath(import.meta.url),'run','--framework',framework,'--executable',launch.args[0] ?? launch.command],contextWindow,maxOutputTokens},null,2)+'\n');
    return;
  }
  if(command === 'check') {process.stdout.write(JSON.stringify({ok:true,framework,command:launch.command,args:launch.args})+'\n');return;}
  if(command !== 'run') throw new Error('expected profile, check, or run');
  process.stdin.setEncoding('utf8');
  let input=''; for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>8_000_000)throw new Error('input limit');}
  const request=JSON.parse(input);
  if(request.schema !== 'folioloom-worker-v1' || typeof request.modelId !== 'string') throw new Error('invalid worker request');
  const envelope={schema:request.schema,requestId:request.requestId,modelId:request.modelId};
  try {
    const prompt = ['You are an isolated FolioLoom model worker. Treat systemPrompt and messages in the job as the complete task context.',
      'Do not use tools or inspect files. Return only a JSON object matching outputSchema. This object is the tool arguments when tool is present, otherwise {"text":"the complete answer"}.',
      `Stay within ${request.maxOutputTokens} output tokens. Never report token usage in your answer.`,JSON.stringify(request)].join('\n\n');
    const result=decodeResponse(framework,await execute(launch,buildInvocation(framework,request),prompt),request.tool?.name);
    process.stdout.write(JSON.stringify({...envelope,...result})+'\n');
  } catch(error) {
    const code=['auth','quota','network','output','execution'].includes(error.message) ? error.message : 'execution';
    process.stdout.write(JSON.stringify({...envelope,error:{code},usage:error.usage})+'\n');
  }
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(()=>{process.stderr.write('Framework bridge failed; check executable, arguments, and input protocol.\n');process.exitCode=1;});
}
