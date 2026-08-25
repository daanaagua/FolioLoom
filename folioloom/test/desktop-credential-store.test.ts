import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DesktopCredentialStore,
  type DesktopSecretBox,
} from "../src/desktop/desktop-credential-store.js";

function secretBox(available = true): DesktopSecretBox {
  return {
    isEncryptionAvailable: () => available,
    encryptString(value) {
      return Buffer.from(`encrypted:${value}`, "utf8");
    },
    decryptString(value) {
      const plaintext = value.toString("utf8");
      if (!plaintext.startsWith("encrypted:")) {
        throw new Error("ciphertext cannot be decrypted");
      }
      return plaintext.slice("encrypted:".length);
    },
  };
}

test("credential store persists only safeStorage ciphertext and never exposes a saved key in its snapshot", () => {
  const directory = mkdtempSync(join(tmpdir(), "folioloom-credentials-"));
  const path = join(directory, "credentials.json");
  const apiKey = "sk-desktop-secret-123";
  try {
    const store = new DesktopCredentialStore({ path, secretBox: secretBox() });
    assert.equal(store.save("deepseek", apiKey).persistence, "encrypted");

    const raw = readFileSync(path, "utf8");
    const persisted = JSON.parse(raw) as { schema: string; credentials: Record<string, string> };
    assert.equal(persisted.schema, "folioloom-desktop-credentials-1");
    assert.equal(typeof persisted.credentials.deepseek, "string");
    assert.doesNotMatch(raw, new RegExp(apiKey));
    assert.doesNotMatch(JSON.stringify(store.snapshot()), new RegExp(apiKey));

    const restored = new DesktopCredentialStore({ path, secretBox: secretBox() });
    assert.deepEqual(restored.read("deepseek"), {
      status: "available",
      credential: apiKey,
      persistence: "encrypted",
    });

    restored.forget("deepseek");
    assert.equal(restored.read("deepseek").status, "missing");
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("credential store uses an explicit in-memory session when safeStorage is unavailable", () => {
  const directory = mkdtempSync(join(tmpdir(), "folioloom-credentials-"));
  const path = join(directory, "credentials.json");
  const apiKey = "session-only-secret";
  try {
    const store = new DesktopCredentialStore({ path, secretBox: secretBox(false) });
    assert.equal(store.save("openai", apiKey).persistence, "session");
    assert.equal(existsSync(path), false);
    assert.deepEqual(store.read("openai"), {
      status: "available",
      credential: apiKey,
      persistence: "session",
    });
    const snapshot = store.snapshot();
    assert.equal(snapshot.persistence, "session");
    assert.match(snapshot.message, /关闭应用后需要重新输入/);
    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(apiKey));

    const restarted = new DesktopCredentialStore({ path, secretBox: secretBox(false) });
    assert.equal(restarted.read("openai").status, "missing");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("credential store never forwards a secret from a failing safeStorage implementation", () => {
  const directory = mkdtempSync(join(tmpdir(), "folioloom-credentials-"));
  const path = join(directory, "credentials.json");
  const apiKey = "safe-storage-failure-secret";
  try {
    const store = new DesktopCredentialStore({
      path,
      secretBox: {
        isEncryptionAvailable: () => true,
        encryptString(value) {
          throw new Error(`safeStorage rejected ${value}`);
        },
        decryptString: () => "",
      },
    });
    assert.throws(
      () => store.save("deepseek", apiKey),
      (error: unknown) => error instanceof Error && !error.message.includes(apiKey),
    );
    assert.equal(existsSync(path), false);
    assert.equal(store.read("deepseek").status, "missing");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("credential store marks one corrupted ciphertext for re-entry without deleting other providers", () => {
  const directory = mkdtempSync(join(tmpdir(), "folioloom-credentials-"));
  const path = join(directory, "credentials.json");
  try {
    writeFileSync(path, JSON.stringify({
      schema: "folioloom-desktop-credentials-1",
      credentials: {
        deepseek: Buffer.from("corrupted", "utf8").toString("base64"),
        openai: Buffer.from("encrypted:other-key", "utf8").toString("base64"),
      },
    }), "utf8");
    const store = new DesktopCredentialStore({ path, secretBox: secretBox() });

    assert.equal(store.read("deepseek").status, "needs_reentry");
    assert.deepEqual(store.read("openai"), {
      status: "available",
      credential: "other-key",
      persistence: "encrypted",
    });
    const raw = JSON.parse(readFileSync(path, "utf8")) as { credentials: Record<string, string> };
    assert.equal(typeof raw.credentials.deepseek, "string");
    assert.equal(typeof raw.credentials.openai, "string");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
