"""
知识库/记忆管理模块
负责实体档案 (Entity Dossier) 的存储、检索和更新
"""
import json
import re
from pathlib import Path
from typing import List, Optional, Dict, Set
from .schemas import Entity, EntityRelation, TermCategory

class KnowledgeBase:
    """
    知识库管理器
    维护项目中的实体档案
    """
    def __init__(self, project_dir: str):
        self.project_dir = Path(project_dir)
        self.entities_dir = self.project_dir / "entities"
        self.entities_dir.mkdir(parents=True, exist_ok=True)
        
        # 内存缓存: id -> Entity
        self.entities: Dict[str, Entity] = {}
        self._load_all()

    def _normalize_id(self, name: str) -> str:
        """生成标准化的 ID (lowercase, snake_case)"""
        return re.sub(r'\s+', '_', name.strip().lower())

    def _load_all(self):
        """加载所有实体档案"""
        for file_path in self.entities_dir.glob("*.json"):
            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    entity = Entity(**data)
                    self.entities[entity.id] = entity
            except Exception as e:
                print(f"[KnowledgeBase] Load failed for {file_path}: {e}")

    def get_entity(self, name: str) -> Optional[Entity]:
        """根据名称查找实体 (尝试 ID 和 aliases)"""
        query_id = self._normalize_id(name)
        
        # 1. Direct ID match
        if query_id in self.entities:
            return self.entities[query_id]
            
        # 2. Alias match (Linear search, can be optimized)
        for entity in self.entities.values():
            if name.lower() == entity.name.lower():
                return entity
            for alias in entity.aliases:
                if name.lower() == alias.lower():
                    return entity
        return None

    def add_entity(self, name: str, category: str, description: str = "") -> Entity:
        """添加新实体"""
        entity_id = self._normalize_id(name)
        
        if entity_id in self.entities:
            return self.entities[entity_id]
            
        # Convert category string to Enum
        try:
            cat_enum = TermCategory(category)
        except ValueError:
            cat_enum = TermCategory.CONCEPT
            
        entity = Entity(
            id=entity_id,
            name=name,
            type=cat_enum,
            description=description
        )
        self.entities[entity_id] = entity
        self._save_entity(entity)
        return entity

    def add_alias(self, entity_id: str, alias: str):
        """添加别名"""
        if entity_id in self.entities:
            entity = self.entities[entity_id]
            if alias and alias not in entity.aliases and alias != entity.name:
                entity.aliases.append(alias)
                self._save_entity(entity)

    def update_entity_relation(self, subject_name: str, object_name: str, relation_desc: str, context: str = None):
        """更新实体关系"""
        subject = self.get_entity(subject_name)
        if not subject:
            # Auto-create if not exists (Lazy creation)
            # Default to CONCEPT if unknown
            print(f"[KnowledgeBase] Auto-creating entity: {subject_name}")
            subject = self.add_entity(subject_name, "concept", description="Auto-created from relation extraction.")
        
        # Create relation object
        rel = EntityRelation(
            source=subject.name,
            target=object_name,
            relation=relation_desc,
            context=context
        )
        
        # Check duplication
        # Simple check: same target and relation
        is_duplicate = False
        for existing_rel in subject.relations:
            if existing_rel.target == object_name and existing_rel.relation == relation_desc:
                is_duplicate = True
                break
        
        if not is_duplicate:
            subject.relations.append(rel)
            self._save_entity(subject)

    def _save_entity(self, entity: Entity):
        """保存实体到磁盘"""
        file_path = self.entities_dir / f"{entity.id}.json"
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(entity.model_dump_json(indent=2))
            
        # Optional: Save MD for human reading
        md_path = self.entities_dir / f"{entity.id}.md"
        with open(md_path, 'w', encoding='utf-8') as f:
            f.write(entity.to_markdown())

    def get_prompt_text(self, names: List[str]) -> str:
        """
        根据名字列表生成 Context Prompt
        """
        context_lines = []
        seen_ids = set()
        
        for name in names:
            entity = self.get_entity(name)
            if entity and entity.id not in seen_ids:
                seen_ids.add(entity.id)
                # Format:
                # - Severian (Person): The narrator. Relations: friend of Foila.
                desc = entity.description or "No description."
                rel_text = ""
                if entity.relations:
                    rels = [f"{r.relation} {r.target}" for r in entity.relations[-3:]] # limit to recent 3
                    rel_text = f" Relations: {', '.join(rels)}."
                
                context_lines.append(f"- **{entity.name}** ({entity.type.value}): {desc}{rel_text}")
        
        if not context_lines:
            return ""
            
        return "## 相关实体档案\n" + "\n".join(context_lines)
