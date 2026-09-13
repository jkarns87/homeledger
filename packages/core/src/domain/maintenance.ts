const DAY_MS = 86_400_000;

function toDate(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00Z`);
}

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function computeNextDue(lastDoneAt: string, intervalDays: number): string {
  return toIso(new Date(toDate(lastDoneAt).getTime() + intervalDays * DAY_MS));
}

export function isOverdue(nextDueAt: string, now: string): boolean {
  return toDate(nextDueAt).getTime() < toDate(now.slice(0, 10)).getTime();
}
