import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

import type {
  DesktopExportDestination,
  DesktopExportSnapshot,
} from "../../../contracts.js";
import { ExportWorkspace } from "./ExportWorkspace.js";

afterEach(() => cleanup());

const destination: DesktopExportDestination = {
  destinationId: "opaque-destination",
  displayPath: "D:\\Books\\Exports",
};

const snapshot: DesktopExportSnapshot = {
  candidates: [
    {
      runId: "ready-run",
      modelId: "deepseek-v4",
      status: "ready",
      completedWindows: 100,
      totalWindows: 100,
      blockers: [],
    },
    {
      runId: "blocked-run",
      modelId: "deepseek-v4",
      status: "incomplete",
      completedWindows: 74,
      totalWindows: 100,
      blockers: ["翻译尚未完成"],
    },
  ],
  defaultDestination: destination,
};

describe("ExportWorkspace", () => {
  it("defaults to all reading formats and builds an opaque export request", async () => {
    const user = userEvent.setup();
    const onExport = vi.fn();
    render(
      <ExportWorkspace
        title="示例小说"
        snapshot={snapshot}
        destination={destination}
        busy={false}
        onChooseDirectory={vi.fn()}
        onExport={onExport}
        onOpenDirectory={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "导出" })).toBeTruthy();
    expect(screen.getByText("100 / 100 个文本块")).toBeTruthy();
    for (const label of ["中文 TXT", "双语 TXT", "EPUB"]) {
      expect((screen.getByRole("checkbox", { name: label }) as HTMLInputElement).checked)
        .toBe(true);
    }
    expect(screen.getByText(destination.displayPath)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "导出文件" }));
    expect(onExport).toHaveBeenCalledWith({
      runId: "ready-run",
      destinationId: "opaque-destination",
      formats: ["translation_txt", "bilingual_txt", "epub"],
    });
    expect(screen.queryByText("ready-run")).toBeNull();
  });

  it("disables export with no formats and explains incomplete candidates", async () => {
    const user = userEvent.setup();
    render(
      <ExportWorkspace
        title="示例小说"
        snapshot={snapshot}
        destination={destination}
        busy={false}
        onChooseDirectory={vi.fn()}
        onExport={vi.fn()}
        onOpenDirectory={vi.fn()}
      />,
    );
    for (const label of ["中文 TXT", "双语 TXT", "EPUB"]) {
      await user.click(screen.getByRole("checkbox", { name: label }));
    }
    expect((screen.getByRole("button", { name: "导出文件" }) as HTMLButtonElement).disabled)
      .toBe(true);

    await user.selectOptions(screen.getByRole("combobox", { name: "选择翻译记录" }), "blocked-run");
    expect(screen.getByText("仍有 26 个文本块未完成")).toBeTruthy();
  });

  it("locks actions while exporting and exposes successful files", async () => {
    const onOpen = vi.fn();
    const { rerender } = render(
      <ExportWorkspace
        title="示例小说"
        snapshot={snapshot}
        destination={destination}
        busy
        onChooseDirectory={vi.fn()}
        onExport={vi.fn()}
        onOpenDirectory={onOpen}
      />,
    );
    expect((screen.getByRole("button", { name: "正在导出" }) as HTMLButtonElement).disabled)
      .toBe(true);

    rerender(
      <ExportWorkspace
        title="示例小说"
        snapshot={snapshot}
        destination={destination}
        result={{
          exportId: "export-1",
          runId: "ready-run",
          directory: destination.displayPath,
          files: [
            { format: "translation_txt", fileName: "示例小说-中文.txt" },
            { format: "epub", fileName: "示例小说.epub" },
          ],
        }}
        busy={false}
        onChooseDirectory={vi.fn()}
        onExport={vi.fn()}
        onOpenDirectory={onOpen}
      />,
    );
    expect(screen.getByText("示例小说-中文.txt")).toBeTruthy();
    expect(screen.getByText("示例小说.epub")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "打开文件夹" }));
    expect(onOpen).toHaveBeenCalledWith("export-1");
  });

  it("shows recovery guidance and folded technical details without clearing the destination", () => {
    render(
      <ExportWorkspace
        title="示例小说"
        snapshot={snapshot}
        destination={destination}
        error={{
          code: "DESKTOP_EXPORT_FAILED",
          message: "导出没有完成",
          nextAction: "请检查磁盘空间后重试。",
          retryable: true,
          technicalDetails: "ENOSPC",
        }}
        busy={false}
        onChooseDirectory={vi.fn()}
        onExport={vi.fn()}
        onOpenDirectory={vi.fn()}
      />,
    );
    expect(screen.getByText(destination.displayPath)).toBeTruthy();
    expect(screen.getByText("请检查磁盘空间后重试。")).toBeTruthy();
    expect(screen.getByText("技术详情")).toBeTruthy();
    expect(screen.getByText("ENOSPC")).toBeTruthy();
  });
});
