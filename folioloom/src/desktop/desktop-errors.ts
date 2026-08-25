import type { DesktopError, DesktopResult } from "./contracts.js";
import { SourceIntegrityError } from "../source/source-ledger.js";
import { redactSecrets } from "./secret-redaction.js";

export class DesktopInputError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DesktopInputError";
    this.code = code;
  }
}

interface PublicErrorDefinition {
  message: string;
  nextAction?: string;
  retryable: boolean;
}

const PUBLIC_ERRORS: Readonly<Record<string, PublicErrorDefinition>> = Object.freeze({
  AUTH_INVALID: {
    message: "API Key 无效或已失效",
    nextAction: "请检查密钥是否完整，并确认它属于当前选择的服务商。",
    retryable: false,
  },
  MODEL_NOT_FOUND: {
    message: "没有找到这个模型",
    nextAction: "请核对模型 ID，或重新获取模型列表。",
    retryable: false,
  },
  DEEPSEEK_MODEL_RETIRED: {
    message: "DeepSeek 旧模型路由已经停用",
    nextAction: "请选择 deepseek-v4-flash 或 deepseek-v4-pro 后重新测试连接。",
    retryable: false,
  },
  QUOTA_EXHAUSTED: {
    message: "账户额度不足",
    nextAction: "请在服务商控制台检查余额或配额。",
    retryable: false,
  },
  RATE_LIMITED: {
    message: "请求过于频繁",
    nextAction: "请稍后再试，或在服务商控制台检查限流设置。",
    retryable: true,
  },
  PROVIDER_BUSY: {
    message: "模型服务暂时繁忙",
    nextAction: "请稍后重试。",
    retryable: true,
  },
  TOOL_CALL_UNSUPPORTED: {
    message: "这个模型不能完成 FolioLoom 所需的工具调用",
    nextAction: "请换用支持工具调用的模型。",
    retryable: false,
  },
  REASONING_CONTINUITY_UNSUPPORTED: {
    message: "这个模型不能稳定继续多轮推理",
    nextAction: "请换用兼容性检查通过的模型。",
    retryable: false,
  },
  REQUEST_TIMEOUT: {
    message: "连接模型服务超时",
    nextAction: "请检查网络后重试。",
    retryable: true,
  },
  ENCODING_AMBIGUOUS: {
    message: "无法确定书稿的文字编码",
    nextAction: "请重新选择正确的编码后导入。",
    retryable: false,
  },
  SOURCE_ENCODING_AMBIGUOUS: {
    message: "无法确定书稿的文字编码",
    nextAction: "请从程序给出的候选编码中选择一种，或重新选择书稿。",
    retryable: false,
  },
  SOURCE_ENCODING_UNSUPPORTED: {
    message: "无法读取这份书稿的文字编码",
    nextAction: "请先把书稿转换为 UTF-8，或选择 Shift-JIS、EUC-JP、EUC-KR、CP949、Windows-1252 后重试。",
    retryable: false,
  },
  DESKTOP_TRIAL_ALREADY_RUNNING: {
    message: "这本书正在试译",
    nextAction: "请等待当前试译结束，或先取消它。",
    retryable: true,
  },
  DESKTOP_TRIAL_MODEL_NOT_READY: {
    message: "模型还没有准备好",
    nextAction: "请先完成模型连接测试。",
    retryable: false,
  },
  DESKTOP_TRIAL_SOURCE_CHANGED: {
    message: "书稿在试译前发生了变化",
    nextAction: "请重新选择书稿后再试。",
    retryable: true,
  },
  DESKTOP_TRIAL_RESULT_UNAVAILABLE: {
    message: "本次试译没有生成可用译文",
    nextAction: "请检查模型设置后重试。",
    retryable: true,
  },
  DESKTOP_TRIAL_CANCELLED: {
    message: "试译已取消",
    retryable: true,
  },
  DESKTOP_FULLBOOK_ATTENTION_RECOVERY_UNAVAILABLE: {
    message: "这些文本块不能再次自动重试",
    nextAction: "请导出隐私诊断文件；现有翻译进度仍保存在本地。",
    retryable: false,
  },
  KNOWLEDGE_IMPORT_ALREADY_COMMITTED: {
    message: "这份知识已经导入",
    nextAction: "如需再次导入，请先撤销上一次导入，或修改文件内容。",
    retryable: false,
  },
  KNOWLEDGE_IMPORT_BATCH_NOT_STAGED: {
    message: "这项暂存导入已经失效",
    nextAction: "请重新选择知识文件开始导入。",
    retryable: false,
  },
});

export function redactDesktopTechnicalDetails(value: string): string {
  const bounded = value.slice(0, 8_000);
  return redactSecrets(bounded)
    .replace(/https?:\/\/[^\s;,?#]+\?[^\s;,]*/giu, (url) => url.slice(0, url.indexOf("?")))
    .slice(0, 2_000);
}

export function ok<T>(value: T): DesktopResult<T> {
  return { ok: true, value };
}

export function fail<T = never>(error: DesktopError): DesktopResult<T> {
  return { ok: false, error };
}

export function toDesktopError(error: unknown): DesktopError {
  if (error instanceof SourceIntegrityError || error instanceof DesktopInputError) {
    return { code: error.code, message: error.message, retryable: false };
  }
  const structured = error !== null && typeof error === "object"
    ? error as { code?: unknown }
    : {};
  const details = redactDesktopTechnicalDetails(error instanceof Error ? error.message : String(error));
  const messageCode = error instanceof Error
    ? error.message.match(/^[A-Z][A-Z0-9_]+/u)?.[0]
    : undefined;
  const code = typeof structured.code === "string" && structured.code.trim().length > 0
    ? structured.code
    : messageCode !== undefined && PUBLIC_ERRORS[messageCode] !== undefined
      ? messageCode
      : "DESKTOP_ERROR";
  const definition = PUBLIC_ERRORS[code];
  if (definition !== undefined) {
    return {
      code,
      message: definition.message,
      ...(definition.nextAction === undefined ? {} : { nextAction: definition.nextAction }),
      retryable: definition.retryable,
      ...(details.length === 0 ? {} : { technicalDetails: details }),
    };
  }
  return {
    code,
    message: "操作没有完成",
    retryable: false,
    ...(details.length === 0 ? {} : { technicalDetails: details }),
  };
}
