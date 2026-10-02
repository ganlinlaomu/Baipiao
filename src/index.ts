import { adminHtml } from './admin-ui';
import { sha256Hex } from './nostr';
import { RelayDurableObject } from './relay-object';
import type { Env } from './types';

export { RelayDurableObject };

function landingHtml(host: string): string {
  const wsScheme = host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'ws' : 'wss';
  const relayUrl = `${wsScheme}://${host}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cloudflare Nostr Relay</title><style>body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#f5f5f2;color:#171717;margin:0}.w{max-width:760px;margin:10vh auto;padding:28px}.c{background:white;border:1px solid #ddd;border-radius:16px;padding:26px}code{background:#f0f0ed;padding:4px 7px;border-radius:6px;word-break:break-all}a{color:inherit}h1{margin-top:0}</style></head><body><div class="w"><div class="c"><h1>Cloudflare Nostr Relay</h1><p>This is a Cloudflare-native Nostr relay with application and NIP-42 user access control.</p><p>Relay URL: <code>${relayUrl}</code></p><p><a href="/admin">Relay administration</a></p></div></div></body></html>`;
}

async function constantTimeTokenEqual(received: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256Hex(received), sha256Hex(expected)]);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function isAdmin(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get('authorization');
  if (!header?.toLowerCase().startsWith('bearer ')) return false;
  const token = header.slice(7).trim();
  if (!token || !env.ADMIN_TOKEN) return false;
  return constantTimeTokenEqual(token, env.ADMIN_TOKEN);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const stub = env.RELAY.getByName('primary');

    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      if (url.pathname !== '/' && url.pathname !== '/relay') return new Response('Not found', { status: 404 });
      return stub.fetch(request);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,OPTIONS', 'access-control-allow-headers': 'Accept' } });
    }

    if (url.pathname === '/' && request.method === 'GET') {
      if (request.headers.get('accept')?.includes('application/nostr+json')) {
        const info = await stub.relayInfo();
        return new Response(JSON.stringify(info), {
          headers: {
            'content-type': 'application/nostr+json; charset=utf-8',
            'access-control-allow-origin': '*',
            'cache-control': 'public, max-age=60',
          },
        });
      }
      return new Response(landingHtml(url.host), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    if (url.pathname === '/health' && request.method === 'GET') {
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    }

    if (url.pathname === '/admin' && request.method === 'GET') {
      return new Response(adminHtml(), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
          'x-frame-options': 'DENY',
          'referrer-policy': 'no-referrer',
        },
      });
    }

    if (url.pathname.startsWith('/api/admin/')) {
      if (!(await isAdmin(request, env))) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer' },
        });
      }
      return stub.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
