# Cloudflare Nostr Relay

A Cloudflare-native Nostr relay with **application access control**, **NIP-42 user whitelists**, and a small owner dashboard. It is designed for relay owners who want a relay dedicated to their own application while optionally allowing other applications or individual Nostr users.

The project is intentionally application-neutral. It is not tied to any Nostr client.

## Goals

- One-click deployment to Cloudflare
- Free-tier friendly architecture
- No VPS, Docker, PostgreSQL, Redis, D1, KV, or R2 required
- Durable Objects with SQLite storage
- WebSocket Hibernation for long-lived relay connections
- App whitelist and per-app tokens
- NIP-42 user whitelist
- Independent read/write access policies
- Per-app/per-user event-kind restrictions
- Query and subscription guards to protect free-tier SQLite reads
- Admin dashboard

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ganlinlaomu/cloudflare-nostr-relay)

Cloudflare reads `wrangler.jsonc`, provisions the SQLite-backed Durable Object, asks for the required `ADMIN_TOKEN` secret, builds the Worker, and deploys it.

After deployment:

1. Open `https://<your-worker>.workers.dev/admin`.
2. Enter the `ADMIN_TOKEN` you configured during deployment.
3. Configure read/write policy.
4. Add your first application and copy its token. The raw token is shown only once.
5. Optionally add Nostr users by `npub` or hex pubkey.

## Access policies

Read and write policies are independent. Each can be set to:

- `public` — anyone
- `app` — approved applications only
- `user` — approved NIP-42 users only
- `app_or_user` — an approved app **or** approved user
- `app_and_user` — an approved app **and** approved NIP-42 user

A common dedicated-app configuration is:

- Read: `public`
- Write: `app_or_user`

This lets the owner's approved app write to the relay while also allowing individually whitelisted users to write from other Nostr clients after NIP-42 authentication.

## Application authentication

Creating an application in `/admin` returns an opaque token such as:

```text
nra_...
```

Only a SHA-256 hash of this token is stored by the relay.

### Native/server clients

When the client can set WebSocket upgrade headers:

```http
Authorization: Bearer nra_...
```

### Browser/PWA clients

Browser WebSocket APIs cannot set an `Authorization` header. Pass the token as a WebSocket subprotocol:

```js
const ws = new WebSocket('wss://relay.example.com', [
  'nostr',
  `relay-app.${APP_TOKEN}`,
]);
```

The relay selects the `nostr` subprotocol while using the `relay-app.*` value only for access control.

**Security note:** a secret embedded in public browser JavaScript cannot be treated as a confidential application credential. For `web` applications the relay can additionally restrict the token to exact allowed Origins. This raises the bar for casual reuse, but it is not cryptographic app attestation. Native apps can later add platform attestation outside the Nostr protocol if stronger app identity is required.

## User authentication

The relay implements NIP-42. A challenge is sent immediately after WebSocket connection:

```json
["AUTH", "<challenge>"]
```

The client replies with a signed `kind:22242` authentication event. The relay verifies:

- valid event ID and Schnorr signature
- `kind === 22242`
- timestamp within approximately 10 minutes
- exact challenge tag
- relay tag host matches this relay

The authenticated pubkey belongs to the **connection session**. Published event pubkeys do not have to equal the NIP-42 pubkey. This is important for NIP-59 gift wraps, which use ephemeral outer keys.

## Supported protocol behavior

Current first release advertises:

- NIP-01 — basic relay protocol and filters
- NIP-09 — deletion requests
- NIP-11 — relay information document
- NIP-40 — expiration timestamps
- NIP-42 — client authentication

NIP-01 replaceable, ephemeral, and addressable event storage semantics are implemented. Generic event kinds used by features such as NIP-51 or NIP-59 do not require special relay-side code and can be stored subject to owner policy.

## Free-tier protections

The relay defaults to conservative limits:

- default query limit: 100
- maximum query limit: 250
- maximum filters per `REQ`: 10
- maximum subscriptions per connection: 20
- maximum event message size: 128 KiB
- maximum filter terms: 80
- future timestamp tolerance: 10 minutes
- default write rate: 120 events/minute per connection

These can be adjusted in `/admin` within hard safety bounds.

## Local development

```bash
cp .dev.vars.example .dev.vars
# edit ADMIN_TOKEN
npm install
npm run dev
```

Run checks:

```bash
npm run check
```

Deploy manually:

```bash
npm run deploy
```

## Architecture

```text
Nostr client
    |
    | WebSocket
    v
Cloudflare Worker
    |
    v
RelayDurableObject (single logical relay instance)
    |-- WebSocket Hibernation
    |-- NIP-42 session state
    |-- App/User access policy
    |-- SQLite event storage
    |-- SQLite ACL/settings storage
    `-- realtime subscription fan-out
```

The Worker routes all relay traffic to the Durable Object named `primary`. This gives one deployment one coherent relay database and subscription hub while retaining Cloudflare's scale-to-zero behavior.

## Data model

SQLite tables are created automatically inside the Durable Object:

- `events`
- `event_tags`
- `applications`
- `users`
- `settings`

No external database migration step is required.

## License

MIT
