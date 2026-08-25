import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PilotArtifactPayload {
  translation: string;
  bilingual: string;
  audit: unknown;
  metrics: unknown;
}

export interface PilotArtifactPaths {
  translation: string;
  bilingual: string;
  audit: string;
  metrics: string;
}

export class PilotStore {
  constructor(private readonly outputDirectory: string) {}

  write(prefix: string, payload: PilotArtifactPayload): PilotArtifactPaths {
    mkdirSync(this.outputDirectory, { recursive: true });
    const paths = {
      translation: join(this.outputDirectory, `${prefix}_translation.txt`),
      bilingual: join(this.outputDirectory, `${prefix}_bilingual.txt`),
      audit: join(this.outputDirectory, `${prefix}_audit.json`),
      metrics: join(this.outputDirectory, `${prefix}_metrics.json`),
    };
    writeFileSync(paths.translation, payload.translation, "utf8");
    writeFileSync(paths.bilingual, payload.bilingual, "utf8");
    writeFileSync(paths.audit, `${JSON.stringify(payload.audit, null, 2)}\n`, "utf8");
    writeFileSync(paths.metrics, `${JSON.stringify(payload.metrics, null, 2)}\n`, "utf8");
    return paths;
  }
}
