# Local Relay Performance Baseline

This benchmarks an **isolated loopback-only Wrangler instance** of Baipiao, not a deployed relay. The script rejects non-loopback targets and requires a local admin token.

Measurements:
- Pre-signed, verified Nostr EVENT writes with 1 or 4 authenticated NIP-42 connections (ACK latency + throughput).
- Historical REQ-to-EOSE latency across kind+author, kind+tag, and combined indexed filters.
- Live delivery fan-out to 10 subscriptions (delivery integrity and send-to-receipt latency).
- Stored event count and SQLite database size.

## Local run

Install dependencies with `npm install`. Start a disposable server in one terminal:

```bash
printf 'ADMIN_TOKEN=benchmark-only-local-secret\n' > .dev.vars
npx wrangler dev --local --ip 127.0.0.1 --port 8787
```

Then run in another terminal:

```bash
BENCH_ADMIN_TOKEN=benchmark-only-local-secret BENCH_JSON=baseline.json BENCH_MARKDOWN=baseline.md node bench/relay.mjs
```

Do **not** use production endpoints or production admin tokens. The workflow uses an ephemeral GitHub runner, its own local test credential and local Durable Object database; it does not deploy anything. It can be run manually from Actions after merging, or automatically on benchmark-file PRs.

P50/P95/P99 are client-observed round trips, with client signing done before each measured phase. They are not direct Cloudflare-edge production throughput numbers. Run at least three repetitions for comparisons, use the same runner and workload, and record variability before claiming speedups.
