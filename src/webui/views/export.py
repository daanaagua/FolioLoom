import streamlit as st
import io

def show_export(project):
    st.title("📤 导出译文")
    
    export_format = st.radio("格式", ["Markdown (纯译文)", "Markdown (双语对照)"])
    
    if st.button("生成导出文件"):
        full_text = ""
        chapter_files = sorted(project.memory.chapters_dir.glob("*.json"))
        
        progress_bar = st.progress(0)
        
        for i, ch_file in enumerate(chapter_files):
            chapter = project.memory.load_chapter(ch_file.stem)
            if not chapter: continue
            
            # 章节标题
            full_text += f"# {chapter.title}\n\n"
            
            for chunk in chapter.chunks:
                translation = chunk.final_translation or ""
                source = chunk.source_text or ""
                
                if "双语" in export_format:
                    full_text += f"> {source.replace(chr(10), chr(10)+'> ')}\n\n"
                    full_text += f"{translation}\n\n"
                else:
                    full_text += f"{translation}\n\n"
            
            full_text += "---\n\n"
            progress_bar.progress((i + 1) / len(chapter_files))
            
        st.success("生成完毕！")
        
        # 下载按钮
        st.download_button(
            label="下载文件",
            data=full_text,
            file_name=f"{project.book_id}_export.md",
            mime="text/markdown"
        )
