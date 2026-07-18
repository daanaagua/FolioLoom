import streamlit as st
import json
from src.core.schemas import TermCategory

def show_knowledge_base(project):
    st.header("🧠 知识库 (记忆系统)")
    st.info("这里管理项目中所有实体档案 (Entity Dossier) 及其关系网。")
    
    kb = project.knowledge_base
    
    # 获取所有实体
    # KB 目前没有直接暴露 list_all 方法，但可以访问 entities 属性
    # 重新加载以确保最新
    kb._load_all()
    entities = kb.entities
    
    if not entities:
        st.warning("暂无实体数据。请运行翻译任务以自动提取。")
        return

    # 布局：左侧列表，右侧详情
    col1, col2 = st.columns([1, 2])
    
    with col1:
        st.subheader("实体列表")
        
        # 搜索框
        search_term = st.text_input("搜索实体", "")
        
        # 筛选
        filter_type = st.multiselect("类型筛选", [t.value for t in TermCategory], default=[t.value for t in TermCategory])
        
        entity_list = []
        for eid, ent in entities.items():
            if search_term.lower() in ent.name.lower() and ent.type.value in filter_type:
                entity_list.append(ent)
        
        # 排序
        entity_list.sort(key=lambda x: x.name)
        
        selected_entity_name = st.radio(
            "选择实体",
            options=[e.name for e in entity_list],
            key="kb_entity_select"
        )
    
    with col2:
        if selected_entity_name:
            entity = kb.get_entity(selected_entity_name)
            if entity:
                st.subheader(f"{entity.name}")
                st.caption(f"ID: {entity.id} | Type: {entity.type.value}")
                
                # 编辑基本信息
                with st.expander("基本信息", expanded=True):
                    new_desc = st.text_area("简介", value=entity.description, height=100)
                    if new_desc != entity.description:
                        entity.description = new_desc
                        kb._save_entity(entity)
                        st.toast("简介已更新")
                
                # 关系网
                st.subheader("关系网")
                if entity.relations:
                    for i, rel in enumerate(entity.relations):
                        with st.container(border=True):
                            cols = st.columns([2, 1, 3])
                            cols[0].markdown(f"**{rel.relation}**")
                            cols[1].markdown(f"-> {rel.target}")
                            cols[2].caption(f"Context: {rel.context or 'N/A'}")
                else:
                    st.info("暂无关系记录")
                
                # Raw JSON
                with st.expander("查看原始 JSON"):
                    st.json(entity.model_dump())
