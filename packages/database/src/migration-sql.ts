export type MigrationSqlStatement = {
  readonly source: string;
  readonly searchable: string;
  readonly containsDollarQuote: boolean;
  readonly containsUnicodeEscapedIdentifier: boolean;
};

const statementBreakpoint = "--> statement-breakpoint";
const postgresIdentifierContinuationClass = String.raw`A-Za-z0-9_$\u0080-\u{10ffff}`;

function isPostgresIdentifierContinuation(character: string | undefined): boolean {
  const codePoint = character?.codePointAt(0);
  return codePoint !== undefined && (/[A-Za-z0-9_$]/u.test(character ?? "") || codePoint >= 0x80);
}

function isPostgresIdentifierStart(character: string | undefined): boolean {
  const codePoint = character?.codePointAt(0);
  return codePoint !== undefined && (/[A-Za-z_]/u.test(character ?? "") || codePoint >= 0x80);
}

export function postgresKeyword(value: string): string {
  return `(?<![${postgresIdentifierContinuationClass}])${value}(?![${postgresIdentifierContinuationClass}])`;
}

export function postgresPattern(value: string): RegExp {
  return new RegExp(value, "iu");
}

function dollarQuoteDelimiter(source: string, index: number): string | undefined {
  if (source[index] !== "$" || isPostgresIdentifierContinuation(source[index - 1])) {
    return undefined;
  }
  let cursor = index + 1;
  if (source[cursor] === "$") return "$$";
  if (!isPostgresIdentifierStart(source[cursor])) return undefined;
  cursor += 1;
  while (
    source[cursor] !== "$" &&
    (isPostgresIdentifierStart(source[cursor]) || /[0-9]/u.test(source[cursor] ?? ""))
  ) {
    cursor += 1;
  }
  return source[cursor] === "$" ? source.slice(index, cursor + 1) : undefined;
}

