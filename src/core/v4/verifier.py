"""Independent two-vote verification for high-impact knowledge proposals."""

from __future__ import annotations

import json
import time
from typing import Any, Callable, Dict, List, Optional
from uuid import uuid4

from .database import V4Database
from .models import VerificationResponse


VERIFY_SYSTEM = """你是高影响翻译知识的独立核验器。你只能依据请求中给出的原文证据判断候选译法或约束是否得到支持。

规则：
1. 不使用书外剧情知识，不猜测后文谜底。
2. 证据不足时必须选择 uncertain。
3. evidence_quotes 必须逐字来自请求中的 evidence_quote。
4. 只输出合法JSON：{"verdict":"support|reject|uncertain","rationale":"...","evidence_quotes":["..."]}。
5. JSON字符串内部的中文引用使用「」而不是未转义半角双引号。
"""


class V4Verifier:
    def __init__(
        self,
        database: V4Database,
        llm_factory: Callable[[], Any],
        max_attempts: int = 2,
        max_tokens: int = 4096,
    ):
        self.database = database
        self.llm_factory = llm_factory
        self.max_attempts = max(1, max_attempts)
        self.max_tokens = max_tokens

    @staticmethod
    def _clean_json(raw: str) -> str:
        text = raw.strip()
        if text.startswith("```json"):
            text = text[7:]
        elif text.startswith("```"):
            text = text[3:]
        if text.endswith("```"):
            text = text[:-3]
        return text.strip()

    @staticmethod
    def _validate_quotes(parsed: VerificationResponse, payload: Dict[str, Any]) -> None:
        allowed = [
            str(item.get("evidence_quote") or "")
            for item in payload.get("evidence", [])
            if item.get("evidence_quote")
        ]
        for quote in parsed.evidence_quotes:
            if not any(quote in evidence for evidence in allowed):
                raise ValueError(f"核验引文不在证据中: {quote!r}")
        if parsed.verdict == "support" and not parsed.evidence_quotes:
            raise ValueError("support必须至少提供一条原文证据")

    def _vote(self, task: Dict[str, Any], verifier_index: int) -> Dict[str, Any]:
        payload = json.loads(task["payload_json"])
        messages = [
            {"role": "system", "content": VERIFY_SYSTEM},
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "verifier_index": verifier_index,
                        "subject_type": task["subject_type"],
                        "proposal": payload,
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
            },
        ]
        last_error: Optional[str] = None
        last_raw = ""
        started = time.perf_counter()
        llm = self.llm_factory()
        for attempt in range(1, self.max_attempts + 1):
            request_messages = list(messages)
            if last_error:
                request_messages.append(
                    {
                        "role": "user",
                        "content": f"上次输出未通过严格校验：{last_error[:500]}。请重新输出完整JSON。",
                    }
                )
            try:
                last_raw = llm.chat(
                    messages=request_messages,
                    purpose="verify",
                    temperature=0.0,
                    max_tokens=self.max_tokens,
                    json_mode=True,
                    stream=False,
                )
                parsed = VerificationResponse.model_validate_json(self._clean_json(last_raw))
                self._validate_quotes(parsed, payload)
                return {
                    "model": llm.get_model("verify"),
                    "request": {"messages": request_messages, "json_mode": True},
                    "raw_response": last_raw,
                    "parsed": parsed.model_dump(mode="json"),
                    "accepted": True,
                    "attempts": attempt,
                    "elapsed_ms": int((time.perf_counter() - started) * 1000),
                }
            except Exception as exc:
                last_error = str(exc)
        return {
            "model": llm.get_model("verify"),
            "request": {"messages": messages, "json_mode": True},
            "raw_response": last_raw,
            "parsed": None,
            "accepted": False,
            "attempts": self.max_attempts,
            "elapsed_ms": int((time.perf_counter() - started) * 1000),
            "error": last_error or "未知核验错误",
        }

    def run(self, max_tasks: Optional[int] = None) -> Dict[str, Any]:
        tasks = self.database.list_verification_tasks("open")
        if max_tasks is not None:
            tasks = tasks[:max_tasks]
        run_id = f"verify_{uuid4().hex}"
        self.database.start_run(run_id, "verify", {"max_tasks": max_tasks})
        verified = needs_human = 0
        change_ids: set[int] = set()
        try:
            for task in tasks:
                votes = [self._vote(task, 1), self._vote(task, 2)]
                result = self.database.commit_verification_result(
                    run_id, task, votes, return_change_ids=True
                )
                status = result["status"]
                change_ids.update(int(value) for value in result["change_ids"])
                verified += status == "verified"
                needs_human += status == "needs_human"
            self.database.finish_run(run_id, "completed")
        except Exception as exc:
            self.database.finish_run(run_id, "failed", str(exc))
            raise
        return {
            "run_id": run_id,
            "tasks": len(tasks),
            "verified": verified,
            "needs_human": needs_human,
            "change_ids": sorted(change_ids),
        }
