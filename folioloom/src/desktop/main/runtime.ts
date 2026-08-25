import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const ELECTRON_VITE_PRELOAD_ENTRY = "index.cjs";

export interface DesktopWindowChrome {
  applicationMenu: null;
  windowOptions: {
    autoHideMenuBar: true;
    titleBarStyle: "hidden";
    titleBarOverlay: {
      color: "#0c0f13";
      symbolColor: "#edf2f7";
      height: 42;
    };
  };
}

export interface DesktopRendererTargetOptions {
  isPackaged: boolean;
  rendererFilePath: string;
  rendererUrl: string | undefined;
}

export type DesktopRendererTarget =
  | { kind: "development"; url: string; expectedUrl: string }
  | { kind: "file"; filePath: string; expectedUrl: string };

export interface DesktopNavigationWebContents {
  on(
    event: "will-navigate",
    listener: (event: { preventDefault(): void }, url: string) => void,
  ): unknown;
  setWindowOpenHandler(handler: (details: unknown) => { action: "deny" }): void;
}

export function desktopWindowChrome(): DesktopWindowChrome {
  return {
    applicationMenu: null,
    windowOptions: {
      autoHideMenuBar: true,
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "#0c0f13",
        symbolColor: "#edf2f7",
        height: 42,
      },
    },
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function loopbackRendererUrl(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    const loopback = parsed.hostname === "localhost"
      || parsed.hostname === "127.0.0.1"
      || parsed.hostname === "::1"
      || parsed.hostname === "[::1]";
    return parsed.protocol === "http:" && loopback && parsed.username.length === 0 && parsed.password.length === 0
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}

function matchesExpectedRendererUrl(actualValue: string, expectedValue: string): boolean {
  try {
    const actual = new URL(actualValue);
    const expected = new URL(expectedValue);
    if (expected.protocol === "file:") {
      return actual.href === expected.href;
    }
    return expected.protocol === "http:"
      && loopbackRendererUrl(expected.href) !== undefined
      && actual.href === expected.href;
  } catch {
    return false;
  }
}

export function preloadEntryPath(mainDirectory: string): string {
  return join(mainDirectory, "..", "preload", ELECTRON_VITE_PRELOAD_ENTRY);
}

export function resolveDesktopRendererTarget(
  options: DesktopRendererTargetOptions,
): DesktopRendererTarget {
  const developmentUrl = options.isPackaged
    ? undefined
    : loopbackRendererUrl(options.rendererUrl);
  if (developmentUrl !== undefined) {
    return { kind: "development", url: developmentUrl, expectedUrl: developmentUrl };
  }
  return {
    kind: "file",
    filePath: options.rendererFilePath,
    expectedUrl: pathToFileURL(options.rendererFilePath).href,
  };
}

export function installNavigationGuards(webContents: DesktopNavigationWebContents): void {
  webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

export function isTrustedDesktopIpcEvent(
  event: unknown,
  expectedRendererUrls: ReadonlyMap<number, string>,
): boolean {
  const candidate = record(event);
  const sender = record(candidate?.sender);
  const senderFrame = record(candidate?.senderFrame);
  const senderId = sender?.id;
  const frameUrl = senderFrame?.url;
  if (typeof senderId !== "number" || !Number.isInteger(senderId)
    || typeof frameUrl !== "string" || senderFrame?.parent !== null) {
    return false;
  }
  const expectedUrl = expectedRendererUrls.get(senderId);
  return expectedUrl !== undefined && matchesExpectedRendererUrl(frameUrl, expectedUrl);
}
