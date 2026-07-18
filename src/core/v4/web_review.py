"""Localhost-only review dashboard for parallel_v4."""

from __future__ import annotations

import hashlib
import json
import secrets
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict
from urllib.parse import parse_qs, urlparse

from ..text_normalization import normalize_chinese_quote_style
from .database import V4Database


REVIEW_HTML = r"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>parallel_v4 本地裁决</title>
<style>
:root{color-scheme:dark;--bg:#111318;--panel:#1a1e26;--line:#303744;--text:#edf1f7;--muted:#9aa7b8;--accent:#79b8ff;--ok:#78dba9;--warn:#ffca70;--bad:#ff8585}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,"Microsoft YaHei",sans-serif}
header{position:sticky;top:0;z-index:3;padding:14px 20px;background:#111318ee;border-bottom:1px solid var(--line);display:flex;gap:18px;align-items:center}
header h1{font-size:17px;margin:0}.muted{color:var(--muted)}button,input,textarea,select{font:inherit;color:var(--text);background:#11151c;border:1px solid var(--line);border-radius:6px;padding:7px 9px}button{cursor:pointer}button:hover{border-color:var(--accent)}
main{display:grid;grid-template-columns:minmax(280px,360px) 1fr;min-height:calc(100vh - 58px)}aside{padding:16px;border-right:1px solid var(--line);overflow:auto}.content{padding:20px;overflow:auto}.card{background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:12px;margin-bottom:12px}.card h3{margin:0 0 8px;font-size:15px}.pill{display:inline-block;padding:2px 7px;border-radius:99px;background:#2a3340;color:var(--muted);font-size:12px}.queue-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.block{cursor:pointer}.block:hover{border-color:var(--accent)}
.queue-payload{max-height:120px;overflow:auto;word-break:break-all;font-size:12px}details{margin-top:18px;border-top:1px solid var(--line);padding-top:12px}summary{cursor:pointer;font-size:16px;font-weight:700;margin-bottom:12px}details[open]>summary{color:var(--accent)}
.vote-actions{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}.vote-actions button{min-width:92px}.vote-actions button.selected{border-color:var(--ok);background:#173126}.vote-status{color:var(--ok);margin-top:8px}
.columns{display:grid;grid-template-columns:1fr 1fr;gap:14px}.prose{white-space:pre-wrap;background:#12161d;border:1px solid var(--line);padding:14px;border-radius:8px;max-height:58vh;overflow:auto}.source{max-height:35vh}.section-title{display:flex;justify-content:space-between;align-items:center;margin:24px 0 9px}h2{font-size:18px;margin:0}.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
@media(max-width:900px){main{grid-template-columns:1fr}aside{border-right:0;border-bottom:1px solid var(--line)}.columns{grid-template-columns:1fr}}
</style></head><body>
<header><h1>parallel_v4 本地裁决</h1><span id="summary" class="muted">载入中</span><button onclick="loadState()">刷新</button></header>
<main><aside><div class="section-title"><h2>译文盲评</h2></div><div id="blocks"></div><details><summary>人工队列</summary><div id="queue"></div></details><details><summary>提示性警告</summary><h3>不确定共指</h3><div id="warning-uncertain-coreference"></div><h3>译名渲染冲突</h3><div id="warning-render-conflicts"></div><h3>可用但陈旧的译文</h3><div id="warning-stale"></div></details><details><summary>声明与假说</summary><div id="claims"></div></details><details><summary>核验与修复</summary><div id="tasks"></div></details></aside>
<section class="content"><div id="empty" class="card muted">选择左侧文本块查看原文、盲评候选、证据和注释。</div><div id="detail" hidden>
<div class="section-title"><h2 id="blockTitle"></h2><button id="revealBtn">揭示来源</button></div><div id="blockMeta" class="muted"></div>
<div class="section-title"><h2>原文</h2></div><div id="source" class="prose source"></div>
<div class="section-title"><h2>译文对照</h2></div><div id="candidates" class="columns"></div>
<div id="votePanel" class="card" hidden><h3>盲评选择</h3><div class="muted">点击四个评价按钮会立即保存选择和当前理由；修改理由后，可单独点击“保存理由/更新评价”。</div><div class="vote-actions"><button data-vote-choice="A" onclick="submitVote('A')">A更好</button><button data-vote-choice="B" onclick="submitVote('B')">B更好</button><button data-vote-choice="tie" onclick="submitVote('tie')">两者相当</button><button data-vote-choice="neither" onclick="submitVote('neither')">都不合格</button></div><input id="voteNote" oninput="saveVoteDraft()" placeholder="可选：简短说明理由" style="width:100%"><div class="queue-actions"><button onclick="saveCurrentVote()">保存理由/更新评价</button></div><div id="voteStatus" class="vote-status"></div></div>
<div class="section-title"><h2>证据</h2></div><div id="evidence"></div>
<div class="section-title"><h2>叙事上下文</h2></div>
<div class="columns"><div><h3>记忆与关系</h3><div id="narrative-memory" class="prose"></div></div><div><h3>位置快照</h3><div id="narrative-snapshot" class="prose"></div></div></div>
<div class="section-title"><h2>动态调度</h2></div><div id="narrative-volatility" class="prose"></div>
<div class="section-title"><h2>注释</h2></div><div id="annotations"></div><div class="card"><input id="annIndex" type="number" min="0" value="0" style="width:90px"><input id="annBody" placeholder="注释正文" style="width:min(560px,70%)"><button onclick="addAnnotation()">添加待审注释</button></div>
<div class="section-title"><h2>局部修复</h2></div><div class="card"><textarea id="repairIssues" rows="3" style="width:100%" placeholder="每行一个需要修复的问题"></textarea><button onclick="requestRepair()">加入局部修复队列</button></div>
</div></section></main>
<script>
const TOKEN=__TOKEN__;const DRAFT_KEY=`parallel_v4_vote_drafts_${TOKEN}`;let currentBlock=null;let revealed=false;let currentVoteChoice=null;let currentVoteBlinded=null;let voteDrafts={};try{voteDrafts=JSON.parse(localStorage.getItem(DRAFT_KEY)||'{}')}catch(_){voteDrafts={}}
async function api(path,opt={}){opt.headers={...(opt.headers||{}),'Content-Type':'application/json','X-Review-Token':TOKEN};const r=await fetch(path,opt);const data=await r.json();if(!r.ok)throw new Error(data.error||r.statusText);return data}
function escText(el,text){el.textContent=text??''}
async function loadState(){const s=await api('/api/state');escText(document.querySelector('#summary'),`可选队列 ${s.queue.length} · 核验 ${s.verification_tasks.length} · 修复 ${s.repair_tasks.length}`);renderQueue(s.queue);renderWarnings(s.warnings);renderClaims(s.claims);renderTasks(s.verification_tasks,s.repair_tasks);renderBlocks(s.blocks);if(!currentBlock){const first=s.blocks.find(b=>b.translation_status==='completed'||b.translation_status==='completed_with_warnings')||s.blocks.find(b=>b.translation_status)||s.blocks[0];if(first)await loadBlock(first.legacy_id,true)}}
function renderQueue(rows){const root=document.querySelector('#queue');root.innerHTML='';if(!rows.length){root.innerHTML='<div class="muted">暂无待裁决项目</div>';return}for(const q of rows){const c=document.createElement('div');c.className='card';const h=document.createElement('h3');h.textContent=`#${q.id} ${q.kind}`;c.append(h);const p=document.createElement('div');p.className='muted queue-payload';p.textContent=JSON.stringify(q.payload);c.append(p);const a=document.createElement('div');a.className='queue-actions';const actions=(q.kind==='context_overflow'||q.kind==='repair_failed')?['retry']:['accept','reject'];for(const action of actions){const b=document.createElement('button');b.textContent={accept:'接受并锁定',reject:'拒绝',retry:'重试'}[action];b.onclick=()=>queueAction(q.id,action);a.append(b)}if(q.kind==='translation_proposal'||q.kind==='high_impact_verification'){const e=document.createElement('button');e.textContent='编辑后接受';e.onclick=()=>editAccept(q.id);a.append(e)}c.append(a);root.append(c)}}
function renderWarningList(id,rows,label){const root=document.querySelector(id);root.innerHTML='';if(!rows.length){root.innerHTML='<div class="muted">暂无</div>';return}for(const row of rows){const c=document.createElement('div');c.className='card warn';c.textContent=`${label} · ${row.legacy_id||row.canonical_form||row.block_id||row.id} · ${row.action||row.kind||row.relation||''}`;root.append(c)}}
function renderWarnings(warnings){renderWarningList('#warning-uncertain-coreference',warnings.uncertain_coreference,'共指');renderWarningList('#warning-render-conflicts',warnings.render_conflicts,'渲染');renderWarningList('#warning-stale',warnings.warning_stale,'陈旧译文')}
function renderClaims(rows){const root=document.querySelector('#claims');root.innerHTML='';if(!rows.length){root.innerHTML='<div class="muted">暂无声明</div>';return}for(const x of rows.slice(0,50)){const c=document.createElement('div');c.className='card';const h=document.createElement('h3');h.textContent=`${x.kind} · ${x.status}`;c.append(h);const p=document.createElement('div');p.textContent=x.statement;c.append(p);const m=document.createElement('div');m.className='muted';m.textContent=`揭示位置 ${x.reveal_global_index} · ${x.scope}${x.locked?' · 已锁定':''}`;c.append(m);root.append(c)}}
function renderTasks(verify,repair){const root=document.querySelector('#tasks');root.innerHTML='';for(const x of verify){const c=document.createElement('div');c.className='card';c.textContent=`核验 ${x.subject_type}:${x.subject_id} · ${x.status}`;root.append(c)}for(const x of repair){const c=document.createElement('div');c.className='card';c.textContent=`修复 ${x.legacy_id} · ${x.status}`;root.append(c)}if(!root.children.length)root.innerHTML='<div class="muted">暂无开放任务</div>'}
function renderBlocks(rows){const root=document.querySelector('#blocks');root.innerHTML='';for(const b of rows){const c=document.createElement('div');c.className='card block';c.onclick=()=>loadBlock(b.legacy_id,true);c.innerHTML=`<h3></h3><span class="pill"></span>`;c.querySelector('h3').textContent=`${b.legacy_id} · ${b.chapter_title}`;c.querySelector('.pill').textContent=(b.translation_status||b.status)+(b.comparison_choice?` · 已选${{A:'A',B:'B',tie:'相当',neither:'均不合格'}[b.comparison_choice]}`:'');root.append(c)}}
async function queueAction(id,action){try{await api(`/api/queue/${id}`,{method:'POST',body:JSON.stringify({action})});await loadState()}catch(e){alert(e.message)}}
async function editAccept(id){const replacement=prompt('输入替换后的译法或声明：');if(!replacement)return;try{await api(`/api/queue/${id}`,{method:'POST',body:JSON.stringify({action:'accept',replacement})});await loadState()}catch(e){alert(e.message)}}
async function loadBlock(id,blind=true){currentBlock=id;const d=await api(`/api/block?id=${encodeURIComponent(id)}&blind=${blind?'1':'0'}`);revealed=d.blind_available?!blind:true;document.querySelector('#empty').hidden=true;document.querySelector('#detail').hidden=false;escText(document.querySelector('#blockTitle'),`${d.legacy_id} · ${d.chapter_title}`);const warnings=JSON.parse(d.warnings_json||'[]');escText(document.querySelector('#blockMeta'),`${d.v4_status||d.status} · global_index=${d.global_index}${warnings.length?' · 警告：'+warnings.join('；'):''}`);escText(document.querySelector('#source'),d.source_text);const cr=document.querySelector('#candidates');cr.innerHTML='';for(const x of d.candidates){const box=document.createElement('div');box.innerHTML='<h3></h3><div class="prose"></div>';box.querySelector('h3').textContent=x.label+(x.origin?` · ${x.origin}`:'');box.querySelector('.prose').textContent=x.text||'（无译文）';cr.append(box)}renderVote(d);const er=document.querySelector('#evidence');er.innerHTML='';for(const e of d.evidence){const c=document.createElement('div');c.className='card';c.textContent=`[${e.kind}] ${e.paragraph_id}: ${e.evidence_quote}`;er.append(c)}await loadNarrative(id);renderAnnotations(d.annotations);const reveal=document.querySelector('#revealBtn');reveal.hidden=!d.blind_available;reveal.onclick=()=>loadBlock(id,revealed);reveal.textContent=revealed?'恢复盲评':'揭示来源'}
async function loadNarrative(id){const q=encodeURIComponent(id);const [memory,snapshot,volatility]=await Promise.all([api(`/api/narrative-memory?block=${q}`),api(`/api/narrative-snapshot?block=${q}`),api(`/api/narrative-volatility?block=${q}`)]);escText(document.querySelector('#narrative-memory'),JSON.stringify(memory.memories,null,2));escText(document.querySelector('#narrative-snapshot'),JSON.stringify(snapshot.snapshots,null,2));escText(document.querySelector('#narrative-volatility'),JSON.stringify(volatility.premap,null,2))}
function renderVote(d){const panel=document.querySelector('#votePanel');panel.hidden=!d.blind_available;if(panel.hidden)return;const labels={A:'A更好',B:'B更好',tie:'两者相当',neither:'都不合格'};currentVoteChoice=d.comparison_vote?.choice||null;currentVoteBlinded=d.comparison_vote?.blinded??null;for(const button of document.querySelectorAll('[data-vote-choice]'))button.classList.toggle('selected',button.dataset.voteChoice===currentVoteChoice);const saved=d.comparison_vote?.note||'';const hasDraft=Object.prototype.hasOwnProperty.call(voteDrafts,currentBlock);document.querySelector('#voteNote').value=hasDraft?voteDrafts[currentBlock]:saved;let status=d.comparison_vote?`已记录：${labels[d.comparison_vote.choice]}${d.comparison_vote.blinded?'（盲评）':'（揭示后选择）'}`:'';if(hasDraft&&voteDrafts[currentBlock]!==saved)status+=(status?' · ':'')+'理由草稿尚未提交';document.querySelector('#voteStatus').textContent=status}
function saveVoteDraft(){if(!currentBlock)return;voteDrafts[currentBlock]=document.querySelector('#voteNote').value;localStorage.setItem(DRAFT_KEY,JSON.stringify(voteDrafts));const status=document.querySelector('#voteStatus');if(!status.textContent.includes('理由草稿尚未提交'))status.textContent+=(status.textContent?' · ':'')+'理由草稿尚未提交'}
async function persistVote(choice,blinded){const block=currentBlock;const note=document.querySelector('#voteNote').value;await api('/api/comparison-votes',{method:'POST',body:JSON.stringify({block,choice,blinded,note})});delete voteDrafts[block];localStorage.setItem(DRAFT_KEY,JSON.stringify(voteDrafts));await loadBlock(block,!revealed);const s=await api('/api/state');renderBlocks(s.blocks)}
async function submitVote(choice){await persistVote(choice,!revealed)}
async function saveCurrentVote(){if(!currentVoteChoice){alert('请先选择A更好、B更好、两者相当或都不合格。');return}await persistVote(currentVoteChoice,currentVoteBlinded??!revealed)}
function renderAnnotations(rows){const root=document.querySelector('#annotations');root.innerHTML='';for(const a of rows){const c=document.createElement('div');c.className='card';c.textContent=`P${a.paragraph_index} [${a.status}] ${a.body}`;if(a.status==='proposed'){for(const action of ['approve','reject']){const b=document.createElement('button');b.textContent=action==='approve'?'批准':'拒绝';b.onclick=()=>resolveAnnotation(a.id,action);c.append(b)}}root.append(c)}}
async function resolveAnnotation(id,action){await api(`/api/annotations/${id}`,{method:'POST',body:JSON.stringify({action})});await loadBlock(currentBlock,!revealed)}
async function addAnnotation(){const paragraph_index=Number(document.querySelector('#annIndex').value);const body=document.querySelector('#annBody').value;await api('/api/annotations',{method:'POST',body:JSON.stringify({block:currentBlock,paragraph_index,body})});document.querySelector('#annBody').value='';await loadBlock(currentBlock,!revealed)}
async function requestRepair(){const issues=document.querySelector('#repairIssues').value.split('\n').filter(Boolean);await api('/api/repair',{method:'POST',body:JSON.stringify({block:currentBlock,issues})});alert('已加入局部修复队列');await loadState()}
loadState().catch(e=>alert(e.message));
</script></body></html>"""


def _json_safe_queue(rows):
    result = []
    for row in rows:
        item = dict(row)
        item["payload"] = json.loads(item.pop("payload_json"))
        result.append(item)
    return result


def _json_safe_tasks(rows):
    result = []
    for row in rows:
        item = dict(row)
        if "payload_json" in item:
            item["payload"] = json.loads(item.pop("payload_json"))
        if "issues_json" in item:
            item["issues"] = json.loads(item.pop("issues_json"))
        result.append(item)
    return result


def create_review_server(database: V4Database, port: int = 8765):
    token = secrets.token_urlsafe(24)

    class Handler(BaseHTTPRequestHandler):
        server_version = "ParallelV4Review/2"

        def log_message(self, format, *args):
            return

        def _send_json(self, value: Any, status: int = 200):
            payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)

        def _error(self, exc: Exception, status: int = 400):
            self._send_json({"error": str(exc)}, status)

        def _body(self) -> Dict[str, Any]:
            size = int(self.headers.get("Content-Length") or 0)
            if size > 1024 * 1024:
                raise ValueError("请求体超过1MB")
            return json.loads(self.rfile.read(size) or b"{}")

        def _authorized(self) -> bool:
            supplied = self.headers.get("X-Review-Token") or ""
            return secrets.compare_digest(supplied, token)

        def do_GET(self):
            parsed = urlparse(self.path)
            try:
                if parsed.path == "/":
                    payload = REVIEW_HTML.replace("__TOKEN__", json.dumps(token)).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'")
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                    return
                if parsed.path == "/api/state":
                    self._send_json(
                        {
                            "summary": database.status_summary(),
                            "queue": _json_safe_queue(database.list_human_queue()),
                            "warnings": database.review_warning_sections(),
                            "blocks": database.review_blocks(),
                            "claims": database.list_claims(),
                            "baselines": database.list_baseline_documents(),
                            "verification_tasks": _json_safe_tasks(database.list_verification_tasks()),
                            "annotations": database.list_annotations("proposed"),
                            "repair_tasks": _json_safe_tasks(database.list_repair_tasks()),
                            "comparison_vote_count": len(database.list_comparison_votes()),
                        }
                    )
                    return
                if parsed.path == "/api/block":
                    query = parse_qs(parsed.query)
                    identifier = (query.get("id") or [""])[0]
                    blind = (query.get("blind") or ["1"])[0] != "0"
                    data = database.get_review_block(identifier)
                    baseline = data.pop("baseline", None)
                    baseline_candidate = {
                        "origin": (baseline or {}).get("document", {}).get(
                            "name", "serial_v3"
                        ),
                        "text": normalize_chinese_quote_style(
                            (baseline or {}).get("text")
                            or data.get("serial_translation")
                            or ""
                        ),
                    }
                    v4_candidate = {
                        "origin": "parallel_v4",
                        "text": normalize_chinese_quote_style(
                            data.get("v4_translation") or ""
                        ),
                    }
                    blind_available = bool(
                        baseline_candidate["text"].strip()
                        and v4_candidate["text"].strip()
                    )
                    if blind_available:
                        candidates = [v4_candidate, baseline_candidate]
                        if int(hashlib.sha256(data["id"].encode()).hexdigest(), 16) % 2:
                            candidates.reverse()
                        for index, candidate in enumerate(candidates):
                            candidate["label"] = chr(ord("A") + index)
                            if blind:
                                candidate.pop("origin", None)
                    else:
                        # 只有一个实际候选时不能进行盲评，否则候选会在A/B间
                        # 交替，看起来像译文错位。固定显示基线在左、V4在右。
                        baseline_candidate["label"] = "旧译文基线"
                        v4_candidate["label"] = "parallel_v4"
                        if not baseline_candidate["text"].strip():
                            baseline_candidate["origin"] += "（尚无译文）"
                        if not v4_candidate["text"].strip():
                            v4_candidate["origin"] += "（尚未生成）"
                        candidates = [baseline_candidate, v4_candidate]
                    data["blind_available"] = blind_available
                    data["candidates"] = candidates
                    candidate_hashes = [
                        hashlib.sha256(candidate["text"].encode("utf-8")).hexdigest()
                        for candidate in candidates
                    ]
                    vote = database.comparison_vote_for_block(
                        identifier, candidate_hashes[0], candidate_hashes[1]
                    )
                    if vote and blind:
                        for key in (
                            "candidate_a_origin",
                            "candidate_b_origin",
                            "selected_origin",
                        ):
                            vote.pop(key, None)
                    if vote:
                        vote.pop("candidate_a_hash", None)
                        vote.pop("candidate_b_hash", None)
                    data["comparison_vote"] = vote
                    data.pop("v4_translation", None)
                    data.pop("serial_translation", None)
                    self._send_json(data)
                    return
                if parsed.path in {
                    "/api/narrative-memory",
                    "/api/narrative-snapshot",
                    "/api/narrative-volatility",
                }:
                    query = parse_qs(parsed.query)
                    identifier = (query.get("block") or [""])[0]
                    block = database.get_block_by_identifier(identifier)
                    data = database.inspect_narrative_memory(
                        block_id=block.id
                    )
                    if parsed.path == "/api/narrative-memory":
                        self._send_json(
                            {
                                "block_id": block.id,
                                "memories": data["memories"],
                            }
                        )
                    elif parsed.path == "/api/narrative-snapshot":
                        self._send_json(
                            {
                                "block_id": block.id,
                                "snapshots": data["snapshots"],
                            }
                        )
                    else:
                        self._send_json(
                            {
                                "block_id": block.id,
                                "premap": data["premap"],
                            }
                        )
                    return
                self._send_json({"error": "not found"}, 404)
            except Exception as exc:
                self._error(exc)

        def do_POST(self):
            if not self._authorized():
                self._send_json({"error": "invalid review token"}, 403)
                return
            parsed = urlparse(self.path)
            try:
                body = self._body()
                if parsed.path.startswith("/api/queue/"):
                    item_id = int(parsed.path.rsplit("/", 1)[-1])
                    replacement = str(body.get("replacement") or "").strip()
                    if replacement:
                        database.amend_human_item(item_id, replacement)
                    self._send_json(database.resolve_human_item(item_id, body["action"]))
                    return
                if parsed.path == "/api/annotations":
                    annotation_id = database.add_annotation(
                        body["block"], int(body["paragraph_index"]), body["body"]
                    )
                    self._send_json({"id": annotation_id}, 201)
                    return
                if parsed.path.startswith("/api/annotations/"):
                    annotation_id = parsed.path.rsplit("/", 1)[-1]
                    self._send_json(database.resolve_annotation(annotation_id, body["action"]))
                    return
                if parsed.path == "/api/repair":
                    task_id = database.request_repair(body["block"], body.get("issues") or [])
                    self._send_json({"id": task_id}, 201)
                    return
                if parsed.path == "/api/comparison-votes":
                    identifier = str(body["block"])
                    detail = database.get_review_block(identifier)
                    baseline = detail.get("baseline") or {}
                    baseline_origin = baseline.get("document", {}).get(
                        "name", "serial_v3"
                    )
                    baseline_text = (
                        baseline.get("text")
                        or detail.get("serial_translation")
                        or ""
                    )
                    baseline_text = normalize_chinese_quote_style(baseline_text)
                    v4_text = normalize_chinese_quote_style(
                        detail.get("v4_translation") or ""
                    )
                    if not baseline_text.strip() or not v4_text.strip():
                        raise ValueError("只有两份候选译文都存在时才能提交盲评")
                    candidate_pairs = [
                        ("parallel_v4", v4_text),
                        (baseline_origin, baseline_text),
                    ]
                    if int(
                        hashlib.sha256(detail["id"].encode()).hexdigest(), 16
                    ) % 2:
                        candidate_pairs.reverse()
                    vote = database.record_comparison_vote(
                        identifier,
                        str(body["choice"]),
                        candidate_pairs[0][0],
                        candidate_pairs[1][0],
                        hashlib.sha256(
                            candidate_pairs[0][1].encode("utf-8")
                        ).hexdigest(),
                        hashlib.sha256(
                            candidate_pairs[1][1].encode("utf-8")
                        ).hexdigest(),
                        blinded=bool(body.get("blinded", True)),
                        note=str(body.get("note") or ""),
                    )
                    if vote.get("blinded"):
                        for key in (
                            "candidate_a_origin",
                            "candidate_b_origin",
                            "selected_origin",
                        ):
                            vote.pop(key, None)
                    vote.pop("candidate_a_hash", None)
                    vote.pop("candidate_b_hash", None)
                    self._send_json(vote, 201)
                    return
                if parsed.path == "/api/claims":
                    claim_id = database.create_claim(**body)
                    self._send_json({"id": claim_id}, 201)
                    return
                self._send_json({"error": "not found"}, 404)
            except Exception as exc:
                self._error(exc)

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.review_token = token
    return server


def serve_review_ui(database: V4Database, port: int = 8765, open_browser: bool = True):
    server = create_review_server(database, port)
    host, actual_port = server.server_address
    url = f"http://{host}:{actual_port}/"
    if open_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    print(f"本地裁决界面: {url}")
    print("仅绑定127.0.0.1；按 Ctrl+C 停止。")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
