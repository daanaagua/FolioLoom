import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CommittedImportReport,
  DesktopResult,
  ImportInspectionResult,
  MappingSuggestion,
  PendingKnowledgeImport,
  StagedImportReport,
  StagedImportSummary,
} from "../../../contracts.js";
import type { FolioLoomDesktopApi } from "../../../preload/folioloom-api.js";
import { KnowledgeImportWizard } from "./KnowledgeImportWizard.js";

afterEach(() => cleanup());

function ok<T>(value: T): DesktopResult<T> {
  return { ok: true, value };
}

function pending(): PendingKnowledgeImport {
  return {
    pendingImportId: "0f6daf3e-acde-4ca7-a1a2-7e15964d1da3",
    fileName: "terms.json",
    format: "json",
  };
}

function inspection(): ImportInspectionResult {
  return {
    status: "ready",
    inspection: {
      pendingImportId: pending().pendingImportId,
      fileName: pending().fileName,
      format: "json",
      recordPaths: [{
        id: "record-path:1",
        label: "$.records",
        shape: "records",
      }],
      sheets: [],
      sample: [{
        ordinal: 1,
        location: "$.records[0]",
        values: {
          source: "Archon",
          target: "执政官",
          note: "职位称呼",
        },
      }],
    },
  };
}

function mapping(confidence: "high" | "medium" = "high"): MappingSuggestion {
  return {
    selection: {
      recordPathId: "record-path:1",
      objectType: "term",
      scope: "book",
    },
    fields: {
      sourceForm: {
        targetField: "sourceForm",
        sourceColumn: "source",
        confidence: "high",
        confirmed: true,
      },
      target: {
        targetField: "target",
        sourceColumn: "target",
        confidence: "high",
        confirmed: true,
      },
      note: {
        targetField: "note",
        sourceColumn: "note",
        confidence,
        confirmed: confidence === "high",
      },
    },
    reasons: {
      sourceForm: ["exact alias match"],
      target: ["exact alias match"],
      note: [confidence === "high"
        ? "official template field"
        : "ambiguous collision with another source column"],
    },
    mappingHash: "a".repeat(64),
  };
}

function staged(overrides: Partial<StagedImportReport> = {}): StagedImportReport {
  return {
    batchId: "214f314d-091a-437b-8295-f9a836de03df",
    counts: {
      ready: 12,
      merge: 0,
      conflict: 0,
      invalid: 0,
      skipped: 0,
    },
    unresolved: 0,
    rows: [],
    ...overrides,
  };
}

function committed(): CommittedImportReport {
  return {
    batchId: staged().batchId,
    added: 12,
    updated: 0,
    merged: 0,
    skipped: 0,
    invalid: 0,
    committed: 12,
    generation: 8,
    snapshotId: "b".repeat(64),
  };
}

