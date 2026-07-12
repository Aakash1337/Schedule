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
  return databaseErrorProperty(error, "code");
}

export function databaseErrorConstraint(error: unknown): string | undefined {
  return databaseErrorProperty(error, "constraint_name");
}
