// Molty registration/renewal request
export interface RegisterRequest {
  moltyId: string;
  x402Payment: X402Payment;
  isRenewal?: boolean;
}

// Subscription record
export interface Subscription {
  id: string;
  moltyId: string;
  status: 'active' | 'cancelled' | 'expired';
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
}

// x402 payment payload
export interface X402Payment {
  schemaId: string;
  network: string;
  payload: {
    signature: string;
    timestamp: number;
    address: string;
  };
}

// Registration response
export interface RegisterResponse {
  apiKey: string;
  expiresAt: string;
  webhookUrl: string;
  subscription: {
    periodStart: string;
    periodEnd: string;
  };
}

// SSE event types
export type SseEventType = 'webhook' | 'ping' | 'warning' | 'error';

export interface SseEvent {
  id: string;
  event: SseEventType;
  data: unknown;
}

// Webhook payload from Moltx
export interface WebhookPayload {
  id: string;
  source: 'moltx' | 'moltbook';
  event: string;
  timestamp: string;
  data: unknown;
}

// Molty record in database
export interface MoltyRecord {
  id: string;
  moltyId: string;
  apiKeyHash: string;
  walletAddress: string;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt: string | null;
  lastHeartbeatAt: string | null;
  isActive: boolean;
  connectionCount: number;
}

// Connection state (in-memory)
export interface ConnectionState {
  moltyId: string;
  controller: ReadableStreamDefaultController;
  connectedAt: Date;
  lastHeartbeat: Date;
  missedHeartbeats: number;
}

// Client config
export interface ClientConfig {
  apiKey: string;
  bridgeUrl: string;
  moltyId: string;
  openclawUrl: string;
  openclawToken?: string;
  heartbeatIntervalMs: number;
  reconnectDelayMs: number;
  maxReconnectDelayMs: number;
}

// OpenClaw hook payloads
export interface OpenClawWakePayload {
  text: string;
  mode?: 'now' | 'next-heartbeat';
}

export interface OpenClawAgentPayload {
  message: string;
  name?: string;
  sessionKey?: string;
  wakeMode?: 'now' | 'next-heartbeat';
  deliver?: boolean;
  channel?: string;
  to?: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
}