function importApi(options: {
  suggestion?: MappingSuggestion;
  stagedBatches?: readonly StagedImportSummary[];
  inspectResult?: Promise<DesktopResult<ImportInspectionResult>>;
  suggestResult?: Promise<DesktopResult<MappingSuggestion>>;
  stageReport?: StagedImportReport;
} = {}): FolioLoomDesktopApi {
  const suggestion = options.suggestion ?? mapping();
  const unavailable = async (): Promise<DesktopResult<never>> => ({
    ok: false,
    error: { code: "UNAVAILABLE", message: "不可用", retryable: false },
  });
  return {
    chooseSource: unavailable,
    confirmSourceEncoding: unavailable,
    getOnboardingState: unavailable,
    discoverModels: unavailable,
    testModel: unavailable,
    forgetCredential: unavailable,
    startTrial: unavailable,
    cancelTrial: unavailable,
    onTrialProgress: () => () => undefined,
    getFullBookState: unavailable,
    startFullBook: unavailable,
    pauseFullBook: unavailable,
    resumeFullBook: unavailable,
    onFullBookProgress: () => () => undefined,
    getExportState: unavailable,
    chooseExportDirectory: unavailable,
    exportBook: unavailable,
    openExportDirectory: unavailable,
    copyDiagnosticSummary: unavailable,
    exportDiagnostics: unavailable,
    listKnowledge: unavailable,
    getKnowledgeDetail: unavailable,
    mutateKnowledge: unavailable,
    promoteKnowledgeToGlobal: unavailable,
    listGlobalKnowledge: unavailable,
    attachGlobalKnowledge: unavailable,
    getKnowledgeDiagnostics: unavailable,
    chooseKnowledgeImport: vi.fn().mockResolvedValue(ok(pending())),
    inspectKnowledgeImport: vi.fn().mockImplementation(() =>
      options.inspectResult ?? Promise.resolve(ok(inspection()))),
    confirmKnowledgeImportEncoding: vi.fn().mockResolvedValue(ok(inspection())),
    listStagedKnowledgeImports: vi.fn().mockResolvedValue(
      ok(options.stagedBatches ?? []),
    ),
    getStagedKnowledgeImport: vi.fn().mockResolvedValue(ok(staged())),
    suggestKnowledgeImport: vi.fn().mockImplementation(() =>
      options.suggestResult ?? Promise.resolve(ok(suggestion))),
    stageKnowledgeImport: vi.fn().mockResolvedValue(ok(
      options.stageReport ?? staged(),
    )),
    decideKnowledgeImport: vi.fn().mockResolvedValue(ok(staged())),
    commitKnowledgeImport: vi.fn().mockResolvedValue(ok(committed())),
    rollbackKnowledgeImport: vi.fn().mockResolvedValue(ok({
      batchId: staged().batchId,
      rolledBack: 12,
      generation: 9,
      snapshotId: "c".repeat(64),
    })),
    cancelKnowledgeImportOperation: vi.fn().mockResolvedValue(ok(undefined)),
    cancelPendingKnowledgeImport: vi.fn().mockResolvedValue(ok(undefined)),
    discardStagedKnowledgeImport: vi.fn().mockResolvedValue(ok(undefined)),
    chooseProject: unavailable,
    chooseStore: unavailable,
    refreshProject: unavailable,
    selectRun: unavailable,
    runDoctor: unavailable,
  };
}

