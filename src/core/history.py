"""
翻译记忆模块 (Translation Memory)
负责管理翻译结果的持久化、检索和增量更新检查
"""
import json
from pathlib import Path
from typing import Optional

from .schemas import TextChunk, ChunkStatus, Chapter


class TranslationMemory:
    """
    翻译记忆库
    管理特定项目的翻译状态和内容
    """
    
    def __init__(self, project_dir: Path):
        self.project_dir = project_dir
        self.artifacts_dir = project_dir / "artifacts"
        self.chapters_dir = self.artifacts_dir / "chapters"
        self.long_term_memory_file = self.artifacts_dir / "long_term_memory.json"
        
        # 确保目录存在
        self.chapters_dir.mkdir(parents=True, exist_ok=True)
    
    def save_chunk(self, chunk: TextChunk) -> None:
        """
        保存单个 Chunk 的翻译结果
        实际上是更新其所属的章节文件（为了保持原子性和减少文件碎片）
        """
        chapter_file = self.chapters_dir / f"{chunk.chapter_id}.json"
        
        if not chapter_file.exists():
            raise FileNotFoundError(f"章节文件不存在: {chapter_file}")
        
        # 读取章节
        chapter_data = json.loads(chapter_file.read_text(encoding='utf-8'))
        
        # 更新对应的 Chunk
        found = False
        for i, c_data in enumerate(chapter_data.get("chunks", [])):
            if c_data["id"] == chunk.id:
                # 转换为 dict 并合并（保留原有字段）
                updated_data = chunk.model_dump(mode='json')
                chapter_data["chunks"][i] = updated_data
                found = True
                break
        
        if not found:
            raise ValueError(f"Chunk {chunk.id} 不在章节文件中")
        
        self._atomic_write_json(chapter_file, chapter_data)

    @staticmethod
    def _atomic_write_json(path: Path, data: dict) -> None:
        temp_path = path.with_suffix(path.suffix + ".tmp")
        temp_path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        temp_path.replace(path)

    def _load_long_term_memory(self) -> dict:
        if not self.long_term_memory_file.exists():
            return {
                "rolling_summary": "",
                "recent_chunks": [],
                "last_updated_chunk": None,
            }
        try:
            data = json.loads(self.long_term_memory_file.read_text(encoding="utf-8"))
            data.setdefault("rolling_summary", "")
            data.setdefault("recent_chunks", [])
            data.setdefault("last_updated_chunk", None)
            return data
        except (json.JSONDecodeError, OSError):
            return {
                "rolling_summary": "",
                "recent_chunks": [],
                "last_updated_chunk": None,
            }
    
    def get_chunk(self, chapter_id: str, chunk_index: int) -> Optional[TextChunk]:
        """获取指定 Chunk"""
        chapter = self.load_chapter(chapter_id)
        if not chapter:
            return None
        
        for chunk in chapter.chunks:
            if chunk.index == chunk_index:
                return chunk
        return None

    def load_chapter(self, chapter_id: str) -> Optional[Chapter]:
        """加载完整章节"""
        chapter_file = self.chapters_dir / f"{chapter_id}.json"
        if not chapter_file.exists():
            return None
            
        try:
            data = json.loads(chapter_file.read_text(encoding='utf-8'))
            return Chapter(**data)
        except Exception as e:
            print(f"Error loading chapter {chapter_id}: {e}")
            return None

    def should_skip(self, chunk: TextChunk, force: bool = False) -> bool:
        """
        判断是否应该跳过翻译
        
        规则：
        1. 如果 force=True，不跳过
        2. 如果状态是 COMPLETED 或 HUMAN_REVIEW，且已有译文，则跳过
        """
        if force:
            return False
        
        # 只有完成且有内容的才跳过
        is_finished = chunk.status in [ChunkStatus.COMPLETED, ChunkStatus.HUMAN_REVIEW]
        has_content = bool(chunk.final_translation)
        
        return is_finished and has_content

    def initialize_chapter(self, chapter: Chapter) -> None:
        """初始化章节存储（如果不存在）"""
        chapter_file = self.chapters_dir / f"{chapter.id}.json"
        if not chapter_file.exists():
            self._atomic_write_json(chapter_file, chapter.model_dump(mode="json"))

    def get_previous_chunk(self, current_chunk: TextChunk) -> Optional[TextChunk]:
        """获取前一个 Chunk"""
        if current_chunk.index == 0:
            return None
        return self.get_chunk(current_chunk.chapter_id, current_chunk.index - 1)

    def get_context_for_chunk(
        self,
        chunk: TextChunk,
        summary_max_chars: int = 1200,
        recent_chunks: int = 2,
        recent_source_chars: int = 600,
        recent_translation_chars: int = 1000,
    ) -> str:
        """
        获取用于翻译的上下文
        
        同时注入固定长度的全书滚动摘要，以及最近若干块的原文和译文。
        最近块存放在独立状态文件中，因此能跨章节衔接并支持断点续译。
        """
        state = self._load_long_term_memory()
        parts = []
        summary = str(state.get("rolling_summary") or "").strip()
        if summary:
            parts.append(
                "<long_term_summary>\n"
                + summary[-summary_max_chars:]
                + "\n</long_term_summary>"
            )

        recent = list(state.get("recent_chunks") or [])[-recent_chunks:]
        if recent:
            rendered = []
            for item in recent:
                source = str(item.get("source") or "")[-recent_source_chars:]
                translation = str(item.get("translation") or "")[-recent_translation_chars:]
                rendered.append(
                    f"<chunk id=\"{item.get('chunk_id', '')}\">\n"
                    f"<source_tail>{source}</source_tail>\n"
                    f"<translation_tail>{translation}</translation_tail>\n"
                    "</chunk>"
                )
            parts.append("<recent_context>\n" + "\n".join(rendered) + "\n</recent_context>")
        return "\n\n".join(parts)

    def update_long_term_memory(
        self,
        chunk: TextChunk,
        recent_chunks: int = 2,
        summary_max_chars: int = 1200,
        recent_source_chars: int = 600,
        recent_translation_chars: int = 1000,
    ) -> None:
        """Persist the memory snapshot emitted by layer one after a completed chunk."""
        if chunk.status not in {ChunkStatus.COMPLETED, ChunkStatus.HUMAN_REVIEW}:
            return
        if not chunk.final_translation:
            return

        state = self._load_long_term_memory()
        if chunk.memory_summary:
            state["rolling_summary"] = chunk.memory_summary.strip()[-summary_max_chars:]

        recent = [
            item for item in state.get("recent_chunks", [])
            if item.get("chunk_id") != chunk.id
        ]
        recent.append({
            "chunk_id": chunk.id,
            "chapter_id": chunk.chapter_id,
            "source": chunk.source_text[-recent_source_chars:],
            "translation": chunk.final_translation[-recent_translation_chars:],
        })
        state["recent_chunks"] = recent[-recent_chunks:]
        state["last_updated_chunk"] = chunk.id
        self._atomic_write_json(self.long_term_memory_file, state)

    def reset_long_term_memory(self) -> None:
        """Reset derived context without deleting any translations."""
        self._atomic_write_json(
            self.long_term_memory_file,
            {"rolling_summary": "", "recent_chunks": [], "last_updated_chunk": None},
        )
