export type CompiledQuery =
  | { operation: "mentions"; terms: string[]; limit: number }
  | {
      operation: "cooccurrence";
      terms: string[];
      cues: string[];
      limit: number;
    }
  | {
      operation: "context";
      evidenceIds: string[];
      beforeParagraphs: number;
      afterParagraphs: number;
    }
  | {
      operation: "nearest";
      terms: string[];
      direction: "before" | "after" | "either";
      limit: number;
    };

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("query must be an object");
  }
  return value as Record<string, unknown>;
}

function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new TypeError(`${name} must contain 1 to 20 strings`);
  }
  const result = value.map((item) => {
    if (typeof item !== "string" || item.trim().length === 0 || item.length > 200) {
      throw new TypeError(`${name} contains an invalid string`);
    }
    return item.trim();
  });
  return [...new Set(result)];
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw new TypeError(`unsupported query fields: ${extras.join(", ")}`);
  }
}

/** Converts untrusted agent JSON into the only query shapes the kernel permits. */
export class QueryCompiler {
  compile(value: unknown): CompiledQuery {
    const query = record(value);
    switch (query.operation) {
      case "mentions":
        exactKeys(query, ["operation", "terms", "limit"]);
        return {
          operation: "mentions",
          terms: strings(query.terms, "terms"),
          limit: integer(query.limit, "limit", 1, 100),
        };
      case "cooccurrence":
        exactKeys(query, ["operation", "terms", "cues", "limit"]);
        return {
          operation: "cooccurrence",
          terms: strings(query.terms, "terms"),
          cues: strings(query.cues, "cues"),
          limit: integer(query.limit, "limit", 1, 100),
        };
      case "context":
        exactKeys(query, [
          "operation",
          "evidenceIds",
          "beforeParagraphs",
          "afterParagraphs",
        ]);
        return {
          operation: "context",
          evidenceIds: strings(query.evidenceIds, "evidenceIds"),
          beforeParagraphs: integer(
            query.beforeParagraphs,
            "beforeParagraphs",
            0,
            10,
          ),
          afterParagraphs: integer(
            query.afterParagraphs,
            "afterParagraphs",
            0,
            10,
          ),
        };
      case "nearest": {
        exactKeys(query, ["operation", "terms", "direction", "limit"]);
        if (!(["before", "after", "either"] as const).includes(
          query.direction as "before" | "after" | "either",
        )) {
          throw new TypeError("direction must be before, after, or either");
        }
        return {
          operation: "nearest",
          terms: strings(query.terms, "terms"),
          direction: query.direction as "before" | "after" | "either",
          limit: integer(query.limit, "limit", 1, 100),
        };
      }
      default:
        throw new TypeError(`unsupported query operation: ${String(query.operation)}`);
    }
  }
}
