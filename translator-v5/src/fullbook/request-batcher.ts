import { createHash } from "node:crypto";

import type {
  PhysicalRequestPlan,
  RequestBatchOptions,
  RequestBatchWindow,
} from "./types.js";

export type {
  PhysicalRequestPlan,
  RequestBatchOptions,
  RequestBatchWindow,
} from "./types.js";

const REQUEST_PROTOCOL_VERSION = "v5-physical-request-1";

export class RequestBatchError extends Error {
  readonly code = "REQUEST_SOURCE_TOKENS_EXCEEDED" as const;

  constructor(windowId: string, sourceTokens: number, maxRequestTokens: number) {
    super(
      `REQUEST_SOURCE_TOKENS_EXCEEDED: logical window ${windowId} has `
      + `${sourceTokens} source tokens, max ${maxRequestTokens}`,
    );
    this.name = "RequestBatchError";
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function requestId(windows: readonly RequestBatchWindow[]): string {
  const hash = createHash("sha256");
  hash.update(REQUEST_PROTOCOL_VERSION);
  for (const window of windows) {
    hash.update("\0");
    hash.update(String(window.ordinal));
    hash.update("\0");
    hash.update(window.windowId);
  }
  return `request-${hash.digest("hex").slice(0, 20)}`;
}

function isPendingTiny(
  window: RequestBatchWindow,
  tinyWindowTokens: number,
): boolean {
  return (window.status ?? "pending") === "pending"
    && window.sourceTokens < tinyWindowTokens;
}

function physicalRequest(
  windows: RequestBatchWindow[],
): PhysicalRequestPlan {
  return {
    requestId: requestId(windows),
    windows,
    sourceTokens: windows.reduce(
      (total, window) => total + window.sourceTokens,
      0,
    ),
  };
}

export function packPhysicalRequests(
  input: readonly RequestBatchWindow[],
  options: RequestBatchOptions,
): PhysicalRequestPlan[] {
  const tinyWindowTokens = positiveInteger(
    options.tinyWindowTokens,
    "tinyWindowTokens",
  );
  const maxRequestTokens = positiveInteger(
    options.maxRequestTokens,
    "maxRequestTokens",
  );
  const maxWindowsPerRequest = positiveInteger(
    options.maxWindowsPerRequest,
    "maxWindowsPerRequest",
  );
  const windows = [...input].sort((left, right) =>
    left.ordinal - right.ordinal || left.windowId.localeCompare(right.windowId));
  for (const window of windows) {
    if (window.sourceTokens > maxRequestTokens) {
      throw new RequestBatchError(
        window.windowId,
        window.sourceTokens,
        maxRequestTokens,
      );
    }
  }
  const requests: PhysicalRequestPlan[] = [];
  let current: RequestBatchWindow[] = [];
  let currentTokens = 0;

  const flush = (): void => {
    if (current.length > 0) {
      requests.push(physicalRequest(current));
      current = [];
      currentTokens = 0;
    }
  };

  for (const window of windows) {
    const previous = current.at(-1);
    const mayJoin = previous !== undefined
      && isPendingTiny(previous, tinyWindowTokens)
      && isPendingTiny(window, tinyWindowTokens)
      && window.ordinal === previous.ordinal + 1
      && current.length < maxWindowsPerRequest
      && currentTokens + window.sourceTokens <= maxRequestTokens;
    if (previous !== undefined && !mayJoin) {
      flush();
    }
    current.push(window);
    currentTokens += window.sourceTokens;
  }
  flush();
  return requests;
}
