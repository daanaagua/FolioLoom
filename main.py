"""
DeepNovel-Translator CLI 入口 (v2.0 Project-Based)
"""
import argparse
import json
import sys
import shutil
from pathlib import Path

# 添加项目根目录到 Python 路径
project_root = Path(__file__).parent
sys.path.insert(0, str(project_root))

from src.utils.config_loader import ConfigLoader
from src.core.llm_client import LLMManager
from src.core.translator import TranslationEngine, TranslationConfig
from src.core.project_manager import ProjectManager
from src.core.exporter import BookExporter
from src.core.folioloom_exporter import FolioLoomBookExporter
from src.agents.glossary_manager import GlossaryManager
from src.core.schemas import ChunkStatus
from src.core.v4 import (
    CoreferenceCoordinator,
    ParallelV4BookExporter,
    DocxBaselineImporter,
    RevalidationRunner,
    V4Database,
    V4Migrator,
    V4PipelineConfig,
    V4Repairer,
    V4Scanner,
    V4TranslationPipeline,
    V4Validator,
    V4Verifier,
    serve_review_ui,
    write_shadow_comparison,
)
from src.core.v4.adjudicator import V4Adjudicator
from src.core.v4.schema_v8 import (
    confirm_schema8 as _confirm_schema7_to8,
    preview_schema8 as _preview_schema7_to8,
)
from src.core.v4.schema_v9 import (
    inspect_schema as _inspect_v4_schema,
    preview_schema9,
)

# Compatibility seam for existing CLI tests and extensions.  It now previews
# the current schema-9 migration rather than the retired schema-8 migration.
preview_schema8 = preview_schema9
from src.core.v4.target_resolver import TargetResolver
from rich.console import Console
from rich.theme import Theme

# 初始化 Rich Console
console = Console(theme=Theme({"think": "dim white", "info": "cyan"}))

# 初始化核心组件
config_loader = ConfigLoader(config_dir=str(project_root / "config"))
project_manager = ProjectManager(projects_root=str(project_root / "projects"))

def stream_printer(phase, content):
    """流式打印回调"""
    if phase == "logic":
        console.print(f"\r[info][Logic][/info] {content}", end="")
    elif phase == "draft_start":
        console.print("\n\n[bold green][Draft][/bold green] ", end="")
    elif phase == "draft_think":
        console.print(content, style="think", end="")
    elif phase == "draft_content":
        console.print(content, end="")
    elif phase == "polish_start":
        console.print("\n\n[bold yellow][Polish][/bold yellow] ", end="")
    elif phase == "polish_think":
        console.print(content, style="think", end="")
    elif phase == "polish_content":
        console.print(content, end="")

def cmd_init(args):
    """初始化新项目"""
    print(f"正在创建项目: {args.book_id} ...")
    try:
        global_config = config_loader.load_config()
        chunking = global_config.get("translation", {}).get("chunking", {})
        project = project_manager.create_project(
            book_id=args.book_id,
            source_path=args.file,
            force=args.force,
            max_chunk_tokens=int(chunking.get("max_tokens", 1100)),
            overlap_sentences=int(chunking.get("overlap_sentences", 0)),
            source_encoding=args.encoding,
            source_language=args.source_language,
        )
        print(f"[OK] 项目创建成功！位置: {project.root_dir}")
        print(f"下一步: 请运行 'python main.py translate {args.book_id}' 开始翻译")
    except Exception as e:
        print(f"[ERROR] 创建失败: {e}")

def cmd_list(args):
    """列出所有项目"""
    projects = project_manager.list_projects()
    if not projects:
        print("暂无项目。请使用 'init' 命令创建。")
        return
    
    print("【项目列表】")
    for p in projects:
        print(f"  - {p}")

def cmd_translate(args):
    """项目翻译命令"""
    book_id = args.book_id
    
    try:
        project = project_manager.load_project(book_id)
    except FileNotFoundError:
        print(f"❌ 项目 '{book_id}' 不存在。")
        return

    # 1. 加载配置
    global_config = config_loader.load_config()
    prompts = config_loader.load_prompts()
    
    # 2. 初始化引擎组件
    llm_manager = LLMManager(global_config["llm"])
    
    # 加载项目专用术语表
    glossary_manager = GlossaryManager(str(project.glossary_dir))
    glossary_manager.load()
    
    # 初始化翻译引擎
    translation_settings = global_config.get("translation", {})
    draft_settings = translation_settings.get("draft", {})
    polish_settings = translation_settings.get("polish", {})
    memory_settings = translation_settings.get("memory", {})
    trans_config = TranslationConfig(
        enable_polish=not args.no_polish,
        draft_temperature=(args.temp_draft if args.temp_draft is not None else float(draft_settings.get("temperature", 0.1))),
        draft_max_tokens=int(draft_settings.get("max_tokens", 6144)),
        polish_temperature=(args.temp_polish if args.temp_polish is not None else float(polish_settings.get("temperature", 0.2))),
        polish_max_tokens=int(polish_settings.get("max_tokens", 6144)),
        glossary_mode=args.glossary_mode,
    )
    engine = TranslationEngine(
        llm_manager=llm_manager,
        glossary_manager=glossary_manager,
        knowledge_base=project.knowledge_base,
        prompts=prompts,
        config=trans_config
    )
    
    print(f"[START] 开始翻译项目: {book_id}")
    print(f"配置: 术语模式={args.glossary_mode}, 润色={'OFF' if args.no_polish else 'ON'}")
    
    # 3. 遍历章节和 Chunk
    chapter_files = sorted(project.memory.chapters_dir.glob("*.json"))
    
    total_processed = 0
    total_skipped = 0
    total_failed = 0
    total_review = 0
    stop_requested = False
    
    for ch_file in chapter_files:
        chapter_id = ch_file.stem
        
        # 如果指定了章节范围
        if args.chapters and chapter_id not in args.chapters.split(','):
            continue
            
        print(f"\n[Chapter] 处理章节: {chapter_id}")
        
        # 加载章节数据
        chapter = project.memory.load_chapter(chapter_id)
        if not chapter:
            print(f"  [WARN] 无法加载章节 {chapter_id}")
            continue
            
        for chunk in chapter.chunks:
            if args.max_chunks is not None and total_processed >= args.max_chunks:
                stop_requested = True
                break
            # 检查是否需要跳过
            if project.memory.should_skip(chunk, force=args.force):
                print(f"  [SKIP] Chunk {chunk.id}: 已完成，跳过")
                total_skipped += 1
                continue
            
            print(f"  [TRANS] 翻译 Chunk {chunk.id} (Tokens: {chunk.token_count})...")
            
            # 获取上下文
            context = project.memory.get_context_for_chunk(
                chunk,
                summary_max_chars=int(memory_settings.get("rolling_summary_max_chars", 1200)),
                recent_chunks=int(memory_settings.get("recent_chunks", 2)),
                recent_source_chars=int(memory_settings.get("recent_source_chars", 600)),
                recent_translation_chars=int(memory_settings.get("recent_translation_chars", 1000)),
            )
            
            # 执行翻译 (带流式回调)
            result_chunk = engine.translate_chunk(
                chunk, 
                memory_context=context,
                stream_callback=None if args.quiet else stream_printer,
            )
            
            print("") # 换行
            
            # 保存结果
            project.memory.save_chunk(result_chunk)
            project.memory.update_long_term_memory(
                result_chunk,
                recent_chunks=int(memory_settings.get("recent_chunks", 2)),
                summary_max_chars=int(memory_settings.get("rolling_summary_max_chars", 1200)),
                recent_source_chars=int(memory_settings.get("recent_source_chars", 600)),
                recent_translation_chars=int(memory_settings.get("recent_translation_chars", 1000)),
            )
            
            if result_chunk.status == ChunkStatus.COMPLETED:
                print(f"     [OK] 完成")
            elif result_chunk.status == ChunkStatus.HUMAN_REVIEW:
                total_review += 1
                print(f"     [WARN] 润色不完整，已用完整初稿兜底并标记复核")
            else:
                print(f"     [ERR] 失败: {result_chunk.error_message}")
                total_failed += 1
                print("[STOP] 为保持长程记忆连续，当前块必须先重试成功。")
                return 1
            
            total_processed += 1

        if stop_requested:
            break
            
    print("\n" + "="*40)
    print(f"[DONE] 任务结束")
    print(f"处理: {total_processed}")
    print(f"跳过: {total_skipped}")
    print(f"失败: {total_failed}")
    print(f"待复核: {total_review}")
    return 1 if total_failed else 0

