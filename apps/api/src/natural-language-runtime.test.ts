import { HmacNaturalLanguagePromptHasher } from "@schedule/application";
import { workspaceId } from "@schedule/domain";
import { describe, expect, it, vi } from "vitest";

import { createNaturalLanguagePromptHasher } from "./natural-language-runtime.js";

describe("natural-language runtime", () => {
  const promptFingerprintInput = {
    workspaceId: workspaceId("11111111-1111-4111-8111-111111111111"),
    requestId: "22222222-2222-4222-8222-222222222222",
    prompt: "private prompt",
    referenceDate: null,
    timeZone: "UTC",
  };

  it("ignores a stale short configured HMAC key while proposals are disabled", () => {
    const fallbackKey = "f".repeat(32);
    const generateFallbackKey = vi.fn(() => fallbackKey);

    const hasher = createNaturalLanguagePromptHasher(
      "disabled",
      "stale-placeholder",
      generateFallbackKey,
    );

    expect(hasher.digest(promptFingerprintInput)).toBe(
      new HmacNaturalLanguagePromptHasher(fallbackKey).digest(promptFingerprintInput),
    );
    expect(generateFallbackKey).toHaveBeenCalledOnce();
  });

  it("uses the configured HMAC key when proposals are enabled", () => {
    const configuredKey = "c".repeat(32);
    const generateFallbackKey = vi.fn(() => "f".repeat(32));

    const hasher = createNaturalLanguagePromptHasher("ollama", configuredKey, generateFallbackKey);

    expect(hasher.digest(promptFingerprintInput)).toBe(
      new HmacNaturalLanguagePromptHasher(configuredKey).digest(promptFingerprintInput),
    );
    expect(generateFallbackKey).not.toHaveBeenCalled();
  });
});
