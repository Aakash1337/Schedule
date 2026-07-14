function hasConstraint(error: unknown, code: string, constraintName: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code &&
    "constraint_name" in error &&
    (error as { constraint_name?: unknown }).constraint_name === constraintName
  );
}

export async function expectConstraint(
  operation: () => Promise<unknown>,
  code: string,
  constraintName: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (hasConstraint(error, code, constraintName)) return;
    throw error;
  }
  throw new Error(`Expected ${constraintName} to reject the statement.`);
}
