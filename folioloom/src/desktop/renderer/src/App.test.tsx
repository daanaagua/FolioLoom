import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

import type {
  DesktopChooseSourceResult,
  DesktopExportSnapshot,
  DesktopFullBookProgress,
  DesktopFullBookSnapshot,
  DesktopOnboardingState,
  DesktopProjectSnapshot,
  DesktopResult,
  DesktopTestModelResult,
  DesktopTrialProgress,
} from "../../contracts.js";
import type { FolioLoomDesktopApi } from "../../preload/folioloom-api.js";
import { App } from "./App.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const providers: DesktopOnboardingState["providers"] = [
  {
    id: "deepseek",
    displayName: "DeepSeek",
    keyPlaceholder: "DeepSeek API Key",
    efforts: ["off", "high", "max"],
    fallbackModelIds: ["deepseek-v4-flash", "deepseek-v4-pro"],
    allowManualModel: false,
    allowCustomBaseUrl: false,
    credentialStatus: "missing",
  },
  {
    id: "kimi-cn",
    displayName: "Kimi",
    keyPlaceholder: "Kimi API Key",
    efforts: ["off", "high"],
    fallbackModelIds: ["moonshot-v1-8k"],
    allowManualModel: true,
    allowCustomBaseUrl: false,
    credentialStatus: "missing",
  },
  {
    id: "bailian",
    displayName: "阿里云百炼",
    keyPlaceholder: "百炼 API Key",
    efforts: ["off", "high"],
    fallbackModelIds: ["qwen-plus"],
    allowManualModel: true,
    allowCustomBaseUrl: false,
    credentialStatus: "missing",
  },
  {
    id: "volcengine",
    displayName: "火山方舟",
    keyPlaceholder: "火山 API Key",
    efforts: ["off", "high"],
    fallbackModelIds: ["doubao-seed"],
    allowManualModel: true,
    allowCustomBaseUrl: false,
    credentialStatus: "missing",
  },
  {
    id: "openai",
    displayName: "OpenAI",
    keyPlaceholder: "OpenAI API Key",
    efforts: ["low", "medium", "high"],
    fallbackModelIds: ["gpt-5-mini"],
    allowManualModel: true,
    allowCustomBaseUrl: false,
    credentialStatus: "missing",
  },
  {
    id: "siliconflow",
    displayName: "硅基流动",
    keyPlaceholder: "硅基流动 API Key",
    efforts: [],
    fallbackModelIds: ["deepseek-ai/DeepSeek-V3"],
    allowManualModel: true,
    allowCustomBaseUrl: false,
    credentialStatus: "missing",
  },
  {
    id: "openai-compatible",
    displayName: "自定义 OpenAI-compatible",
    keyPlaceholder: "兼容接口 API Key",
    efforts: ["on", "off"],
    fallbackModelIds: [],
    allowManualModel: true,
    allowCustomBaseUrl: true,
    credentialStatus: "missing",
  },
];

const project: DesktopProjectSnapshot = {
  title: "The Example Book",
  sourceLanguage: "英语",
  detectedLanguage: "英语",
  sourceEncoding: "utf-8",
  encodingConfidence: 0.98,
  languageProfileVersion: "source-language-profile-2",
  sourceChars: 12840,
  sourceVersion: "source-example",
  store: { state: "ready" },
  runs: [],
  runSelection: "none",
};

const knowledgeReadyProject: DesktopProjectSnapshot = {
  ...project,
  selectedRunId: "run-ready",
  runs: [
    {
      runId: "run-ready",
      sourceVersion: "source-example",
      modelId: "deepseek-v4-flash",
      status: "ready",
      progress: {
        totalWindows: 4,
        pendingWindows: 0,
        completedWindows: 4,
        warningWindows: 0,
        humanRequiredWindows: 0,
        failedWindows: 0,
      },
    },
  ],
  runSelection: "selected",
};

const emptyOnboarding: DesktopOnboardingState = {
  providers,
  readiness: { source: false, model: false, trial: false },
};

const sourceOnlyOnboarding: DesktopOnboardingState = {
  ...emptyOnboarding,
  project,
  readiness: { source: true, model: false, trial: false },
};

const readyOnboarding: DesktopOnboardingState = {
  ...emptyOnboarding,
  project,
  activeModel: {
    providerId: "deepseek",
    modelId: "deepseek-v4-pro",
    reasoningEffort: "max",
    capability: "ready",
  },
  latestProbe: { status: "ready", message: "连接检查已通过" },
  readiness: { source: true, model: true, trial: true },
};

function ok<T>(value: T): DesktopResult<T> {
  return { ok: true, value };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function failure<T = never>(
  code: string,
  message: string,
  technicalDetails?: string,
): DesktopResult<T> {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable: false,
      ...(technicalDetails === undefined ? {} : { technicalDetails }),
    },
  };
}

function testResult(onboarding: DesktopOnboardingState = readyOnboarding): DesktopTestModelResult {
  return {
    report: { status: "ready", message: "连接检查已通过" },
    onboarding,
  };
}

