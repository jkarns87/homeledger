export const VOICE_MAX_ITEMS = 5;

export function speakList(items: string[], noun: string): string {
  const plural = (n: number) => (n === 1 ? noun : `${noun}s`);
  if (items.length === 0) return `No ${plural(0)}.`;
  const shown = items.slice(0, VOICE_MAX_ITEMS);
  const rest = items.length - shown.length;
  let joined: string;
  if (shown.length === 1) joined = shown[0]!;
  else if (shown.length === 2 && rest === 0) joined = `${shown[0]} and ${shown[1]}`;
  else joined = `${shown.slice(0, -1).join(', ')}, and ${rest > 0 ? `${rest} more` : shown[shown.length - 1]}`;
  if (rest > 0 && shown.length > 1) joined = `${shown.join(', ')}, and ${rest} more`;
  return `${items.length} ${plural(items.length)}: ${joined}.`;
}

export function hasJson(text: string): boolean {
  return /[{}[\]]/.test(text);
}

export function speakDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
}
