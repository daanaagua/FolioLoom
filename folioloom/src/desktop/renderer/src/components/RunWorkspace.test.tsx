import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

import type {
  DesktopFullBookRunSnapshot,
  DesktopFullBookSnapshot,
} from "../../../contracts.js";
import { RunWorkspace } from "./RunWorkspace.js";

afterEach(() => cleanup());

function run(
  phase: DesktopFullBookRunSnapshot["phase"],
  overrides: Partial<DesktopFullBookRunSnapshot> = {},
): DesktopFullBookRunSnapshot {
  return {
    runId: "internal-run-id",
    sourceVersion: "internal-source-version",
    modelId: "deepseek-v4",
    mode: "quality",
    optimizationProfile: "balanced",
    phase,
    progress: {
      totalWindows: 100,
      pendingWindows: 67,
      runningWindows: phase === "running" ? 1 : 0,
      stagedWindows: 0,
      completedWindows: 30,
      warningWindows: 2,
      humanRequiredWindows: 0,
      failedWindows: 0,
    },
    canPause: phase === "running",
    canResume: phase === "paused" || phase === "failed",
    canExport: phase === "completed",
    ...overrides,
  };
}

function snapshot(item?: DesktopFullBookRunSnapshot): DesktopFullBookSnapshot {
  return item === undefined ? { runs: [] } : {
    ...(item.phase === "running" ? { activeRunId: item.runId } : {}),
    runs: [item],
  };
}

