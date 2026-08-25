import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

import type {
  DesktopKnowledgeDetail,
  DesktopKnowledgePage,
} from "../../../knowledge-contracts.js";
import type { DesktopResult } from "../../../contracts.js";
import type { FolioLoomDesktopApi } from "../../../preload/folioloom-api.js";
import { KnowledgeWorkbench } from "./KnowledgeWorkbench.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function ok<T>(value: T): DesktopResult<T> {
  return { ok: true, value };
}

function fail<T = never>(code: string, message: string): DesktopResult<T> {
  return {
    ok: false,
    error: { code, message, retryable: code.includes("CONFLICT") },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

type KnowledgeItem = DesktopKnowledgePage["items"][number];

const archon: KnowledgeItem = {
  id: "term-archon",
  normalizedSubject: "archon",
  displayName: "Archon",
  objectType: "term",
  kind: "term_sense",
  revision: 3,
  scopeRevision: { scope: "book", revision: 3 },
  status: "active",
  origin: "manual",
  scope: "book",
};

const piaton: KnowledgeItem = {
  id: "entity-piaton",
  normalizedSubject: "piaton",
  displayName: "皮亚顿",
  objectType: "entity",
  kind: "character",
  revision: 2,
  scopeRevision: { scope: "book", revision: 2 },
  status: "active",
  origin: "model",
  scope: "book",
};

function detail(
  item: KnowledgeItem = archon,
  fields: DesktopKnowledgeDetail["fields"] = {
    sourceForm: "Archon",
    target: "执政官",
    alternatives: ["大人"],
    policy: "叙述中使用职衔，面称按语境处理",
    note: "",
  },
): DesktopKnowledgeDetail {
  return {
    item,
    fields,
    evidence: [
      {
        kind: "source_block",
        globalIndex: 42,
        sourceText: "Archon, I beg you.",
      },
    ],
    history: [
      {
        revision: item.revision,
        revisionId: `${item.id}-r${item.revision}`,
        origin: item.origin,
        scope: item.scope,
        createdAt: "2026-07-23T12:00:00.000Z",
      },
      {
        revision: 1,
        revisionId: `${item.id}-r1`,
        origin: "model",
        scope: "book",
        createdAt: "2026-07-20T12:00:00.000Z",
      },
    ],
    impacts: [
      { blockId: "block-0042", globalIndex: 42, status: "pending" },
    ],
    relations: [
      { subjectId: item.id, predicate: "效忠", objectId: "entity-autarch" },
    ],
  };
}

function page(
  items: DesktopKnowledgePage["items"] = [archon, piaton],
  nextCursor?: string,
): DesktopKnowledgePage {
  return {
    generation: 7,
    snapshotId: "snapshot-7",
    items,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

function api(overrides: Partial<FolioLoomDesktopApi> = {}): FolioLoomDesktopApi {
  const unavailable = async () => fail("UNAVAILABLE", "暂不可用");
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
    listKnowledge: vi.fn().mockResolvedValue(ok(page())),
    getKnowledgeDetail: vi.fn().mockImplementation(async (id: string) =>
      id === piaton.id
        ? ok(detail(piaton, {
          canonicalName: "Piaton",
          targetName: "皮亚顿",
          entityType: "人物",
          description: "与提丰共用一具身体。",
        }))
        : ok(detail())),
    mutateKnowledge: vi.fn().mockResolvedValue(ok({
      generation: 8,
      snapshotId: "snapshot-8",
      detail: detail({ ...archon, revision: 4 }, {
        ...detail().fields,
        target: "阁下",
      }),
    })),
    promoteKnowledgeToGlobal: vi.fn().mockResolvedValue(ok({
      generation: 8,
      snapshotId: "snapshot-8",
      detail: detail(),
    })),
    listGlobalKnowledge: vi.fn().mockResolvedValue(ok({
      items: [
        {
          recordId: "global-archon",
          revision: 3,
          objectType: "term",
          normalizedSubject: "archon",
          displayValue: "Archon → 阁下",
        },
      ],
    })),
    attachGlobalKnowledge: vi.fn().mockResolvedValue(ok({
      generation: 8,
      snapshotId: "snapshot-8",
      detail: detail(),
    })),
    getKnowledgeDiagnostics: vi.fn().mockResolvedValue(ok({
      schemaVersion: 3,
      knowledgeGeneration: 7,
      countsByType: { term: 1, entity: 1 },
      countsByStatus: { active: 2 },
      pendingImpacts: 1,
      latestMigration: "lossless-book-schema-v3",
      advanced: {
        tables: [{ name: "knowledge_records", rowCount: 2 }],
        recentEvents: [{ kind: "manual_update", createdAt: "2026-07-23" }],
        integrityCheck: "ok",
      },
    })),
    chooseKnowledgeImport: vi.fn().mockResolvedValue(fail("DESKTOP_SELECTION_CANCELLED", "已取消选择")),
    inspectKnowledgeImport: vi.fn().mockResolvedValue(fail("KNOWLEDGE_IMPORT_NOT_FOUND", "没有待导入文件")),
    confirmKnowledgeImportEncoding: vi.fn().mockResolvedValue(fail("KNOWLEDGE_IMPORT_NOT_FOUND", "没有待导入文件")),
    listStagedKnowledgeImports: vi.fn().mockResolvedValue(ok([])),
    getStagedKnowledgeImport: vi.fn().mockResolvedValue(fail("KNOWLEDGE_IMPORT_BATCH_NOT_FOUND", "没有导入批次")),
    suggestKnowledgeImport: vi.fn().mockResolvedValue(fail("KNOWLEDGE_IMPORT_NOT_FOUND", "没有待导入文件")),
    stageKnowledgeImport: vi.fn().mockResolvedValue(fail("KNOWLEDGE_IMPORT_NOT_FOUND", "没有待导入文件")),
    decideKnowledgeImport: vi.fn().mockResolvedValue(fail("KNOWLEDGE_IMPORT_BATCH_NOT_FOUND", "没有导入批次")),
    commitKnowledgeImport: vi.fn().mockResolvedValue(fail("KNOWLEDGE_IMPORT_BATCH_NOT_FOUND", "没有导入批次")),
    rollbackKnowledgeImport: vi.fn().mockResolvedValue(fail("KNOWLEDGE_IMPORT_BATCH_NOT_FOUND", "没有导入批次")),
    cancelKnowledgeImportOperation: vi.fn().mockResolvedValue(ok(undefined)),
    cancelPendingKnowledgeImport: vi.fn().mockResolvedValue(ok(undefined)),
    discardStagedKnowledgeImport: vi.fn().mockResolvedValue(ok(undefined)),
    chooseProject: unavailable,
    chooseStore: unavailable,
    refreshProject: unavailable,
    selectRun: unavailable,
    runDoctor: unavailable,
    ...overrides,
  };
}

describe("KnowledgeWorkbench", () => {
  it("loads another cursor page without replacing the selected detail", async () => {
    const user = userEvent.setup();
    const listKnowledge = vi.fn()
      .mockResolvedValueOnce(ok(page([archon], "cursor-2")))
      .mockResolvedValueOnce(ok(page([piaton])));
    render(<KnowledgeWorkbench api={api({ listKnowledge })} />);

    await user.click(await screen.findByRole("row", { name: /Archon/u }));
    expect(await screen.findByRole("heading", { name: "Archon" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "加载更多" }));

    expect(await screen.findByRole("row", { name: /皮亚顿/u })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Archon" })).toBeTruthy();
    expect(listKnowledge).toHaveBeenLastCalledWith(expect.objectContaining({
      cursor: "cursor-2",
      limit: 50,
    }));
  });

  it("does not let a late search response replace newer filters", async () => {
    const user = userEvent.setup();
    const firstSearch = deferred<DesktopResult<DesktopKnowledgePage>>();
    const listKnowledge = vi.fn()
      .mockResolvedValueOnce(ok(page()))
      .mockImplementationOnce(() => firstSearch.promise)
      .mockResolvedValueOnce(ok(page([piaton])));
    render(<KnowledgeWorkbench api={api({ listKnowledge })} />);
    await screen.findByRole("row", { name: /Archon/u });

    const search = screen.getByRole("searchbox", { name: "搜索知识" });
    await user.type(search, "a");
    await user.type(search, "b");
    expect(await screen.findByRole("row", { name: /皮亚顿/u })).toBeTruthy();

    firstSearch.resolve(ok(page([archon])));
    await waitFor(() => {
      expect(screen.queryByRole("row", { name: /Archon/u })).toBeNull();
    });
  });

  it("saves only changed term fields and refreshes the generation", async () => {
    const user = userEvent.setup();
    const mutateKnowledge = vi.fn().mockResolvedValue(ok({
      generation: 8,
      snapshotId: "snapshot-8",
      detail: detail({ ...archon, revision: 4 }, {
        ...detail().fields,
        target: "阁下",
      }),
    }));
    render(<KnowledgeWorkbench api={api({ mutateKnowledge })} />);

    await user.click(await screen.findByRole("row", { name: /Archon/u }));
    const target = await screen.findByLabelText("首选译法");
    await user.clear(target);
    await user.type(target, "阁下");
    await user.click(screen.getByRole("button", { name: "保存修改" }));

    expect(await screen.findByText("修改已保存")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Archon" })).toBeTruthy();
    expect(mutateKnowledge).toHaveBeenCalledWith(expect.objectContaining({
      requestId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
      ),
      expectedGeneration: 7,
      expectedSnapshotId: "snapshot-7",
      command: expect.objectContaining({
        type: "upsert",
        objectType: "term",
        expectedRevision: 3,
        fieldPatch: { target: "阁下" },
        ownedFields: ["/target"],
      }),
    }));
  });

  it("keeps a draft after an optimistic-lock conflict", async () => {
    const user = userEvent.setup();
    const mutateKnowledge = vi.fn().mockResolvedValue(
      fail("KNOWLEDGE_GENERATION_CONFLICT", "stale"),
    );
    render(<KnowledgeWorkbench api={api({ mutateKnowledge })} />);

    await user.click(await screen.findByRole("row", { name: /Archon/u }));
    const target = await screen.findByLabelText("首选译法");
    await user.clear(target);
    await user.type(target, "阁下");
    await user.click(screen.getByRole("button", { name: "保存修改" }));

    expect(await screen.findByText("这条知识已在其他位置更新")).toBeTruthy();
    expect((screen.getByLabelText("首选译法") as HTMLInputElement).value).toBe("阁下");
    expect(screen.getByRole("button", { name: "重新载入" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制草稿" })).toBeTruthy();
  });

  it("uses bounded semantic controls instead of accepting arbitrary term policy text", async () => {
    const user = userEvent.setup();
    const policyDetail = detail(archon, {
      sourceForm: "Archon",
      target: "执政官",
      alternatives: [],
      policy: "preferred",
    });
    const getKnowledgeDetail = vi.fn().mockResolvedValue(ok(policyDetail));
    const mutateKnowledge = vi.fn().mockResolvedValue(ok({
      generation: 8,
      snapshotId: "snapshot-8",
      detail: {
        ...policyDetail,
        item: { ...archon, revision: 4 },
        fields: { ...policyDetail.fields, policy: "contextual" },
      },
    }));
    render(<KnowledgeWorkbench api={api({ getKnowledgeDetail, mutateKnowledge })} />);

    await user.click(await screen.findByRole("row", { name: /Archon/u }));
    const policy = await screen.findByLabelText("使用规则");
    expect(policy.tagName).toBe("SELECT");
    await user.selectOptions(policy, "contextual");
    await user.click(screen.getByRole("button", { name: "保存修改" }));

    expect(mutateKnowledge).toHaveBeenCalledWith(expect.objectContaining({
      command: expect.objectContaining({ fieldPatch: { policy: "contextual" } }),
    }));
  });

  it("does not submit a narrative memory with only one position boundary", async () => {
    const user = userEvent.setup();
    const memory = {
      ...archon,
      id: "memory-piaton",
      normalizedSubject: "皮亚顿控制心跳",
      displayName: "皮亚顿控制心跳",
      objectType: "memory",
      kind: "narrative_memory",
    } as const satisfies KnowledgeItem;
    const getKnowledgeDetail = vi.fn().mockResolvedValue(ok(detail(memory, {
      summary: "皮亚顿仍控制这具身体的心跳。",
      startBlockId: "block-100",
      endBlockId: "block-180",
      entities: ["entity-piaton", "entity-typhon"],
    })));
    const mutateKnowledge = vi.fn();
    render(<KnowledgeWorkbench api={api({
      listKnowledge: vi.fn().mockResolvedValue(ok(page([memory]))),
      getKnowledgeDetail,
      mutateKnowledge,
    })} />);

    await user.click(await screen.findByRole("row", { name: /皮亚顿控制心跳/u }));
    await user.clear(await screen.findByLabelText("失效点"));
    await user.type(screen.getByLabelText("记忆内容"), " 这是新增说明");

    expect(await screen.findByText("生效起点和失效点必须同时填写")).toBeTruthy();
    expect((screen.getByRole("button", { name: "保存修改" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mutateKnowledge).not.toHaveBeenCalled();
  });

  it("rolls back by creating a new revision and keeps the drawer open", async () => {
    const user = userEvent.setup();
    const mutateKnowledge = vi.fn().mockResolvedValue(ok({
      generation: 8,
      snapshotId: "snapshot-8",
      detail: detail({ ...archon, revision: 4 }),
    }));
    render(<KnowledgeWorkbench api={api({ mutateKnowledge })} />);

    await user.click(await screen.findByRole("row", { name: /Archon/u }));
    await user.click(await screen.findByRole("button", { name: "恢复版本 1" }));

    expect(mutateKnowledge).toHaveBeenCalledWith(expect.objectContaining({
      command: expect.objectContaining({
        type: "rollback",
        expectedRevision: 3,
        targetRevision: 1,
      }),
    }));
    expect(await screen.findByText("已创建新的恢复修订")).toBeTruthy();
  });

  it("promotes only terms or styles and attaches an explicit global revision", async () => {
    const user = userEvent.setup();
    const attachGlobalKnowledge = vi.fn().mockResolvedValue(ok({
      generation: 8,
      snapshotId: "snapshot-8",
      detail: detail(),
    }));
    const desktopApi = api({ attachGlobalKnowledge });
    render(<KnowledgeWorkbench api={desktopApi} />);

    await user.click(await screen.findByRole("row", { name: /Archon/u }));
    expect(await screen.findByRole("button", { name: "保存为通用术语" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "添加通用术语" }));
    const option = await screen.findByRole("checkbox", {
      name: /Archon → 阁下.*revision 3/u,
    });
    await user.click(option);
    await user.click(screen.getByRole("button", { name: "添加到当前书" }));

    expect(attachGlobalKnowledge).toHaveBeenCalledWith(expect.objectContaining({
      recordId: "global-archon",
      revision: 3,
      expectedGeneration: 7,
      expectedSnapshotId: "snapshot-7",
    }));
  });

  it("shows bounded relation, evidence, impact, history, and read-only diagnostics", async () => {
    const user = userEvent.setup();
    render(<KnowledgeWorkbench api={api()} />);

    await user.click(await screen.findByRole("row", { name: /Archon/u }));
    expect(await screen.findByText("Archon, I beg you.")).toBeTruthy();
    expect(screen.getAllByText("entity-autarch")).toHaveLength(2);
    expect(screen.getByText(/block-0042/u)).toBeTruthy();
    expect(screen.getByText(/版本 1/u)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "只读诊断" }));
    expect(await screen.findByText("Schema v3")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /SQL/u })).toBeNull();
    await user.click(screen.getByRole("button", { name: "高级只读诊断" }));
    expect(await screen.findByText("knowledge_records")).toBeTruthy();
    expect(screen.getByText("完整性：ok")).toBeTruthy();
  });

  it("offers a future import entry only when a callback is provided", async () => {
    const user = userEvent.setup();
    const onImportKnowledge = vi.fn();
    render(
      <KnowledgeWorkbench
        api={api()}
        onImportKnowledge={onImportKnowledge}
        importSlot={<p>导入向导占位</p>}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "导入知识" }));
    expect(onImportKnowledge).toHaveBeenCalledTimes(1);
    expect(screen.getByText("导入向导占位")).toBeTruthy();
  });

  it("opens the built-in import wizard when no external slot is supplied", async () => {
    const user = userEvent.setup();
    const listStagedKnowledgeImports = vi.fn().mockResolvedValue(ok([]));
    render(<KnowledgeWorkbench api={api({ listStagedKnowledgeImports })} />);

    await user.click(await screen.findByRole("button", { name: "导入知识" }));

    expect(await screen.findByRole("dialog", {
      name: "导入已有术语与知识",
    })).toBeTruthy();
    expect(listStagedKnowledgeImports).toHaveBeenCalledTimes(1);
  });

  it("keeps the completed import visible while refreshing the workbench", async () => {
    const user = userEvent.setup();
    const refreshed = deferred<DesktopResult<DesktopKnowledgePage>>();
    const listKnowledge = vi.fn()
      .mockResolvedValueOnce(ok(page()))
      .mockImplementationOnce(() => refreshed.promise);
    const desktopApi = api({
      listKnowledge,
      chooseKnowledgeImport: vi.fn().mockResolvedValue(ok({
        pendingImportId: "0f6daf3e-acde-4ca7-a1a2-7e15964d1da3",
        fileName: "terms.json",
        format: "json",
      })),
      inspectKnowledgeImport: vi.fn().mockResolvedValue(ok({
        status: "ready",
        inspection: {
          pendingImportId: "0f6daf3e-acde-4ca7-a1a2-7e15964d1da3",
          fileName: "terms.json",
          format: "json",
          recordPaths: [{ id: "records", label: "$.records", shape: "records" }],
          sheets: [],
          sample: [{
            ordinal: 1,
            location: "$.records[0]",
            values: { source: "Archon", target: "执政官" },
          }],
        },
      })),
      suggestKnowledgeImport: vi.fn().mockResolvedValue(ok({
        selection: {
          recordPathId: "records",
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
        },
        reasons: {},
        mappingHash: "a".repeat(64),
      })),
      stageKnowledgeImport: vi.fn().mockResolvedValue(ok({
        batchId: "214f314d-091a-437b-8295-f9a836de03df",
        counts: { ready: 1, merge: 0, conflict: 0, invalid: 0, skipped: 0 },
        unresolved: 0,
        rows: [],
      })),
      commitKnowledgeImport: vi.fn().mockResolvedValue(ok({
        batchId: "214f314d-091a-437b-8295-f9a836de03df",
        added: 1,
        updated: 0,
        merged: 0,
        skipped: 0,
        invalid: 0,
        committed: 1,
        generation: 8,
        snapshotId: "snapshot-8",
      })),
    });
    render(<KnowledgeWorkbench api={desktopApi} />);

    await user.click(await screen.findByRole("button", { name: "导入知识" }));
    await user.click(await screen.findByRole("button", { name: "选择文件" }));
    await user.click(await screen.findByRole("button", { name: "确认导入" }));

    await waitFor(() => expect(listKnowledge).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("导入完成")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "导入已有术语与知识" })).toBeTruthy();
    refreshed.resolve(ok({
      ...page(),
      generation: 8,
      snapshotId: "snapshot-8",
    }));
    await waitFor(() => expect(screen.getByText("导入完成")).toBeTruthy());
  });

  it("labels every knowledge row with enough context for keyboard selection", async () => {
    render(<KnowledgeWorkbench api={api()} />);
    const table = await screen.findByRole("table", { name: "知识条目" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[1] as HTMLElement).getByText("Archon")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("皮亚顿")).toBeTruthy();
  });
});
