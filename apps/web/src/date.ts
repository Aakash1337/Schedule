export function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function todayKey(now: Date = new Date()): string {
  return localDateKey(now);
}

export function addDays(date: Date, amount: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + amount);
  return result;
}

export function startOfWeek(date: Date): Date {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const distance = (result.getDay() + 6) % 7;
  result.setDate(result.getDate() - distance);
  return result;
}

export function localDateTimeToIso(date: string, time: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const local = new Date(year ?? 0, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0);
  if (
    local.getFullYear() !== year ||
    local.getMonth() !== (month ?? 1) - 1 ||
    local.getDate() !== day ||
    local.getHours() !== hour ||
    local.getMinutes() !== minute
  ) {
    throw new RangeError("This local date and time does not exist in the browser time zone.");
  }
  const sameLocalMinute = (candidate: Date): boolean =>
    candidate.getFullYear() === year &&
    candidate.getMonth() === (month ?? 1) - 1 &&
    candidate.getDate() === day &&
    candidate.getHours() === hour &&
    candidate.getMinutes() === minute;
  const offset = local.getTimezoneOffset();
  for (const nearby of [
    new Date(local.getTime() - 2 * 86_400_000),
    new Date(local.getTime() + 2 * 86_400_000),
  ]) {
    const alternative = new Date(local.getTime() + (nearby.getTimezoneOffset() - offset) * 60_000);
    if (alternative.getTime() !== local.getTime() && sameLocalMinute(alternative)) {
      throw new RangeError("This local date and time is ambiguous in the browser time zone.");
    }
  }
  return local.toISOString();
}

export function isoToLocalDate(instant: string): string {
  return localDateKey(new Date(instant));
}

export function isoToLocalTime(instant: string): string {
  const date = new Date(instant);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

export function formatDay(date: Date, options: Intl.DateTimeFormatOptions = {}): string {
  return new Intl.DateTimeFormat(undefined, options).format(date);
}

export function formatTime(instant: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
    new Date(instant),
  );
}

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function splitTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}
