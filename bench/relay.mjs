#!/usr/bin/env node
// Baipiao end-to-end baseline: local-only, pre-signed test events, verified ACK/EOSE/fanout.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

const base = new URL(process.env.BENCH_URL || 'http://127.0.0.1:8787');
assert.equal(base.protocol, 'http:', 'Only local HTTP benchmarks permitted');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Refusing to benchmark a remote relay');
assert.ok(!base.username && !base.password, 'No credentials in BENCH_URL');
assert.ok(process.env.BENCH_ADMIN_TOKEN, 'BENCH_ADMIN_TOKEN required');
const relay = new URL('/relay', base).href.replace(/^http/, 'ws');
const secret = randomBytes(32);
const pubkey = bytesToHex(schnorr.getPublicKey(secret));
const runId = randomUUID();
let seq = 0;

function makeEvent(kind, tags, content) {
  const ev = { pubkey, created_at: Math.floor(Date.now() / 1000), kind, tags, content: runId + ':' + (++seq) + ':' + content };
  const serialized = JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]);
  const id = bytesToHex(sha256(utf8ToBytes(serialized)));
  return { ...ev, id, sig: bytesToHex(schnorr.sign(id, secret)) };
}
function events(n, label, tag = 'bench') {
  return Array.from({ length: n }, (_, i) => makeEvent(1, [['t', tag]], label + ':' + i + ':' + 'x'.repeat(192)));
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function withTimeout(promise, label, ms = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout: ' + label)), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, err => { clearTimeout(timer); reject(err); });
  });
}
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return +sorted[Math.max(0, Math.ceil(values.length * p) - 1)].toFixed(2);
}
function summarize(samples, duration, ops = samples.length) {
  return { operations: ops, ops_per_sec: +(ops * 1000 / Math.max(duration, .001)).toFixed(2),
    elapsed_ms: +duration.toFixed(2), p50_ms: percentile(samples, .5),
    p95_ms: percentile(samples, .95), p99_ms: percentile(samples, .99) };
}
async function admin(path, method = 'GET', body) {
  const res = await fetch(new URL(path, base), {
    method, headers: { authorization: 'Bearer ' + process.env.BENCH_ADMIN_TOKEN, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await res.json();
  assert.ok(res.ok, 'Admin failed ' + path + ' ' + res.status + ' ' + JSON.stringify(data));
  return data;
}
class Client {
  constructor() {
    this.oks = new Map();
    this.reqs = new Map();
    this.live = new Map();
    this.challenge = new Promise(resolve => { this.challengeResolve = resolve; });
    this.ws = new WebSocket(relay, ['nostr']);
    this.ws.addEventListener('message', raw => {
      try {
        const msg = JSON.parse(raw.data);
        if (msg[0] === 'AUTH') this.challengeResolve(msg[1]);
        if (msg[0] === 'OK') {
          const done = this.oks.get(msg[1]);
          if (done) { this.oks.delete(msg[1]); done(msg); }
        }
        if (msg[0] === 'EVENT') {
          const query = this.reqs.get(msg[1]);
          if (query) { query.count++; query.first ||= performance.now(); }
          const live = this.live.get(msg[1]);
          if (live) live.set(msg[2].id, performance.now());
        }
        if (msg[0] === 'EOSE') {
          const query = this.reqs.get(msg[1]);
          if (query) { this.reqs.delete(msg[1]); query.resolve({ count: query.count, first: query.first }); }
        }
        if (msg[0] === 'NOTICE') {
          const notice = String(msg[1]);
          this.lastNotice = notice;
          for (const [id, q] of this.reqs) { this.reqs.delete(id); q.reject(new Error('Relay NOTICE: ' + notice)); }
        }
        if (msg[0] === 'CLOSED') {
          const query = this.reqs.get(msg[1]);
          if (query) { this.reqs.delete(msg[1]); query.reject(new Error('REQ closed: ' + msg[2])); }
        }
      } catch (err) { this.messageError = err; }
    });
  }
  async init() {
    await withTimeout(new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('WebSocket error')), { once: true });
    }), 'open');
    const challenge = await withTimeout(this.challenge, 'NIP-42 challenge');
    const auth = makeEvent(22242, [['relay', relay], ['challenge', challenge]], '');
    const ack = await this.sendAndAck('AUTH', auth);
    assert.equal(ack[2], true, 'NIP-42 rejected ' + ack[3]);
    return this;
  }
  async sendAndAck(operation, ev) {
    const promise = new Promise(resolve => this.oks.set(ev.id, resolve));
    this.ws.send(JSON.stringify([operation, ev]));
    try { return await withTimeout(promise, operation + ' ACK'); }
    finally { this.oks.delete(ev.id); }
  }
  async write(ev) {
    const start = performance.now();
    const ack = await this.sendAndAck('EVENT', ev);
    assert.equal(ack[2], true, 'EVENT rejected: ' + ack[3]);
    assert.ok(!String(ack[3]).includes('duplicate'), 'Unexpected duplicate event');
    return performance.now() - start;
  }
  async query(filter, id = 'q-' + randomUUID()) {
    const start = performance.now();
    const promise = new Promise((resolve, reject) => this.reqs.set(id, { count: 0, first: 0, resolve, reject }));
    this.ws.send(JSON.stringify(['REQ', id, filter]));
    let result;
    try { result = await withTimeout(promise, 'REQ EOSE ' + id); }
    catch (error) { throw new Error(String(error.message) + ' notice=' + (this.lastNotice || '(none)') + ' messageError=' + (this.messageError || '(none)')); }
    finally { this.reqs.delete(id); }
    const end = performance.now();
    this.ws.send(JSON.stringify(['CLOSE', id]));
    return { elapsed: end - start, count: result.count, first: result.first ? result.first - start : null };
  }
  async subscribe(id, filter) {
    const deliveries = new Map();
    this.live.set(id, deliveries);
    const promise = new Promise((resolve, reject) => this.reqs.set(id, { count: 0, first: 0, resolve, reject }));
    this.ws.send(JSON.stringify(['REQ', id, filter]));
    try { await withTimeout(promise, 'subscribe EOSE ' + id); }
    finally { this.reqs.delete(id); }
    return deliveries;
  }
  close() { try { this.ws.close(); } catch {} }
}
async function openMany(n) { return Promise.all(Array.from({ length: n }, () => new Client().init())); }
async function writes(items, concurrent) {
  const clients = await openMany(concurrent);
  const shards = Array.from({ length: concurrent }, () => []);
  items.forEach((ev, i) => shards[i % concurrent].push(ev));
  const latencies = [];
  try {
    const started = performance.now();
    await Promise.all(clients.map(async (client, i) => {
      for (const ev of shards[i]) latencies.push(await client.write(ev));
    }));
    return summarize(latencies, performance.now() - started, items.length);
  } finally { clients.forEach(client => client.close()); }
}
async function reads(name, filter) {
  const [client] = await openMany(1);
  const timings = [], counts = [];
  try {
    await client.query(filter); // warmup before timed queries
    const started = performance.now();
    for (let i = 0; i < 30; i++) {
      const q = await client.query(filter);
      timings.push(q.elapsed);
      counts.push(q.count);
    }
    assert.ok(counts.every(v => v > 0), 'Empty results for ' + name);
    return { name, ...summarize(timings, performance.now() - started), returned_min: Math.min(...counts), returned_max: Math.max(...counts) };
  } finally { client.close(); }
}
async function fanout() {
  const clients = await openMany(10);
  const [writer] = await openMany(1);
  const tag = 'live-' + runId;
  const liveEvents = events(30, 'live', tag);
  const sendTimes = new Map(), acks = [];
  try {
    const recorders = await Promise.all(clients.map((c, i) => c.subscribe('live-' + i, { kinds: [1], '#t': [tag], limit: 1 })));
    const started = performance.now();
    for (const ev of liveEvents) {
      sendTimes.set(ev.id, performance.now());
      acks.push(await writer.write(ev));
    }
    const deadline = Date.now() + 15000;
    while (recorders.some(m => m.size !== liveEvents.length) && Date.now() < deadline) await sleep(10);
    const elapsed = performance.now() - started;
    const deliveryLatencies = [];
    for (const recorder of recorders) {
      assert.equal(recorder.size, liveEvents.length, 'Missing live deliveries');
      for (const [id, when] of recorder) deliveryLatencies.push(when - sendTimes.get(id));
    }
    return { write: summarize(acks, elapsed), subscribers: clients.length, expected: clients.length * liveEvents.length,
      delivered: deliveryLatencies.length, delivery_p50_ms: percentile(deliveryLatencies, .5),
      delivery_p95_ms: percentile(deliveryLatencies, .95), delivery_p99_ms: percentile(deliveryLatencies, .99) };
  } finally { [...clients, writer].forEach(c => c.close()); }
}
function makeMarkdown(r) {
  const row = (name, s) => '| ' + name + ' | ' + s.operations + ' | ' + s.ops_per_sec +
    ' | ' + s.p50_ms + ' | ' + s.p95_ms + ' | ' + s.p99_ms + ' |';
  return ['# Baipiao isolated baseline', '',
    'GitHub Actions local Wrangler / SQLite Durable Object. Not a production Cloudflare benchmark or a Ditto/strfry comparison.', '',
    'Revision: ' + r.revision + ' | Node: ' + r.node + ' | Date: ' + r.timestamp, '',
    '| Workload | Ops | Ops/s | P50 ms | P95 ms | P99 ms |',
    '|---|---:|---:|---:|---:|---:|',
    row('Seed writes (4 connections)', r.runs.seed),
    row('Sequential writes (1 connection)', r.runs.sequential),
    row('Concurrent writes (4 connections)', r.runs.parallel),
    ...r.runs.queries.map(q => row('REQ+EOSE ' + q.name, q)),
    row('Fanout writes (10 subscribers)', r.runs.fanout.write), '',
    'Fanout: ' + r.runs.fanout.delivered + '/' + r.runs.fanout.expected +
    ', delivery P95: ' + r.runs.fanout.delivery_p95_ms + ' ms', '',
    'Stored events: ' + r.before.stored_events + ' → ' + r.after.stored_events,
    'SQLite bytes: ' + r.before.database_bytes + ' → ' + r.after.database_bytes, '',
    'All writes authenticated via NIP-42 whitelist and signed before measurement. ' +
    'Sequential/event ACK and REQ→EOSE latencies are measured client-side.',
    'Compare multiple repetitions on similarly sized runners; network, CPU and scheduling vary.'].join('\n') + '\n';
}
async function main() {
  assert.equal(typeof WebSocket, 'function', 'Node 22+ required');
  const health = await fetch(new URL('/health', base));
  assert.ok(health.ok, 'Local relay /health failed');
  await admin('/api/admin/users', 'POST', { pubkey, name: 'Transient benchmark signer', can_read: true, can_write: true });
  const before = (await admin('/api/admin/state')).stats;
  const [warm] = await openMany(1);
  try { for (const ev of events(12, 'warm')) await warm.write(ev); }
  finally { warm.close(); }
  console.log('PHASE: seed writes');
  const seed = await writes(events(240, 'seed'), 4);
  console.log('PHASE: sequential writes');
  const sequential = await writes(events(60, 'sequential'), 1);
  console.log('PHASE: parallel writes');
  const parallel = await writes(events(240, 'parallel'), 4);
  console.log('PHASE: historical queries');
  const queries = [
    await reads('kind+author', { kinds: [1], authors: [pubkey], limit: 100 }),
    await reads('kind+tag', { kinds: [1], '#t': ['bench'], limit: 100 }),
    await reads('kind+author+tag', { kinds: [1], authors: [pubkey], '#t': ['bench'], limit: 100 })
  ];
  console.log('PHASE: live fanout');
  const distributed = await fanout();
  const after = (await admin('/api/admin/state')).stats;
  assert.equal(+after.stored_events - +before.stored_events, 12 + 240 + 60 + 240 + 30,
    'Storage count differs from acknowledged writes');
  const r = { timestamp: new Date().toISOString(), revision: process.env.GITHUB_SHA || 'local',
    node: process.version, before: { stored_events: before.stored_events, database_bytes: before.database_bytes },
    after: { stored_events: after.stored_events, database_bytes: after.database_bytes },
    runs: { seed, sequential, parallel, queries, fanout: distributed } };
  const md = makeMarkdown(r);
  if (process.env.BENCH_JSON) await writeFile(process.env.BENCH_JSON, JSON.stringify(r, null, 2) + '\n');
  if (process.env.BENCH_MARKDOWN) await writeFile(process.env.BENCH_MARKDOWN, md);
  console.log(md);
}
main().catch(err => { console.error(err); process.exitCode = 1; });
