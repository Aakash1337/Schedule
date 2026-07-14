const expectedSourceDatabase = "/schedule";

export function requireLocalHermesVerificationDatabaseUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Hermes adapter verification requires a valid local PostgreSQL URL.");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.hostname !== "127.0.0.1" ||
    url.pathname !== expectedSourceDatabase ||
    url.username.length === 0 ||
    url.password.length === 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(
      "Hermes adapter verification is restricted to the disposable loopback Schedule database.",
    );
  }
  return url.toString();
}
