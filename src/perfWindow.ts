/** Bounded, read-only diagnostics for the current Durable Object activation.
 * Intentionally not persisted: exact durable counters remain independent, and
 * perf sampling must not add any SQLite writes to the NIP-17 hot path.
 */
export type PerformanceKind = 'req' | 'query' | 'write';
const MAX_SAMPLES = 128;
type Sample = { ms: number; rowsRead: number };
type Samples = Record<PerformanceKind, Sample[]>;

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] * 10) / 10;
}

export class PerformanceWindow {
  readonly startedAt = Date.now();
  private samples: Samples = { req: [], query: [], write: [] };

  record(kind: PerformanceKind, ms: number, rowsRead = 0): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    const samples = this.samples[kind];
    if (samples.length === MAX_SAMPLES) samples.shift();
    samples.push({ ms, rowsRead: Number.isFinite(rowsRead) ? Math.max(0, rowsRead) : 0 });
  }

  snapshot() {
    const summarize = (samples: Sample[]) => ({
      sample_count: samples.length,
      p50_ms: percentile(samples.map(sample => sample.ms), 0.5),
      p95_ms: percentile(samples.map(sample => sample.ms), 0.95),
      avg_rows_read: samples.length
        ? Math.round(samples.reduce((sum, sample) => sum + sample.rowsRead, 0) / samples.length * 10) / 10
        : null,
    });
    return {
      ephemeral: true as const,
      started_at: this.startedAt,
      sample_limit: MAX_SAMPLES,
      req: summarize(this.samples.req),
      query: summarize(this.samples.query),
      write: summarize(this.samples.write),
    };
  }
}
