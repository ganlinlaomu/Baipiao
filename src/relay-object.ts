import { DurableObject } from 'cloudflare:workers';
import {
  eventMatchesFilter,
  getChallengeTag,
  getDTag,
  getExpiration,
  getRelayTag,
  isEphemeralKind,
  isParameterizedReplaceableKind,
  isReplaceableKind,
  isValidEventShape,
  isValidFilter,
  normalizePubkey,
  randomToken,
  relayTagMatchesHost,
  sha256Hex,
  verifyEvent,
} from './nostr';
import { evaluateRead, evaluateWrite } from './policy';
import type {
  AppRecord,
  Env,
  NostrEvent,
  NostrFilter,
  RelaySettings,
  SessionAttachment,
  UserRecord,
} from './types';

const DEFAULT_SETTINGS: RelaySettings = {
  relay_name: 'Cloudflare Nostr Relay',
  relay_description: 'A Cloudflare-native Nostr relay with application and user access control.',
  read_policy: 'public',
  write_policy: 'app_or_user',
  default_limit: 100,
  max_limit: 250,
  max_filters: 10,
  max_subscriptions: 20,
  max_event_bytes: 131072,
  max_future_seconds: 600,
  default_rate_limit: 120,
};

const ACCESS_MODES = new Set(['public', 'app', 'user', 'app_or_user', 'app_and_user']);
const APP_TYPES = new Set(['web', 'native', 'service']);
const encoder = new TextEncoder();

type SqlRow = Record<string, SqlStorageValue>;

type AppSessionGrant = {
  app: AppRecord;
  subjectPubkey: string | null;
  expiresAt: number;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function bool(value: SqlStorageValue): boolean {
  return Number(value) === 1;
}

function parseKinds(value: SqlStorageValue): number[] | null {
  if (value === null || value === undefined || value === '') return null;
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.filter(Number.isInteger) : null;
  } catch {
    return null;
  }
}

function parseStringArray(value: SqlStorageValue): string[] {
  if (value === null || value === undefined || value === '') return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.filter(v => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function appFromRow(row: SqlRow): AppRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    type: String(row.type) as AppRecord['type'],
    enabled: bool(row.enabled),
    can_read: bool(row.can_read),
    can_write: bool(row.can_write),
    allowed_kinds: parseKinds(row.allowed_kinds),
    allowed_origins: parseStringArray(row.allowed_origins),
    rate_limit: Number(row.rate_limit),
    expires_at: row.expires_at === null ? null : Number(row.expires_at),
    created_at: Number(row.created_at),
  };
}

function userFromRow(row: SqlRow): UserRecord {
  return {
    pubkey: String(row.pubkey),
    name: String(row.name ?? ''),
    enabled: bool(row.enabled),
    can_read: bool(row.can_read),
    can_write: bool(row.can_write),
    allowed_kinds: parseKinds(row.allowed_kinds),
    expires_at: row.expires_at === null ? null : Number(row.expires_at),
    created_at: Number(row.created_at),
  };
}

function eventFromRow(row: SqlRow): NostrEvent {
  return {
    id: String(row.id),
    pubkey: String(row.pubkey),
    created_at: Number(row.created_at),
    kind: Number(row.kind),
    tags: JSON.parse(String(row.tags_json)),
    content: String(row.content),
    sig: String(row.sig),
  };
}

function allowedKinds(input: unknown): number[] | null {
  if (input === null || input === undefined || input === '') return null;
  if (!Array.isArray(input)) throw new Error('allowed_kinds must be an array or null');
  const values = [...new Set(input.map(Number))];
  if (values.some(v => !Number.isInteger(v) || v < 0 || v > 65535)) throw new Error('invalid event kind');
  if (values.length > 100) throw new Error('too many allowed kinds');
  return values;
}

function normalizeOrigins(input: unknown): string[] {
  if (input === null || input === undefined) return [];
  if (!Array.isArray(input)) throw new Error('allowed_origins must be an array');
  const values: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string') throw new Error('invalid origin');
    const url = new URL(item);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('origin must use http or https');
    values.push(url.origin);
  }
  return [...new Set(values)].slice(0, 20);
}

function formatDecision(prefix: string | undefined, reason: string | undefined): string {
  return `${prefix ?? 'restricted'}: ${reason ?? 'access denied'}`;
}