describe("KnowledgeImportWizard", () => {
  it("takes a fully confirmed official mapping straight to conflict preview", async () => {
    const user = userEvent.setup();
    const api = importApi();
    render(
      <KnowledgeImportWizard
        api={api}
        generation={7}
        snapshotId={"1".repeat(64)}
        onClose={vi.fn()}
        onCommitted={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "选择文件" }));

    expect(await screen.findByRole("heading", {
      name: "检查与解决冲突",
    })).toBeTruthy();
    expect(screen.getByText("将新增 12 条")).toBeTruthy();
    expect(api.stageKnowledgeImport).toHaveBeenCalledTimes(1);
  });

  it("requires confirmation for a medium-confidence field mapping", async () => {
    const user = userEvent.setup();
    render(
      <KnowledgeImportWizard
        api={importApi({ suggestion: mapping("medium") })}
        generation={7}
        snapshotId={"1".repeat(64)}
        onClose={vi.fn()}
        onCommitted={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "选择文件" }));

    expect(await screen.findByText("请确认“备注”的来源列")).toBeTruthy();
    expect((screen.getByRole("button", {
      name: "生成预览",
    }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("commits once and reports the new generation", async () => {
    const onCommitted = vi.fn();
    const user = userEvent.setup();
    const api = importApi();
    render(
      <KnowledgeImportWizard
        api={api}
        generation={7}
        snapshotId={"1".repeat(64)}
        onClose={vi.fn()}
        onCommitted={onCommitted}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "选择文件" }));
    await user.click(await screen.findByRole("button", { name: "确认导入" }));

    await waitFor(() => expect(onCommitted).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 8 }),
    ));
    expect(api.commitKnowledgeImport).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("导入完成")).toBeTruthy();
  });

  it("resumes a staged batch through the bounded desktop page contract", async () => {
    const summary: StagedImportSummary = {
      batchId: staged().batchId,
      sourceName: "terms.xlsx",
      sourceFormat: "xlsx",
      counts: staged().counts,
      unresolved: 0,
      createdAt: "2026-07-23T12:00:00.000Z",
    };
    const api = importApi({ stagedBatches: [summary] });
    const user = userEvent.setup();
    render(
      <KnowledgeImportWizard
        api={api}
        generation={7}
        snapshotId={"1".repeat(64)}
        onClose={vi.fn()}
        onCommitted={vi.fn()}
      />,
    );

    expect(await screen.findByText("发现一项尚未提交的导入")).toBeTruthy();
    expect(screen.getByRole("button", { name: "丢弃暂存" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "继续处理" }));

    expect(await screen.findByText("没有需要逐条处理的记录。")).toBeTruthy();
    await waitFor(() => expect(
      screen.getByRole("dialog").contains(document.activeElement),
    ).toBe(true));
    expect(api.getStagedKnowledgeImport).toHaveBeenCalledWith({
      batchId: summary.batchId,
      limit: 100,
    });
  });

  it("cancels an active inspection and returns to a usable chooser", async () => {
    const api = importApi({
      inspectResult: new Promise<DesktopResult<ImportInspectionResult>>(
        () => undefined,
      ),
    });
    const user = userEvent.setup();
    render(
      <KnowledgeImportWizard
        api={api}
        generation={7}
        snapshotId={"1".repeat(64)}
        onClose={vi.fn()}
        onCommitted={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "选择文件" }));
    await user.click(await screen.findByRole("button", { name: "取消检查" }));

    expect(api.cancelKnowledgeImportOperation).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "选择文件" })).toBeTruthy();
  });

  it("loads the next bounded preview page without losing the first page", async () => {
    const first = staged({
      counts: { ready: 0, merge: 0, conflict: 2, invalid: 0, skipped: 0 },
      unresolved: 2,
      rows: [{
        ordinal: 1,
        location: "$.records[0]",
        state: "conflict",
        displayFields: { sourceForm: "Archon" },
        diagnostics: [],
        allowedDecisions: ["keep_existing"],
      }],
      nextCursor: "page-2",
    });
    const second = staged({
      counts: first.counts,
      unresolved: 2,
      rows: [{
        ordinal: 2,
        location: "$.records[1]",
        state: "conflict",
        displayFields: { sourceForm: "Autarch" },
        diagnostics: [],
        allowedDecisions: ["keep_existing"],
      }],
    });
    const base = importApi({ stageReport: first });
    const getStagedKnowledgeImport = vi.fn().mockResolvedValue(ok(second));
    const api = { ...base, getStagedKnowledgeImport };
    const user = userEvent.setup();
    render(
      <KnowledgeImportWizard
        api={api}
        generation={7}
        snapshotId={"1".repeat(64)}
        onClose={vi.fn()}
        onCommitted={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "选择文件" }));
    expect(await screen.findByText(/sourceForm: Archon/u)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "加载更多记录" }));

    expect(await screen.findByText(/sourceForm: Autarch/u)).toBeTruthy();
    expect(screen.getByText(/sourceForm: Archon/u)).toBeTruthy();
    expect(getStagedKnowledgeImport).toHaveBeenCalledWith({
      batchId: first.batchId,
      cursor: "page-2",
      limit: 100,
    });
  });

  it("turns a rejected desktop call into an actionable in-dialog error", async () => {
    const base = importApi();
    const api = {
      ...base,
      chooseKnowledgeImport: vi.fn().mockRejectedValue(
        new Error("renderer transport unavailable"),
      ),
    };
    const user = userEvent.setup();
    render(
      <KnowledgeImportWizard
        api={api}
        generation={7}
        snapshotId={"1".repeat(64)}
        onClose={vi.fn()}
        onCommitted={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "选择文件" }));

    expect(await screen.findByText("操作没有完成")).toBeTruthy();
    expect(screen.getByText("错误编号：DESKTOP_RENDERER_ERROR")).toBeTruthy();
  });

  it("releases a pending file when closing during mapping discovery", async () => {
    const api = importApi({
      suggestResult: new Promise<DesktopResult<MappingSuggestion>>(
        () => undefined,
      ),
    });
    const user = userEvent.setup();
    render(
      <KnowledgeImportWizard
        api={api}
        generation={7}
        snapshotId={"1".repeat(64)}
        onClose={vi.fn()}
        onCommitted={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "选择文件" }));
    await waitFor(() => expect(api.suggestKnowledgeImport).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "关闭导入" }));

    expect(api.cancelPendingKnowledgeImport).toHaveBeenCalledWith(
      pending().pendingImportId,
    );
  });

  it("closes with Escape while focus remains inside the modal", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <KnowledgeImportWizard
        api={importApi()}
        generation={7}
        snapshotId={"1".repeat(64)}
        onClose={onClose}
        onCommitted={vi.fn()}
      />,
    );

    const closeButton = await screen.findByRole("button", { name: "关闭导入" });
    await waitFor(() => expect(
      closeButton.closest('[role="dialog"]')?.contains(document.activeElement),
    ).toBe(true));
    await user.keyboard("{Escape}");

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
