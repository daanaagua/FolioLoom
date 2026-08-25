import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const CREDENTIALS_SCHEMA = "folioloom-desktop-credentials-1";
const SESSION_ONLY_MESSAGE = "安全存储不可用；关闭应用后需要重新输入 API Key。";
const ENCRYPTED_MESSAGE = "API Key 已由系统安全存储加密保存。";

export type DesktopCredentialPersistence = "encrypted" | "session";

export interface DesktopSecretBox {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface DesktopCredentialStoreOptions {
  path: string;
  secretBox: DesktopSecretBox;
}

export type DesktopCredentialReadResult =
  | {
    status: "available";
    credential: string;
    persistence: DesktopCredentialPersistence;
  }
  | {
    status: "missing";
  }
  | {
    status: "needs_reentry";
    persistence: "encrypted";
  };

export interface DesktopCredentialSaveResult {
  persistence: DesktopCredentialPersistence;
  message: string;
}

export interface DesktopCredentialSummary {
  providerId: string;
  status: Exclude<DesktopCredentialReadResult["status"], "available"> | "available";
  persistence?: DesktopCredentialPersistence;
}

export interface DesktopCredentialStoreSnapshot {
  persistence: DesktopCredentialPersistence;
  message: string;
  credentials: readonly DesktopCredentialSummary[];
}

interface CredentialFile {
  schema: typeof CREDENTIALS_SCHEMA;
  credentials: Record<string, string>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function validatedProviderId(value: string): string {
  const providerId = value.trim();
  if (
    !/^[A-Za-z0-9._-]+$/.test(providerId)
    || providerId === "__proto__"
    || providerId === "constructor"
    || providerId === "prototype"
  ) {
    throw new TypeError("providerId must contain only letters, numbers, dots, underscores, or hyphens");
  }
  return providerId;
}

function validatedCredential(value: string): string {
  const credential = value.trim();
  if (credential.length === 0) {
    throw new TypeError("API Key must be a non-empty string");
  }
  return credential;
}

function credentialFile(value: unknown): CredentialFile | undefined {
  const candidate = asRecord(value);
  const encryptedCredentials = candidate === undefined ? undefined : asRecord(candidate.credentials);
  if (candidate?.schema !== CREDENTIALS_SCHEMA || encryptedCredentials === undefined) {
    return undefined;
  }
  const credentials: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [providerId, ciphertext] of Object.entries(encryptedCredentials)) {
    if (
      /^[A-Za-z0-9._-]+$/.test(providerId)
      && providerId !== "__proto__"
      && providerId !== "constructor"
      && providerId !== "prototype"
      && typeof ciphertext === "string"
      && ciphertext.length > 0
    ) {
      credentials[providerId] = ciphertext;
    }
  }
  return { schema: CREDENTIALS_SCHEMA, credentials };
}

/**
 * Stores secrets in Electron safeStorage ciphertext whenever it is available.
 * The public snapshot intentionally contains only configuration state, never a
 * plaintext credential or ciphertext.
 */
export class DesktopCredentialStore {
  readonly #path: string;
  readonly #secretBox: DesktopSecretBox;
  readonly #sessionCredentials = new Map<string, string>();
  readonly #knownProviderIds = new Set<string>();
  readonly #needsReentry = new Set<string>();

  constructor(options: DesktopCredentialStoreOptions) {
    this.#path = resolve(options.path);
    this.#secretBox = options.secretBox;
  }

  save(providerIdInput: string, credentialInput: string): DesktopCredentialSaveResult {
    const providerId = validatedProviderId(providerIdInput);
    const credential = validatedCredential(credentialInput);
    this.#knownProviderIds.add(providerId);
    this.#needsReentry.delete(providerId);

    if (!this.#encryptionAvailable()) {
      this.#sessionCredentials.set(providerId, credential);
      return { persistence: "session", message: SESSION_ONLY_MESSAGE };
    }

    try {
      const credentials = this.#readEncryptedCredentials();
      const ciphertext = this.#secretBox.encryptString(credential).toString("base64");
      credentials[providerId] = ciphertext;
      this.#writeEncryptedCredentials(credentials);
    } catch {
      throw new Error("无法使用系统安全存储保存 API Key，请检查系统设置后重试。");
    }
    this.#sessionCredentials.set(providerId, credential);
    return { persistence: "encrypted", message: ENCRYPTED_MESSAGE };
  }

