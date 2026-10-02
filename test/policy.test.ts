import { describe, expect, it } from 'vitest';
import { evaluateWrite } from '../src/policy';
import type { AppRecord, RelaySettings, UserRecord } from '../src/types';

const settings: RelaySettings = {
  relay_name: 'x', relay_description: 'x', read_policy: 'public', write_policy: 'app_or_user',
  default_limit: 100, max_limit: 250, max_filters: 10, max_subscriptions: 20,
  max_event_bytes: 131072, max_future_seconds: 600, default_rate_limit: 120,
};
const app: AppRecord = { id: 'app', name: 'app', type: 'service', enabled: true, can_read: true, can_write: true, allowed_kinds: null, allowed_origins: [], rate_limit: 120, expires_at: null, created_at: 1 };
const user: UserRecord = { pubkey: 'a'.repeat(64), name: '', enabled: true, can_read: true, can_write: true, allowed_kinds: [1], expires_at: null, created_at: 1 };

describe('policy', () => {
  it('allows approved app in app_or_user mode', () => {
    expect(evaluateWrite(settings, { app, users: [], authenticatedPubkeys: [] }, 1).allowed).toBe(true);
  });
  it('requests NIP-42 when no app or authenticated user exists', () => {
    const result = evaluateWrite(settings, { app: null, users: [], authenticatedPubkeys: [] }, 1);
    expect(result.allowed).toBe(false);
    expect(result.prefix).toBe('auth-required');
  });
  it('enforces per-user kinds', () => {
    expect(evaluateWrite({ ...settings, write_policy: 'user' }, { app: null, users: [user], authenticatedPubkeys: [user.pubkey] }, 1).allowed).toBe(true);
    expect(evaluateWrite({ ...settings, write_policy: 'user' }, { app: null, users: [user], authenticatedPubkeys: [user.pubkey] }, 7).allowed).toBe(false);
  });
});
