import streamlit as st
import sys
from pathlib import Path

# 添加项目根目录到 Python 路径
project_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(project_root))

from src.core.project_manager import ProjectManager
from src.core.history import TranslationMemory
from src.core.schemas import ChunkStatus

# 配置页面
st.set_page_config(
    page_title="DeepNovel-Translator",
    page_icon="📚",
    layout="wide",
    initial_sidebar_state="expanded"
)

# 初始化全局状态
if "project_manager" not in st.session_state:
    st.session_state.project_manager = ProjectManager(str(project_root / "projects"))

# 侧边栏：项目选择
with st.sidebar:
    st.title("📚 DNT 工作台")
    
    # 刷新项目列表
    projects = st.session_state.project_manager.list_projects()
    
    selected_project_id = st.selectbox(
        "选择项目",
        options=projects,
        index=0 if projects else None
    )
    
    if selected_project_id:
        st.session_state.current_project = st.session_state.project_manager.load_project(selected_project_id)
        st.success(f"已加载: {selected_project_id}")
    else:
        st.session_state.current_project = None
        st.info("请先在 CLI 中创建项目")

    st.divider()
    st.markdown("### 导航")
    page = st.radio("Go to", ["仪表盘", "翻译审阅", "术语库", "知识库", "导出"])

# 路由分发
if not st.session_state.current_project:
    st.warning("请先选择或创建一个项目")
else:
    project = st.session_state.current_project
    
    if page == "仪表盘":
        from src.webui.views.dashboard import show_dashboard
        show_dashboard(project)
        
    elif page == "翻译审阅":
        from src.webui.views.editor import show_editor
        show_editor(project)
        
    elif page == "术语库":
        from src.webui.views.glossary_view import show_glossary
        show_glossary(project)
        
    elif page == "知识库":
        from src.webui.views.knowledge_base_view import show_knowledge_base
        show_knowledge_base(project)
        
    elif page == "导出":
        from src.webui.views.export import show_export
        show_export(project)
