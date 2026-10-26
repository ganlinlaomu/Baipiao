export type AccessMode = 'public' | 'app' | 'user' | 'app_or_user' | 'app_and_user';
export type AppType = 'web' | 'native' | 'service';

export interface Env {
  RELAY: DurableObjectNamespace<import('./relay-object').RelayDurableObject>;
  ADMIN_TOKEN?: string;
}

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  /**
   * Extension: only events this relay stored at or after this time (seconds).
   * Lets a client fetch just what arrived since its last sync instead of
   * re-reading the NIP-59 backdating window. Advertised in NIP-11.
   */
  received_since?: number;
  [key: `#${string}`]: unknown;
}

export interface AppRecord {
  id: string;
  name: string;
  type: AppType;
  enabled: boolean;
  can_read: boolean;
  can_write: boolean;
  allowed_kinds: number[] | null;
  allowed_origins: string[];
  rate_limit: number;
  expires_at: number | null;
  created_at: number;
}

export interface UserRecord {
  pubkey: string;
  name: string;
  enabled: boolean;
  can_read: boolean;
  can_write: boolean;
  allowed_kinds: number[] | null;
  expires_at: number | null;
  created_at: number;
}

export interface RelaySettings {
  relay_name: string;
  relay_description: string;
  read_policy: AccessMode;
  write_policy: AccessMode;
  default_limit: number;
  max_limit: number;
  max_filters: number;
  max_subscriptions: number;
  max_event_bytes: number;
  max_future_seconds: number;
  default_rate_limit: number;
}

export interface SessionAttachment {
  id: string;
  challenge: string;
  /** Canonical WebSocket URL for this connection's relay endpoint. */
  relay_url?: string;
  relay_host: string;
  app_id: string | null;
  app_session_expires_at: number | null;
  app_session_pubkey: string | null;
  authenticated_pubkeys: string[];
  subscriptions: Record<string, NostrFilter[]>;
  rate_window_started_at: number;
  rate_count: number;
  /** REQ/AUTH limits survive Durable Object WebSocket hibernation. */
  control_windows?: Partial<Record<'REQ' | 'AUTH', { startedAt: number; count: number }>>;
}

export interface AccessDecision {
  allowed: boolean;
  authenticated: boolean;
  reason?: string;
  prefix?: 'auth-required' | 'restricted';
}
