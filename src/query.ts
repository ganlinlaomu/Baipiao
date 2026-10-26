import type { NostrEvent, NostrFilter } from './types';

export const GIFT_WRAP_KIND = 1059;
const FULL_HEX = /^[0-9a-f]{64}$/;
const MAX_TERMS = 80;

/** One index-ordered batch of expired event ids; bindings: now, batch size. */
export const EXPIRED_EVENTS_BATCH_SQL = 'SELECT id FROM events WHERE expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at LIMIT ?';

export type SqlValue = string | number | null;
export type FilterQuery = { sql: string; bindings: SqlValue[] };

export type QueryOptions = {
  limit: number;
  now: number;
  /** Pubkeys this connection proved it controls; only they may read their gift wraps. */
  recipients: string[];
  /** event_tags.created_at is filled for every row, so tag queries can walk its index. */
  tagIndexReady: boolean;
  /** Enabled only after the legacy event_tags.received_at backfill completes. */
  recipientTimeIndexReady?: boolean;
};

/**
 * NIP-17 gift wraps hide sender and content, but who receives how many and
 * when is still metadata. Serve a wrap only to a connection authenticated as
 * one of its `p` recipients.
 */
export function giftWrapVisible(event: NostrEvent, recipients: string[]): boolean {
  if (event.kind !== GIFT_WRAP_KIND) return true;
  return event.tags.some(tag => tag[0] === 'p' && !!tag[1] && recipients.includes(tag[1]));
}

// Full-length values use the primary key/indexes directly. LIKE is
// case-insensitive in SQLite and cannot use them; GLOB is case-sensitive and
// can (prefixes are validated hex, so they carry no GLOB metacharacters).
function matchAny(column: string, values: string[], bindings: SqlValue[]): string {
  const exact = values.filter(value => FULL_HEX.test(value));
  const prefixes = values.filter(value => !FULL_HEX.test(value));
  const parts: string[] = [];
  if (exact.length) {
    parts.push(`${column} IN (${exact.map(() => '?').join(',')})`);
    bindings.push(...exact);
  }
  for (const prefix of prefixes) {
    parts.push(`${column} GLOB ?`);
    bindings.push(`${prefix}*`);
  }
  return parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
}

function tagEntries(filter: NostrFilter): Array<[string, string[]]> {
  return Object.entries(filter)
    .filter(([key]) => key.startsWith('#'))
    .map(([key, value]) => [key.slice(1), [...new Set(value as string[])]]);
}

export function buildFilterQuery(filter: NostrFilter, options: QueryOptions): FilterQuery | null {
  const tags = tagEntries(filter);
  const termCount = (filter.ids?.length ?? 0) + (filter.authors?.length ?? 0) + (filter.kinds?.length ?? 0)
    + tags.reduce((sum, [, values]) => sum + values.length, 0);
  if (termCount > MAX_TERMS) return null;
  if (tags.some(([, values]) => !values.length)) return null;
  if (options.limit <= 0) return null;
  if (filter.since !== undefined && filter.until !== undefined && filter.since > filter.until) return null;

  const bindings: SqlValue[] = [];
  const where: string[] = [];

  // A single tag value drives the query from the tag index, walking it newest
  // first so a page reads about `limit` rows instead of every event in the
  // time window. Several values could match one event twice, so they keep
  // the event-driven plan below.
  // received_since reads only what arrived since then, across the whole
  // relay, which is far fewer rows than one recipient's backdating window.
  const byReceipt = filter.received_since !== undefined;
  // Restrict the recipient index fast path to one authenticated #p target.
  // Keep the global arrival-time index for untrusted/multi-recipient queries.
  const receiptRecipient = byReceipt && options.recipientTimeIndexReady
    ? tags.find(([name, values]) => name === 'p'
        && values.length === 1 && options.recipients.includes(values[0]))
    : undefined;
  const driver = receiptRecipient || (options.tagIndexReady && !byReceipt
    ? tags.find(([, values]) => values.length === 1) : undefined);
  let from = 'events e';
  let order = 'e.created_at DESC, e.id ASC';
  if (receiptRecipient) {
    from = 'event_tags t INDEXED BY event_tags_received_time_idx CROSS JOIN events e ON e.id = t.event_id';
    order = 't.received_at DESC, t.event_id ASC';
    where.push('t.name = ?', 't.value = ?', 't.received_at >= ?');
    bindings.push(receiptRecipient[0], receiptRecipient[1][0], filter.received_since!);
    if (filter.since !== undefined) { where.push('e.created_at >= ?'); bindings.push(filter.since); }
    if (filter.until !== undefined) { where.push('e.created_at <= ?'); bindings.push(filter.until); }
  } else if (byReceipt) {
    from = 'events e INDEXED BY events_received_at_idx';
    order = 'e.received_at DESC, e.id ASC';
    where.push('e.received_at >= ?');
    bindings.push(filter.received_since!);
    if (filter.since !== undefined) { where.push('e.created_at >= ?'); bindings.push(filter.since); }
    if (filter.until !== undefined) { where.push('e.created_at <= ?'); bindings.push(filter.until); }
  } else if (driver) {
    from = 'event_tags t CROSS JOIN events e ON e.id = t.event_id';
    order = 't.created_at DESC, t.event_id ASC';
    where.push('t.name = ?', 't.value = ?');
    bindings.push(driver[0], driver[1][0]);
    if (filter.since !== undefined) { where.push('t.created_at >= ?'); bindings.push(filter.since); }
    if (filter.until !== undefined) { where.push('t.created_at <= ?'); bindings.push(filter.until); }
  } else {
    if (filter.since !== undefined) { where.push('e.created_at >= ?'); bindings.push(filter.since); }
    if (filter.until !== undefined) { where.push('e.created_at <= ?'); bindings.push(filter.until); }
  }

  where.push('(e.expires_at IS NULL OR e.expires_at > ?)');
  bindings.push(options.now);
  if (filter.ids?.length) where.push(matchAny('e.id', filter.ids, bindings));
  if (filter.authors?.length) where.push(matchAny('e.pubkey', filter.authors, bindings));
  if (filter.kinds?.length) {
    where.push(`e.kind IN (${filter.kinds.map(() => '?').join(',')})`);
    bindings.push(...filter.kinds);
  }
  for (const [name, values] of tags) {
    if (driver && name === driver[0]) continue;
    where.push(`EXISTS (SELECT 1 FROM event_tags x WHERE x.event_id = e.id AND x.name = ? AND x.value IN (${values.map(() => '?').join(',')}))`);
    bindings.push(name, ...values);
  }

  // A `#p` limited to the caller's own pubkeys already proves recipiency.
  const ownRecipientsOnly = tags.some(([name, values]) => name === 'p' && values.every(value => options.recipients.includes(value)));
  if ((!filter.kinds || filter.kinds.includes(GIFT_WRAP_KIND)) && !ownRecipientsOnly) {
    if (options.recipients.length) {
      where.push(`(e.kind <> ${GIFT_WRAP_KIND} OR EXISTS (SELECT 1 FROM event_tags g WHERE g.event_id = e.id AND g.name = 'p' AND g.value IN (${options.recipients.map(() => '?').join(',')})))`);
      bindings.push(...options.recipients);
    } else {
      where.push(`e.kind <> ${GIFT_WRAP_KIND}`);
    }
  }

  bindings.push(options.limit);
  return {
    sql: `SELECT e.* FROM ${from} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`,
    bindings,
  };
}
