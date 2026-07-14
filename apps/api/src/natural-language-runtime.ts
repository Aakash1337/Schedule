import { randomBytes } from "node:crypto";

import { HmacNaturalLanguagePromptHasher } from "@schedule/application";

type ProposalMode = "disabled" | "ollama";

/**
 * Builds the prompt hasher without letting unused disabled-mode configuration
 * prevent the API from starting.
 */
export function createNaturalLanguagePromptHasher(
  mode: ProposalMode,
  configuredKey: string | undefined,
  generateFallbackKey: () => string = () => randomBytes(32).toString("base64url"),
): HmacNaturalLanguagePromptHasher {
  const key = mode === "ollama" ? configuredKey : generateFallbackKey();
  if (key === undefined) {
    throw new Error("The enabled natural-language proposal mode requires an HMAC key.");
  }
  return new HmacNaturalLanguagePromptHasher(key);
}