  read(providerIdInput: string): DesktopCredentialReadResult {
    const providerId = validatedProviderId(providerIdInput);
    this.#knownProviderIds.add(providerId);

    const sessionCredential = this.#sessionCredentials.get(providerId);
    if (sessionCredential !== undefined) {
      return {
        status: "available",
        credential: sessionCredential,
        persistence: this.#encryptionAvailable() ? "encrypted" : "session",
      };
    }
    if (this.#needsReentry.has(providerId)) {
      return { status: "needs_reentry", persistence: "encrypted" };
    }
    if (!this.#encryptionAvailable()) {
      return { status: "missing" };
    }

    const ciphertext = this.#readEncryptedCredentials()[providerId];
    if (ciphertext === undefined) {
      return { status: "missing" };
    }
    try {
      const credential = validatedCredential(this.#secretBox.decryptString(Buffer.from(ciphertext, "base64")));
      this.#sessionCredentials.set(providerId, credential);
      return { status: "available", credential, persistence: "encrypted" };
    } catch {
      this.#needsReentry.add(providerId);
      return { status: "needs_reentry", persistence: "encrypted" };
    }
  }

  forget(providerIdInput: string): void {
    const providerId = validatedProviderId(providerIdInput);
    this.#knownProviderIds.add(providerId);
    this.#sessionCredentials.delete(providerId);
    this.#needsReentry.delete(providerId);

    const credentials = this.#readEncryptedCredentials();
    if (credentials[providerId] === undefined) {
      return;
    }
    delete credentials[providerId];
    this.#writeEncryptedCredentials(credentials);
  }

  snapshot(): DesktopCredentialStoreSnapshot {
    const providerIds = new Set(this.#knownProviderIds);
    if (this.#encryptionAvailable()) {
      for (const providerId of Object.keys(this.#readEncryptedCredentials())) {
        providerIds.add(providerId);
      }
    }
    const credentials = [...providerIds]
      .sort((left, right) => left.localeCompare(right))
      .map((providerId): DesktopCredentialSummary => {
        const result = this.read(providerId);
        switch (result.status) {
          case "available":
            return {
              providerId,
              status: "available",
              persistence: result.persistence,
            };
          case "needs_reentry":
            return {
              providerId,
              status: "needs_reentry",
              persistence: result.persistence,
            };
          case "missing":
            return { providerId, status: "missing" };
        }
      });
    const persistence = this.#encryptionAvailable() ? "encrypted" : "session";
    return {
      persistence,
      message: persistence === "encrypted" ? ENCRYPTED_MESSAGE : SESSION_ONLY_MESSAGE,
      credentials,
    };
  }

  #encryptionAvailable(): boolean {
    try {
      return this.#secretBox.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  #readEncryptedCredentials(): Record<string, string> {
    try {
      const parsed = credentialFile(JSON.parse(readFileSync(this.#path, "utf8")) as unknown);
      return parsed === undefined ? {} : { ...parsed.credentials };
    } catch {
      return {};
    }
  }

  #writeEncryptedCredentials(credentials: Record<string, string>): void {
    if (Object.keys(credentials).length === 0) {
      rmSync(this.#path, { force: true });
      return;
    }
    const parent = dirname(this.#path);
    mkdirSync(parent, { recursive: true });
    const temporaryPath = `${this.#path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, JSON.stringify({
        schema: CREDENTIALS_SCHEMA,
        credentials,
      } satisfies CredentialFile), "utf8");
      renameSync(temporaryPath, this.#path);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }
}