describe("RunWorkspace", () => {
  it("starts idle books with one of three optimization profiles", async () => {
    const user = userEvent.setup();
    const onStart = vi.fn();
    render(
      <RunWorkspace
        title="示例小说"
        modelReady
        snapshot={snapshot()}
        busy={false}
        onStart={onStart}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onExportDiagnostics={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "翻译运行" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "经济" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "均衡" }).getAttribute("aria-pressed"))
      .toBe("true");
    expect(screen.getByRole("button", { name: "极速" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "开始整本翻译" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "经济" }));
    await user.click(screen.getByRole("button", { name: "开始整本翻译" }));
    expect(onStart).toHaveBeenCalledWith("economy");
  });

  it("shows durable progress and only the action allowed by the current phase", async () => {
    const user = userEvent.setup();
    const onPause = vi.fn();
    const onResume = vi.fn();
    const { rerender } = render(
      <RunWorkspace
        title="示例小说"
        modelReady
        snapshot={snapshot(run("running", {
          scheduler: {
            estimatedRemainingMs: 90_001,
            predictedTokenRange: { lower: 1_000, upper: 1_200 },
            wallTimeDeviationPercent: 5,
            tokenDeviationPercent: -2.5,
            adjustment: "throttled",
          },
        }))}
        busy={false}
        onStart={vi.fn()}
        onPause={onPause}
        onResume={onResume}
        onExportDiagnostics={vi.fn()}
      />,
    );

    expect(screen.getByText("32 / 100 个文本块")).toBeTruthy();
    expect(screen.getByText("2 分钟")).toBeTruthy();
    expect(screen.getByText("1,000–1,200")).toBeTruthy();
    expect(screen.getByText("耗时 +5.0% · Token -2.5%")).toBeTruthy();
    expect(screen.getByText("正在因限流调整并发")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("32");
    expect(screen.queryByRole("button", { name: "开始整本翻译" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "暂停" }));
    expect(onPause).toHaveBeenCalledTimes(1);

    rerender(
      <RunWorkspace
        title="示例小说"
        modelReady
        snapshot={snapshot(run("pausing"))}
        busy={false}
        onStart={vi.fn()}
        onPause={onPause}
        onResume={onResume}
        onExportDiagnostics={vi.fn()}
      />,
    );
    expect(screen.getByText("正在完成当前文本块后暂停")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "继续翻译" })).toBeNull();

    rerender(
      <RunWorkspace
        title="示例小说"
        modelReady
        snapshot={snapshot(run("paused"))}
        busy={false}
        onStart={vi.fn()}
        onPause={onPause}
        onResume={onResume}
        onExportDiagnostics={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "继续翻译" }));
    expect(onResume).toHaveBeenCalledWith("internal-run-id");
    expect(screen.queryByText("internal-run-id")).toBeNull();
    expect(screen.queryByText(/SQLite|v5-book/u)).toBeNull();
  });

  it("keeps progress visible beside attention and retry guidance", () => {
    const onResume = vi.fn();
    const onExportDiagnostics = vi.fn();
    render(
      <RunWorkspace
        title="示例小说"
        modelReady
        snapshot={snapshot(run("needs_attention", {
          progress: {
            ...run("needs_attention").progress,
            humanRequiredWindows: 3,
            failedWindows: 1,
          },
          attention: {
            totalItems: 1,
            truncated: false,
            retryAvailable: false,
            retryAttempted: false,
            items: [{
              windowId: "window-7",
              ordinal: 6,
              location: "第二章 · 第 7 个文本块",
              sourceChars: 3_600,
              attemptCount: 3,
              status: "human_required",
              category: "protocol",
              code: "ATTENTION_RESPONSE_PROTOCOL",
              title: "模型返回格式不符合要求",
              explanation: "模型没有按完整性协议返回可提交的译文，系统因此拒绝保存不完整结果。",
              nextAction: "保持原模型配置并安全重试；若再次出现，请导出诊断文件。",
              retryable: true,
            }],
          },
        }))}
        busy={false}
        error={{
          code: "REQUEST_TIMEOUT",
          message: "网络连接超时",
          nextAction: "检查网络后继续。",
          retryable: true,
          technicalDetails: "socket timeout",
        }}
        onStart={vi.fn()}
        onPause={vi.fn()}
        onResume={onResume}
        onExportDiagnostics={onExportDiagnostics}
      />,
    );
    expect(screen.getByText(/3 个文本块需要人工处理/u)).toBeTruthy();
    expect(screen.getByText("32 / 100 个文本块")).toBeTruthy();
    expect(screen.getByText("检查网络后继续。")).toBeTruthy();
    expect(screen.getByText("socket timeout")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "需要处理的文本块" })).toBeTruthy();
    expect(screen.getByText("第二章 · 第 7 个文本块")).toBeTruthy();
    expect(screen.getByText("模型返回格式不符合要求")).toBeTruthy();
    expect(screen.getByText("ATTENTION_RESPONSE_PROTOCOL")).toBeTruthy();
    expect(screen.queryByText(/internal-source-version/u)).toBeNull();
    expect(screen.queryByRole("button", { name: /安全重试/u })).toBeNull();
    expect(screen.getByText(/存在运行失败的文本块/u)).toBeTruthy();
    screen.getByRole("button", { name: "导出诊断文件" }).click();
    expect(onExportDiagnostics).toHaveBeenCalledTimes(1);
  });

  it("offers one audited retry when every attention item is retryable", async () => {
    const user = userEvent.setup();
    const onResume = vi.fn();
    render(
      <RunWorkspace
        title="示例小说"
        modelReady
        snapshot={snapshot(run("needs_attention", {
          progress: {
            ...run("needs_attention").progress,
            humanRequiredWindows: 1,
          },
          canResume: true,
          attention: {
            totalItems: 1,
            truncated: false,
            retryAvailable: true,
            retryAttempted: false,
            items: [{
              windowId: "window-7",
              ordinal: 6,
              location: "第二章 · 第 7 个文本块",
              sourceChars: 3_600,
              attemptCount: 3,
              status: "human_required",
              category: "provider",
              code: "ATTENTION_PROVIDER_UNAVAILABLE",
              title: "模型服务或网络没有完成请求",
              explanation: "请求在外部模型服务阶段中断；已经完成的翻译仍保存在本地。",
              nextAction: "先确认网络和模型连接测试通过，再安全重试这些文本块。",
              retryable: true,
            }],
          },
        }))}
        busy={false}
        onStart={vi.fn()}
        onPause={vi.fn()}
        onResume={onResume}
        onExportDiagnostics={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "安全重试 1 个文本块" }));
    expect(onResume).toHaveBeenCalledWith("internal-run-id");
  });
});
