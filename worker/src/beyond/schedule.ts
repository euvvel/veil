/** Next Monday 06:00 UTC after `now` (when "This week's veil" is gathered). */
export function nextWeekly(now: number): number {
  const d = new Date(now);
  d.setUTCHours(6, 0, 0, 0);
  const add = (8 - d.getUTCDay()) % 7 || (d.getTime() <= now ? 7 : 0);
  return d.getTime() + add * 24 * 3600_000;
}
