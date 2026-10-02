import type { AccessDecision, AccessMode, AppRecord, NostrFilter, RelaySettings, UserRecord } from './types';

interface PrincipalContext {
  app: AppRecord | null;
  users: UserRecord[];
  authenticatedPubkeys: string[];
}

function isActive(expiresAt: number | null, enabled: boolean): boolean {
  return enabled && (expiresAt === null || expiresAt > Math.floor(Date.now() / 1000));
}

function kindsAllowed(allowedKinds: number[] | null, kinds: number[]): boolean {
  return allowedKinds === null || kinds.every(kind => allowedKinds.includes(kind));
}

function filtersKinds(filters: NostrFilter[]): number[] | null {
  const kinds = new Set<number>();
  for (const filter of filters) {
    if (!filter.kinds?.length) return null;
    for (const kind of filter.kinds) kinds.add(kind);
  }
  return [...kinds];
}

function appAllows(app: AppRecord | null, action: 'read' | 'write', kinds: number[] | null): boolean {
  if (!app || !isActive(app.expires_at, app.enabled)) return false;
  if (action === 'read' && !app.can_read) return false;
  if (action === 'write' && !app.can_write) return false;
  if (app.allowed_kinds !== null) {
    if (kinds === null) return false;
    return kindsAllowed(app.allowed_kinds, kinds);
  }
  return true;
}

function userAllows(users: UserRecord[], action: 'read' | 'write', kinds: number[] | null): boolean {
  return users.some(user => {
    if (!isActive(user.expires_at, user.enabled)) return false;
    if (action === 'read' && !user.can_read) return false;
    if (action === 'write' && !user.can_write) return false;
    if (user.allowed_kinds !== null) {
      if (kinds === null) return false;
      return kindsAllowed(user.allowed_kinds, kinds);
    }
    return true;
  });
}

function evaluate(mode: AccessMode, ctx: PrincipalContext, action: 'read' | 'write', kinds: number[] | null): AccessDecision {
  if (mode === 'public') return { allowed: true, authenticated: ctx.authenticatedPubkeys.length > 0 };

  const appOk = appAllows(ctx.app, action, kinds);
  const userOk = userAllows(ctx.users, action, kinds);
  const hasAuth = ctx.authenticatedPubkeys.length > 0;

  let allowed = false;
  switch (mode) {
    case 'app': allowed = appOk; break;
    case 'user': allowed = userOk; break;
    case 'app_or_user': allowed = appOk || userOk; break;
    case 'app_and_user': allowed = appOk && userOk; break;
  }

  if (allowed) return { allowed: true, authenticated: hasAuth };

  const userCouldSatisfy = mode === 'user' || mode === 'app_or_user' || mode === 'app_and_user';
  if (userCouldSatisfy && !hasAuth) {
    return {
      allowed: false,
      authenticated: false,
      prefix: 'auth-required',
      reason: 'NIP-42 authentication is required by relay policy',
    };
  }

  return {
    allowed: false,
    authenticated: hasAuth,
    prefix: 'restricted',
    reason: 'this app or user is not allowed by relay policy',
  };
}

export function evaluateRead(settings: RelaySettings, ctx: PrincipalContext, filters: NostrFilter[]): AccessDecision {
  return evaluate(settings.read_policy, ctx, 'read', filtersKinds(filters));
}

export function evaluateWrite(settings: RelaySettings, ctx: PrincipalContext, kind: number): AccessDecision {
  return evaluate(settings.write_policy, ctx, 'write', [kind]);
}
