import type { ScheduleBlock } from "./types";

export interface AvailabilityWindow {
  readonly startsAt: string;
  readonly endsAt: string;
}

type AvailabilityBlock = Pick<ScheduleBlock, "id" | "startsAt" | "endsAt" | "version">;

interface NormalizedBlock {
  readonly id: string;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly version: number;
}

function instant(value: string, label: string): number {
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) throw new RangeError(`${label} must be a valid instant.`);
  return parsed;
}

function normalizeOuterWindow(window: AvailabilityWindow): {
  readonly startsAt: number;
  readonly endsAt: number;
} {
  const startsAt = instant(window.startsAt, "Availability start");
  const endsAt = instant(window.endsAt, "Availability end");
  if (endsAt <= startsAt) throw new RangeError("Availability must end after it starts.");
  return { startsAt, endsAt };
}

function normalizeIntersectingBlocks(
  window: AvailabilityWindow,
  blocks: readonly AvailabilityBlock[],
): readonly NormalizedBlock[] {
  const outer = normalizeOuterWindow(window);
  return blocks
    .map((block) => {
      const startsAt = instant(block.startsAt, `Schedule block ${block.id} start`);
      const endsAt = instant(block.endsAt, `Schedule block ${block.id} end`);
      if (endsAt <= startsAt) {
        throw new RangeError(`Schedule block ${block.id} must end after it starts.`);
      }
      if (!Number.isSafeInteger(block.version) || block.version < 1) {
        throw new RangeError(`Schedule block ${block.id} must have a positive version.`);
      }
      return { id: block.id, startsAt, endsAt, version: block.version };
    })
    .filter((block) => block.endsAt > outer.startsAt && block.startsAt < outer.endsAt)
    .map((block) => ({
      ...block,
      startsAt: Math.max(block.startsAt, outer.startsAt),
      endsAt: Math.min(block.endsAt, outer.endsAt),
    }))
    .sort(
      (left, right) =>
        left.startsAt - right.startsAt ||
        left.endsAt - right.endsAt ||
        left.id.localeCompare(right.id) ||
        left.version - right.version,
    );
}

/**
 * Subtracts schedule blocks from one outer planning range using half-open intervals.
 * Overlapping and adjacent blocks are merged before the free windows are emitted.
 */
export function deriveFreeAvailability(
  window: AvailabilityWindow,
  blocks: readonly AvailabilityBlock[],
): readonly AvailabilityWindow[] {
  const outer = normalizeOuterWindow(window);
  const occupied = normalizeIntersectingBlocks(window, blocks);
  const free: AvailabilityWindow[] = [];
  let cursor = outer.startsAt;

  for (const block of occupied) {
    if (block.startsAt > cursor) {
      free.push({
        startsAt: new Date(cursor).toISOString(),
        endsAt: new Date(block.startsAt).toISOString(),
      });
    }
    cursor = Math.max(cursor, block.endsAt);
  }

  if (cursor < outer.endsAt) {
    free.push({
      startsAt: new Date(cursor).toISOString(),
      endsAt: new Date(outer.endsAt).toISOString(),
    });
  }
  return free;
}

export function totalAvailabilityMinutes(windows: readonly AvailabilityWindow[]): number {
  const durationMs = windows.reduce((total, window) => {
    const normalized = normalizeOuterWindow(window);
    return total + normalized.endsAt - normalized.startsAt;
  }, 0);
  return Math.floor(durationMs / 60_000);
}

export function countIntersectingScheduleBlocks(
  window: AvailabilityWindow,
  blocks: readonly AvailabilityBlock[],
): number {
  return normalizeIntersectingBlocks(window, blocks).length;
}

/**
 * Captures only blocks that affect the selected range. Reordering never changes the key,
 * while timing, identity, or version changes do.
 */
export function availabilitySnapshotKey(
  window: AvailabilityWindow,
  blocks: readonly AvailabilityBlock[],
): string {
  return JSON.stringify(
    normalizeIntersectingBlocks(window, blocks).map((block) => [
      block.id,
      block.version,
      new Date(block.startsAt).toISOString(),
      new Date(block.endsAt).toISOString(),
    ]),
  );
}
