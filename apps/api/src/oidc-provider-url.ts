const MAXIMUM_PROVIDER_URL_BYTES = 2_048;
const FORBIDDEN_RAW_URL_CHARACTER = /[\s\\]/u;

function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Parses one exact default-port HTTPS provider URL. Root URLs may retain the interoperable spelling
 * without a trailing slash; every other spelling must already match URL's canonical form.
 */
export function parseExactOidcProviderUrl(value: unknown, allowQuery: boolean): URL | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAXIMUM_PROVIDER_URL_BYTES ||
    FORBIDDEN_RAW_URL_CHARACTER.test(value) ||
    containsAsciiControl(value)
  ) {
    return null;
  }

  try {
    const parsed = new URL(value);
    const hasBareQueryDelimiter = parsed.search.length === 0 && value.includes("?");
    const hasBareFragmentDelimiter = parsed.hash.length === 0 && value.includes("#");
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname.length === 0 ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.port.length > 0 ||
      parsed.hash.length > 0 ||
      hasBareQueryDelimiter ||
      hasBareFragmentDelimiter ||
      (!allowQuery && parsed.search.length > 0)
    ) {
      return null;
    }
    if (parsed.href !== value && !(parsed.pathname === "/" && parsed.href === `${value}/`)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
