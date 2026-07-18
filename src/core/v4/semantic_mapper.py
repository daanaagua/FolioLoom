"""Focused semantic mapping for relations that literal sentence-by-sentence translation may lose."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Dict, List


ALLOWED_RELATION_TYPES = {
    "referential_link",
    "same_event_different_rendering",
    "viewpoint_or_layer_shift",
    "ellipsis_or_implicit_subject",
    "causal_or_contrast_link",
    "deliberate_ambiguity",
}
ALLOWED_STRENGTHS = {"explicit", "strongly_implied", "ambiguous"}


@dataclass
class SemanticMapperConfig:
    temperature: float = 0.0
    max_tokens: int = 4096
    max_attempts: int = 2
    max_rendered_chars: int = 4000


class SemanticMapper:
    """Ask a separate, narrow model pass to map semantic relations before translation."""

    SYSTEM_PROMPT = """你是文学翻译流程中的独立语义映射器。你不翻译原文，也不评价文笔；你只识别逐句直译时容易丢失、但中文读者仍应能够恢复的句间关系。

只检查以下通用关系：
1. 跨句指代；
2. 同一事件在现实层、感知层、虚拟呈现层或不同观察者版本中的连续描写；
3. 视角或呈现载体切换后出现的无名主体；
4. 省略主语或省略比较对象；
5. 句间因果、转折或反讽；
6. 原文刻意保留的多义关系。

判断只能依据当前原文和给出的前文证据。不得补写设定，不得把多义解释裁成唯一答案，不得提出固定译名。只有在关系为明说、强暗示或确需保留歧义时才记录。translation_constraint只说明中文必须保住什么关系及其显隐强度，不得直接给出整句译文。

严格输出JSON，不得输出JSON以外的文字：
{
  "relations": [
    {
      "relation_type": "referential_link | same_event_different_rendering | viewpoint_or_layer_shift | ellipsis_or_implicit_subject | causal_or_contrast_link | deliberate_ambiguity",
      "inference_strength": "explicit | strongly_implied | ambiguous",
      "source_spans": ["当前原文中的短引文1", "当前原文中的短引文2"],
      "translation_constraint": "中文中必须保留的关系；不得添加原文没有明说的结论"
    }
  ]
}

若没有高风险关系，输出 {"relations": []}。source_spans必须逐字取自当前原文，每条关系至少给出两个片段。"""

    def __init__(self, llm: Any, config: SemanticMapperConfig | None = None):
        self.llm = llm
        self.config = config or SemanticMapperConfig()
        self.last_succeeded = False

    @staticmethod
    def _strip_code_fence(text: str) -> str:
        value = text.strip()
        if value.startswith("```"):
            value = re.sub(r"^```(?:json)?\s*", "", value, count=1, flags=re.I)
            value = re.sub(r"\s*```$", "", value, count=1)
        return value.strip()

    @staticmethod
    def _normalized(value: str) -> str:
        return re.sub(r"\s+", " ", value).strip()

    @classmethod
    def _span_is_grounded(cls, span: str, source_text: str) -> bool:
        return bool(span.strip()) and cls._normalized(span) in cls._normalized(source_text)

    def _validate(self, payload: Any, source_text: str) -> List[Dict[str, Any]]:
        if not isinstance(payload, dict) or not isinstance(payload.get("relations"), list):
            raise ValueError("顶层必须是包含relations数组的对象")
        valid: List[Dict[str, Any]] = []
        for item in payload["relations"]:
            if not isinstance(item, dict):
                continue
            relation_type = str(item.get("relation_type") or "")
            strength = str(item.get("inference_strength") or "")
            spans = item.get("source_spans")
            constraint = str(item.get("translation_constraint") or "").strip()
            if relation_type not in ALLOWED_RELATION_TYPES:
                continue
            if strength not in ALLOWED_STRENGTHS:
                continue
            if not isinstance(spans, list) or len(spans) < 2 or not constraint:
                continue
            grounded = [str(span).strip() for span in spans if isinstance(span, str)]
            if len(grounded) < 2 or not all(
                self._span_is_grounded(span, source_text) for span in grounded
            ):
                continue
            valid.append(
                {
                    "relation_type": relation_type,
                    "inference_strength": strength,
                    "source_spans": grounded[:4],
                    "translation_constraint": constraint,
                }
            )
        return valid

    def _render(self, relations: List[Dict[str, Any]]) -> str:
        if not relations:
            return ""
        lines = ["【独立语义映射：只约束关系，不提供固定译法】"]
        for item in relations:
            spans = " ⇄ ".join(f"“{span}”" for span in item["source_spans"])
            entry = (
                f"- {item['relation_type']} / {item['inference_strength']}：{spans}。"
                f"约束：{item['translation_constraint']}"
            )
            if len("\n".join(lines + [entry])) > self.config.max_rendered_chars:
                break
            lines.append(entry)
        return "\n".join(lines) if len(lines) > 1 else ""

    def map(self, source_text: str, prior_context: str = "") -> str:
        self.last_succeeded = False
        user_prompt = (
            "<prior_context>\n"
            f"{prior_context}\n"
            "</prior_context>\n\n"
            "<current_source>\n"
            f"{source_text}\n"
            "</current_source>"
        )
        messages = [
            {"role": "system", "content": self.SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ]
        last_error = ""
        for attempt in range(self.config.max_attempts):
            attempt_messages = list(messages)
            if attempt and last_error:
                attempt_messages.append(
                    {
                        "role": "user",
                        "content": f"上一份JSON无效：{last_error}。请重新输出完全符合格式的JSON。",
                    }
                )
            try:
                raw = self.llm.chat(
                    messages=attempt_messages,
                    purpose="semantic",
                    temperature=self.config.temperature,
                    max_tokens=self.config.max_tokens,
                    json_mode=True,
                    stream=False,
                )
                payload = json.loads(self._strip_code_fence(str(raw)))
                relations = self._validate(payload, source_text)
                if payload.get("relations") and not relations:
                    raise ValueError("relations非空，但没有任何关系通过原文引文校验")
                self.last_succeeded = True
                return self._render(relations)
            except Exception as exc:
                last_error = str(exc)
        return ""
