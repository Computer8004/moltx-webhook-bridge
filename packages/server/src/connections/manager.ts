import type { ConnectionState } from '@moltx/bridge-types';

// In-memory connection store
const connections = new Map<string, ConnectionState>();

// Heartbeat configuration
const HEARTBEAT_INTERVAL = 30000; // 30 seconds (server sends ping)
const HEARTBEAT_TIMEOUT = 3 * 60 * 1000; // 3 minutes without client response
const MAX_MISSED_HEARTBEATS = 3;

export function addConnection(
  moltyId: string,
  controller: ReadableStreamDefaultController
): ConnectionState {
  // Close any existing connection for this molty
  removeConnection(moltyId);

  const state: ConnectionState = {
    moltyId,
    controller,
    connectedAt: new Date(),
    lastHeartbeat: new Date(),
    missedHeartbeats: 0,
  };

  connections.set(moltyId, state);
  return state;
}

export function removeConnection(moltyId: string): boolean {
  const state = connections.get(moltyId);
  if (state) {
    try {
      state.controller.close();
    } catch {
      // Controller might already be closed
    }
    connections.delete(moltyId);
    return true;
  }
  return false;
}

export function getConnection(moltyId: string): ConnectionState | undefined {
  return connections.get(moltyId);
}

export function hasConnection(moltyId: string): boolean {
  return connections.has(moltyId);
}

export function updateHeartbeat(moltyId: string): boolean {
  const state = connections.get(moltyId);
  if (state) {
    state.lastHeartbeat = new Date();
    state.missedHeartbeats = 0;
    return true;
  }
  return false;
}

// Maximum queue size for backpressure protection
const MAX_QUEUE_SIZE = 100;

export function sendEvent<T>(moltyId: string, event: string, data: T): boolean {
  const state = connections.get(moltyId);
  if (!state) return false;

  // Check for backpressure - if connection is overwhelmed, drop the message
  if (state.missedHeartbeats >= MAX_MISSED_HEARTBEATS) {
    console.warn(`[backpressure] Dropping event for ${moltyId}: connection overwhelmed`);
    return false;
  }

  const message = formatSseMessage(event, data);

  try {
    const encoder = new TextEncoder();
    state.controller.enqueue(encoder.encode(message));
    return true;
  } catch (err) {
    // Connection likely closed
    removeConnection(moltyId);
    return false;
  }
}

export function formatSseMessage(event: string, data: unknown): string {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const jsonData = JSON.stringify(data);

  return `id: ${id}\nevent: ${event}\ndata: ${jsonData}\n\n`;
}

// Heartbeat checker - call this periodically
export function checkHeartbeats(): string[] {
  const now = Date.now();
  const stale: string[] = [];

  for (const [moltyId, state] of connections) {
    const timeSinceLastHeartbeat = now - state.lastHeartbeat.getTime();

    // Send ping if it's time
    if (timeSinceLastHeartbeat > HEARTBEAT_INTERVAL) {
      const pingSent = sendEvent(moltyId, 'ping', { timestamp: Date.now() });
      if (!pingSent) {
        stale.push(moltyId);
      }
    }

    // Mark as stale if too many missed heartbeats (only if we haven't already sent ping this cycle)
    else if (timeSinceLastHeartbeat > HEARTBEAT_TIMEOUT) {
      state.missedHeartbeats++;

      if (state.missedHeartbeats >= MAX_MISSED_HEARTBEATS) {
        stale.push(moltyId);
      }
    }
  }

  // Remove stale connections
  for (const moltyId of stale) {
    removeConnection(moltyId);
  }

  return stale;
}

// Get connection stats
export function getStats(): {
  totalConnections: number;
  moltyIds: string[];
} {
  return {
    totalConnections: connections.size,
    moltyIds: Array.from(connections.keys()),
  };
}

// Graceful shutdown
export function closeAll(): void {
  for (const moltyId of connections.keys()) {
    removeConnection(moltyId);
  }
}