export class RelayDurableObject extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.initializeSchema();
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  private initializeSchema(): void {
    this.sql.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS applications (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1,
        can_read INTEGER NOT NULL DEFAULT 1,
        can_write INTEGER NOT NULL DEFAULT 1,
        allowed_kinds TEXT,
        allowed_origins TEXT NOT NULL DEFAULT '[]',
        rate_limit INTEGER NOT NULL DEFAULT 120,
        expires_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS applications_token_hash_idx ON applications(token_hash);
      CREATE TABLE IF NOT EXISTS app_sessions (
        token_hash TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        subject_pubkey TEXT,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(app_id) REFERENCES applications(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS app_sessions_expiry_idx ON app_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS users (
        pubkey TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        can_read INTEGER NOT NULL DEFAULT 1,
        can_write INTEGER NOT NULL DEFAULT 1,
        allowed_kinds TEXT,
        expires_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        pubkey TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        kind INTEGER NOT NULL,
        d_tag TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        sig TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS events_created_at_idx ON events(created_at DESC, id ASC);
      CREATE INDEX IF NOT EXISTS events_pubkey_created_idx ON events(pubkey, created_at DESC);
      CREATE INDEX IF NOT EXISTS events_kind_created_idx ON events(kind, created_at DESC);
      CREATE INDEX IF NOT EXISTS events_replaceable_idx ON events(pubkey, kind, d_tag, created_at DESC, id ASC);
      CREATE TABLE IF NOT EXISTS event_tags (
        event_id TEXT NOT NULL,
        name TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY(event_id, name, value),
        FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS event_tags_lookup_idx ON event_tags(name, value, event_id);
      CREATE TABLE IF NOT EXISTS relay_metrics (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        read_requests INTEGER NOT NULL DEFAULT 0,
        read_events INTEGER NOT NULL DEFAULT 0,
        read_denied INTEGER NOT NULL DEFAULT 0,
        write_attempts INTEGER NOT NULL DEFAULT 0,
        write_accepted INTEGER NOT NULL DEFAULT 0,
        write_denied INTEGER NOT NULL DEFAULT 0,
        last_read_at INTEGER,
        last_write_at INTEGER
      );
      INSERT OR IGNORE INTO relay_metrics(id) VALUES(1);
    `);

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      this.sql.exec('INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)', key, JSON.stringify(value));
    }
  }

  private getSettings(): RelaySettings {
    const rows = this.sql.exec('SELECT key, value FROM settings').toArray() as SqlRow[];
    const result = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
    for (const row of rows) {
      try { result[String(row.key)] = JSON.parse(String(row.value)); } catch { /* ignore invalid row */ }
    }
    return result as unknown as RelaySettings;
  }

  async relayInfo(): Promise<Record<string, unknown>> {
    const settings = this.getSettings();
    return {
      name: settings.relay_name,
      description: settings.relay_description,
      software: 'https://github.com/ganlinlaomu/Baipiao',
      version: '0.1.0',
      supported_nips: [1, 9, 11, 40, 42],
      limitation: {
        auth_required: false,
        restricted_writes: settings.write_policy !== 'public',
        max_message_length: settings.max_event_bytes,
        max_subscriptions: settings.max_subscriptions,
        max_filters: settings.max_filters,
        default_limit: settings.default_limit,
        max_limit: settings.max_limit,
        created_at_upper_limit: settings.max_future_seconds,
      },
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      return this.handleUpgrade(request);
    }
    if (url.pathname === '/api/app/session') return this.issueAppSession(request);
    if (url.pathname.startsWith('/api/admin/')) return this.handleAdmin(request, url);
    return new Response('Not found', { status: 404 });
  }

  private async handleUpgrade(request: Request): Promise<Response> {
    if (request.method !== 'GET') return new Response('WebSocket upgrade requires GET', { status: 405 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const requestUrl = new URL(request.url);
    const grant = await this.resolveAppSessionFromRequest(request);
    const attachment: SessionAttachment = {
      id: crypto.randomUUID(),
      challenge: randomToken(24),
      relay_host: requestUrl.host,
      app_id: grant?.app.id ?? null,
      app_session_expires_at: grant?.expiresAt ?? null,
      app_session_pubkey: grant?.subjectPubkey ?? null,
      authenticated_pubkeys: [],
      subscriptions: {},
      rate_window_started_at: Date.now(),
      rate_count: 0,
    };

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(attachment);
    server.send(JSON.stringify(['AUTH', attachment.challenge]));

    const headers = new Headers();
    const protocols = (request.headers.get('sec-websocket-protocol') ?? '').split(',').map(v => v.trim());
    if (protocols.includes('nostr')) headers.set('sec-websocket-protocol', 'nostr');
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  private bearerToken(request: Request): string | null {
    const auth = request.headers.get('authorization');
    if (!auth?.toLowerCase().startsWith('bearer ')) return null;
    const token = auth.slice(7).trim();
    return token || null;
  }

  private async appFromLongTermToken(token: string): Promise<AppRecord | null> {
    const tokenHash = await sha256Hex(token);
    const rows = this.sql.exec(
      'SELECT * FROM applications WHERE token_hash = ? AND enabled = 1 LIMIT 1',
      tokenHash,
    ).toArray() as SqlRow[];
    if (!rows.length) return null;
    const app = appFromRow(rows[0]);
    const now = Math.floor(Date.now() / 1000);
    if (app.expires_at !== null && app.expires_at <= now) return null;
    return app;
  }

  private async issueAppSession(request: Request): Promise<Response> {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    const token = this.bearerToken(request);
    if (!token) return json({ error: 'unauthorized' }, 401);
    const app = await this.appFromLongTermToken(token);
    if (!app) return json({ error: 'unauthorized' }, 401);

    let body: Record<string, unknown>;
    try { body = await request.json() as Record<string, unknown>; }
    catch { return json({ error: 'invalid_json' }, 400); }

    const subjectRaw = body.subject;
    let subjectPubkey: string | null = null;
    if (subjectRaw !== undefined && subjectRaw !== null && subjectRaw !== '') {
      subjectPubkey = normalizePubkey(String(subjectRaw));
      if (!subjectPubkey) return json({ error: 'invalid_subject_pubkey' }, 400);
    }
    const ttl = body.ttl === undefined ? 600 : Number(body.ttl);
    if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 3600) return json({ error: 'invalid_ttl' }, 400);

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + ttl;
    const sessionToken = `nrs_${randomToken(32)}`;
    const sessionHash = await sha256Hex(sessionToken);

    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM app_sessions WHERE expires_at <= ?', now);
      this.sql.exec(
        'INSERT INTO app_sessions(token_hash, app_id, subject_pubkey, expires_at, created_at) VALUES(?, ?, ?, ?, ?)',
        sessionHash, app.id, subjectPubkey, expiresAt, now,
      );
    });

    return json({
      bindingVersion: 1,
      token: sessionToken,
      appId: app.id,
      subject: subjectPubkey,
      scope: 'relay',
      expiresAt,
    }, 201);
  }

  private async resolveAppSessionFromRequest(request: Request): Promise<AppSessionGrant | null> {
    let token = this.bearerToken(request);
    if (!token) {
      const protocols = (request.headers.get('sec-websocket-protocol') ?? '').split(',').map(v => v.trim());
      const appProtocol = protocols.find(v => v.startsWith('relay-app.'));
      if (appProtocol) token = appProtocol.slice('relay-app.'.length);
    }
    if (!token) return null;

    const tokenHash = await sha256Hex(token);
    const now = Math.floor(Date.now() / 1000);
    const rows = this.sql.exec(
      `SELECT a.*, s.subject_pubkey, s.expires_at AS session_expires_at
       FROM app_sessions s
       JOIN applications a ON a.id = s.app_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND a.enabled = 1
       LIMIT 1`,
      tokenHash, now,
    ).toArray() as SqlRow[];
    if (!rows.length) return null;

    const app = appFromRow(rows[0]);
    if (app.expires_at !== null && app.expires_at <= now) return null;
    if (app.type === 'web' && app.allowed_origins.length) {
      const origin = request.headers.get('origin');
      if (!origin) return null;
      let normalized: string;
      try { normalized = new URL(origin).origin; } catch { return null; }
      if (!app.allowed_origins.includes(normalized)) return null;
    }

    const rawSubject = rows[0].subject_pubkey;
    return {
      app,
      subjectPubkey: rawSubject === null || rawSubject === undefined || rawSubject === '' ? null : String(rawSubject),
      expiresAt: Number(rows[0].session_expires_at),
    };
  }

  private session(ws: WebSocket): SessionAttachment {
    const attachment = ws.deserializeAttachment() as SessionAttachment | null;
    if (!attachment) throw new Error('missing websocket session');
    return attachment;
  }

  private saveSession(ws: WebSocket, session: SessionAttachment): void {
    ws.serializeAttachment(session);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      if (typeof message !== 'string') {
        ws.send(JSON.stringify(['NOTICE', 'binary messages are not supported']));
        return;
      }
      const parsed = JSON.parse(message);
      if (!Array.isArray(parsed) || typeof parsed[0] !== 'string') {
        ws.send(JSON.stringify(['NOTICE', 'invalid message']));
        return;
      }

      switch (parsed[0]) {
        case 'AUTH': await this.handleAuth(ws, parsed); break;
        case 'EVENT': await this.handleEvent(ws, parsed, encoder.encode(message).byteLength); break;
        case 'REQ': await this.handleReq(ws, parsed); break;
        case 'CLOSE': this.handleClose(ws, parsed); break;
        default: ws.send(JSON.stringify(['NOTICE', 'unsupported message type']));
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : 'internal error';
      ws.send(JSON.stringify(['NOTICE', messageText]));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    try { ws.close(code, reason); } catch { /* already closed */ }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try { ws.close(1011, 'websocket error'); } catch { /* already closed */ }
  }

  private async handleAuth(ws: WebSocket, msg: unknown[]): Promise<void> {
    const event = msg[1];
    const id = isValidEventShape(event) ? event.id : '';
    if (!isValidEventShape(event) || event.kind !== 22242 || !verifyEvent(event)) {
      ws.send(JSON.stringify(['OK', id, false, 'invalid: invalid NIP-42 auth event']));
      return;
    }

    const session = this.session(ws);
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(event.created_at - now) > 600) {
      ws.send(JSON.stringify(['OK', event.id, false, 'invalid: auth event timestamp is too far from current time']));
      return;
    }
    if (getChallengeTag(event) !== session.challenge) {
      ws.send(JSON.stringify(['OK', event.id, false, 'invalid: auth challenge does not match']));
      return;
    }
    const relayTag = getRelayTag(event);
    if (!relayTag || !relayTagMatchesHost(relayTag, session.relay_host)) {
      ws.send(JSON.stringify(['OK', event.id, false, 'invalid: relay tag does not match this relay']));
      return;
    }

    if (!session.authenticated_pubkeys.includes(event.pubkey)) {
      session.authenticated_pubkeys = [...session.authenticated_pubkeys, event.pubkey].slice(-8);
      this.saveSession(ws, session);
    }
    ws.send(JSON.stringify(['OK', event.id, true, '']));
  }

  private getAppById(id: string | null): AppRecord | null {
    if (!id) return null;
    const rows = this.sql.exec('SELECT * FROM applications WHERE id = ? LIMIT 1', id).toArray() as SqlRow[];
    return rows.length ? appFromRow(rows[0]) : null;
  }

  private getUsers(pubkeys: string[]): UserRecord[] {
    if (!pubkeys.length) return [];
    const placeholders = pubkeys.map(() => '?').join(',');
    const rows = this.sql.exec(`SELECT * FROM users WHERE pubkey IN (${placeholders})`, ...pubkeys).toArray() as SqlRow[];
    return rows.map(userFromRow);
  }

  private accessContext(session: SessionAttachment): { app: AppRecord | null; users: UserRecord[]; authenticatedPubkeys: string[] } {
    const now = Math.floor(Date.now() / 1000);
    const appSessionActive = !!session.app_id
      && typeof session.app_session_expires_at === 'number'
      && session.app_session_expires_at > now;
    const authenticatedPubkeys = [...session.authenticated_pubkeys];
    if (appSessionActive && session.app_session_pubkey && !authenticatedPubkeys.includes(session.app_session_pubkey)) {
      authenticatedPubkeys.push(session.app_session_pubkey);
    }
    return {
      app: appSessionActive ? this.getAppById(session.app_id) : null,
      users: this.getUsers(authenticatedPubkeys),
      authenticatedPubkeys,
    };
  }


  private recordRead(eventsReturned: number, denied: boolean): void {
    const now = Math.floor(Date.now() / 1000);
    this.sql.exec(
      `UPDATE relay_metrics
       SET read_requests = read_requests + 1,
           read_events = read_events + ?,
           read_denied = read_denied + ?,
           last_read_at = ?
       WHERE id = 1`,
      Math.max(0, eventsReturned), denied ? 1 : 0, now,
    );
  }

  private recordWrite(accepted: boolean): void {
    const now = Math.floor(Date.now() / 1000);
    this.sql.exec(
      `UPDATE relay_metrics
       SET write_attempts = write_attempts + 1,
           write_accepted = write_accepted + ?,
           write_denied = write_denied + ?,
           last_write_at = ?
       WHERE id = 1`,
      accepted ? 1 : 0, accepted ? 0 : 1, now,
    );
  }

  private getRelayStats(): Record<string, unknown> {
    const metricRows = this.sql.exec('SELECT * FROM relay_metrics WHERE id = 1').toArray() as SqlRow[];
    const metrics = metricRows[0] ?? {};
    const count = (sql: string, ...bindings: SqlStorageValue[]) => {
      const rows = this.sql.exec(sql, ...bindings).toArray() as SqlRow[];
      return Number(rows[0]?.count ?? 0);
    };
    const sockets = this.ctx.getWebSockets();
    let activeSubscriptions = 0;
    for (const socket of sockets) {
      const session = socket.deserializeAttachment() as SessionAttachment | null;
      if (session) activeSubscriptions += Object.keys(session.subscriptions ?? {}).length;
    }
    const now = Math.floor(Date.now() / 1000);
    const recentWrites = (this.sql.exec(
      'SELECT id, pubkey, created_at, kind FROM events ORDER BY created_at DESC, id ASC LIMIT 20',
    ).toArray() as SqlRow[]).map(row => ({
      id: String(row.id),
      pubkey: String(row.pubkey),
      created_at: Number(row.created_at),
      kind: Number(row.kind),
    }));

    return {
      active_connections: sockets.length,
      active_subscriptions: activeSubscriptions,
      active_app_sessions: count('SELECT COUNT(*) AS count FROM app_sessions WHERE expires_at > ?', now),
      stored_events: count('SELECT COUNT(*) AS count FROM events'),
      database_bytes: this.sql.databaseSize,
      read_requests: Number(metrics.read_requests ?? 0),
      read_events: Number(metrics.read_events ?? 0),
      read_denied: Number(metrics.read_denied ?? 0),
      write_attempts: Number(metrics.write_attempts ?? 0),
      write_accepted: Number(metrics.write_accepted ?? 0),
      write_denied: Number(metrics.write_denied ?? 0),
      last_read_at: metrics.last_read_at === null || metrics.last_read_at === undefined ? null : Number(metrics.last_read_at),
      last_write_at: metrics.last_write_at === null || metrics.last_write_at === undefined ? null : Number(metrics.last_write_at),
      recent_writes: recentWrites,
    };
  }

  private async handleReq(ws: WebSocket, msg: unknown[]): Promise<void> {
    const settings = this.getSettings();
    const subId = msg[1];
    const filters = msg.slice(2);
    if (typeof subId !== 'string' || !subId.length || subId.length > 64) {
      this.recordRead(0, true);
      ws.send(JSON.stringify(['NOTICE', 'invalid subscription id']));
      return;
    }
    if (!filters.length || filters.length > settings.max_filters || !filters.every(isValidFilter)) {
      this.recordRead(0, true);
      ws.send(JSON.stringify(['CLOSED', subId, 'invalid: invalid or excessive filters']));
      return;
    }

    const session = this.session(ws);
    const existing = Object.keys(session.subscriptions);
    if (!session.subscriptions[subId] && existing.length >= settings.max_subscriptions) {
      this.recordRead(0, true);
      ws.send(JSON.stringify(['CLOSED', subId, 'restricted: too many subscriptions']));
      return;
    }

    const typedFilters = filters as NostrFilter[];
    const decision = evaluateRead(settings, this.accessContext(session), typedFilters);
    if (!decision.allowed) {
      this.recordRead(0, true);
      ws.send(JSON.stringify(['CLOSED', subId, formatDecision(decision.prefix, decision.reason)]));
      return;
    }

    const events = new Map<string, NostrEvent>();
    for (const filter of typedFilters) {
      for (const event of this.queryFilter(filter, settings)) events.set(event.id, event);
    }
    const ordered = [...events.values()].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
    this.recordRead(ordered.length, false);
    for (const event of ordered) ws.send(JSON.stringify(['EVENT', subId, event]));
    ws.send(JSON.stringify(['EOSE', subId]));

    session.subscriptions[subId] = typedFilters;
    this.saveSession(ws, session);
  }

  private handleClose(ws: WebSocket, msg: unknown[]): void {
    const subId = msg[1];
    if (typeof subId !== 'string') return;
    const session = this.session(ws);
    delete session.subscriptions[subId];
    this.saveSession(ws, session);
  }

  private queryFilter(filter: NostrFilter, settings: RelaySettings): NostrEvent[] {
    const termCount = (filter.ids?.length ?? 0) + (filter.authors?.length ?? 0) + (filter.kinds?.length ?? 0) +
      Object.entries(filter).filter(([k]) => k.startsWith('#')).reduce((sum, [, value]) => sum + ((value as string[]).length ?? 0), 0);
    if (termCount > 80) return [];

    const where: string[] = ['(e.expires_at IS NULL OR e.expires_at > ?)'];
    const bindings: SqlStorageValue[] = [Math.floor(Date.now() / 1000)];

    if (filter.ids?.length) {
      where.push(`(${filter.ids.map(() => 'e.id LIKE ?').join(' OR ')})`);
      bindings.push(...filter.ids.map(v => `${v}%`));
    }
    if (filter.authors?.length) {
      where.push(`(${filter.authors.map(() => 'e.pubkey LIKE ?').join(' OR ')})`);
      bindings.push(...filter.authors.map(v => `${v}%`));
    }
    if (filter.kinds?.length) {
      where.push(`e.kind IN (${filter.kinds.map(() => '?').join(',')})`);
      bindings.push(...filter.kinds);
    }
    if (filter.since !== undefined) { where.push('e.created_at >= ?'); bindings.push(filter.since); }
    if (filter.until !== undefined) { where.push('e.created_at <= ?'); bindings.push(filter.until); }

    for (const [key, raw] of Object.entries(filter)) {
      if (!key.startsWith('#')) continue;
      const values = raw as string[];
      if (!values.length) return [];
      where.push(`EXISTS (SELECT 1 FROM event_tags t WHERE t.event_id = e.id AND t.name = ? AND t.value IN (${values.map(() => '?').join(',')}))`);
      bindings.push(key.slice(1), ...values);
    }

    const requested = filter.limit ?? settings.default_limit;
    const limit = Math.max(0, Math.min(requested, settings.max_limit));
    if (limit === 0) return [];
    bindings.push(limit);
    const rows = this.sql.exec(
      `SELECT e.* FROM events e WHERE ${where.join(' AND ')} ORDER BY e.created_at DESC, e.id ASC LIMIT ?`,
      ...bindings,
    ).toArray() as SqlRow[];
    return rows.map(eventFromRow);
  }

  private async handleEvent(ws: WebSocket, msg: unknown[], bytes: number): Promise<void> {
    const settings = this.getSettings();
    const candidate = msg[1];
    const id = isValidEventShape(candidate) ? candidate.id : '';
    if (bytes > settings.max_event_bytes) {
      this.recordWrite(false);
      ws.send(JSON.stringify(['OK', id, false, 'invalid: event message exceeds relay size limit']));
      return;
    }
    if (!isValidEventShape(candidate) || !verifyEvent(candidate)) {
      this.recordWrite(false);
      ws.send(JSON.stringify(['OK', id, false, 'invalid: event id or signature is invalid']));
      return;
    }
    const event = candidate as NostrEvent;
    if (event.kind === 22242) {
      this.recordWrite(false);
      ws.send(JSON.stringify(['OK', event.id, false, 'invalid: kind 22242 is reserved for AUTH']));
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    if (event.created_at > now + settings.max_future_seconds) {
      this.recordWrite(false);
      ws.send(JSON.stringify(['OK', event.id, false, 'invalid: event timestamp is too far in the future']));
      return;
    }
    const expiration = getExpiration(event);
    if (expiration !== null && expiration <= now) {
      this.recordWrite(false);
      ws.send(JSON.stringify(['OK', event.id, false, 'blocked: event is already expired']));
      return;
    }

    const session = this.session(ws);
    const ctx = this.accessContext(session);
    const decision = evaluateWrite(settings, ctx, event.kind);
    if (!decision.allowed) {
      this.recordWrite(false);
      ws.send(JSON.stringify(['OK', event.id, false, formatDecision(decision.prefix, decision.reason)]));
      return;
    }
    if (!this.consumeRate(session, ctx.app?.rate_limit ?? settings.default_rate_limit)) {
      this.saveSession(ws, session);
      this.recordWrite(false);
      ws.send(JSON.stringify(['OK', event.id, false, 'rate-limited: write rate exceeded']));
      return;
    }
    this.saveSession(ws, session);

    const existing = this.sql.exec('SELECT id FROM events WHERE id = ? LIMIT 1', event.id).toArray();
    if (existing.length) {
      this.recordWrite(true);
      ws.send(JSON.stringify(['OK', event.id, true, 'duplicate: already stored']));
      return;
    }

    if (!isEphemeralKind(event.kind)) {
      const stored = this.storeEvent(event, expiration);
      if (!stored) {
        this.recordWrite(true);
        ws.send(JSON.stringify(['OK', event.id, true, 'duplicate: newer replaceable event already stored']));
        return;
      }
      if (event.kind === 5) this.applyDeletion(event);
    }

    this.recordWrite(true);
    ws.send(JSON.stringify(['OK', event.id, true, '']));
    this.broadcast(event);
  }

  private consumeRate(session: SessionAttachment, limit: number): boolean {
    if (limit <= 0) return true;
    const now = Date.now();
    if (now - session.rate_window_started_at >= 60_000) {
      session.rate_window_started_at = now;
      session.rate_count = 0;
    }
    session.rate_count += 1;
    return session.rate_count <= limit;
  }

  private storeEvent(event: NostrEvent, expiresAt: number | null): boolean {
    const dTag = getDTag(event);
    if (isReplaceableKind(event.kind) || isParameterizedReplaceableKind(event.kind)) {
      const rows = this.sql.exec(
        'SELECT id, created_at FROM events WHERE pubkey = ? AND kind = ? AND d_tag = ? ORDER BY created_at DESC, id ASC LIMIT 1',
        event.pubkey, event.kind, isParameterizedReplaceableKind(event.kind) ? dTag : '',
      ).toArray() as SqlRow[];
      if (rows.length) {
        const current = rows[0];
        const currentCreated = Number(current.created_at);
        const currentId = String(current.id);
        if (currentCreated > event.created_at || (currentCreated === event.created_at && currentId.localeCompare(event.id) < 0)) return false;
        this.sql.exec('DELETE FROM events WHERE pubkey = ? AND kind = ? AND d_tag = ?', event.pubkey, event.kind, isParameterizedReplaceableKind(event.kind) ? dTag : '');
      }
    }

    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        'INSERT INTO events(id,pubkey,created_at,kind,d_tag,content,sig,tags_json,expires_at) VALUES(?,?,?,?,?,?,?,?,?)',
        event.id, event.pubkey, event.created_at, event.kind, isParameterizedReplaceableKind(event.kind) ? dTag : '', event.content, event.sig, JSON.stringify(event.tags), expiresAt,
      );
      for (const tag of event.tags) {
        if (tag.length < 2 || tag[0].length !== 1 || !/^[A-Za-z]$/.test(tag[0])) continue;
        this.sql.exec('INSERT OR IGNORE INTO event_tags(event_id,name,value) VALUES(?,?,?)', event.id, tag[0], tag[1]);
      }
    });
    return true;
  }

  private applyDeletion(event: NostrEvent): void {
    for (const tag of event.tags) {
      if (tag[0] === 'e' && tag[1]) {
        const rows = this.sql.exec('SELECT pubkey, kind FROM events WHERE id = ? LIMIT 1', tag[1]).toArray() as SqlRow[];
        if (rows.length && String(rows[0].pubkey) === event.pubkey && Number(rows[0].kind) !== 5) this.sql.exec('DELETE FROM events WHERE id = ?', tag[1]);
      }
      if (tag[0] === 'a' && tag[1]) {
        const parts = tag[1].split(':');
        if (parts.length < 3) continue;
        const kind = Number(parts[0]);
        const pubkey = parts[1];
        const dTag = parts.slice(2).join(':');
        if (!Number.isInteger(kind) || pubkey !== event.pubkey) continue;
        this.sql.exec('DELETE FROM events WHERE pubkey = ? AND kind = ? AND d_tag = ? AND created_at <= ? AND kind != 5', pubkey, kind, dTag, event.created_at);
      }
    }
  }

  private broadcast(event: NostrEvent): void {
    for (const socket of this.ctx.getWebSockets()) {
      const session = socket.deserializeAttachment() as SessionAttachment | null;
      if (!session) continue;
      for (const [subId, filters] of Object.entries(session.subscriptions ?? {})) {
        if (filters.some(filter => eventMatchesFilter(event, filter))) {
          try { socket.send(JSON.stringify(['EVENT', subId, event])); } catch { /* disconnected */ }
        }
      }
    }
  }

  private async handleAdmin(request: Request, url: URL): Promise<Response> {
    try {
      if (request.method === 'GET' && url.pathname === '/api/admin/state') {
        return json({ settings: this.getSettings(), apps: this.listApps(), users: this.listUsers(), stats: this.getRelayStats(), database_bytes: this.sql.databaseSize });
      }
      if (request.method === 'GET' && url.pathname === '/api/admin/stats') {
        return json(this.getRelayStats());
      }
      if (request.method === 'PUT' && url.pathname === '/api/admin/settings') {
        const body = await request.json() as Record<string, unknown>;
        this.updateSettings(body);
        this.disconnectAll('relay policy changed');
        return json({ ok: true });
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/apps') {
        const result = await this.createApp(await request.json() as Record<string, unknown>);
        this.disconnectAll('application access list changed');
        return json(result, 201);
      }
      if (request.method === 'DELETE' && url.pathname.startsWith('/api/admin/apps/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/admin/apps/'.length));
        this.sql.exec('DELETE FROM applications WHERE id = ?', id);
        this.disconnectAll('application access list changed');
        return json({ ok: true });
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/users') {
        const result = this.createUser(await request.json() as Record<string, unknown>);
        this.disconnectAll('user access list changed');
        return json(result, 201);
      }
      if (request.method === 'DELETE' && url.pathname.startsWith('/api/admin/users/')) {
        const pubkey = normalizePubkey(decodeURIComponent(url.pathname.slice('/api/admin/users/'.length)));
        if (!pubkey) return json({ error: 'invalid pubkey' }, 400);
        this.sql.exec('DELETE FROM users WHERE pubkey = ?', pubkey);
        this.disconnectAll('user access list changed');
        return json({ ok: true });
      }
      return json({ error: 'not found' }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'bad request' }, 400);
    }
  }

  private listApps(): AppRecord[] {
    return (this.sql.exec('SELECT * FROM applications ORDER BY created_at DESC').toArray() as SqlRow[]).map(appFromRow);
  }

  private listUsers(): UserRecord[] {
    return (this.sql.exec('SELECT * FROM users ORDER BY created_at DESC').toArray() as SqlRow[]).map(userFromRow);
  }

  private updateSettings(body: Record<string, unknown>): void {
    const current = this.getSettings();
    const next: RelaySettings = { ...current };
    if (typeof body.relay_name === 'string') next.relay_name = body.relay_name.slice(0, 120);
    if (typeof body.relay_description === 'string') next.relay_description = body.relay_description.slice(0, 500);
    if (typeof body.read_policy === 'string' && ACCESS_MODES.has(body.read_policy)) next.read_policy = body.read_policy as RelaySettings['read_policy'];
    if (typeof body.write_policy === 'string' && ACCESS_MODES.has(body.write_policy)) next.write_policy = body.write_policy as RelaySettings['write_policy'];

    const numeric: Array<[keyof RelaySettings, number, number]> = [
      ['default_limit', 1, 500], ['max_limit', 1, 1000], ['max_filters', 1, 20], ['max_subscriptions', 1, 100],
      ['max_event_bytes', 1024, 1048576], ['max_future_seconds', 0, 86400], ['default_rate_limit', 1, 10000],
    ];
    for (const [key, min, max] of numeric) {
      if (body[key] === undefined) continue;
      const value = Number(body[key]);
      if (!Number.isInteger(value) || value < min || value > max) throw new Error(`invalid ${String(key)}`);
      (next as unknown as Record<string, unknown>)[key] = value;
    }
    if (next.default_limit > next.max_limit) throw new Error('default_limit cannot exceed max_limit');

    for (const [key, value] of Object.entries(next)) {
      this.sql.exec('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
    }
  }

  private async createApp(body: Record<string, unknown>): Promise<{ app: AppRecord; token: string }> {
    const name = String(body.name ?? '').trim();
    if (!name || name.length > 120) throw new Error('application name is required');
    const type = String(body.type ?? 'service');
    if (!APP_TYPES.has(type)) throw new Error('invalid application type');
    const canRead = body.can_read !== false;
    const canWrite = body.can_write !== false;
    const kinds = allowedKinds(body.allowed_kinds);
    const origins = normalizeOrigins(body.allowed_origins);
    const rateLimit = Number(body.rate_limit ?? 120);
    if (!Number.isInteger(rateLimit) || rateLimit < 1 || rateLimit > 10000) throw new Error('invalid rate_limit');
    const expiresAt = body.expires_at === null || body.expires_at === undefined ? null : Number(body.expires_at);
    if (expiresAt !== null && (!Number.isInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000))) throw new Error('invalid expires_at');

    const token = `nra_${randomToken(32)}`;
    const tokenHash = await sha256Hex(token);
    const id = `app_${randomToken(9)}`;
    const createdAt = Math.floor(Date.now() / 1000);
    this.sql.exec(
      'INSERT INTO applications(id,name,type,token_hash,enabled,can_read,can_write,allowed_kinds,allowed_origins,rate_limit,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      id, name, type, tokenHash, 1, canRead ? 1 : 0, canWrite ? 1 : 0, kinds === null ? null : JSON.stringify(kinds), JSON.stringify(origins), rateLimit, expiresAt, createdAt,
    );
    const app = appFromRow((this.sql.exec('SELECT * FROM applications WHERE id=?', id).toArray() as SqlRow[])[0]);
    return { app, token };
  }

  private createUser(body: Record<string, unknown>): { user: UserRecord } {
    const pubkey = normalizePubkey(String(body.pubkey ?? ''));
    if (!pubkey) throw new Error('invalid npub or hex pubkey');
    const name = String(body.name ?? '').trim().slice(0, 120);
    const canRead = body.can_read !== false;
    const canWrite = body.can_write !== false;
    const kinds = allowedKinds(body.allowed_kinds);
    const expiresAt = body.expires_at === null || body.expires_at === undefined ? null : Number(body.expires_at);
    if (expiresAt !== null && (!Number.isInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000))) throw new Error('invalid expires_at');
    const createdAt = Math.floor(Date.now() / 1000);
    this.sql.exec(
      `INSERT INTO users(pubkey,name,enabled,can_read,can_write,allowed_kinds,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(pubkey) DO UPDATE SET name=excluded.name,enabled=1,can_read=excluded.can_read,can_write=excluded.can_write,allowed_kinds=excluded.allowed_kinds,expires_at=excluded.expires_at`,
      pubkey, name, 1, canRead ? 1 : 0, canWrite ? 1 : 0, kinds === null ? null : JSON.stringify(kinds), expiresAt, createdAt,
    );
    const user = userFromRow((this.sql.exec('SELECT * FROM users WHERE pubkey=?', pubkey).toArray() as SqlRow[])[0]);
    return { user };
  }

  private disconnectAll(reason: string): void {
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.close(1012, reason); } catch { /* disconnected */ }
    }
  }
}
