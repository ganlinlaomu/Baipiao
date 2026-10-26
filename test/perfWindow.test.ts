import { describe, expect, it } from 'vitest';
import { PerformanceWindow } from '../src/perfWindow';

describe('bounded performance telemetry', () => {
  it('keeps recent percentiles and SQL row cost without storing any event content', () => {
    const window = new PerformanceWindow();
    window.record('query', 15, 3);
    window.record('query', 5, 7);
    window.record('query', 10, 8);
    window.record('req', 22);
    const stats = window.snapshot();
    expect(stats.query).toMatchObject({ sample_count: 3, p50_ms: 10, p95_ms: 15, avg_rows_read: 6 });
    expect(stats.req).toMatchObject({ sample_count: 1, p95_ms: 22 });
    expect(stats.write).toMatchObject({ sample_count: 0, p95_ms: null });
    expect(stats.ephemeral).toBe(true);
  });

  it('drops older samples so snapshots remain bounded under sustained REQ', () => {
    const window = new PerformanceWindow();
    for (let index = 0; index < 200; index++) window.record('req', index);
    const stats = window.snapshot();
    expect(stats.req.sample_count).toBe(128);
    expect(stats.req.p50_ms).toBe(135);
  });

  it('ignores nonfinite durations and never records sensitive event payloads', () => {
    const window = new PerformanceWindow();
    window.record('query', Number.NaN);
    window.record('query', Number.POSITIVE_INFINITY);
    expect(window.snapshot().query.sample_count).toBe(0);
  });
});
