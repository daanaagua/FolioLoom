import { posix, win32 } from "node:path";

export function runtimeProfilePath(userDataPath: string): string {
  if (typeof userDataPath !== "string" || userDataPath.trim().length === 0) {
    throw new TypeError("userDataPath must be non-empty");
  }
  if (/^(?:[A-Za-z]:[\\/]|\\\\)/u.test(userDataPath)
    && win32.isAbsolute(userDataPath)) {
    return win32.join(userDataPath, "runtime-profiles.db");
  }
  if (posix.isAbsolute(userDataPath)) {
    return posix.join(userDataPath, "runtime-profiles.db");
  }
  throw new TypeError("userDataPath must be absolute");
}
