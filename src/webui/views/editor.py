import streamlit as st
from src.core.schemas import ChunkStatus

def show_editor(project):
    st.title("📝 翻译审阅")
    
    # 1. 选择章节
    chapter_files = sorted(project.memory.chapters_dir.glob("*.json"))
    chapter_ids = [f.stem for f in chapter_files]
    
    selected_chapter_id = st.selectbox("选择章节", chapter_ids)
    
    if not selected_chapter_id:
        return
        
    # 加载章节
    chapter = project.memory.load_chapter(selected_chapter_id)
    if not chapter:
        st.error("无法加载章节内容")
        return
    
    # 2. 导航 Chunk
    # 使用 session_state 记录当前 chunk index
    if "current_chunk_idx" not in st.session_state:
        st.session_state.current_chunk_idx = 0
        
    # 确保索引有效
    if st.session_state.current_chunk_idx >= len(chapter.chunks):
        st.session_state.current_chunk_idx = 0
        
    chunk_idx = st.session_state.current_chunk_idx
    chunk = chapter.chunks[chunk_idx]
    
    # 导航栏
    col_prev, col_info, col_next = st.columns([1, 4, 1])
    
    with col_prev:
        if st.button("⬅️ 上一段", disabled=chunk_idx == 0):
            st.session_state.current_chunk_idx -= 1
            st.rerun()
            
    with col_info:
        st.markdown(f"<div style='text-align: center'><b>Chunk {chunk.id}</b> ({chunk_idx + 1}/{len(chapter.chunks)}) - {chunk.status.value}</div>", unsafe_allow_html=True)
        
    with col_next:
        if st.button("下一段 ➡️", disabled=chunk_idx == len(chapter.chunks) - 1):
            st.session_state.current_chunk_idx += 1
            st.rerun()
            
    st.divider()
    
    # 3. 编辑区域 (双栏)
    col_source, col_target = st.columns(2)
    
    with col_source:
        st.markdown("### 原文")
        st.info(chunk.source_text)
        
        # 显示逻辑分析
        if chunk.analysis:
            with st.expander("🧠 逻辑分析 (AI Analysis)", expanded=True):
                st.markdown(chunk.analysis)
        # 兼容旧版本数据
        elif chunk.logic_analysis and chunk.logic_analysis.has_ambiguity:
            with st.expander("🧠 逻辑分析 (Legacy)", expanded=True):
                for item in chunk.logic_analysis.analysis:
                    st.markdown(f"**引用**: `{item.quote}`")
                    st.markdown(f"**含义**: {item.interpretation}")
                    if item.disconnection:
                        st.markdown(f"⚠️ **排雷**: {item.disconnection}")
                    st.divider()

    with col_target:
        st.markdown("### 译文")
        
        # 初始值
        initial_value = chunk.final_translation or chunk.draft_translation or ""
        
        # 动态计算高度
        # 假设每行约 40-50 字符，行高 25px，基础高度 200px
        # 这是一个粗略估计，为了更好的阅读体验
        line_count = initial_value.count('\n') + (len(initial_value) / 40)
        dynamic_height = max(400, int(line_count * 25))
        
        # 编辑框
        new_translation = st.text_area(
            "编辑译文",
            value=initial_value,
            height=dynamic_height,
            key=f"edit_{chunk.id}"
        )
        
        # 保存按钮
        if st.button("💾 保存修改", type="primary"):
            # 更新对象
            chunk.final_translation = new_translation
            chunk.status = ChunkStatus.HUMAN_REVIEW # 标记为人工已审
            
            # 持久化
            project.memory.save_chunk(chunk)
            st.success("已保存！")
            
            # 自动跳到下一段？
            # st.session_state.current_chunk_idx += 1
            # st.rerun()
            
    # 辅助信息
    with st.expander("调试信息"):
        st.json(chunk.model_dump())