function lexSqlChunk(
  source: string,
  splitTopLevelSemicolons: boolean,
): readonly MigrationSqlStatement[] {
  const statements: MigrationSqlStatement[] = [];
  let statementStart = 0;
  let searchable = "";
  let containsDollarQuote = false;
  let containsUnicodeEscapedIdentifier = false;
  let parenthesisDepth = 0;
  let index = 0;

  const finish = (end: number): void => {
    const statementSource = source.slice(statementStart, end);
    if (statementSource.trim() !== "") {
      statements.push({
        source: statementSource,
        searchable,
        containsDollarQuote,
        containsUnicodeEscapedIdentifier,
      });
    }
    searchable = "";
    containsDollarQuote = false;
    containsUnicodeEscapedIdentifier = false;
  };

  while (index < source.length) {
    const character = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (character === "-" && next === "-") {
      const newline = source.indexOf("\n", index + 2);
      searchable += " ";
      index = newline === -1 ? source.length : newline;
      continue;
    }
    if (character === "/" && next === "*") {
      let depth = 1;
      index += 2;
      while (index < source.length && depth > 0) {
        if (source[index] === "/" && source[index + 1] === "*") {
          depth += 1;
          index += 2;
        } else if (source[index] === "*" && source[index + 1] === "/") {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      if (depth !== 0) throw new Error("Migration contains an unterminated block comment.");
      searchable += " ";
      continue;
    }
    if (character === "'") {
      const prefix = source[index - 1];
      const beforePrefix = source[index - 2];
      const escapeBackslashes =
        (prefix === "E" || prefix === "e") && !isPostgresIdentifierContinuation(beforePrefix);
      index += 1;
      let closed = false;
      while (index < source.length) {
        if (escapeBackslashes && source[index] === "\\") {
          index += 2;
        } else if (source[index] === "'" && source[index + 1] === "'") {
          index += 2;
        } else if (source[index] === "'") {
          index += 1;
          closed = true;
          break;
        } else {
          index += 1;
        }
      }
      if (!closed) throw new Error("Migration contains an unterminated string literal.");
      searchable += "''";
      continue;
    }
    if (character === '"') {
      const unicodeEscaped =
        source[index - 1] === "&" &&
        (source[index - 2] === "U" || source[index - 2] === "u") &&
        !isPostgresIdentifierContinuation(source[index - 3]);
      const quotedStart = index;
      index += 1;
      let closed = false;
      while (index < source.length) {
        if (source[index] === '"' && source[index + 1] === '"') {
          index += 2;
        } else if (source[index] === '"') {
          index += 1;
          closed = true;
          break;
        } else {
          index += 1;
        }
      }
      if (!closed) throw new Error("Migration contains an unterminated quoted identifier.");
      const quotedIdentifier = source.slice(quotedStart + 1, index - 1).replaceAll('""', '"');
      const normalizedIdentifier = quotedIdentifier.toLowerCase();
      containsUnicodeEscapedIdentifier ||= unicodeEscaped;
      searchable +=
        normalizedIdentifier === "standard_conforming_strings"
          ? '"standard_conforming_strings"'
          : ["set_config", "setval"].includes(quotedIdentifier)
            ? `"${quotedIdentifier}"`
            : '""';
      continue;
    }
    if (character === "$") {
      const delimiter = dollarQuoteDelimiter(source, index);
      if (delimiter !== undefined) {
        const end = source.indexOf(delimiter, index + delimiter.length);
        if (end === -1) throw new Error("Migration contains an unterminated dollar quote.");
        containsDollarQuote = true;
        searchable += " ";
        index = end + delimiter.length;
        continue;
      }
    }
    if (character === "(") {
      parenthesisDepth += 1;
    } else if (character === ")" && parenthesisDepth > 0) {
      parenthesisDepth -= 1;
    } else if (character === ";" && splitTopLevelSemicolons && parenthesisDepth === 0) {
      finish(index);
      index += 1;
      statementStart = index;
      continue;
    }
    searchable += character;
    index += 1;
  }
  finish(source.length);
  return statements;
}

function sqlChunkStatements(source: string): readonly MigrationSqlStatement[] {
  const statements = lexSqlChunk(source, true);
  if (statements.length <= 1) return statements;

  const unsplit = lexSqlChunk(source, false);
  const [compound] = unsplit;
  if (compound === undefined) return statements;
  const sql = compound.searchable.replaceAll(/\s+/gu, " ").trim();
  const keyword = postgresKeyword;
  const atomicHeader = postgresPattern(
    `^${keyword("CREATE")}\\s+(?:${keyword("OR")}\\s+${keyword("REPLACE")}\\s+)?(?:${keyword("FUNCTION")}|${keyword("PROCEDURE")})`,
  );
  if (!atomicHeader.test(sql)) return statements;

  const tokens =
    sql.match(/[A-Za-z_\u0080-\u{10ffff}][A-Za-z0-9_$\u0080-\u{10ffff}]*|[^\s]/gu) ?? [];
  let headerParenthesisDepth = 0;
  let begin = -1;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]?.toUpperCase();
    if (token === "(") headerParenthesisDepth += 1;
    else if (token === ")" && headerParenthesisDepth > 0) headerParenthesisDepth -= 1;
    else if (token === ";") return statements;
    else if (
      headerParenthesisDepth === 0 &&
      token === "BEGIN" &&
      tokens[index + 1]?.toUpperCase() === "ATOMIC"
    ) {
      begin = index;
      break;
    }
  }
  if (begin === -1) return statements;

  let statementStart = true;
  for (let index = begin + 2; index < tokens.length; index += 1) {
    const token = tokens[index]?.toUpperCase();
    const next = tokens[index + 1]?.toUpperCase();
    if (token === ";") {
      statementStart = true;
      continue;
    }
    if (!statementStart || !/^[A-Z_\u0080-\u{10ffff}]/u.test(token ?? "")) continue;
    if (token === "END") {
      return tokens.slice(index + 1).every((remaining) => remaining === ";") ? unsplit : statements;
    }
    if (
      ["COMMIT", "ROLLBACK", "ABORT", "SAVEPOINT", "RELEASE", "BEGIN"].includes(token ?? "") ||
      (token === "START" && next === "TRANSACTION") ||
      (token === "PREPARE" && next === "TRANSACTION")
    ) {
      return statements;
    }
    statementStart = false;
  }
  return statements;
}

export function migrationSqlStatements(source: string): readonly MigrationSqlStatement[] {
  return source.split(statementBreakpoint).flatMap((chunk) => sqlChunkStatements(chunk));
}

export function controlsMigrationTransaction(statement: MigrationSqlStatement): boolean {
  const sql = statement.searchable.replaceAll(/\s+/gu, " ").trim();
  const keyword = postgresKeyword;
  return postgresPattern(
    `^(?:${["COMMIT", "END", "ROLLBACK", "ABORT", "BEGIN", "SAVEPOINT", "RELEASE"]
      .map(keyword)
      .join(
        "|",
      )}|${keyword("START")}\\s+${keyword("TRANSACTION")}|${keyword("PREPARE")}\\s+${keyword("TRANSACTION")})`,
  ).test(sql);
}