def cmd_export(args):
    """导出完整译文为TXT和EPUB。"""
    try:
        project = project_manager.load_project(args.book_id)
        result = BookExporter(project).export(
            output_dir=args.output_dir,
            require_complete=not args.allow_incomplete,
        )
    except Exception as exc:
        print(f"[ERROR] 导出失败: {exc}")
        return 1
    print(f"[OK] TXT: {result.txt_path}")
    print(f"[OK] EPUB: {result.epub_path}")
    print(f"章节: {result.chapter_count}，文本块: {result.chunk_count}")
    return 0


def _load_project_or_error(book_id):
    try:
        return project_manager.load_project(book_id)
    except FileNotFoundError as exc:
        print(f"[ERROR] {exc}")
        return None


def _non_negative_int(value):
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise argparse.ArgumentTypeError("must be a non-negative integer") from exc
    if parsed < 0:
        raise argparse.ArgumentTypeError("must be a non-negative integer")
    return parsed


def _positive_int(value):
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise argparse.ArgumentTypeError("must be a positive integer") from exc
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def _decision_mode(value):
    if value == "unattended":
        return "auto"
    if value not in {"auto", "interactive"}:
        raise argparse.ArgumentTypeError("must be auto or interactive")
    return value


def _preview_v4_migration(database_path):
    version = _inspect_v4_schema(database_path)
    if version == 7:
        result = dict(_preview_schema7_to8(database_path))
        result["from_schema"] = 7
        result["target_schema"] = 8
        result["next_schema"] = 9
        return result
    result = dict(preview_schema9(database_path))
    result["from_schema"] = version
    result["target_schema"] = 9
    return result


def cmd_migrate_v4(args):
    project = _load_project_or_error(args.book_id)
    if not project:
        return 1
    try:
        database_path = (
            Path(project.root_dir) / "artifacts" / "parallel_v4" / "book.db"
        ).resolve()
        if getattr(args, "preview", False):
            result = _preview_v4_migration(database_path)
        elif _inspect_v4_schema(database_path) == 7:
            confirm_token = getattr(args, "confirm", None)
            if not confirm_token:
                raise ValueError(
                    "schema 7 requires migrate-v4 --preview followed by "
                    "--confirm before schema 9 migration"
                )
            result = dict(
                _confirm_schema7_to8(database_path, confirm_token)
            )
            result["schema_version"] = 8
            result["next_schema"] = 9
        else:
            result = V4Migrator(
                project, confirm_token=getattr(args, "confirm", None)
            ).migrate()
    except Exception as exc:
        _print_stage_error("migrate", exc)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def cmd_import_baseline_v4(args):
    project = _load_project_or_error(args.book_id)
    if not project:
        return 1
    V4Migrator(project).migrate()
    try:
        result = DocxBaselineImporter(V4Database(project.root_dir), project).import_docx(
            args.docx,
            name=args.name,
            require_exact_count=not args.allow_count_mismatch,
        )
    except Exception as exc:
        print(f"[ERROR] 基线导入失败: {exc}")
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def _run_scan_v4(project, args):
    scanner = V4Scanner(
        V4Database(project.root_dir),
        max_attempts=args.max_attempts,
    )
    return scanner.scan_project(
        initial_workers=getattr(args, "initial_workers", 2),
        max_workers=getattr(args, "max_workers", 4),
        max_blocks=getattr(args, "max_blocks", None),
        block_ids=getattr(args, "block", None),
    )


def _preparation_audit_mode(args, config):
    return getattr(args, "audit_mode", None) or config.get(
        "parallel_v4", {}
    ).get("audit_mode", "full")


def _adjudication_worker_limits(args):
    initial_workers = int(getattr(args, "initial_workers", 2))
    max_workers = int(getattr(args, "max_workers", 4))
    if initial_workers > max_workers:
        raise ValueError("initial_workers cannot exceed max_workers")
    return initial_workers, max_workers


def _run_adjudicate_v4(project, args):
    initial_workers, max_workers = _adjudication_worker_limits(args)
    config = config_loader.load_config()
    database = V4Database(project.root_dir)
    llm_config = config["llm"]
    return V4Adjudicator(
        LLMManager(llm_config),
        llm_factory=lambda: LLMManager(llm_config),
        database=database,
        max_attempts=args.max_attempts,
        audit_mode=_preparation_audit_mode(args, config),
    ).run(
        max_clusters=getattr(args, "max_clusters", None),
        initial_workers=initial_workers,
        max_workers=max_workers,
    )


