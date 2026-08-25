import type { JSX } from "react";
import { redactSecrets } from "../../../secret-redaction.js";

/**
 * The renderer treats every diagnostic as untrusted.  This deliberately
 * redacts again even though the main process is expected to redact before it
 * crosses the preload boundary.
 */
export function redactTechnicalDetails(value: string): string {
  return redactSecrets(value, "[redacted]");
}

interface TechnicalDetailsProps {
  details?: string;
}

export function TechnicalDetails({ details }: TechnicalDetailsProps): JSX.Element | null {
  if (details === undefined || details.trim() === "") return null;

  return (
    <details className="technical-details">
      <summary>技术详情</summary>
      <pre>{redactTechnicalDetails(details)}</pre>
    </details>
  );
}