function createApi(overrides: Partial<FolioLoomDesktopApi> = {}): FolioLoomDesktopApi {
  return {
    chooseSource: vi.fn().mockResolvedValue(failure("DESKTOP_SELECTION_CANCELLED", "已取消选择")),
    confirmSourceEncoding: vi.fn().mockResolvedValue(failure("DESKTOP_INPUT_INVALID", "编码确认已失效")),
    getOnboardingState: vi.fn().mockResolvedValue(ok(emptyOnboarding)),
    discoverModels: vi.fn().mockResolvedValue(ok([])),
    testModel: vi.fn().mockResolvedValue(ok(testResult())),
    forgetCredential: vi.fn().mockResolvedValue(ok(emptyOnboarding)),
    startTrial: vi.fn().mockResolvedValue(failure("DESKTOP_TRIAL_NOT_READY", "试译尚未准备好")),
    cancelTrial: vi.fn().mockResolvedValue(ok(undefined)),
    onTrialProgress: vi.fn().mockReturnValue(() => undefined),
    getFullBookState: vi.fn().mockResolvedValue(failure("UNAVAILABLE", "暂不可用")),
    startFullBook: vi.fn().mockResolvedValue(failure("UNAVAILABLE", "暂不可用")),
    pauseFullBook: vi.fn().mockResolvedValue(failure("UNAVAILABLE", "暂不可用")),
    resumeFullBook: vi.fn().mockResolvedValue(failure("UNAVAILABLE", "暂不可用")),
    onFullBookProgress: vi.fn().mockReturnValue(() => undefined),
    getExportState: vi.fn().mockResolvedValue(failure("UNAVAILABLE", "暂不可用")),
    chooseExportDirectory: vi.fn().mockResolvedValue(failure("UNAVAILABLE", "暂不可用")),
    exportBook: vi.fn().mockResolvedValue(failure("UNAVAILABLE", "暂不可用")),
    openExportDirectory: vi.fn().mockResolvedValue(failure("UNAVAILABLE", "暂不可用")),
    copyDiagnosticSummary: vi.fn().mockResolvedValue(ok(undefined)),
    exportDiagnostics: vi.fn().mockResolvedValue(ok({
      fileName: "FolioLoom-diagnostics.json",
      displayPath: "D:\\Exports\\FolioLoom-diagnostics.json",
    })),
    listKnowledge: vi.fn().mockResolvedValue(ok({
      generation: 0,
      snapshotId: "snapshot-0",
      items: [],
    })),
    getKnowledgeDetail: vi.fn().mockResolvedValue(failure("KNOWLEDGE_NOT_FOUND", "没有知识条目")),
    mutateKnowledge: vi.fn().mockResolvedValue(failure("KNOWLEDGE_NOT_FOUND", "没有知识条目")),
    promoteKnowledgeToGlobal: vi.fn().mockResolvedValue(failure("KNOWLEDGE_NOT_FOUND", "没有知识条目")),
    listGlobalKnowledge: vi.fn().mockResolvedValue(ok({ items: [] })),
    attachGlobalKnowledge: vi.fn().mockResolvedValue(failure("GLOBAL_KNOWLEDGE_REVISION_NOT_FOUND", "没有通用条目")),
    getKnowledgeDiagnostics: vi.fn().mockResolvedValue(ok({
      schemaVersion: 3,
      knowledgeGeneration: 0,
      countsByType: {},
      countsByStatus: {},
      pendingImpacts: 0,
      latestMigration: "lossless-book-schema-v3",
    })),
    chooseKnowledgeImport: vi.fn().mockResolvedValue(failure("DESKTOP_SELECTION_CANCELLED", "已取消选择")),
    inspectKnowledgeImport: vi.fn().mockResolvedValue(failure("KNOWLEDGE_IMPORT_NOT_FOUND", "没有待导入文件")),
    confirmKnowledgeImportEncoding: vi.fn().mockResolvedValue(failure("KNOWLEDGE_IMPORT_NOT_FOUND", "没有待导入文件")),
    listStagedKnowledgeImports: vi.fn().mockResolvedValue(ok([])),
    getStagedKnowledgeImport: vi.fn().mockResolvedValue(failure("KNOWLEDGE_IMPORT_BATCH_NOT_FOUND", "没有导入批次")),
    suggestKnowledgeImport: vi.fn().mockResolvedValue(failure("KNOWLEDGE_IMPORT_NOT_FOUND", "没有待导入文件")),
    stageKnowledgeImport: vi.fn().mockResolvedValue(failure("KNOWLEDGE_IMPORT_NOT_FOUND", "没有待导入文件")),
    decideKnowledgeImport: vi.fn().mockResolvedValue(failure("KNOWLEDGE_IMPORT_BATCH_NOT_FOUND", "没有导入批次")),
    commitKnowledgeImport: vi.fn().mockResolvedValue(failure("KNOWLEDGE_IMPORT_BATCH_NOT_FOUND", "没有导入批次")),
    rollbackKnowledgeImport: vi.fn().mockResolvedValue(failure("KNOWLEDGE_IMPORT_BATCH_NOT_FOUND", "没有导入批次")),
    cancelKnowledgeImportOperation: vi.fn().mockResolvedValue(ok(undefined)),
    cancelPendingKnowledgeImport: vi.fn().mockResolvedValue(ok(undefined)),
    discardStagedKnowledgeImport: vi.fn().mockResolvedValue(ok(undefined)),
    chooseProject: vi.fn().mockResolvedValue(failure("DESKTOP_NO_PROJECT", "没有可打开的书稿")),
    chooseStore: vi.fn().mockResolvedValue(failure("DESKTOP_NO_PROJECT", "没有可打开的书稿")),
    refreshProject: vi.fn().mockResolvedValue(failure("DESKTOP_NO_PROJECT", "没有可打开的书稿")),
    selectRun: vi.fn().mockResolvedValue(failure("DESKTOP_NO_PROJECT", "没有可打开的书稿")),
    runDoctor: vi.fn().mockResolvedValue(failure("DESKTOP_NO_PROJECT", "没有可打开的书稿")),
    ...overrides,
  };
}

