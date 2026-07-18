"""
术语表管理模块
负责术语库的加载、检索和动态注入
"""
import json
import re
from pathlib import Path
from typing import List, Optional, Set

from ..core.schemas import Glossary, GlossaryItem, GlossaryRule, TermCategory, TermStatus


class GlossaryManager:
    """
    术语表管理器
    支持从 JSON 文件加载术语，并根据文本内容动态检索相关术语
    """
    
    def __init__(self, glossary_dir: str = "data/glossary"):
        """
        初始化术语表管理器
        
        Args:
            glossary_dir: 术语表目录
        """
        self.glossary_dir = Path(glossary_dir)
        self.glossary = Glossary()
        self._term_patterns: dict = {}  # 缓存编译后的正则
    
    def load(self, file_path: Optional[str] = None) -> Glossary:
        """
        加载术语表
        
        Args:
            file_path: 术语表文件路径，如不指定则加载目录下所有 JSON
        
        Returns:
            加载后的 Glossary 对象
        """
        if file_path:
            self._load_file(Path(file_path))
        else:
            # 加载目录下所有 JSON 文件
            if self.glossary_dir.exists():
                for json_file in self.glossary_dir.glob("*.json"):
                    self._load_file(json_file)
        
        # 构建正则缓存
        self._build_patterns()
        
        return self.glossary
    
    def _load_file(self, path: Path) -> None:
        """加载单个术语表文件"""
        if not path.exists():
            return
        
        try:
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            
            # 支持两种格式：数组或 {"items": [...]}
            items = data if isinstance(data, list) else data.get("items", [])
            
            for item_data in items:
                item = self._parse_item(item_data)
                if item:
                    self.glossary.items.append(item)
        
        except Exception as e:
            print(f"[GlossaryManager] 加载术语表失败 {path}: {e}")
    
    def _parse_item(self, data: dict) -> Optional[GlossaryItem]:
        """解析单个术语条目"""
        try:
            rules = []
            for rule_data in data.get("rules", []):
                rule = GlossaryRule(
                    condition=rule_data.get("condition", ""),
                    target=rule_data.get("target") or rule_data.get("tgt", ""),
                    example=rule_data.get("example")
                )
                rules.append(rule)
            
            category = None
            if "category" in data:
                try:
                    category = TermCategory(data["category"])
                except ValueError:
                    pass
            
            status = TermStatus.VERIFIED
            if "status" in data:
                try:
                    status = TermStatus(data["status"])
                except ValueError:
                    pass

            return GlossaryItem(
                id=data.get("id"),
                src=data["src"],
                default_target=data.get("default_target") or data.get("default_tgt", ""),
                category=category,
                status=status,
                description=data.get("description"),
                rules=rules
            )
        except Exception:
            return None
    
    def _build_patterns(self) -> None:
        """为所有术语构建正则匹配模式"""
        self._term_patterns.clear()
        for item in self.glossary.items:
            # 使用单词边界匹配，忽略大小写
            pattern = re.compile(rf'\b{re.escape(item.src)}\b', re.IGNORECASE)
            self._term_patterns[item.src] = pattern
    
    def find_terms_in_text(self, text: str, status_filter: Optional[List[TermStatus]] = None) -> List[GlossaryItem]:
        """
        在文本中查找所有出现的术语
        
        Args:
            text: 待检索文本
            status_filter: 状态过滤列表，默认为 [TermStatus.VERIFIED]
        
        Returns:
            命中的术语列表
        """
        if status_filter is None:
            status_filter = [TermStatus.VERIFIED]
            
        found_terms = []
        found_srcs: Set[str] = set()
        
        for item in self.glossary.items:
            # 状态过滤
            if item.status not in status_filter:
                continue
                
            pattern = self._term_patterns.get(item.src)
            if pattern and pattern.search(text):
                if item.src.lower() not in found_srcs:
                    found_terms.append(item)
                    found_srcs.add(item.src.lower())
        
        return found_terms
    
    def get_prompt_text(self, text: str) -> str:
        """
        根据文本内容生成术语提示文本
        (仅返回已确认的术语)
        """
        terms = self.find_terms_in_text(text, status_filter=[TermStatus.VERIFIED])
        
        if not terms:
            return "（无特殊术语）"
        
        return "\n".join(term.to_prompt_text() for term in terms)
    
    def find_by_src(self, src: str) -> Optional[GlossaryItem]:
        """根据原词查找术语 (代理方法)"""
        return self.glossary.find_by_src(src)

    def add_term(
        self,
        src: str,
        default_target: str,
        category: Optional[str] = None,
        description: Optional[str] = None,
        rules: Optional[List[dict]] = None,
        status: TermStatus = TermStatus.PENDING
    ) -> GlossaryItem:
        """
        添加新术语
        """
        parsed_rules = []
        if rules:
            for r in rules:
                parsed_rules.append(GlossaryRule(
                    condition=r.get("condition", ""),
                    target=r.get("target", ""),
                    example=r.get("example")
                ))
        
        # 简单去重：如果已存在同名术语，不添加
        # 注意：这里我们做一个不区分大小写的检查
        if self.find_by_src(src):
            return self.find_by_src(src)

        item = GlossaryItem(
            id=f"term_{src.lower().replace(' ', '_')}",
            src=src,
            default_target=default_target,
            category=TermCategory(category) if category else None,
            status=status,
            description=description,
            rules=parsed_rules
        )
        
        self.glossary.items.append(item)
        
        # 更新正则缓存
        pattern = re.compile(rf'\b{re.escape(src)}\b', re.IGNORECASE)
        self._term_patterns[src] = pattern
        
        # 自动保存到 auto_generated.json
        self._save_auto_term(item)
        
        return item

    def _save_auto_term(self, item: GlossaryItem):
        """将新术语追加到 auto_generated.json"""
        if not self.glossary_dir.exists():
            return
            
        auto_file = self.glossary_dir / "auto_generated.json"
        
        data = []
        if auto_file.exists():
            try:
                with open(auto_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
            except Exception:
                data = [] # 文件损坏或为空，重新开始
        
        # 构造字典
        item_data = {
            "id": item.id,
            "src": item.src,
            "default_target": item.default_target,
            "category": item.category.value if item.category else None,
            "status": item.status.value,
            "description": item.description
        }
        
        data.append(item_data)
        
        with open(auto_file, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    
    def save(self, file_path: str) -> None:
        """
        保存术语表到文件
        
        Args:
            file_path: 保存路径
        """
        data = []
        for item in self.glossary.items:
            item_data = {
                "id": item.id,
                "src": item.src,
                "default_target": item.default_target,
                "status": item.status.value
            }
            if item.category:
                item_data["category"] = item.category.value
            if item.description:
                item_data["description"] = item.description
            if item.rules:
                item_data["rules"] = [
                    {
                        "condition": r.condition,
                        "target": r.target,
                        "example": r.example
                    }
                    for r in item.rules
                ]
            data.append(item_data)
        
        path = Path(file_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
