function databaseErrorProperty(
  error: unknown,
  property: "code" | "constraint_name",
): string | undefined {
  let current = error;
  const seen = new Set<object>();
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (typeof record[property] === "string") return record[property];
    current = record.cause;
  }
  return undefined;
}

export function databaseErrorCode(error: unknown): string | undefined {
  let current = error;
  let fallback: string | undefined;
  let sqlState: string | undefined;
  const seen = new Set<object>();
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (typeof record.code === "string") {
      fallback ??= record.code;
      // Adapter wrappers sometimes expose a generic outer code. Prefer the
      // deepest PostgreSQL SQLSTATE in the cause chain when one is present.
      if (/^[0-9A-Z]{5}$/u.test(record.code)) sqlState = record.code;
    }
    current = record.cause;
  }
  return sqlState ?? fallback;
}

export function databaseErrorConstraint(error: unknown): string | undefined {
  return databaseErrorProperty(error, "constraint_name");
}
