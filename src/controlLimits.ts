import type { SessionAttachment } from './types';

/** Hard input ceiling before JSON.parse, independent of configurable EVENT limit. */
export const MAX_RELAY_FRAME_CHARS = 1_100_000;
export const MAX_CONTROL_FRAME_CHARS = 32 * 1024;
// These limits protect the SQLite-backed Durable Object from unbounded REQ
// traffic, without blocking the bounded catch-up batches sent by HaiNei.
export const MAX_REQ_PER_MINUTE = 300;
export const MAX_AUTH_PER_MINUTE = 12;

/** Per-connection budget persists in the hibernatable WebSocket attachment. */
export function allowControlMessage(
  session: SessionAttachment,
  kind: 'REQ' | 'AUTH',
  at = Date.now(),
): boolean {
  const previous = session.control_windows?.[kind];
  const withinWindow = previous && at >= previous.startedAt && at - previous.startedAt < 60_000;
  const next = withinWindow
    ? { startedAt: previous.startedAt, count: previous.count + 1 }
    : { startedAt: at, count: 1 };
  session.control_windows = { ...session.control_windows, [kind]: next };
  return next.count <= (kind === 'REQ' ? MAX_REQ_PER_MINUTE : MAX_AUTH_PER_MINUTE);
}
