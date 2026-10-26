import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { eventMatchesFilter } from '../src/nostr';
import {
  buildFilterQuery,
  eventJson,
  EXPIRED_EVENTS_BATCH_SQL,
  giftWrapVisible,
  GIFT_WRAP_KIND,
  sessionMayReceiveGiftWrap,
  storedEventJson,
  type StoredEventRow,
} from '../src/query';
import type { NostrEvent, NostrFilter, SessionAttachment } from '../src/types';

// Mirrors the events/event_tags schema and indexes in relay-object.ts.
function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE events (
      id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, created_at INTEGER NOT NULL, received_at INTEGER,
      kind INTEGER NOT NULL, d_tag TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, sig TEXT NOT NULL,
      tags_json TEXT NOT NULL, expires_at INTEGER
    );
    CREATE INDEX events_created_at_idx ON events(created_at DESC, id ASC);
    CREATE INDEX events_pubkey_created_idx ON events(pubkey, created_at DESC);
    CREATE INDEX events_kind_created_idx ON events(kind, created_at DESC);
    CREATE INDEX events_replaceable_idx ON events(pubkey, kind, d_tag, created_at DESC, id ASC);
    CREATE INDEX events_author_kind_created_idx ON events(pubkey, kind, created_at DESC, id ASC);
    CREATE INDEX events_received_at_idx ON events(received_at DESC, id ASC);
    CREATE INDEX events_expires_idx ON events(expires_at) WHERE expires_at IS NOT NULL;
    CREATE TABLE event_tags (
      event_id TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER, received_at INTEGER,
      PRIMARY KEY(event_id, name, value)
    );
    CREATE INDEX event_tags_time_idx ON event_tags(name, value, created_at DESC, event_id ASC);
    CREATE INDEX event_tags_p_received_idx ON event_tags(value, received_at DESC, event_id ASC) WHERE name = 'p';
  `);
  return db;
}

const hex = (n: number, width = 64) => n.toString(16).padStart(width, '0');
const ALICE = 'a'.repeat(64);
const BOB = 'b'.repeat(64);

function makeEvents(): NostrEvent[] {
  const events: NostrEvent[] = [];
  for (let i = 0; i < 600; i++) {
    const recipient = i % 3 === 0 ? ALICE : BOB;
    const kind = i % 4 === 0 ? 1 : GIFT_WRAP_KIND;
    events.push({
      id: hex(i + 1),
      pubkey: hex(1000 + (i % 7)),
      // Repeated timestamps exercise the id tie-break.
      created_at: 10_000 - Math.floor(i / 2),
      kind,
      tags: [['p', recipient], ...(i % 5 === 0 ? [['e', hex(9999)]] : [])],
      content: '',
      sig: '0'.repeat(128),
    });
  }
  return events;
}

// Wraps are backdated, so arrival order differs from created_at order.
const receivedAt = (event: NostrEvent) => 20_000 + (parseInt(event.id.slice(-4), 16) * 7) % 600;
const expiresAt = (event: NostrEvent) => parseInt(event.id.slice(-4), 16) % 10 === 0 ? 50 + parseInt(event.id.slice(-4), 16) : null;

function insert(db: DatabaseSync, events: NostrEvent[]) {
  const insertEvent = db.prepare('INSERT INTO events(id,pubkey,created_at,received_at,kind,content,sig,tags_json,expires_at) VALUES(?,?,?,?,?,?,?,?,?)');
  const insertTag = db.prepare('INSERT OR IGNORE INTO event_tags(event_id,name,value,created_at,received_at) VALUES(?,?,?,?,?)');
  for (const event of events) {
    insertEvent.run(event.id, event.pubkey, event.created_at, receivedAt(event), event.kind, event.content, event.sig, JSON.stringify(event.tags), expiresAt(event));
    for (const tag of event.tags) insertTag.run(event.id, tag[0], tag[1], event.created_at, receivedAt(event));
  }
}

function run(db: DatabaseSync, filter: NostrFilter, recipients: string[], tagIndexReady = true, limit = filter.limit ?? 250, recipientTimeIndexReady = false) {
  const query = buildFilterQuery(filter, { limit, now: 1, recipients, tagIndexReady, recipientTimeIndexReady });
  if (!query) return [];
  return (db.prepare(query.sql).all(...query.bindings) as Array<{ id: string }>).map(row => row.id);
}

function expected(events: NostrEvent[], filter: NostrFilter, recipients: string[], limit = filter.limit ?? 250) {
  return events
    .filter(event => eventMatchesFilter(event, filter) && giftWrapVisible(event, recipients))
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map(event => event.id);
}

describe('filter queries', () => {
  const events = makeEvents();
  const db = database();
  insert(db, events);

  const filters: NostrFilter[] = [
    { kinds: [GIFT_WRAP_KIND], '#p': [ALICE], limit: 50 },
    { kinds: [GIFT_WRAP_KIND], '#p': [ALICE], since: 9_800, until: 9_900 },
    { '#p': [ALICE, BOB], limit: 120 },
    { '#p': [ALICE], '#e': [hex(9999)] },
    { kinds: [1], authors: [hex(1003)] },
    { kinds: [1, GIFT_WRAP_KIND], authors: [hex(1001), hex(1004)], since: 9_850, limit: 20 },
    { authors: [hex(1003).slice(0, 62)], kinds: [1] },
    { ids: [hex(5), hex(42), hex(3).slice(0, 63)] },
    { kinds: [1], limit: 30 },
    { until: 9_900, limit: 40 },
  ];

  for (const [index, filter] of filters.entries()) {
    it(`matches the reference filter semantics (#${index})`, () => {
      expect(run(db, filter, [ALICE])).toEqual(expected(events, filter, [ALICE]));
      expect(run(db, filter, [ALICE], false)).toEqual(expected(events, filter, [ALICE]));
    });
  }

  it('serves gift wraps only to an authenticated recipient', () => {
    const filter = { kinds: [GIFT_WRAP_KIND], '#p': [ALICE] };
    expect(run(db, filter, [])).toEqual([]);
    expect(run(db, filter, [BOB])).toEqual([]);
    expect(run(db, filter, [ALICE]).length).toBeGreaterThan(0);
    // Wildcard and id lookups cannot reach someone else's wrap either.
    expect(run(db, { limit: 500 }, [BOB]).every(id => {
      const event = events.find(item => item.id === id)!;
      return event.kind !== GIFT_WRAP_KIND || event.tags.some(tag => tag[1] === BOB);
    })).toBe(true);
    const aliceWrap = events.find(event => event.kind === GIFT_WRAP_KIND && event.tags[0][1] === ALICE)!;
    expect(run(db, { ids: [aliceWrap.id] }, [BOB])).toEqual([]);
    expect(run(db, { ids: [aliceWrap.id] }, [ALICE])).toEqual([aliceWrap.id]);
    // Other kinds stay public to the read policy.
    expect(run(db, { kinds: [1], '#p': [ALICE] }, []).length).toBeGreaterThan(0);
  });

  it('walks the tag time index for a recipient query instead of scanning events', () => {
    const query = buildFilterQuery(
      { kinds: [GIFT_WRAP_KIND], '#p': [ALICE], since: 9_000, until: 10_000 },
      { limit: 250, now: 1, recipients: [ALICE], tagIndexReady: true },
    )!;
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.bindings) as Array<{ detail: string }>)
      .map(row => row.detail).join('\n');
    expect(plan).toContain('event_tags_time_idx');
    expect(plan).not.toMatch(/SCAN e\b/);
    expect(plan).not.toContain('TEMP B-TREE FOR ORDER BY');
  });

  it('received_since returns only what arrived since then, from the arrival index', () => {
    const filter = { kinds: [GIFT_WRAP_KIND], '#p': [ALICE], received_since: 20_450 };
    const ids = run(db, filter, [ALICE], true, 1_000);
    const want = events
      .filter(event => event.kind === GIFT_WRAP_KIND && event.tags[0][1] === ALICE && receivedAt(event) >= 20_450)
      .map(event => event.id);
    expect(ids.length).toBeGreaterThan(0);
    expect([...ids].sort()).toEqual([...want].sort());
    expect(run(db, filter, [BOB], true, 1_000)).toEqual([]);
    const query = buildFilterQuery(filter, { limit: 250, now: 1, recipients: [ALICE], tagIndexReady: true })!;
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.bindings) as Array<{ detail: string }>)
      .map(row => row.detail).join('\n');
    expect(plan).toContain('events_received_at_idx');
  });

  it('optimizes NIP-17 arrival queries with no changes to their result ordering or permissions', () => {
    const filter = { kinds: [GIFT_WRAP_KIND], '#p': [ALICE], received_since: 20_350, limit: 250 };
    const legacy = run(db, filter, [ALICE], true, 250, false);
    const optimized = run(db, filter, [ALICE], true, 250, true);
    expect(optimized).toEqual(legacy);
    expect(run(db, filter, [BOB], true, 250, true)).toEqual([]);
    expect(run(db, filter, [], true, 250, true)).toEqual([]);

    const query = buildFilterQuery(filter, {
      limit: 250, now: 1, recipients: [ALICE], tagIndexReady: true, recipientTimeIndexReady: true
    })!;
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.bindings) as Array<{ detail: string }>)
      .map(row => row.detail).join('\n');
    expect(plan).toContain('event_tags_p_received_idx');
    expect(plan).not.toMatch(/SCAN e\\b/);
    expect(plan).not.toContain('TEMP B-TREE FOR ORDER BY');

    const multi = buildFilterQuery({ '#p': [ALICE, BOB], received_since: 20_350 }, {
      limit: 250, now: 1, recipients: [ALICE], tagIndexReady: true, recipientTimeIndexReady: true
    })!;
    expect(multi.sql).toContain('events_received_at_idx');
  });

  it('prefilters unrelated gift wraps without bypassing NIP-42 and app-session expiry', () => {
    const event = events.find(item => item.kind === GIFT_WRAP_KIND && item.tags[0][1] === ALICE)!;
    const session = {
      authenticated_pubkeys: [BOB], app_id: 'app', app_session_pubkey: ALICE,
      app_session_expires_at: 200
    } as SessionAttachment;
    expect(sessionMayReceiveGiftWrap(event, session, 199)).toBe(true);
    expect(sessionMayReceiveGiftWrap(event, session, 200)).toBe(false);
    session.authenticated_pubkeys.push(ALICE);
    expect(sessionMayReceiveGiftWrap(event, session, 200)).toBe(true);
    session.authenticated_pubkeys = [BOB];
    session.app_id = null;
    expect(sessionMayReceiveGiftWrap(event, session, 199)).toBe(false);
    expect(sessionMayReceiveGiftWrap({ ...event, kind: 1 }, session, 199)).toBe(true);
  });

  it('selects expired events in bounded batches', () => {
    const expiredDb = database();
    insert(expiredDb, events);
    const rows = expiredDb.prepare(EXPIRED_EVENTS_BATCH_SQL).all(100, 5) as Array<{ id: string }>;
    const expired = events.filter(event => { const at = expiresAt(event); return at !== null && at <= 100; });
    expect(rows).toHaveLength(Math.min(5, expired.length));
    expect(rows.every(row => expired.some(event => event.id === row.id))).toBe(true);
  });

  it('walks the author index for follow-list timelines', () => {
    const planFor = (filter: NostrFilter) => {
      const query = buildFilterQuery(filter, { limit: 50, now: 1, recipients: [], tagIndexReady: true })!;
      return (db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.bindings) as Array<{ detail: string }>)
        .map(row => row.detail).join('\n');
    };
    const plan = planFor({ authors: [hex(1001), hex(1003)], kinds: [1] });
    expect(plan).toContain('events_author_kind_created_idx');
    expect(plan).not.toContain('events_kind_created_idx');
    // Prefixes cannot be forced onto the index (INDEXED BY would fail to plan).
    expect(planFor({ authors: [hex(1003).slice(0, 10)], kinds: [1] })).not.toContain('events_author_kind_created_idx');
  });

  it('serializes stored rows exactly like JSON.stringify of the event', () => {
    const event: NostrEvent = {
      id: hex(7), pubkey: hex(8), created_at: 1_700_000_000, kind: 1,
      tags: [['p', ALICE, 'wss://r.example', 'say "hi"\n'], ['t', '海内\u2028']],
      content: 'line\n"quoted" \\ \u0000 😀',
      sig: '0'.repeat(128),
    };
    const row: StoredEventRow = { ...event, tags_json: JSON.stringify(event.tags) };
    expect(storedEventJson(row)).toBe(JSON.stringify(event));
    expect(JSON.parse(storedEventJson(row))).toEqual(event);
    expect(eventJson({ ...event, extra: 'dropped' } as NostrEvent)).toBe(JSON.stringify(event));
  });

  it('uses exact matches for full-length ids and authors', () => {
    const query = buildFilterQuery({ ids: [hex(5)], authors: [hex(1003)] }, { limit: 10, now: 1, recipients: [], tagIndexReady: true })!;
    expect(query.sql).not.toContain('LIKE');
    expect(query.sql).toContain('e.id IN (?)');
  });
});
