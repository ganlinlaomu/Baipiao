import { describe, expect, it } from 'vitest';
import { allowControlMessage, MAX_AUTH_PER_MINUTE, MAX_REQ_PER_MINUTE } from '../src/controlLimits';
import type { SessionAttachment } from '../src/types';

function session() {
  return { control_windows: {} } as SessionAttachment;
}

describe('hibernatable control-message budgets', () => {
  it('bounds REQ traffic per websocket and restarts the budget after one minute', () => {
    const state = session();
    for (let i = 0; i < MAX_REQ_PER_MINUTE; i++) expect(allowControlMessage(state, 'REQ', 100_000)).toBe(true);
    expect(allowControlMessage(state, 'REQ', 100_000)).toBe(false);
    expect(allowControlMessage(state, 'REQ', 160_000)).toBe(true);
  });

  it('does not share the AUTH budget with REQ and resumes after attachment restore', () => {
    const state = session();
    for (let i = 0; i < MAX_AUTH_PER_MINUTE; i++) expect(allowControlMessage(state, 'AUTH', 1_000)).toBe(true);
    const restored = JSON.parse(JSON.stringify(state)) as SessionAttachment;
    expect(allowControlMessage(restored, 'AUTH', 1_000)).toBe(false);
    expect(allowControlMessage(restored, 'REQ', 1_000)).toBe(true);
    expect(allowControlMessage(restored, 'AUTH', 61_000)).toBe(true);
  });
});
