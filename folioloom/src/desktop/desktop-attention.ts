import type { PersistedLosslessWindow } from "../storage/lossless-book-store.js";
import type {
  DesktopAttentionCategory,
  DesktopAttentionItem,
} from "./contracts.js";

interface AttentionCopy {
  readonly category: DesktopAttentionCategory;
  readonly code: string;
  readonly title: string;
  readonly explanation: string;
  readonly nextAction: string;
}

const ATTENTION_COPY: Readonly<Record<DesktopAttentionCategory, AttentionCopy>> = {
  provider: {
    category: "provider",
    code: "ATTENTION_PROVIDER_UNAVAILABLE",
    title: "模型服务或网络没有完成请求",
    explanation: "请求在外部模型服务阶段中断；已经完成的翻译仍保存在本地。",
    nextAction: "先确认网络和模型连接测试通过，再安全重试这些文本块。",
  },
  protocol: {
    category: "protocol",
    code: "ATTENTION_RESPONSE_PROTOCOL",
    title: "模型返回格式不符合要求",
    explanation: "模型没有按完整性协议返回可提交的译文，系统因此拒绝保存不完整结果。",
    nextAction: "保持原模型配置并安全重试；若再次出现，请导出诊断文件。",
  },
  validation: {
    category: "validation",
    code: "ATTENTION_TRANSLATION_VALIDATION",
    title: "译文没有通过完整性校验",
    explanation: "系统发现漏译、结构、术语或边界校验仍不满足严格提交条件。",
    nextAction: "安全重试该文本块；重复失败时导出诊断文件以定位具体校验项。",
  },
  budget: {
    category: "budget",
    code: "ATTENTION_REQUEST_BUDGET",
    title: "请求超过当前安全预算",
    explanation: "文本块、必需上下文或模型调用达到安全上限，系统没有省略内容强行继续。",
    nextAction: "安全重试会重新执行受控拆分；若仍失败，请导出诊断文件。",
  },
  source: {
    category: "source",
    code: "ATTENTION_SOURCE_INVARIANT",
    title: "原文结构或版本需要确认",
    explanation: "系统无法继续证明该位置与已导入原文的结构或版本完全一致。",
    nextAction: "不要修改项目内原文；请先导出诊断文件，再决定是否重新导入书稿。",
  },
  storage: {
    category: "storage",
    code: "ATTENTION_LOCAL_STORAGE",
    title: "本地状态库或磁盘不可用",
    explanation: "项目状态无法安全读取或提交，系统已停止以避免损坏现有进度。",
    nextAction: "确认磁盘空间和文件占用后重启应用；仍失败时导出诊断文件。",
  },
  unknown: {
    category: "unknown",
    code: "ATTENTION_UNCLASSIFIED",
    title: "该文本块未能安全完成",
    explanation: "系统保留了现有进度，但当前公开信息不足以可靠判断失败类别。",
    nextAction: "先安全重试一次；若再次出现，请导出诊断文件。",
  },
};

function classifyFailure(value: string): DesktopAttentionCategory {
  if (/\b(?:sqlite|database|storage|disk)\b|\blocked\b|\bcorrupt(?:ed|ion)?\b|磁盘|数据库|存储/iu.test(value)) {
    return "storage";
  }
  if (/source (?:hash|span|version)|canonical|block membership|source changed|原文(?:结构|版本)|源文(?:哈希|跨度)/iu.test(value)) {
    return "source";
  }
  if (/\b(?:budget|context|token|capacity|oversized|payload too large)\b|request.{0,20}(?:large|limit)|上下文|预算|超限/iu.test(value)) {
    return "budget";
  }
  if (/\b(?:framed|protocol|schema|tool call|malformed)\b|invalid.{0,24}(?:response|submission)|empty.{0,24}translation|返回格式|协议/iu.test(value)) {
    return "protocol";
  }
  if (/\b(?:provider|network|timeout|timed out|rate limit|fetch failed|econn|socket|stream reset)\b|\b429\b|网络|限流|服务波动/iu.test(value)) {
    return "provider";
  }
  if (/\b(?:validation|coverage|boundary|missing block|term usage|source residual|repair|fragment)\b|漏译|校验|边界|术语/iu.test(value)) {
    return "validation";
  }
  return "unknown";
}

function location(window: PersistedLosslessWindow): string {
  const chapter = window.chapterTitle?.trim();
  const block = `第 ${window.ordinal + 1} 个文本块`;
  return chapter === undefined || chapter.length === 0 ? block : `${chapter} · ${block}`;
}

export function projectAttentionItems(
  windows: readonly PersistedLosslessWindow[],
): readonly DesktopAttentionItem[] {
  return windows
    .filter((window) => window.status === "human_required" || window.status === "failed")
    .map((window) => {
      const category = classifyFailure([window.lastError, ...window.warnings].join("\n"));
      const copy = ATTENTION_COPY[category];
      return {
        windowId: window.windowId,
        ordinal: window.ordinal,
        location: location(window),
        sourceChars: window.sourceChars,
        attemptCount: window.attemptCount,
        status: window.status as "human_required" | "failed",
        ...copy,
        retryable: window.status === "human_required",
      };
    });
}
