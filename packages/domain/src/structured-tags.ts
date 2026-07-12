import { invariant } from "./errors.js";

export const routinePriorities = ["low", "medium", "high", "critical"] as const;
export type RoutinePriority = (typeof routinePriorities)[number];

export const effortLevels = ["quick", "short", "medium", "deep"] as const;
export type EffortLevel = (typeof effortLevels)[number];

export const energyLevels = ["low", "normal", "high"] as const;
export type EnergyLevel = (typeof energyLevels)[number];

export const preferenceLevels = ["enjoyable", "neutral", "unpleasant"] as const;
export type PreferenceLevel = (typeof preferenceLevels)[number];

export interface StructuredTags {
  readonly priority: RoutinePriority;
  readonly effort: EffortLevel;
  readonly energy: EnergyLevel;
  readonly preference: PreferenceLevel;
  readonly contexts: readonly string[];
  readonly categories: readonly string[];
  readonly freeForm: readonly string[];
}

export interface CreateStructuredTagsInput {
  readonly priority?: RoutinePriority;
  readonly effort?: EffortLevel;
  readonly energy?: EnergyLevel;
  readonly preference?: PreferenceLevel;
  readonly contexts?: readonly string[];
  readonly categories?: readonly string[];
  readonly freeForm?: readonly string[];
}

function normalizeValues(
  values: readonly string[] | undefined,
  dimension: string,
): readonly string[] {
  const normalized = (values ?? []).map((value) => value.trim().toLocaleLowerCase("en-US"));
  invariant(
    normalized.every((value) => value.length > 0 && value.length <= 64),
    `tags.${dimension}_invalid`,
    `${dimension} tags must contain between 1 and 64 characters.`,
  );
  const unique = [...new Set(normalized)].sort((left, right) => left.localeCompare(right, "en"));
  invariant(
    unique.length <= 32,
    `tags.${dimension}_limit_exceeded`,
    `No more than 32 ${dimension} tags may be assigned.`,
  );
  return unique;
}

function isMember<Value extends string>(values: readonly Value[], value: string): value is Value {
  return values.some((candidate) => candidate === value);
}

export function createStructuredTags(input: CreateStructuredTagsInput = {}): StructuredTags {
  const priority = input.priority ?? "medium";
  const effort = input.effort ?? "medium";
  const energy = input.energy ?? "normal";
  const preference = input.preference ?? "neutral";

  invariant(
    isMember(routinePriorities, priority),
    "tags.priority_invalid",
    "Invalid priority tag.",
  );
  invariant(isMember(effortLevels, effort), "tags.effort_invalid", "Invalid effort tag.");
  invariant(isMember(energyLevels, energy), "tags.energy_invalid", "Invalid energy tag.");
  invariant(
    isMember(preferenceLevels, preference),
    "tags.preference_invalid",
    "Invalid preference tag.",
  );

  return {
    priority,
    effort,
    energy,
    preference,
    contexts: normalizeValues(input.contexts, "context"),
    categories: normalizeValues(input.categories, "category"),
    freeForm: normalizeValues(input.freeForm, "free_form"),
  };
}