describe("FolioLoom desktop onboarding", () => {
  it("keeps a global private diagnostic export available without an open project", async () => {
    const exportDiagnostics = vi.fn().mockResolvedValue(ok({
      fileName: "FolioLoom-diagnostics.json",
      displayPath: "D:\\Exports\\FolioLoom-diagnostics.json",
    }));
    const user = userEvent.setup();
    render(<App api={createApi({ exportDiagnostics })} />);

    await user.click(await screen.findByRole("button", { name: "导出诊断" }));
    expect(exportDiagnostics).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/FolioLoom-diagnostics\.json/u)).toBeTruthy();
  });

  it("offers copy and export actions beside an operation error", async () => {
    const copyDiagnosticSummary = vi.fn().mockResolvedValue(ok(undefined));
    const exportDiagnostics = vi.fn().mockResolvedValue(ok({
      fileName: "trial-diagnostics.json",
      displayPath: "D:\\Exports\\trial-diagnostics.json",
    }));
    const user = userEvent.setup();
    render(<App api={createApi({
      getOnboardingState: vi.fn().mockResolvedValue(
        failure("DESKTOP_REFRESH_FAILED", "书稿状态刷新失败"),
      ),
      copyDiagnosticSummary,
      exportDiagnostics,
    })} />);

    expect(await screen.findByText("书稿状态刷新失败")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "复制诊断摘要" }));
    expect(copyDiagnosticSummary).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("诊断摘要已复制")).toBeTruthy();

    const exportButtons = screen.getAllByRole("button", { name: "导出诊断" });
    await user.click(exportButtons[exportButtons.length - 1]!);
    expect(exportDiagnostics).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/trial-diagnostics\.json/u)).toBeTruthy();
  });

  it("starts with a reader-facing manuscript choice instead of an engineering project picker", async () => {
    render(<App api={createApi()} />);

    expect(await screen.findByRole("heading", { name: "开始翻译一本书" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "选择书稿" })).toBeTruthy();
  });

  it("lets readers override source language before choosing a manuscript", async () => {
    const chooseSource = vi.fn().mockResolvedValue(
      failure("DESKTOP_SELECTION_CANCELLED", "已取消选择"),
    );
    const user = userEvent.setup();
    render(<App api={createApi({ chooseSource })} />);

    const language = await screen.findByLabelText("原文语言") as HTMLSelectElement;
    expect(language.value).toBe("auto");
    await user.selectOptions(language, "de");
    await user.click(screen.getByRole("button", { name: "选择书稿" }));
    expect(chooseSource).toHaveBeenCalledWith({ sourceLanguage: "de" });
  });

  it("keeps unavailable workspaces visible but non-interactive", async () => {
    const user = userEvent.setup();
    render(<App api={createApi()} />);

    for (const name of ["项目概览", "翻译运行", "术语与记忆", "审阅队列", "导出"]) {
      expect(await screen.findByRole("button", { name })).toBeTruthy();
    }

    expect((screen.getByRole("button", { name: "项目概览" }) as HTMLButtonElement).disabled).toBe(false);
    const memory = screen.getByRole("button", { name: "术语与记忆" }) as HTMLButtonElement;
    expect(memory.disabled).toBe(true);

    await user.click(memory);
    expect(await screen.findByRole("heading", { name: "开始翻译一本书" })).toBeTruthy();
  });

  it("opens the knowledge workspace only for a ready selected run", async () => {
    const user = userEvent.setup();
    const onboarding = {
      ...sourceOnlyOnboarding,
      project: knowledgeReadyProject,
    };
    render(<App api={createApi({
      getOnboardingState: vi.fn().mockResolvedValue(ok(onboarding)),
    })} />);

    const memory = await screen.findByRole("button", { name: "术语与记忆" });
    expect((memory as HTMLButtonElement).disabled).toBe(false);
    await user.click(memory);
    expect(await screen.findByRole("heading", { name: "术语与记忆" })).toBeTruthy();
  });

  it("opens the full-book workspace and applies progress events without restarting the run", async () => {
    const user = userEvent.setup();
    let publishProgress: ((progress: DesktopFullBookProgress) => void) | undefined;
    const afterEvent = deferred<DesktopResult<DesktopFullBookSnapshot>>();
    const running: DesktopFullBookSnapshot = {
      activeRunId: "run-hidden",
      runs: [{
        runId: "run-hidden",
        sourceVersion: project.sourceVersion,
        modelId: "deepseek-v4",
        mode: "quality",
        optimizationProfile: "balanced",
        phase: "running",
        progress: {
          totalWindows: 100,
          pendingWindows: 89,
          runningWindows: 1,
          stagedWindows: 0,
          completedWindows: 10,
          warningWindows: 0,
          humanRequiredWindows: 0,
          failedWindows: 0,
        },
        canPause: true,
        canResume: false,
        canExport: false,
      }],
    };
    const getFullBookState = vi.fn()
      .mockResolvedValueOnce(ok(running))
      .mockReturnValueOnce(afterEvent.promise);
    const startFullBook = vi.fn();
    render(<App api={createApi({
      getOnboardingState: vi.fn().mockResolvedValue(ok(readyOnboarding)),
      getFullBookState,
      startFullBook,
      onFullBookProgress: vi.fn().mockImplementation((listener) => {
        publishProgress = listener;
        return () => { publishProgress = undefined; };
      }),
    })} />);

    await user.click(await screen.findByRole("button", { name: "翻译运行" }));
    expect(await screen.findByText("10 / 100 个文本块")).toBeTruthy();
    act(() => publishProgress?.({
      runId: "run-hidden",
      phase: "running",
      progress: {
        ...running.runs[0]!.progress,
        pendingWindows: 67,
        completedWindows: 32,
      },
    }));
    expect(await screen.findByText("32 / 100 个文本块")).toBeTruthy();
    expect(startFullBook).not.toHaveBeenCalled();

    await act(async () => afterEvent.resolve(failure(
      "REQUEST_TIMEOUT",
      "刷新状态超时",
      "socket timeout",
    )));
    expect(screen.getByText("32 / 100 个文本块")).toBeTruthy();
    expect(await screen.findByText("刷新状态超时")).toBeTruthy();
  });

  it("opens the export workspace with the current candidates and destination", async () => {
    const user = userEvent.setup();
    const exportState: DesktopExportSnapshot = {
      candidates: [{
        runId: "run-hidden",
        modelId: "deepseek-v4",
        status: "ready",
        completedWindows: 100,
        totalWindows: 100,
        blockers: [],
      }],
      defaultDestination: {
        destinationId: "destination-hidden",
        displayPath: "D:\\Books\\Exports",
      },
    };
    render(<App api={createApi({
      getOnboardingState: vi.fn().mockResolvedValue(ok(readyOnboarding)),
      getExportState: vi.fn().mockResolvedValue(ok(exportState)),
    })} />);

    await user.click(await screen.findByRole("button", { name: "导出" }));
    expect(await screen.findByRole("heading", { name: "导出" })).toBeTruthy();
    expect(screen.getByText("100 / 100 个文本块")).toBeTruthy();
    expect(screen.getByText("D:\\Books\\Exports")).toBeTruthy();
    expect(screen.queryByText("run-hidden")).toBeNull();
  });

  it("uses the visible manuscript button to call the desktop bridge and advance to model setup", async () => {
    const user = userEvent.setup();
    const chooseSource = vi.fn().mockResolvedValue(ok({
      status: "ready",
      project,
    } satisfies DesktopChooseSourceResult));
    const getOnboardingState = vi.fn()
      .mockResolvedValueOnce(ok(emptyOnboarding))
      .mockResolvedValueOnce(ok(sourceOnlyOnboarding));
    render(<App api={createApi({ chooseSource, getOnboardingState })} />);

    await user.click(await screen.findByRole("button", { name: "选择书稿" }));

    await waitFor(() => expect(chooseSource).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: "DeepSeek" })).toBeTruthy();
  });

  it("ignores a stale startup snapshot that resolves after a newly imported manuscript", async () => {
    const user = userEvent.setup();
    const startup = deferred<DesktopResult<DesktopOnboardingState>>();
    const refreshed = deferred<DesktopResult<DesktopOnboardingState>>();
    const replacement = {
      ...project,
      title: "New Project",
      sourceVersion: "source-new-project",
    };
    const replacementOnboarding = {
      ...sourceOnlyOnboarding,
      project: replacement,
    };
    const getOnboardingState = vi.fn()
      .mockReturnValueOnce(startup.promise)
      .mockReturnValueOnce(refreshed.promise);
    render(<App api={createApi({
      getOnboardingState,
      chooseSource: vi.fn().mockResolvedValue(ok({
        status: "ready",
        project: replacement,
      } satisfies DesktopChooseSourceResult)),
    })} />);

    await user.click(screen.getByRole("button", { name: "选择书稿" }));
    await act(async () => refreshed.resolve(ok(replacementOnboarding)));
    expect(await screen.findByRole("heading", { name: "New Project" })).toBeTruthy();

    await act(async () => startup.resolve(ok(emptyOnboarding)));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "New Project" })).toBeTruthy();
    });
  });

  it("shows source diagnostics as reader-facing language and encoding details without internal paths", async () => {
    const { container } = render(<App api={createApi({
      getOnboardingState: vi.fn().mockResolvedValue(ok(sourceOnlyOnboarding)),
    })} />);

    await screen.findByRole("heading", { name: "The Example Book" });
    expect(screen.getByText("检测语言：英语")).toBeTruthy();
    expect(screen.getByText("编码：UTF-8 · 置信度 98%")).toBeTruthy();
    expect(container.textContent).not.toContain("internal-project-file");
    expect(container.textContent).not.toContain("source_manifest.json");
    expect(container.textContent).not.toContain("SQLite");
  });

  it("describes EPUB and DOCX container extraction without exposing zip-container as an encoding", async () => {
    render(<App api={createApi({
      getOnboardingState: vi.fn().mockResolvedValue(ok({
        ...sourceOnlyOnboarding,
        project: {
          ...project,
          title: "Container Book",
          sourceEncoding: "zip-container",
          encodingConfidence: 1,
        },
      })),
    })} />);

    await screen.findByRole("heading", { name: "Container Book" });
    expect(screen.getByText("格式：电子书/文档容器（正文已提取）")).toBeTruthy();
    expect(document.body.textContent).not.toContain("zip-container");
  });

  it("renders a canonical Japanese or Korean source diagnostic instead of internal profile ids", async () => {
    const japaneseProject: DesktopProjectSnapshot = {
      ...project,
      title: "日本語の本",
      sourceLanguage: "ja",
      detectedLanguage: "日语",
      sourceEncoding: "shift_jis",
      encodingConfidence: 0.87,
    };
    render(<App api={createApi({
      getOnboardingState: vi.fn().mockResolvedValue(ok({
        ...sourceOnlyOnboarding,
        project: japaneseProject,
      })),
    })} />);

    await screen.findByRole("heading", { name: "日本語の本" });
    expect(screen.getByText("检测语言：日语")).toBeTruthy();
    expect(screen.getByText("编码：Shift-JIS · 置信度 87%")).toBeTruthy();
    expect(screen.queryByText("ja")).toBeNull();
  });

  it("keeps an ambiguous source behind an opaque encoding choice before opening the project", async () => {
    const user = userEvent.setup();
    const pending: DesktopChooseSourceResult = {
      status: "encoding_required",
      pendingImportId: "8f0f8277-ec45-41dc-82e1-55586912908b",
      fileName: "korean-novel.txt",
      encodings: ["euc-kr", "windows-949"],
    };
    const chooseSource = vi.fn().mockResolvedValue(ok(pending));
    const confirmSourceEncoding = vi.fn().mockResolvedValue(ok({
      status: "ready",
      project,
    } satisfies DesktopChooseSourceResult));
    const getOnboardingState = vi.fn()
      .mockResolvedValueOnce(ok(emptyOnboarding))
      .mockResolvedValueOnce(ok(sourceOnlyOnboarding));
    render(<App api={createApi({ chooseSource, confirmSourceEncoding, getOnboardingState })} />);

    await user.click(await screen.findByRole("button", { name: "选择书稿" }));
    expect(await screen.findByRole("heading", { name: "请选择文字编码" })).toBeTruthy();
    expect(screen.getByText("korean-novel.txt")).toBeTruthy();
    expect(document.body.textContent).not.toContain(pending.pendingImportId);

    await user.click(screen.getByRole("button", { name: /EUC-KR/u }));
    await waitFor(() => expect(confirmSourceEncoding).toHaveBeenCalledWith({
      pendingImportId: pending.pendingImportId,
      encoding: "euc-kr",
    }));
    expect(await screen.findByRole("button", { name: "DeepSeek" })).toBeTruthy();
  });

  it("shows an encoding choice above an existing project while replacing its manuscript", async () => {
    const user = userEvent.setup();
    const pending: DesktopChooseSourceResult = {
      status: "encoding_required",
      pendingImportId: "9b34f991-35a9-47ba-8fda-92fa847d9459",
      fileName: "replacement-korean.txt",
      encodings: ["euc-kr", "windows-949"],
    };
    render(<App api={createApi({
      getOnboardingState: vi.fn().mockResolvedValue(ok(sourceOnlyOnboarding)),
      chooseSource: vi.fn().mockResolvedValue(ok(pending)),
    })} />);

    await user.click(await screen.findByRole("button", { name: "更换书稿" }));

    expect(await screen.findByRole("heading", { name: "请选择文字编码" })).toBeTruthy();
    expect(screen.getByText("replacement-korean.txt")).toBeTruthy();
  });

  it("clears stale trial state and locks trial when a new-source refresh fails", async () => {
    const user = userEvent.setup();
    const replacement = { ...project, title: "Replacement Book", sourceVersion: "source-replacement" };
    const getOnboardingState = vi.fn()
      .mockResolvedValueOnce(ok(readyOnboarding))
      .mockResolvedValueOnce(failure("DESKTOP_REFRESH_FAILED", "书稿状态刷新失败"));
    const startTrial = vi.fn().mockResolvedValue(ok({
      runId: "old-run",
      sourceText: "OLD SOURCE",
      translationText: "OLD TRANSLATION",
    }));
    render(<App api={createApi({
      getOnboardingState,
      startTrial,
      chooseSource: vi.fn().mockResolvedValue(ok({
        status: "ready",
        project: replacement,
      } satisfies DesktopChooseSourceResult)),
    })} />);

    await user.click(await screen.findByRole("button", { name: "开始试译" }));
    expect(await screen.findByText("OLD TRANSLATION")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "更换书稿" }));

    expect(await screen.findByRole("heading", { name: "Replacement Book" })).toBeTruthy();
    expect(screen.queryByText("OLD TRANSLATION")).toBeNull();
    expect((screen.getByRole("button", { name: "开始试译" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("书稿状态刷新失败")).toBeTruthy();
  });

  it("treats closing the manuscript picker as a no-op", async () => {
    const user = userEvent.setup();
    render(<App api={createApi()} />);

    await user.click(await screen.findByRole("button", { name: "选择书稿" }));

    await waitFor(() => expect(screen.queryByText("已取消选择")).toBeNull());
    expect(screen.getByRole("heading", { name: "开始翻译一本书" })).toBeTruthy();
  });

  it("renders six direct providers and keeps the custom interface under more services", async () => {
    const user = userEvent.setup();
    render(<App api={createApi({ getOnboardingState: vi.fn().mockResolvedValue(ok(sourceOnlyOnboarding)) })} />);

    for (const name of ["DeepSeek", "Kimi", "阿里云百炼", "火山方舟", "OpenAI", "硅基流动"]) {
      expect(await screen.findByRole("button", { name })).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "更多服务" })).toBeTruthy();
    expect(screen.queryByLabelText("Base URL")).toBeNull();

    await user.click(screen.getByRole("button", { name: "更多服务" }));
    await user.click(screen.getByRole("button", { name: "自定义 OpenAI-compatible" }));

    expect(screen.getByLabelText("Base URL")).toBeTruthy();
    expect(screen.getByRole("button", { name: "on" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "off" })).toBeTruthy();
  });

  it("uses raw provider effort values without translating or normalizing them", async () => {
    const user = userEvent.setup();
    render(<App api={createApi({ getOnboardingState: vi.fn().mockResolvedValue(ok(sourceOnlyOnboarding)) })} />);

    await user.click(await screen.findByRole("button", { name: "DeepSeek" }));

    expect(screen.getByRole("button", { name: "high" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "max" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "最大" })).toBeNull();
  });

  it("offers only current DeepSeek V4 choices without a manual model field", async () => {
    render(<App api={createApi({
      getOnboardingState: vi.fn().mockResolvedValue(ok(sourceOnlyOnboarding)),
    })} />);

    const select = await screen.findByLabelText("模型") as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);
    expect(screen.queryByText("或填写模型名称")).toBeNull();
  });

  it("starts the provider form from the saved active model", async () => {
    const savedKimi: DesktopOnboardingState = {
      ...readyOnboarding,
      providers: providers.map((provider) => provider.id === "kimi-cn"
        ? { ...provider, credentialStatus: "available", credentialPersistence: "encrypted" }
        : provider),
      activeModel: {
        providerId: "kimi-cn",
        modelId: "moonshot-v1-8k",
        reasoningEffort: "high",
        capability: "ready",
      },
    };
    render(<App api={createApi({ getOnboardingState: vi.fn().mockResolvedValue(ok(savedKimi)) })} />);

    const kimi = await screen.findByRole("button", { name: "Kimi" });
    expect(kimi.getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByLabelText("模型") as HTMLSelectElement).value).toBe("moonshot-v1-8k");
    expect(screen.getByRole("button", { name: "high" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByLabelText("API Key") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("API Key") as HTMLInputElement).placeholder).toBe("••••••••••••");
  });

  it("locks trial when the visible model draft no longer matches the tested model", async () => {
    const user = userEvent.setup();
    render(<App api={createApi({
      getOnboardingState: vi.fn().mockResolvedValue(ok(readyOnboarding)),
    })} />);

    const trial = await screen.findByRole("button", { name: "开始试译" }) as HTMLButtonElement;
    await waitFor(() => expect(trial.disabled).toBe(false));
    await user.click(screen.getByRole("button", { name: "Kimi" }));

    await waitFor(() => expect(trial.disabled).toBe(true));
    expect(screen.getByText(/重新测试连接后才能试译/u)).toBeTruthy();
  });

  it("replaces the API Key with a persistent mask only after a ready connection", async () => {
    const user = userEvent.setup();
    const configuredReady: DesktopOnboardingState = {
      ...readyOnboarding,
      providers: providers.map((provider) => provider.id === "deepseek"
        ? { ...provider, credentialStatus: "available", credentialPersistence: "encrypted" }
        : provider),
    };
    const testModel = vi.fn().mockResolvedValue(ok(testResult(configuredReady)));
    render(<App api={createApi({
      getOnboardingState: vi.fn().mockResolvedValue(ok(sourceOnlyOnboarding)),
      testModel,
    })} />);

    const apiKey = await screen.findByLabelText("API Key");
    await user.type(apiKey, "sk-temporary-key");
    await user.click(screen.getByRole("button", { name: "测试连接" }));

    await waitFor(() => expect(testModel).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "deepseek",
      apiKey: "sk-temporary-key",
    })));
    await waitFor(() => expect((apiKey as HTMLInputElement).value).toBe(""));
    expect((apiKey as HTMLInputElement).placeholder).toBe("••••••••••••");
    expect(screen.getByRole("status").textContent).toContain("连接成功，API Key 已安全保存。");
  });

  it("keeps the API Key and shows the provider report when a connection test does not pass", async () => {
    const user = userEvent.setup();
    const failedOnboarding: DesktopOnboardingState = {
      ...sourceOnlyOnboarding,
      latestProbe: {
        status: "failed",
        code: "PROVIDER_UNREACHABLE",
        message: "无法连接模型服务，请检查网络或服务设置。",
        retryable: true,
      },
    };
    const testModel = vi.fn().mockResolvedValue(ok({
      report: failedOnboarding.latestProbe!,
      onboarding: failedOnboarding,
    } satisfies DesktopTestModelResult));
    render(<App api={createApi({
      getOnboardingState: vi.fn().mockResolvedValue(ok(sourceOnlyOnboarding)),
      testModel,
    })} />);

    const apiKey = await screen.findByLabelText("API Key");
    await user.type(apiKey, "sk-retry-without-retyping");
    await user.click(screen.getByRole("button", { name: "测试连接" }));

    expect(await screen.findByText("无法连接模型服务，请检查网络或服务设置。")).toBeTruthy();
    expect((apiKey as HTMLInputElement).value).toBe("sk-retry-without-retyping");
  });

  it("keeps the API Key when a connection test is limited", async () => {
    const user = userEvent.setup();
    const limitedProbe = {
      status: "limited" as const,
      message: "连接正常，但该模型不支持完整流程。",
    };
    const limitedOnboarding: DesktopOnboardingState = {
      ...sourceOnlyOnboarding,
      latestProbe: limitedProbe,
    };
    render(<App api={createApi({
      getOnboardingState: vi.fn().mockResolvedValue(ok(sourceOnlyOnboarding)),
      testModel: vi.fn().mockResolvedValue(ok({ report: limitedProbe, onboarding: limitedOnboarding })),
    })} />);

    const apiKey = await screen.findByLabelText("API Key");
    await user.type(apiKey, "sk-limited-retry");
    await user.click(screen.getByRole("button", { name: "测试连接" }));

    expect(await screen.findByText("连接正常，但该模型不支持完整流程。")).toBeTruthy();
    expect((apiKey as HTMLInputElement).value).toBe("sk-limited-retry");
  });

  it("shows the persisted failed probe after restart when no model is active", async () => {
    const restarted: DesktopOnboardingState = {
      ...sourceOnlyOnboarding,
      latestProbe: {
        status: "failed",
        message: "上次连接模型时网络超时。",
        retryable: true,
      },
    };
    render(<App api={createApi({
      getOnboardingState: vi.fn().mockResolvedValue(ok(restarted)),
    })} />);

    expect(await screen.findByText("上次连接模型时网络超时。")).toBeTruthy();
  });

  it("shows a persisted failed probe after restart when it belongs to the active model", async () => {
    const restarted: DesktopOnboardingState = {
      ...readyOnboarding,
      latestProbe: {
        status: "failed",
        providerId: "deepseek",
        modelId: "deepseek-v4-pro",
        message: "matching active-model probe failed",
        retryable: true,
      },
    };
    render(<App api={createApi({
      getOnboardingState: vi.fn().mockResolvedValue(ok(restarted)),
    })} />);

    expect(await screen.findByText("matching active-model probe failed")).toBeTruthy();
  });

  it("does not attribute another model's failed probe to the active model after restart", async () => {
    const restarted: DesktopOnboardingState = {
      ...readyOnboarding,
      latestProbe: {
        status: "failed",
        providerId: "kimi",
        modelId: "moonshot-v1-8k",
        message: "different model probe failed",
        retryable: true,
      },
    };
    render(<App api={createApi({
      getOnboardingState: vi.fn().mockResolvedValue(ok(restarted)),
    })} />);

    await screen.findByLabelText("API Key");
    expect(screen.queryByText("different model probe failed")).toBeNull();
  });

  it("keeps the API Key and reports an IPC connection error beside the button", async () => {
    const user = userEvent.setup();
    render(<App api={createApi({
      getOnboardingState: vi.fn().mockResolvedValue(ok(sourceOnlyOnboarding)),
      testModel: vi.fn().mockResolvedValue({
        ok: false,
        error: {
          code: "PROVIDER_UNREACHABLE",
          message: "连接服务超时，请稍后重试。",
          retryable: true,
        },
      }),
    })} />);

    const apiKey = await screen.findByLabelText("API Key");
    await user.type(apiKey, "sk-keep-after-ipc-error");
    await user.click(screen.getByRole("button", { name: "测试连接" }));

    expect(await screen.findByText("连接服务超时，请稍后重试。")).toBeTruthy();
    expect((apiKey as HTMLInputElement).value).toBe("sk-keep-after-ipc-error");
  });

  it("locks provider selection while model discovery is in flight", async () => {
    const user = userEvent.setup();
    let resolveDiscover!: (value: DesktopResult<readonly { id: string; displayName: string }[]>) => void;
    const discoverModels = vi.fn().mockImplementation(() => new Promise<DesktopResult<readonly { id: string; displayName: string }[]>>((resolve) => {
      resolveDiscover = resolve;
    }));
    render(<App api={createApi({
      getOnboardingState: vi.fn().mockResolvedValue(ok(sourceOnlyOnboarding)),
      discoverModels,
    })} />);

    await user.click(await screen.findByRole("button", { name: "获取模型" }));
    await waitFor(() => expect(discoverModels).toHaveBeenCalledTimes(1));
    expect((screen.getByRole("button", { name: "Kimi" }) as HTMLButtonElement).disabled).toBe(true);

    resolveDiscover(ok([{ id: "deepseek-live", displayName: "DeepSeek Live" }]));
    await waitFor(() => expect((screen.getByRole("button", { name: "Kimi" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("shows an in-place testing state while the provider probe is running", async () => {
    const user = userEvent.setup();
    let resolveTest!: (value: DesktopResult<DesktopTestModelResult>) => void;
    const testModel = vi.fn().mockImplementation(() => new Promise<DesktopResult<DesktopTestModelResult>>((resolve) => {
      resolveTest = resolve;
    }));
    render(<App api={createApi({
      getOnboardingState: vi.fn().mockResolvedValue(ok(sourceOnlyOnboarding)),
      testModel,
    })} />);

    await user.type(await screen.findByLabelText("API Key"), "sk-pending-probe");
    await user.click(screen.getByRole("button", { name: "测试连接" }));

    const pending = await screen.findByRole("button", { name: "正在测试…" });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Kimi" }) as HTMLButtonElement).disabled).toBe(true);

    resolveTest(ok(testResult()));
    expect(await screen.findByText("连接成功，API Key 已安全保存。")).toBeTruthy();
  });

  it("clears ready feedback and readiness after forgetting the active credential", async () => {
    const user = userEvent.setup();
    const configuredReady: DesktopOnboardingState = {
      ...readyOnboarding,
      providers: providers.map((provider) => provider.id === "deepseek"
        ? { ...provider, credentialStatus: "available", credentialPersistence: "encrypted" }
        : provider),
    };
    const testModel = vi.fn().mockResolvedValue(ok(testResult(configuredReady)));
    const forgetCredential = vi.fn().mockResolvedValue(ok(sourceOnlyOnboarding));
    render(<App api={createApi({
      getOnboardingState: vi.fn().mockResolvedValue(ok(sourceOnlyOnboarding)),
      testModel,
      forgetCredential,
    })} />);

    await user.type(await screen.findByLabelText("API Key"), "sk-forget-after-ready");
    await user.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText("连接成功，API Key 已安全保存。")).toBeTruthy();
    expect((screen.getByLabelText("API Key") as HTMLInputElement).placeholder).toBe("••••••••••••");

    await user.click(screen.getByRole("button", { name: "忘记此密钥" }));
    await waitFor(() => expect(forgetCredential).toHaveBeenCalledWith("deepseek"));

    expect(screen.queryByText("连接成功，API Key 已安全保存。")).toBeNull();
    expect((screen.getByLabelText("API Key") as HTMLInputElement).placeholder).toBe("DeepSeek API Key");
    expect((screen.getByRole("button", { name: "开始试译" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("当前已选择 deepseek-v4-pro")).toBeNull();
  });

  it("keeps the trial action disabled until the model is ready", async () => {
    const sourceOnly: DesktopOnboardingState = {
      ...emptyOnboarding,
      project,
      readiness: { source: true, model: false, trial: false },
      activeModel: {
        providerId: "deepseek",
        modelId: "deepseek-v4-pro",
        capability: "limited",
      },
      latestProbe: { status: "limited", message: "这个模型还不能用于完整翻译流程" },
    };
    render(<App api={createApi({ getOnboardingState: vi.fn().mockResolvedValue(ok(sourceOnly)) })} />);

    expect((await screen.findByRole("button", { name: "开始试译" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("runs one real trial and renders the committed source beside its translation", async () => {
    const user = userEvent.setup();
    let publishProgress: ((progress: DesktopTrialProgress) => void) | undefined;
    const startTrial = vi.fn().mockImplementation(async () => {
      publishProgress?.({ stage: "translating" });
      publishProgress?.({ stage: "checking" });
      publishProgress?.({ stage: "completed" });
      return ok({
        runId: "trial-run-1",
        sourceText: "The bell rang above the empty court.",
        translationText: "钟声在空旷的庭院上空回响。",
      });
    });
    const onTrialProgress = vi.fn().mockImplementation((listener: (progress: DesktopTrialProgress) => void) => {
      publishProgress = listener;
      return () => { publishProgress = undefined; };
    });
    const { container } = render(<App api={createApi({
      getOnboardingState: vi.fn().mockResolvedValue(ok(readyOnboarding)),
      startTrial,
      onTrialProgress,
    })} />);

    const button = await waitFor(() => {
      const target = container.querySelector<HTMLButtonElement>('[data-action="start-trial"]');
      expect(target?.disabled).toBe(false);
      return target as HTMLButtonElement;
    });
    await user.click(button);

    expect(await screen.findByText("The bell rang above the empty court.")).toBeTruthy();
    expect(screen.getByText("钟声在空旷的庭院上空回响。")).toBeTruthy();
    expect(startTrial).toHaveBeenCalledTimes(1);
    expect(startTrial).toHaveBeenCalledWith({ mode: "quality" });
    expect(onTrialProgress).toHaveBeenCalledTimes(1);
  });

  it("defaults to quality trial and sends only the explicit fast mode after the user switches", async () => {
    const user = userEvent.setup();
    const startTrial = vi.fn().mockResolvedValue(ok({
      runId: "trial-run-fast",
      sourceText: "The bell rang.",
      translationText: "钟响了。",
    }));
    const { container } = render(<App api={createApi({
      getOnboardingState: vi.fn().mockResolvedValue(ok(readyOnboarding)),
      startTrial,
    })} />);

    const quality = await screen.findByRole("button", { name: "精细试译" });
    const fast = screen.getByRole("button", { name: "快速试译" });
    expect(quality.getAttribute("aria-pressed")).toBe("true");
    expect(fast.getAttribute("aria-pressed")).toBe("false");

    await user.click(fast);
    expect(fast.getAttribute("aria-pressed")).toBe("true");
    await user.click(await waitFor(() => {
      const target = container.querySelector<HTMLButtonElement>("[data-action='start-trial']");
      expect(target?.disabled).toBe(false);
      return target as HTMLButtonElement;
    }));

    expect(startTrial).toHaveBeenCalledWith({ mode: "fast" });
  });

  it("shows a normal error first and keeps redacted technical detail collapsed", async () => {
    const user = userEvent.setup();
    const secret = "json-header-secret-should-not-reach-the-dom";
    const testModel = vi.fn().mockResolvedValue(failure(
      "AUTH_INVALID",
      "API Key 未被接受，请检查后重试。",
      `headers={"x-api-key":"${secret}"}`,
    ));
    const { container } = render(<App api={createApi({
      getOnboardingState: vi.fn().mockResolvedValue(ok(sourceOnlyOnboarding)),
      testModel,
    })} />);

    await user.type(await screen.findByLabelText("API Key"), secret);
    await user.click(screen.getByRole("button", { name: "测试连接" }));

    expect(await screen.findByText("API Key 未被接受，请检查后重试。")).toBeTruthy();
    const details = screen.getByText("技术详情").closest("details");
    expect(details?.open).toBe(false);
    expect(container.textContent).not.toContain(secret);
  });

  it("does not put internal workflow jargon in the default visible interface", async () => {
    const { container } = render(<App api={createApi()} />);
    await screen.findByRole("heading", { name: "开始翻译一本书" });
    const visibleText = container.textContent ?? "";

    for (const forbidden of ["V5", "source_manifest.json", "book.db", "canonical", "SQLite", "状态库", "协议"]) {
      expect(visibleText).not.toContain(forbidden);
    }
  });
});
