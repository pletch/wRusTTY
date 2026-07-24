/** Summary statistics for a sample of measurements. */
export interface Stats {
  n: number
  mean: number
  p50: number
  p95: number
  p99: number
  min: number
  max: number
}

export function summarize(samples: number[]): Stats {
  const s = [...samples].sort((a, b) => a - b)
  const n = s.length
  if (n === 0) return { n: 0, mean: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0 }
  const pct = (p: number) => s[Math.min(n - 1, Math.floor((p / 100) * n))]
  const mean = s.reduce((a, b) => a + b, 0) / n
  return { n, mean, p50: pct(50), p95: pct(95), p99: pct(99), min: s[0], max: s[n - 1] }
}