def _run_coreference_v4(project, args):
    config = config_loader.load_config()
    llm_config = config["llm"]
    return CoreferenceCoordinator(
        V4Database(project.root_dir),
        llm_factory_a=lambda: LLMManager(llm_config),
        llm_factory_b=lambda: LLMManager(llm_config),
        max_attempts=args.max_attempts,
    ).run(max_cases=getattr(args, "max_cases", None))


def _run_resolve_targets_v4(project, args):
    config = config_loader.load_config()
    resolver = TargetResolver(
        V4Database(project.root_dir),
        LLMManager(config["llm"]),
        max_attempts=args.max_attempts,
        audit_mode=_preparation_audit_mode(args, config),
    )
    run_kwargs = {"max_concepts": getattr(args, "max_concepts", None)}
    if hasattr(args, "_prepared_block_ids"):
        run_kwargs["prepared_block_ids"] = tuple(args._prepared_block_ids)
    return resolver.run(**run_kwargs)


def _print_stage_error(stage, exc):
    print(json.dumps({"status": "failed", "stage": stage, "error": str(exc)}, ensure_ascii=False))


def cmd_scan_v4(args):
    project = _load_project_or_error(args.book_id)
    if not project:
        return 1
    try:
        V4Migrator(project).migrate()
        result = _run_scan_v4(project, args)
    except Exception as exc:
        _print_stage_error("scan", exc)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if result["failed"] else 0


def cmd_adjudicate_v4(args):
    try:
        _adjudication_worker_limits(args)
    except ValueError as exc:
        _print_stage_error("arguments", exc)
        return 1
    project = _load_project_or_error(args.book_id)
    if not project:
        return 1
    try:
        V4Migrator(project).migrate()
        result = _run_adjudicate_v4(project, args)
    except Exception as exc:
        _print_stage_error("adjudicate", exc)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if result["failed"] else 0


def cmd_resolve_targets_v4(args):
    project = _load_project_or_error(args.book_id)
    if not project:
        return 1
    try:
        V4Migrator(project).migrate()
        result = _run_resolve_targets_v4(project, args)
    except Exception as exc:
        _print_stage_error("working_target", exc)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if result["queued"] else 0


