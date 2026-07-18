import streamlit as st
import pandas as pd
from src.agents.glossary_manager import GlossaryManager, GlossaryItem, TermCategory, TermStatus

def show_glossary(project):
    st.title("📖 术语库管理")
    
    glossary_dir = project.glossary_dir
    manager = GlossaryManager(str(glossary_dir))
    manager.load()
    
    # 筛选器
    status_filter = st.multiselect(
        "状态筛选", 
        [s.value for s in TermStatus], 
        default=[s.value for s in TermStatus]
    )
    
    # 转换为 DataFrame 方便显示
    data = []
    for item in manager.glossary.items:
        if item.status.value not in status_filter:
            continue
            
        data.append({
            "ID": item.id,
            "原文 (Source)": item.src,
            "译文 (Target)": item.default_target,
            "分类 (Category)": item.category.value if item.category else "",
            "状态 (Status)": item.status.value,
            "描述 (Description)": item.description or "",
            "规则数": len(item.rules)
        })
    
    df = pd.DataFrame(data)
    
    # 顶部工具栏
    col1, col2 = st.columns([4, 1])
    with col2:
        if st.button("➕ 添加术语"):
            st.session_state.editing_term = None # New term
            st.session_state.show_term_editor = True
            st.rerun()

    # 主表格
    if not df.empty:
        st.dataframe(
            df,
            column_config={
                "ID": st.column_config.TextColumn("ID", disabled=True),
            },
            use_container_width=True,
            hide_index=True,
            selection_mode="single-row",
            on_select="rerun",
            key="glossary_table"
        )
        
        # 处理选中行
        selected_rows = st.session_state.glossary_table.get("selection", {}).get("rows", [])
        if selected_rows:
            selected_idx = selected_rows[0]
            selected_item = manager.glossary.items[selected_idx]
            
            st.divider()
            st.subheader(f"编辑: {selected_item.src}")
            
            with st.form("edit_term_form"):
                new_src = st.text_input("原文", value=selected_item.src)
                new_tgt = st.text_input("默认译文", value=selected_item.default_target)
                
                cat_options = [c.value for c in TermCategory]
                current_cat_idx = cat_options.index(selected_item.category.value) if selected_item.category else 0
                new_cat = st.selectbox("分类", options=cat_options, index=current_cat_idx)
                
                status_options = [s.value for s in TermStatus]
                current_status_idx = status_options.index(selected_item.status.value)
                new_status = st.selectbox("状态", options=status_options, index=current_status_idx)
                
                new_desc = st.text_area("描述", value=selected_item.description or "")
                
                # 规则编辑暂略（太复杂），留个口子
                
                col_save, col_del = st.columns([1, 1])
                with col_save:
                    submitted = st.form_submit_button("💾 保存更改", type="primary")
                with col_del:
                    deleted = st.form_submit_button("🗑️ 删除术语", type="secondary")
                
                if submitted:
                    # 更新内存对象
                    selected_item.src = new_src
                    selected_item.default_target = new_tgt
                    selected_item.category = TermCategory(new_cat)
                    selected_item.status = TermStatus(new_status)
                    selected_item.description = new_desc
                    
                    # 保存到文件
                    # 这里为了简单，我们保存整个 glossary 到一个 user_edited.json
                    # 实际生产中应该智能合并
                    manager.save(str(glossary_dir / "user_edited.json"))
                    st.success("已保存！")
                    st.rerun()
                    
                if deleted:
                    manager.glossary.items.pop(selected_idx)
                    manager.save(str(glossary_dir / "user_edited.json"))
                    st.success("已删除！")
                    st.rerun()

    # 添加新术语的 Modal (模拟)
    if st.session_state.get("show_term_editor"):
        with st.form("new_term_form"):
            st.subheader("新增术语")
            new_src = st.text_input("原文")
            new_tgt = st.text_input("默认译文")
            new_cat = st.selectbox("分类", options=[c.value for c in TermCategory])
            new_desc = st.text_area("描述")
            
            if st.form_submit_button("添加"):
                manager.add_term(new_src, new_tgt, new_cat, new_desc)
                manager.save(str(glossary_dir / "user_edited.json"))
                st.session_state.show_term_editor = False
                st.success("添加成功")
                st.rerun()
            
            if st.form_submit_button("取消"):
                st.session_state.show_term_editor = False
                st.rerun()
