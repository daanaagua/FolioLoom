import streamlit as st
import pandas as pd
import subprocess
import shlex
import sys
from pathlib import Path
from src.core.schemas import ChunkStatus

def run_translation_in_terminal(book_id, chapters=None):
    """
    在独立终端窗口中运行翻译命令
    """
    python_exe = sys.executable
    
    # 获取 main.py 的绝对路径
    # dashboard.py 在 src/webui/views/
    # main.py 在项目根目录
    current_file = Path(__file__).resolve()
    project_root = current_file.parent.parent.parent.parent
    script_path = project_root / "main.py"
    
    if not script_path.exists():
        st.error(f"找不到 main.py: {script_path}")
        return

    # 构建参数列表
    args = [str(script_path), "translate", book_id, "--force"]
    if chapters:
        args.extend(["--chapters", chapters])
    
    # 手动构建命令字符串，仅对有空格的部分加引号
    def win_quote(s):
        if " " in s:
            return f'"{s}"'
        return s

    args_str = " ".join(win_quote(s) for s in args)
    
    # 最终执行的命令：python main.py ...
    cmd_to_run = f'{win_quote(python_exe)} {args_str}'
    
    if sys.platform.startswith('win'):
        # 使用 /D 参数指定工作目录为项目根目录，确保相对路径(如 config/) 依然有效
        work_dir = win_quote(str(project_root))
        final_cmd = f'start "DNT: {book_id}" /D {work_dir} cmd /k {cmd_to_run}'
        print(f"Executing: {final_cmd}")
        subprocess.Popen(final_cmd, shell=True)
    else:
        st.warning("弹窗功能目前仅支持 Windows。")
        st.code(f"cd {project_root} && {python_exe} {args_str}")

def show_dashboard(project):
    st.title(f"仪表盘: {project.book_id}")
    
    # 获取统计数据
    # 遍历 artifacts/chapters 目录下的 json 文件
    chapter_files = sorted(project.memory.chapters_dir.glob("*.json"))
    
    total_chapters = len(chapter_files)
    total_chunks = 0
    completed_chunks = 0
    total_tokens = 0
    
    chapter_stats = []
    
    # 进度条占位符
    progress_bar = st.progress(0)
    
    # 快速扫描
    for i, ch_file in enumerate(chapter_files):
        chapter = project.memory.load_chapter(ch_file.stem)
        if not chapter:
            continue
            
        ch_total = len(chapter.chunks)
        ch_completed = sum(1 for c in chapter.chunks if c.status in [ChunkStatus.COMPLETED, ChunkStatus.HUMAN_REVIEW])
        ch_tokens = sum(c.token_count or 0 for c in chapter.chunks)
        
        total_chunks += ch_total
        completed_chunks += ch_completed
        total_tokens += ch_tokens
        
        chapter_stats.append({
            "Chapter ID": chapter.id,
            "Title": chapter.title,
            "Progress": f"{ch_completed}/{ch_total}",
            "Status": "✅" if ch_completed == ch_total else "🔄" if ch_completed > 0 else "⬜",
            "Tokens": ch_tokens
        })
        
        # 更新加载进度
        progress_bar.progress((i + 1) / total_chapters)
    
    # 移除进度条
    progress_bar.empty()
    
    # 核心指标
    col1, col2, col3, col4 = st.columns(4)
    col1.metric("总章节", total_chapters)
    col2.metric("总分块", total_chunks)
    col3.metric("已完成", f"{completed_chunks} ({completed_chunks/total_chunks*100:.1f}%)" if total_chunks else "0%")
    col4.metric("总词数 (Est. Tokens)", total_tokens)
    
    st.divider()
    
    # 控制台区域
    st.subheader("🚀 翻译控制台")
    
    with st.expander("运行配置", expanded=True):
        c1, c2 = st.columns([3, 1])
        with c1:
            target_chapters = st.text_input("指定章节 (逗号分隔，留空翻译所有)", placeholder="例如: v01_ch01,v01_ch02")
        with c2:
            st.write("") # Spacer
            st.write("") 
            start_btn = st.button("🖥️ 启动 CLI 翻译", type="primary", use_container_width=True)
            
        if start_btn:
            run_translation_in_terminal(project.book_id, target_chapters)
            st.success("已启动终端窗口！请在弹出的 CMD 中查看进度。")
            st.info("任务完成后，请手动刷新本页面以更新进度。")

    st.divider()
    
    # 详细列表
    st.subheader("章节列表")
    df = pd.DataFrame(chapter_stats)
    st.dataframe(
        df,
        column_config={
            "Progress": st.column_config.ProgressColumn("进度", min_value=0, max_value=100, format="%f"), 
        },
        use_container_width=True
    )