def cmd_coreference_v4(args):
    project = _load_project_or_error(args.book_id)
    if not project:
        return 1
    try:
        V4Migrator(project).migrate()
        result = _run_coreference_v4(project, args)
    except Exception as exc:
        _print_stage_error("coreference", exc)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def cmd_prepare_v4(args):
    try:
        _adjudication_worker_limits(args)
    except ValueError as exc:
        _print_stage_error("arguments", exc)
        return 1
    project = _load_project_or_error(args.book_id)
    if not project:
        return 1
    try:
        V4Migrator(project).migrate()
    except Exception as exc:
        _print_stage_error("migrate", exc)
        return 1
    stages = {}
    for name, runner, failure_key in (
        ("scan", _run_scan_v4, "failed"),
        ("adjudicate", _run_adjudicate_v4, "failed"),
        ("coreference", _run_coreference_v4, None),
        ("resolve", _run_resolve_targets_v4, "queued"),
    ):
        try:
            result = runner(project, args)
        except Exception as exc:
            result = {"error": str(exc)}
            stages[name] = result
            print(
                json.dumps(
                    {
                        "status": "failed",
                        "failed_stage": name,
                        "stages": stages,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 1
        stages[name] = result
        if failure_key is not None and int(result.get(failure_key, 0)):
            print(
                json.dumps(
                    {
                        "status": "failed",
                        "failed_stage": name,
                        "stages": stages,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 1
        if name == "scan":
            args._prepared_block_ids = tuple(result.get("block_ids", ()))
    print(json.dumps({"status": "completed", "stages": stages}, ensure_ascii=False, indent=2))
    return 0


def cmd_reset_scan_v4(args):
    project = _load_project_or_error(args.book_id)
    if not project:
        return 1
    database = V4Database(project.root_dir)
    try:
        result = (
            database.preview_scan_reset()
            if args.preview
            else database.reset_scan_derivatives(args.confirm)
        )
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def cmd_reconcile_v4(args):
    project = _load_project_or_error(args.book_id)
    if not project:
        return 1
    database = V4Database(project.root_dir)
    version = database.reconcile_exact_forms()
    print(f"[OK] knowledge_version={version}")
    print(json.dumps(database.status_summary(), ensure_ascii=False, indent=2))
    return 0


def cmd_verify_v4(args):
    project = _load_project_or_error(args.book_id)
    if not project:
        return 1
    config = config_loader.load_config()
    result = V4Verifier(
        V4Database(project.root_dir),
        llm_factory=lambda: LLMManager(config["llm"]),
        max_attempts=args.max_attempts,
    ).run(max_tasks=args.max_tasks)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if result["needs_human"] else 0


def cmd_translate_v4(args):
    project = _load_project_or_error(args.book_id)
    if not project:
        return 1
    V4Migrator(project).migrate()
    global_config = config_loader.load_config()
    settings = global_config.get("parallel_v4", {})
    translation = global_config.get("translation", {})
    draft = translation.get("draft", {})
    polish = translation.get("polish", {})
    database = V4Database(project.root_dir)
    include_block_ids = tuple(
        database.get_block_by_identifier(identifier).id
        for identifier in (args.block or [])
    )
    pipeline_config = V4PipelineConfig(
        island_size=args.island_size or int(settings.get("island_size", 3)),
        initial_workers=args.initial_workers or int(settings.get("initial_workers", 2)),
        max_workers=args.max_workers or int(settings.get("max_workers", 4)),
        max_context_chars=int(settings.get("max_context_chars", 24000)),
        max_attempts=args.max_attempts,
        max_blocks=args.max_blocks,
        include_block_ids=include_block_ids,
        decision_mode=args.decision_mode or settings.get("decision_mode", "auto"),
        pause_on_review=(
            args.pause_on_review
            if args.pause_on_review is not None
            else bool(settings.get("pause_on_review", False))
        ),
        unattended_failure_policy=settings.get(
            "unattended_failure_policy", "finish_with_warnings"
        ),
        max_knowledge_epochs=(
            args.max_knowledge_epochs
            or int(settings.get("max_knowledge_epochs", 3))
        ),
        enable_polish=not args.no_polish,
        enable_semantic_mapper=bool(settings.get("enable_semantic_mapper", True)),
        semantic_temperature=float(settings.get("semantic_temperature", 0.0)),
        semantic_max_tokens=int(settings.get("semantic_max_tokens", 4096)),
        semantic_max_attempts=int(settings.get("semantic_max_attempts", 2)),
        enable_narrative_premap=(
            not bool(getattr(args, "no_narrative_premap", False))
            and bool(settings.get("enable_narrative_premap", True))
        ),
        dynamic_scheduling=(
            not bool(getattr(args, "no_dynamic_scheduling", False))
            and bool(settings.get("dynamic_scheduling", True))
        ),
        premap_ahead_blocks=(
            getattr(args, "premap_ahead_blocks", None)
            or int(settings.get("premap_ahead_blocks", 12))
        ),
        premap_max_tokens=(
            getattr(args, "premap_max_tokens", None)
            or int(settings.get("premap_max_tokens", 6144))
        ),
        premap_max_attempts=int(
            settings.get("premap_max_attempts", args.max_attempts)
        ),
        max_narrative_context_chars=(
            getattr(args, "max_narrative_context_chars", None)
            or int(settings.get("max_narrative_context_chars", 6000))
        ),
        draft_input_soft_tokens=int(
            settings.get("draft_input_soft_tokens", 6000)
        ),
        polish_input_soft_tokens=int(
            settings.get("polish_input_soft_tokens", 8000)
        ),
        prompt_reserve_ratio=float(
            settings.get("prompt_reserve_ratio", 0.20)
        ),
        style_directive_max_tokens=int(
            settings.get("style_directive_max_tokens", 60)
        ),
        style_anchor_max_tokens=int(
            settings.get("style_anchor_max_tokens", 300)
        ),
        enable_style_anchors=bool(
            settings.get("enable_style_anchors", True)
        ),
        draft_temperature=float(draft.get("temperature", 0.1)),
        draft_max_tokens=int(draft.get("max_tokens", 6144)),
        polish_temperature=float(polish.get("temperature", 0.2)),
        polish_max_tokens=int(polish.get("max_tokens", 6144)),
        use_baseline_reference=bool(settings.get("use_baseline_reference", False)),
        audit_mode=args.audit_mode or settings.get("audit_mode", "full"),
        force=args.force,
    )
    result = V4TranslationPipeline(
        database=database,
        llm_factory=lambda: LLMManager(global_config["llm"]),
        prompts=config_loader.load_prompts(),
        config=pipeline_config,
    ).run()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if result["failed_retryable"] or result["incomplete_requires_human"] else 0


def _build_narrative_pipeline(project, args):
    config = config_loader.load_config()
    settings = config.get("parallel_v4", {})
    database = V4Database(project.root_dir)
    return database, V4TranslationPipeline(
        database=database,
        llm_factory=lambda: LLMManager(config["llm"]),
        prompts=config_loader.load_prompts(),
        config=V4PipelineConfig(
            enable_narrative_premap=True,
            dynamic_scheduling=bool(
                settings.get("dynamic_scheduling", True)
            ),
            max_attempts=int(getattr(args, "max_attempts", 2)),
            premap_max_attempts=int(
                settings.get(
                    "premap_max_attempts",
                    getattr(args, "max_attempts", 2),
                )
            ),
            premap_max_tokens=int(
                settings.get("premap_max_tokens", 6144)
            ),
            max_narrative_context_chars=int(
                settings.get("max_narrative_context_chars", 6000)
            ),
            draft_input_soft_tokens=int(
                settings.get("draft_input_soft_tokens", 6000)
            ),
            polish_input_soft_tokens=int(
                settings.get("polish_input_soft_tokens", 8000)
            ),
            prompt_reserve_ratio=float(
                settings.get("prompt_reserve_ratio", 0.20)
            ),
            style_directive_max_tokens=int(
                settings.get("style_directive_max_tokens", 60)
            ),
            style_anchor_max_tokens=int(
                settings.get("style_anchor_max_tokens", 300)
            ),
            enable_style_anchors=bool(
                settings.get("enable_style_anchors", True)
            ),
            max_workers=int(settings.get("max_workers", 4)),
            audit_mode=settings.get("audit_mode", "full"),
        ),
    )


def cmd_premap_v4(args):
    project = _load_project_or_error(args.book_id)
    if not project:
        return 1
    try:
        V4Migrator(project).migrate()
        database, pipeline = _build_narrative_pipeline(project, args)
        block_ids = tuple(
            database.get_block_by_identifier(identifier).id
            for identifier in (args.block or ())
        )
        result = pipeline.premap(
            block_ids=block_ids,
            max_blocks=args.max_blocks,
        )
    except Exception as exc:
        _print_stage_error("premap", exc)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def cmd_inspect_memory_v4(args):
    project = _load_project_or_error(args.book_id)
    if not project:
        return 1
    try:
        database = V4Database(project.root_dir)
        block_id = (
            database.get_block_by_identifier(args.block).id
            if args.block
            else None
        )
        result = database.inspect_narrative_memory(
            block_id=block_id,
            subject_id=args.subject,
            memory_type=args.memory_type,
        )
    except Exception as exc:
        _print_stage_error("inspect_memory", exc)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def cmd_rebuild_snapshots_v4(args):
    project = _load_project_or_error(args.book_id)
    if not project:
        return 1
    try:
        V4Migrator(project).migrate()
        _database, pipeline = _build_narrative_pipeline(project, args)
        result = pipeline.rebuild_snapshots(
            from_index=args.from_index
        )
    except Exception as exc:
        _print_stage_error("rebuild_snapshots", exc)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def cmd_status_v4(args):
    project = _load_project_or_error(args.book_id)
    if not project:
        return 1
    database = V4Database(project.root_dir)
    print(json.dumps(database.status_summary(), ensure_ascii=False, indent=2))
    return 0


def cmd_revalidate_v4(args):
    project = _load_project_or_error(args.book_id)
    if not project:
        return 1
    try:
        V4Migrator(project).migrate()
        config = config_loader.load_config()
        settings = config.get("parallel_v4", {})
        polish = config.get("translation", {}).get("polish", {})
        database = V4Database(project.root_dir)
        llm_config = config["llm"]
        prompts = config_loader.load_prompts()
        pipeline = V4TranslationPipeline(
            database=database,
            llm_factory=lambda: LLMManager(llm_config),
            prompts=prompts,
            config=V4PipelineConfig(
                max_attempts=args.max_attempts,
                max_context_chars=int(settings.get("max_context_chars", 24000)),
                enable_polish=bool(settings.get("enable_polish", True)),
                decision_mode="auto",
                enable_narrative_premap=bool(
                    settings.get("enable_narrative_premap", True)
                ),
                dynamic_scheduling=bool(
                    settings.get("dynamic_scheduling", True)
                ),
                max_narrative_context_chars=int(
                    settings.get("max_narrative_context_chars", 6000)
                ),
                draft_input_soft_tokens=int(
                    settings.get("draft_input_soft_tokens", 6000)
                ),
                polish_input_soft_tokens=int(
                    settings.get("polish_input_soft_tokens", 8000)
                ),
                prompt_reserve_ratio=float(
                    settings.get("prompt_reserve_ratio", 0.20)
                ),
                style_directive_max_tokens=int(
                    settings.get("style_directive_max_tokens", 60)
                ),
                style_anchor_max_tokens=int(
                    settings.get("style_anchor_max_tokens", 300)
                ),
                enable_style_anchors=bool(
                    settings.get("enable_style_anchors", True)
                ),
            ),
        )
        repairer = V4Repairer(
            database,
            llm_factory=lambda: LLMManager(llm_config),
            max_attempts=args.max_attempts,
            max_tokens=int(polish.get("max_tokens", 37200)),
            max_context_chars=int(settings.get("max_context_chars", 24000)),
        )
        result = RevalidationRunner(
            database,
            validator_factories=(
                lambda: LLMManager(llm_config),
                lambda: LLMManager(llm_config),
            ),
            repairer=repairer,
            translate_block_factory=lambda: pipeline.translate_block_factory(),
            max_attempts=args.max_attempts,
        ).run(max_tasks=args.max_tasks)
    except Exception as exc:
        _print_stage_error("revalidate", exc)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if int(result.get("unfinished", 0)) else 0


def cmd_serve_v4(args):
    project = _load_project_or_error(args.book_id)
    if not project:
        return 1
    serve_review_ui(
        V4Database(project.root_dir),
        port=args.port,
        open_browser=not args.no_open,
    )
    return 0


def cmd_review_v4(args):
    project = _load_project_or_error(args.book_id)
    if not project:
        return 1
    database = V4Database(project.root_dir)
    if args.edit is not None:
        if not args.replacement:
            print("[ERROR] --edit 必须同时提供 --replacement")
            return 1
        try:
            result = database.amend_human_item(args.edit, args.replacement)
        except Exception as exc:
            print(f"[ERROR] 编辑失败: {exc}")
            return 1
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if args.accept is not None or args.reject is not None or args.retry is not None:
        if args.accept is not None:
            item_id, action = args.accept, "accept"
        elif args.reject is not None:
            item_id, action = args.reject, "reject"
        else:
            item_id, action = args.retry, "retry"
        try:
            result = database.resolve_human_item(item_id, action)
        except Exception as exc:
            print(f"[ERROR] 裁决失败: {exc}")
            return 1
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    rows = database.list_human_queue()
    if not rows:
        print("当前没有待处理的人工队列项。")
        return 0
    for row in rows:
        print(
            json.dumps(
                {
                    "id": row["id"],
                    "block": row.get("legacy_id") or row.get("block_id"),
                    "kind": row["kind"],
                    "severity": row["severity"],
                    "payload": json.loads(row["payload_json"]),
                },
                ensure_ascii=False,
            )
        )
    return 0


def cmd_claim_v4(args):
    project = _load_project_or_error(args.book_id)
    if not project:
        return 1
    database = V4Database(project.root_dir)
    if args.add:
        claim_id = database.create_claim(
            kind=args.kind,
            statement=args.add,
            reveal_global_index=args.reveal_index,
            subject_form=args.subject or "",
            scope=args.scope,
            confidence=args.confidence,
            high_impact=args.high_impact,
        )
        print(f"[OK] claim_id={claim_id}")
        return 0
    print(json.dumps(database.list_claims(), ensure_ascii=False, indent=2))
    return 0


def cmd_annotate_v4(args):
    project = _load_project_or_error(args.book_id)
    if not project:
        return 1
    database = V4Database(project.root_dir)
    try:
        if args.add:
            if not args.block:
                raise ValueError("新增注释时必须提供--block")
            annotation_id = database.add_annotation(
                args.block,
                args.paragraph,
                args.add,
                status="approved" if args.approved else "proposed",
            )
            print(f"[OK] annotation_id={annotation_id}")
            return 0
        if args.approve or args.reject:
            annotation_id = args.approve or args.reject
            action = "approve" if args.approve else "reject"
            print(json.dumps(database.resolve_annotation(annotation_id, action), ensure_ascii=False, indent=2))
            return 0
        print(json.dumps(database.list_annotations(args.status), ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:
        print(f"[ERROR] 注释操作失败: {exc}")
        return 1


def cmd_repair_v4(args):
    project = _load_project_or_error(args.book_id)
    if not project:
        return 1
    config = config_loader.load_config()
    settings = config.get("parallel_v4", {})
    polish = config.get("translation", {}).get("polish", {})
    try:
        result = V4Repairer(
            V4Database(project.root_dir),
            llm_factory=lambda: LLMManager(config["llm"]),
            max_attempts=args.max_attempts,
            max_tokens=int(polish.get("max_tokens", 37200)),
            max_context_chars=int(settings.get("max_context_chars", 24000)),
        ).run(
            max_tasks=args.max_tasks,
            block_identifier=args.block,
            issues=args.issue,
        )
    except Exception as exc:
        print(f"[ERROR] 局部修复失败: {exc}")
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if result["needs_human"] else 0


def cmd_validate_v4(args):
    project = _load_project_or_error(args.book_id)
    if not project:
        return 1
    report = V4Validator(V4Database(project.root_dir)).validate()
    print(report.to_markdown())
    return 1 if report.high_count else 0


def cmd_export_v4(args):
    project = _load_project_or_error(args.book_id)
    if not project:
        return 1
    try:
        result = ParallelV4BookExporter(project).export_v4(
            output_dir=args.output_dir,
            allow_warnings=args.allow_warnings,
            include_annotations=args.include_annotations,
            strict_validation=args.strict_validation,
        )
    except Exception as exc:
        print(f"[ERROR] 导出失败: {exc}")
        return 1
    print(f"[OK] TXT: {result.txt_path}")
    print(f"[OK] EPUB: {result.epub_path}")
    print(f"[OK] 质量报告: {result.quality_report_path}")
    return 0


def cmd_export_folioloom(args):
    project = _load_project_or_error(args.book_id)
    if not project:
        return 1
    try:
        result = FolioLoomBookExporter(
            project,
            run_id=args.run_id,
        ).export_folioloom(
            output_dir=args.output_dir,
            allow_incomplete=args.allow_incomplete,
        )
    except Exception as exc:
        print(f"[ERROR] FolioLoom 导出失败: {exc}")
        return 1
    print(f"[OK] TXT: {result.txt_path}")
    print(f"[OK] EPUB: {result.epub_path}")
    return 0


def cmd_compare_v4(args):
    project = _load_project_or_error(args.book_id)
    if not project:
        return 1
    output = (
        Path(args.output)
        if args.output
        else project.root_dir / "exports" / "parallel_v4" / "shadow_comparison.md"
    )
    try:
        path = write_shadow_comparison(
            V4Database(project.root_dir),
            output,
            max_blocks=args.max_blocks,
            baseline_name=args.baseline,
        )
    except Exception as exc:
        print(f"[ERROR] 生成对照失败: {exc}")
        return 1
    print(f"[OK] 影子对照: {path}")
    return 0

def main(argv=None):
    parser = argparse.ArgumentParser(
        description="DeepNovel-Translator CLI (v3.0)",
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    subparsers = parser.add_subparsers(dest="command", help="可用命令")
    
    # init
    p_init = subparsers.add_parser("init", help="初始化新项目")
    p_init.add_argument("book_id", help="项目ID (英文，无空格)")
    p_init.add_argument("file", help="小说原文路径 (.txt/.md/.docx/.epub)")
    p_init.add_argument("--force", "-f", action="store_true", help="强制覆盖已存在项目")
    p_init.add_argument(
        "--encoding",
        help="无 BOM 且非 UTF-8 的纯文本源编码（如 gbk）",
    )
    p_init.add_argument(
        "--source-language",
        default="en",
        help="source language tag (en, fr, de, es, ru, ja, or und)",
    )
    p_init.set_defaults(func=cmd_init)
    
    # list
    p_list = subparsers.add_parser("list", help="列出所有项目")
    p_list.set_defaults(func=cmd_list)
    
    # translate
    p_trans = subparsers.add_parser("translate", help="翻译项目")
    p_trans.add_argument("book_id", help="项目ID")
    p_trans.add_argument("--chapters", "-c", help="指定章节ID，逗号分隔 (如 ch01,ch02)")
    p_trans.add_argument("--force", "-f", action="store_true", help="强制重翻已完成的块")
    p_trans.add_argument("--glossary-mode", choices=["auto", "manual"], default="manual", help="术语库模式 (auto: 自动采纳, manual: 需人工审核)")
    p_trans.add_argument("--no-polish", action="store_true", help="禁用润色")
    p_trans.add_argument("--temp-draft", type=float, default=None, help="覆盖配置中的第一层温度")
    p_trans.add_argument("--temp-polish", type=float, default=None, help="覆盖配置中的第二层温度")
    p_trans.add_argument("--max-chunks", type=int, default=None, help="本次最多翻译多少个新文本块，适合试跑")
    p_trans.add_argument("--quiet", action="store_true", help="不实时打印模型思考和译文，只显示进度与结果")
    p_trans.set_defaults(func=cmd_translate)

    # export
    p_export = subparsers.add_parser("export", help="导出TXT和EPUB阅读版")
    p_export.add_argument("book_id", help="项目ID")
    p_export.add_argument("--output-dir", help="导出目录，默认 projects/<book_id>/exports")
    p_export.add_argument("--allow-incomplete", action="store_true", help="允许导出尚未翻译完整的项目")
    p_export.set_defaults(func=cmd_export)

    p_migrate_v4 = subparsers.add_parser("migrate-v4", help="非破坏性导入串行项目到parallel_v4")
    p_migrate_v4.add_argument("book_id", help="项目ID")
    migrate_action = p_migrate_v4.add_mutually_exclusive_group()
    migrate_action.add_argument("--preview", action="store_true")
    migrate_action.add_argument("--confirm", metavar="TOKEN")
    p_migrate_v4.set_defaults(func=cmd_migrate_v4)

    p_baseline_v4 = subparsers.add_parser("import-baseline-v4", help="导入逐段DOCX外部译文基线")
    p_baseline_v4.add_argument("book_id", help="项目ID")
    p_baseline_v4.add_argument("docx", help="逐段对应英文源文的DOCX")
    p_baseline_v4.add_argument("--name", default="legacy_docx")
    p_baseline_v4.add_argument("--allow-count-mismatch", action="store_true")
    p_baseline_v4.set_defaults(func=cmd_import_baseline_v4)

    p_scan_v4 = subparsers.add_parser("scan-v4", help="执行证据式并行预扫描")
    p_scan_v4.add_argument("book_id", help="项目ID")
    p_scan_v4.add_argument("--initial-workers", type=int, default=2)
    p_scan_v4.add_argument("--max-workers", type=int, default=4)
    p_scan_v4.add_argument("--max-attempts", type=_positive_int, default=3)
    p_scan_v4.add_argument("--max-blocks", type=_non_negative_int)
    p_scan_v4.add_argument(
        "--block", action="append", help="仅扫描指定文本块，可重复提供ID或旧版ID"
    )
    p_scan_v4.add_argument(
        "--audit-mode", choices=["full", "response", "minimal"]
    )
    p_scan_v4.set_defaults(func=cmd_scan_v4)

    p_adjudicate_v4 = subparsers.add_parser(
        "adjudicate-v4", help="对本地候选簇执行严格双重裁决"
    )
    p_adjudicate_v4.add_argument("book_id", help="项目ID")
    p_adjudicate_v4.add_argument("--initial-workers", type=_positive_int, default=2)
    p_adjudicate_v4.add_argument("--max-workers", type=_positive_int, default=4)
    p_adjudicate_v4.add_argument("--max-clusters", type=_non_negative_int)
    p_adjudicate_v4.add_argument("--max-attempts", type=_positive_int, default=2)
    p_adjudicate_v4.add_argument(
        "--audit-mode", choices=["full", "response", "minimal"]
    )
    p_adjudicate_v4.set_defaults(func=cmd_adjudicate_v4)

    p_resolve_targets_v4 = subparsers.add_parser(
        "resolve-targets-v4", help="为已裁决概念生成全书工作译名"
    )
    p_resolve_targets_v4.add_argument("book_id", help="项目ID")
    p_resolve_targets_v4.add_argument("--max-concepts", type=_non_negative_int)
    p_resolve_targets_v4.add_argument("--max-attempts", type=_positive_int, default=2)
    p_resolve_targets_v4.add_argument(
        "--audit-mode", choices=["full", "response", "minimal"]
    )
    p_resolve_targets_v4.set_defaults(func=cmd_resolve_targets_v4)

    p_coreference_v4 = subparsers.add_parser(
        "coreference-v4", help="执行确定性优先的双模型共指协调"
    )
    p_coreference_v4.add_argument("book_id", help="项目ID")
    p_coreference_v4.add_argument("--max-cases", type=_non_negative_int)
    p_coreference_v4.add_argument("--max-attempts", type=_positive_int, default=2)
    p_coreference_v4.set_defaults(func=cmd_coreference_v4)

    p_prepare_v4 = subparsers.add_parser(
        "prepare-v4", help="依次执行扫描、候选裁决、共指协调和工作译名解析"
    )
    p_prepare_v4.add_argument("book_id", help="项目ID")
    p_prepare_v4.add_argument("--initial-workers", type=_positive_int, default=2)
    p_prepare_v4.add_argument("--max-workers", type=_positive_int, default=4)
    p_prepare_v4.add_argument("--max-blocks", type=_non_negative_int)
    p_prepare_v4.add_argument(
        "--block", action="append", help="仅准备指定文本块，可重复提供ID或旧版ID"
    )
    p_prepare_v4.add_argument("--max-clusters", type=_non_negative_int)
    p_prepare_v4.add_argument("--max-cases", type=_non_negative_int)
    p_prepare_v4.add_argument("--max-attempts", type=_positive_int, default=2)
    p_prepare_v4.add_argument(
        "--audit-mode", choices=["full", "response", "minimal"]
    )
    p_prepare_v4.set_defaults(func=cmd_prepare_v4)

    p_reset_scan_v4 = subparsers.add_parser(
        "reset-scan-v4", help="预览或确认清除扫描派生数据"
    )
    p_reset_scan_v4.add_argument("book_id", help="项目ID")
    reset_action = p_reset_scan_v4.add_mutually_exclusive_group(required=True)
    reset_action.add_argument("--preview", action="store_true")
    reset_action.add_argument("--confirm", metavar="TOKEN")
    p_reset_scan_v4.set_defaults(func=cmd_reset_scan_v4)

    p_reconcile_v4 = subparsers.add_parser("reconcile-v4", help="保守归并完全相同的英文词形")
    p_reconcile_v4.add_argument("book_id", help="项目ID")
    p_reconcile_v4.set_defaults(func=cmd_reconcile_v4)

    p_verify_v4 = subparsers.add_parser("verify-v4", help="对高影响知识执行两个独立核验")
    p_verify_v4.add_argument("book_id", help="项目ID")
    p_verify_v4.add_argument("--max-tasks", type=int)
    p_verify_v4.add_argument("--max-attempts", type=_positive_int, default=2)
    p_verify_v4.set_defaults(func=cmd_verify_v4)

    p_revalidate_v4 = subparsers.add_parser(
        "revalidate-v4", help="执行精确失效校验、修复与整块重译"
    )
    p_revalidate_v4.add_argument("book_id", help="项目ID")
    p_revalidate_v4.add_argument("--max-tasks", type=_non_negative_int)
    p_revalidate_v4.add_argument("--max-attempts", type=_positive_int, default=2)
    p_revalidate_v4.set_defaults(func=cmd_revalidate_v4)

    p_translate_v4 = subparsers.add_parser("translate-v4", help="执行带屏障的并行两层翻译")
    p_translate_v4.add_argument("book_id", help="项目ID")
    p_translate_v4.add_argument("--island-size", type=int)
    p_translate_v4.add_argument("--initial-workers", type=int)
    p_translate_v4.add_argument("--max-workers", type=int)
    p_translate_v4.add_argument("--max-attempts", type=_positive_int, default=2)
    p_translate_v4.add_argument("--max-blocks", type=_non_negative_int)
    p_translate_v4.add_argument(
        "--block",
        action="append",
        help="只翻译指定块；可重复使用，支持块ID或legacy_id",
    )
    p_translate_v4.add_argument(
        "--audit-mode", choices=["full", "response", "minimal"]
    )
    p_translate_v4.add_argument(
        "--decision-mode",
        type=_decision_mode,
        choices=["auto", "interactive"],
        help="auto自动继续；interactive可在评审检查点暂停",
    )
    p_translate_v4.add_argument(
        "--pause-on-review", action="store_true", default=None
    )
    p_translate_v4.add_argument("--max-knowledge-epochs", type=_positive_int)
    p_translate_v4.add_argument(
        "--no-narrative-premap", action="store_true"
    )
    p_translate_v4.add_argument(
        "--no-dynamic-scheduling", action="store_true"
    )
    p_translate_v4.add_argument(
        "--premap-ahead-blocks", type=_positive_int
    )
    p_translate_v4.add_argument(
        "--premap-max-tokens", type=_positive_int
    )
    p_translate_v4.add_argument(
        "--max-narrative-context-chars", type=_positive_int
    )
    p_translate_v4.add_argument("--no-polish", action="store_true")
    p_translate_v4.add_argument("--force", "-f", action="store_true", help="强制重翻已完成块")
    p_translate_v4.set_defaults(func=cmd_translate_v4)

    p_premap_v4 = subparsers.add_parser(
        "premap-v4", help="只运行融合叙事预映射，不生成译文"
    )
    p_premap_v4.add_argument("book_id", help="项目ID")
    p_premap_v4.add_argument("--max-blocks", type=_non_negative_int)
    p_premap_v4.add_argument(
        "--block",
        action="append",
        help="预映射到指定块；可重复使用，系统会保留前序状态",
    )
    p_premap_v4.add_argument(
        "--max-attempts", type=_positive_int, default=2
    )
    p_premap_v4.set_defaults(func=cmd_premap_v4)

    p_inspect_memory_v4 = subparsers.add_parser(
        "inspect-memory-v4", help="查看叙事记忆、证据、关系和快照"
    )
    p_inspect_memory_v4.add_argument("book_id", help="项目ID")
    p_inspect_memory_v4.add_argument("--block")
    p_inspect_memory_v4.add_argument("--subject")
    p_inspect_memory_v4.add_argument(
        "--memory-type",
        choices=[
            "explicit_fact",
            "observation",
            "hypothesis",
            "open_question",
            "contradiction",
            "character_state",
            "relationship_state",
            "timeline_anchor",
            "location_state",
            "narrator_state",
        ],
    )
    p_inspect_memory_v4.set_defaults(func=cmd_inspect_memory_v4)

    p_rebuild_snapshots_v4 = subparsers.add_parser(
        "rebuild-snapshots-v4",
        help="按已缓存预映射重建位置开放叙事快照",
    )
    p_rebuild_snapshots_v4.add_argument("book_id", help="项目ID")
    p_rebuild_snapshots_v4.add_argument(
        "--from-index", type=_non_negative_int, default=0
    )
    p_rebuild_snapshots_v4.add_argument(
        "--max-attempts", type=_positive_int, default=2
    )
    p_rebuild_snapshots_v4.set_defaults(
        func=cmd_rebuild_snapshots_v4
    )

    p_status_v4 = subparsers.add_parser("status-v4", help="查看parallel_v4状态")
    p_status_v4.add_argument("book_id", help="项目ID")
    p_status_v4.set_defaults(func=cmd_status_v4)

    p_serve_v4 = subparsers.add_parser("serve-v4", help="启动仅限本机访问的parallel_v4裁决界面")
    p_serve_v4.add_argument("book_id", help="项目ID")
    p_serve_v4.add_argument("--port", type=int, default=8765)
    p_serve_v4.add_argument("--no-open", action="store_true", help="不自动打开浏览器")
    p_serve_v4.set_defaults(func=cmd_serve_v4)

    p_review_v4 = subparsers.add_parser("review-v4", help="查看或裁决parallel_v4人工队列")
    p_review_v4.add_argument("book_id", help="项目ID")
    review_action = p_review_v4.add_mutually_exclusive_group()
    review_action.add_argument("--accept", type=int, metavar="ID")
    review_action.add_argument("--reject", type=int, metavar="ID")
    review_action.add_argument("--retry", type=int, metavar="ID")
    review_action.add_argument("--edit", type=int, metavar="ID")
    p_review_v4.add_argument("--replacement")
    p_review_v4.set_defaults(func=cmd_review_v4)

    p_claim_v4 = subparsers.add_parser("claim-v4", help="查看或添加可并存的翻译声明与假说")
    p_claim_v4.add_argument("book_id", help="项目ID")
    p_claim_v4.add_argument("--add", help="新增声明文本；省略时列出声明")
    p_claim_v4.add_argument(
        "--kind",
        choices=[
            "translation_constraint",
            "temporal_constraint",
            "identity_hypothesis",
            "reveal_boundary",
            "interpretation_hypothesis",
        ],
        default="interpretation_hypothesis",
    )
    p_claim_v4.add_argument("--reveal-index", type=int, default=0)
    p_claim_v4.add_argument("--subject")
    p_claim_v4.add_argument("--scope", choices=["book", "occurrence"], default="book")
    p_claim_v4.add_argument("--confidence", type=float, default=0.5)
    p_claim_v4.add_argument("--high-impact", action="store_true")
    p_claim_v4.set_defaults(func=cmd_claim_v4)

    p_annotate_v4 = subparsers.add_parser("annotate-v4", help="管理独立于正文的可选注释")
    p_annotate_v4.add_argument("book_id", help="项目ID")
    annotation_action = p_annotate_v4.add_mutually_exclusive_group()
    annotation_action.add_argument("--add", help="新增注释正文")
    annotation_action.add_argument("--approve", metavar="ID")
    annotation_action.add_argument("--reject", metavar="ID")
    p_annotate_v4.add_argument("--block", help="新增注释时指定文本块ID")
    p_annotate_v4.add_argument("--paragraph", type=int, default=0, help="块内译文段落序号，从0开始")
    p_annotate_v4.add_argument("--approved", action="store_true", help="新增时直接批准")
    p_annotate_v4.add_argument("--status", choices=["proposed", "approved", "rejected"])
    p_annotate_v4.set_defaults(func=cmd_annotate_v4)

    p_repair_v4 = subparsers.add_parser("repair-v4", help="执行块级局部修复并保留旧译文版本")
    p_repair_v4.add_argument("book_id", help="项目ID")
    p_repair_v4.add_argument("--block", help="指定文本块；省略时处理开放修复队列")
    p_repair_v4.add_argument("--issue", action="append", help="指定需要修复的问题，可重复")
    p_repair_v4.add_argument("--max-tasks", type=int)
    p_repair_v4.add_argument("--max-attempts", type=_positive_int, default=2)
    p_repair_v4.set_defaults(func=cmd_repair_v4)

    p_validate_v4 = subparsers.add_parser("validate-v4", help="执行确定性完整性校验")
    p_validate_v4.add_argument("book_id", help="项目ID")
    p_validate_v4.set_defaults(func=cmd_validate_v4)

    p_export_v4 = subparsers.add_parser("export-v4", help="严格导出parallel_v4的TXT和EPUB")
    p_export_v4.add_argument("book_id", help="项目ID")
    p_export_v4.add_argument("--output-dir")
    p_export_v4.add_argument("--allow-warnings", action="store_true")
    p_export_v4.add_argument("--strict-validation", action="store_true")
    p_export_v4.add_argument("--include-annotations", action="store_true")
    p_export_v4.set_defaults(func=cmd_export_v4)

    p_export_folioloom = subparsers.add_parser(
        "export-folioloom",
        help="严格导出 FolioLoom 的 TXT 和 EPUB",
    )
    p_export_folioloom.add_argument("book_id", help="项目ID")
    p_export_folioloom.add_argument("--output-dir")
    p_export_folioloom.add_argument("--run-id", help="schema v2 translation run ID")
    p_export_folioloom.add_argument("--allow-incomplete", action="store_true")
    p_export_folioloom.set_defaults(func=cmd_export_folioloom)

    p_compare_v4 = subparsers.add_parser("compare-v4", help="生成串行基线与parallel_v4人工对照")
    p_compare_v4.add_argument("book_id", help="项目ID")
    p_compare_v4.add_argument("--output")
    p_compare_v4.add_argument("--max-blocks", type=_non_negative_int)
    p_compare_v4.add_argument("--baseline", help="指定外部基线名称")
    p_compare_v4.set_defaults(func=cmd_compare_v4)
    
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments[:1] == ["export-v5"]:
        arguments[0] = "export-folioloom"
    args = parser.parse_args(arguments)
    
    if args.command is None:
        parser.print_help()
        return
    
    result = args.func(args)
    return result if isinstance(result, int) else 0

if __name__ == "__main__":
    if sys.platform.startswith('win'):
        import io
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    raise SystemExit(main())
