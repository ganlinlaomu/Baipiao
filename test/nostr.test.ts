import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
import { eventMatchesFilter, getEventHash, normalizePubkey, verifyEvent } from '../src/nostr';
import type { NostrEvent } from '../src/types';

function signedEvent(kind = 1): NostrEvent {
  const privateKey = new Uint8Array(32);
  privateKey[31] = 1;
  const event: NostrEvent = {
    id: '',
    pubkey: bytesToHex(schnorr.getPublicKey(privateKey)),
    created_at: 1700000000,
    kind,
    tags: [['p', 'abcd']],
    content: 'hello',
    sig: '',
  };
  event.id = getEventHash(event);
  event.sig = bytesToHex(schnorr.sign(event.id, privateKey));
  return event;
}

describe('nostr primitives', () => {
  it('verifies a valid event and rejects tampering', () => {
    const event = signedEvent();
    expect(verifyEvent(event)).toBe(true);
    expect(verifyEvent({ ...event, content: 'changed' })).toBe(false);
  });

  it('matches NIP-01 style filters', () => {
    const event = signedEvent(7);
    expect(eventMatchesFilter(event, { kinds: [7], authors: [event.pubkey.slice(0, 10)] })).toBe(true);
    expect(eventMatchesFilter(event, { kinds: [1] })).toBe(false);
    expect(eventMatchesFilter(event, { '#p': ['abcd'] })).toBe(true);
  });

  it('normalizes a hex pubkey', () => {
    const event = signedEvent();
    expect(normalizePubkey(event.pubkey)).toBe(event.pubkey);
  });
});
