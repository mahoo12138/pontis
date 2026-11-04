// One shared duration formatter for the activity surfaces (options tab,
// start-page strip). Seconds in, a skimmable string out: "2 小时 15 分",
// "15 分钟", "40 秒".

export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分钟`;
  return `${s} 秒`;
}
