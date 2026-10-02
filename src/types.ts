export type AccessMode = 'public' | 'app' | 'user' | 'app_or_user' | 'app_and_user';
export type AppType = 'web' | 'native' | 'service';

export interface Env {
  RELAY: DurableObjectNamespace<import('./relay-object').RelayDurableObject>;
  ADMIN_TOKEN: string;
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
  relay_host: string;
  app_id: string | null;
  authenticated_pubkeys: string[];
  subscriptions: Record<string, NostrFilter[]>;
  rate_window_started_at: number;
  rate_count: number;
}

export interface AccessDecision {
  allowed: boolean;
  authenticated: boolean;
  reason?: string;
  prefix?: 'auth-required' | 'restricted';
}
