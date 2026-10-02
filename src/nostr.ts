import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { bech32 } from '@scure/base';
import type { NostrEvent, NostrFilter } from './types';

const HEX_32 = /^[0-9a-f]{64}$/;
const HEX_64 = /^[0-9a-f]{128}$/;
const PREFIX_HEX = /^[0-9a-f]{1,64}$/;

export function serializeEvent(event: Pick<NostrEvent, 'pubkey' | 'created_at' | 'kind' | 'tags' | 'content'>): string {
  return JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
}

export function getEventHash(event: Pick<NostrEvent, 'pubkey' | 'created_at' | 'kind' | 'tags' | 'content'>): string {
  return bytesToHex(sha256(utf8ToBytes(serializeEvent(event))));
}

export function isValidEventShape(value: unknown): value is NostrEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<NostrEvent>;
  return (
    typeof event.id === 'string' && HEX_32.test(event.id) &&
    typeof event.pubkey === 'string' && HEX_32.test(event.pubkey) &&
    Number.isInteger(event.created_at) && (event.created_at as number) >= 0 &&
    Number.isInteger(event.kind) && (event.kind as number) >= 0 && (event.kind as number) <= 65535 &&
    Array.isArray(event.tags) && event.tags.every(tag => Array.isArray(tag) && tag.every(item => typeof item === 'string')) &&
    typeof event.content === 'string' &&
    typeof event.sig === 'string' && HEX_64.test(event.sig)
  );
}

export function verifyEvent(event: NostrEvent): boolean {
  try {
    if (!isValidEventShape(event)) return false;
    const id = getEventHash(event);
    if (id !== event.id) return false;
    return schnorr.verify(event.sig, event.id, event.pubkey);
  } catch {
    return false;
  }
}

export function normalizePubkey(input: string): string | null {
  const value = input.trim().toLowerCase();
  if (HEX_32.test(value)) return value;
  if (!value.startsWith('npub1')) return null;
  try {
    const decoded = bech32.decode(value as `${string}1${string}`, 1000);
    if (decoded.prefix !== 'npub') return null;
    const bytes = bech32.fromWords(decoded.words);
    if (bytes.length !== 32) return null;
    return bytesToHex(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

export function isValidFilter(value: unknown): value is NostrFilter {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const filter = value as Record<string, unknown>;
  if (filter.ids !== undefined && (!Array.isArray(filter.ids) || !filter.ids.every(v => typeof v === 'string' && PREFIX_HEX.test(v)))) return false;
  if (filter.authors !== undefined && (!Array.isArray(filter.authors) || !filter.authors.every(v => typeof v === 'string' && PREFIX_HEX.test(v)))) return false;
  if (filter.kinds !== undefined && (!Array.isArray(filter.kinds) || !filter.kinds.every(v => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 65535))) return false;
  if (filter.since !== undefined && !Number.isInteger(filter.since)) return false;
  if (filter.until !== undefined && !Number.isInteger(filter.until)) return false;
  if (filter.limit !== undefined && (!Number.isInteger(filter.limit) || (filter.limit as number) < 0)) return false;
  for (const [key, val] of Object.entries(filter)) {
    if (key.startsWith('#')) {
      if (key.length !== 2 || !/^[A-Za-z]$/.test(key.slice(1)) || !Array.isArray(val) || !val.every(v => typeof v === 'string')) return false;
    }
  }
  return true;
}

export function eventMatchesFilter(event: NostrEvent, filter: NostrFilter): boolean {
  if (filter.ids?.length && !filter.ids.some(prefix => event.id.startsWith(prefix))) return false;
  if (filter.authors?.length && !filter.authors.some(prefix => event.pubkey.startsWith(prefix))) return false;
  if (filter.kinds?.length && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;

  for (const [key, raw] of Object.entries(filter)) {
    if (!key.startsWith('#')) continue;
    const values = raw as string[];
    const tagName = key.slice(1);
    if (!event.tags.some(tag => tag[0] === tagName && tag[1] !== undefined && values.includes(tag[1]))) return false;
  }
  return true;
}

export function isEphemeralKind(kind: number): boolean {
  return kind >= 20000 && kind < 30000;
}

export function isReplaceableKind(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000);
}

export function isParameterizedReplaceableKind(kind: number): boolean {
  return kind >= 30000 && kind < 40000;
}

export function getDTag(event: NostrEvent): string {
  return event.tags.find(tag => tag[0] === 'd')?.[1] ?? '';
}

export function getExpiration(event: NostrEvent): number | null {
  const raw = event.tags.find(tag => tag[0] === 'expiration')?.[1];
  if (!raw || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

export function getChallengeTag(event: NostrEvent): string | null {
  return event.tags.find(tag => tag[0] === 'challenge')?.[1] ?? null;
}

export function getRelayTag(event: NostrEvent): string | null {
  return event.tags.find(tag => tag[0] === 'relay')?.[1] ?? null;
}

export function relayTagMatchesHost(relayTag: string, expectedHost: string): boolean {
  try {
    const url = new URL(relayTag);
    return (url.protocol === 'wss:' || url.protocol === 'ws:') && url.host.toLowerCase() === expectedHost.toLowerCase();
  } catch {
    return false;
  }
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  let binary = '';
  for (const byte of buffer) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
