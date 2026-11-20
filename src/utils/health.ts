import { Response } from "express";
import { isMainThread, parentPort } from "worker_threads";

// Worker threads get their own copy of this module. There, counter/event calls
// are forwarded to the main thread, which owns the state served by /health.
const inWorker = !isMainThread && !!parentPort;
const WORKER_MSG = "__health";

type ForwardedOp = "increment" | "decrement" | "setCounter" | "record";

// Health events are publicly visible (/viewhealth, /health/events, SSE), so
// identifiers, secrets and URLs are stripped before an event is stored.
const SENSITIVE_KEY = /token|secret|password|passwd|auth|cookie|session|key|webhook|url|uri|email/i;
const REDACTIONS: Array<[RegExp, string]> = [
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "[url]"],
  [/\bwww\.[^\s"'<>]+/gi, "[url]"],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]"],
  [/\b(token|key|secret|password|passwd|auth(?:orization)?|bearer|cookie)(\s*[=:]\s*|\s+)("[^"]*"|'[^']*'|[^\s&,;]+)/gi, "$1$2[redacted]"],
  // JWTs and Discord-style bot tokens (base64.base64.base64)
  [/\b[\w-]{10,}\.[\w-]{4,}\.[\w-]{10,}\b/g, "[token]"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]"],
  // Revolt ULIDs
  [/\b[0-9A-HJKMNP-TV-Z]{26}\b/g, "[id]"],
  // Snowflakes / numeric endpoint, server, channel and user ids
  [/\b\d{15,}\b/g, "[id]"],
  // Long opaque strings (API keys, hashes) containing both letters and digits
  [/\b(?=[\w-]*\d)(?=[\w-]*[a-z])[\w-]{24,}\b/gi, "[token]"],
];

export function redactText(text: string): string {
  let out = String(text);
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

export function redactData(value: any, depth = 0): any {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactText(value);
  if (typeof value === "bigint") return "[id]";
  if (typeof value === "number" && Number.isInteger(value) && Math.abs(value) >= 1e14) return "[id]";
  if (typeof value !== "object") return value;
  if (depth > 5) return "[truncated]";
  if (Array.isArray(value)) return value.map((v) => redactData(v, depth + 1));
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) {
    if (/(^|_)id$|Id$|^ids?$/.test(k)) out[k] = "[id]";
    else if (SENSITIVE_KEY.test(k) && typeof v !== "boolean" && typeof v !== "number") out[k] = "[redacted]";
    else out[k] = redactData(v, depth + 1);
  }
  return out;
}

export type HealthEvent = {
  id: number;
  time: string; // ISO
  type: string;
  message: string;
  data?: any;
};

export type ServiceStatus = "healthy" | "degraded" | "down" | "unknown";

export type ServiceHealth = {
  name: string;
  status: ServiceStatus;
  lastCheck: string;
  latencyMs?: number;
  error?: string;
  metadata?: Record<string, any>;
};

export type LatencyDataPoint = {
  timestamp: string;
  services: Record<string, number>; // serviceKey -> latencyMs
};

export type QueueSizePoint = {
  timestamp: string; // start of the minute (ISO)
  max: number;       // peak queue size during that minute
  last: number;      // queue size at the end of that minute
};

export type QueuedMessageInfo = {
  endpointId: string;
  messageId: string;
  queuePosition: number;
  timestamp: string;
};

export type HealthSummary = {
  startTime: string;
  uptimeSec: number;
  counters: Record<string, number>;
  lastEventId: number;
  services: Record<string, ServiceHealth>;
  latencyHistory: LatencyDataPoint[];
  activeEndpoints: string[];
  queuedMessages: QueuedMessageInfo[];
};

class HealthTracker {
  private events: HealthEvent[] = [];
  private clients: Set<Response> = new Set();
  private maxEvents = 500;
  private nextId = 1;
  private start = Date.now();
  private counters: Record<string, number> = {};
  private services: Record<string, ServiceHealth> = {};
  private heartbeatTimer?: NodeJS.Timeout;
  private latencyHistory: LatencyDataPoint[] = [];
  private maxLatencyPoints = 60; // 15 Minuten bei 15-Sekunden-Intervallen
  private activeEndpoints: string[] = [];
  private queuedMessages: QueuedMessageInfo[] = [];
  // One point per minute, 24h retention. In-memory: resets on restart.
  private queueHistory: QueueSizePoint[] = [];
  private maxQueuePoints = 24 * 60;
  private queueBucketStart = Date.now();
  private queueBucketMax = 0;
  private queueTimer?: NodeJS.Timeout;

  constructor() {
    this.initializeServices();
    if (!inWorker) {
      this.startHeartbeat();
      this.startQueueSampling();
    }
  }



  private initializeServices() {
    this.services = {
      database_pg: {
        name: "PostgreSQL",
        status: "unknown",
        lastCheck: new Date().toISOString(),
      },
      database_surreal: {
        name: "SurrealDB",
        status: "unknown",
        lastCheck: new Date().toISOString(),
      },
      queue_processor: {
        name: "Queue Processor",
        status: "unknown",
        lastCheck: new Date().toISOString(),
      },
      message_distribution: {
        name: "Message Distribution",
        status: "unknown",
        lastCheck: new Date().toISOString(),
      },
    };
  }

  private startHeartbeat() {
    this.heartbeatTimer = setInterval(async () => {
      // Perform ping tests for each service (non-blocking)
      this.performPingTests(); // Don't await, let it run in background
      
      // Send heartbeat immediately
      this.broadcast({
        id: this.nextId++,
        time: new Date().toISOString(),
        type: "heartbeat",
        message: "ping",
      });
      // Also broadcast updated summary every heartbeat
      const summary = this.getSummary();
      this.broadcastSnapshot(summary);
    }, 15000);
  }

  private startQueueSampling() {
    const now = Date.now();
    this.queueBucketStart = now - (now % 60000);
    const tick = () => {
      const current = this.counters.messages_in_queue || 0;
      this.queueHistory.push({
        timestamp: new Date(this.queueBucketStart).toISOString(),
        max: Math.max(this.queueBucketMax, current),
        last: current,
      });
      if (this.queueHistory.length > this.maxQueuePoints) {
        this.queueHistory.splice(0, this.queueHistory.length - this.maxQueuePoints);
      }
      this.queueBucketStart += 60000;
      this.queueBucketMax = current;
    };
    // Align to minute boundaries, then sample every minute.
    setTimeout(() => {
      tick();
      this.queueTimer = setInterval(tick, 60000);
    }, this.queueBucketStart + 60000 - now);
  }

  private trackQueueSize(counter: string) {
    if (counter !== "messages_in_queue") return;
    const value = this.counters[counter] || 0;
    if (value > this.queueBucketMax) this.queueBucketMax = value;
  }

  /** Last 24h of per-minute queue sizes, including the current partial minute. */
  public getQueueHistory(): QueueSizePoint[] {
    const current = this.counters.messages_in_queue || 0;
    return [
      ...this.queueHistory,
      {
        timestamp: new Date(this.queueBucketStart).toISOString(),
        max: Math.max(this.queueBucketMax, current),
        last: current,
      },
    ];
  }

  private async performPingTests() {
    const timestamp = new Date().toISOString();
    const currentLatencies: Record<string, number> = {};
    
    // Only perform real ping tests for database services
    const databaseServices = ['database_pg', 'database_surreal'];
    
    const pingPromises = Object.keys(this.services).map(async (serviceKey) => {
      try {
        const startTime = Date.now();
        let latencyMs: number | undefined;
        let status: ServiceStatus = 'healthy';
        let error: string | undefined;

        // Perform actual ping tests only for database services with timeout
        if (serviceKey === 'database_pg') {
          try {
            // PostgreSQL ping with timeout
            const pingPromise = (async () => {
              const { getDb } = await import('./pgsql');
              const db = await getDb();
              if (db) {
                const testStart = Date.now();
                await db.query('SELECT 1');
                const latency = Date.now() - testStart;
                db.release();
                return latency;
              } else {
                throw new Error('Database connection failed');
              }
            })();
            
            latencyMs = await Promise.race([
              pingPromise,
              new Promise<never>((_, reject) => 
                setTimeout(() => reject(new Error('PostgreSQL ping timeout')), 5000)
              )
            ]);
          } catch (e) {
            error = e instanceof Error ? e.message : 'PostgreSQL connection failed';
            status = 'down';
          }
        } else if (serviceKey === 'database_surreal') {
          try {
            // SurrealDB ping with timeout
            const pingPromise = (async () => {
              const { getDb } = await import('./surrealdb');
              const testStart = Date.now();
              const db = await getDb();
              // Test with a simple query to verify connection and measure latency
              await db.query('SELECT * FROM status:ping');
              const latency = Date.now() - testStart;
              await db.close();
              status = 'healthy';
              error = undefined;
              return latency;
            })();
            
            latencyMs = await Promise.race([
              pingPromise,
              new Promise<never>((_, reject) => 
                setTimeout(() => reject(new Error('SurrealDB ping timeout')), 5000)
              )
            ]);
          } catch (e) {
            error = e instanceof Error ? e.message : 'SurrealDB connection failed';
            status = 'down';
          }
        }

        // Only add latency to history for database services with successful pings
        if (databaseServices.includes(serviceKey) && latencyMs !== undefined) {
          currentLatencies[serviceKey] = latencyMs;
          
          // Determine status based on actual latency
          if (latencyMs > 1000) {
            status = 'down';
          } else if (latencyMs > 500) {
            status = 'degraded';
          } else {
            status = 'healthy';
          }
          
          // Record ping event with latency
          this.record("ping", `${serviceKey} ping: ${latencyMs}ms (${status})`, { 
            service: serviceKey, 
            latency: latencyMs, 
            status 
          });
        }

        // For database services we set lastPing metadata. For messaging services
        // (queue_processor and message_distribution) we instead track lastMessageQueued.
        if (serviceKey === 'queue_processor' || serviceKey === 'message_distribution') {
          // Derived from live counters in refreshMessagingServices().
          return;
        } else {
          this.updateServiceHealth(serviceKey, status, { 
            latencyMs,
            error,
            metadata: {}
          });
        }

      } catch (error) {
        this.updateServiceHealth(serviceKey, 'down', { 
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });

    await Promise.all(pingPromises);
    
    // Store latency data point in history (only database services with actual data)
    if (Object.keys(currentLatencies).length > 0) {
      this.addLatencyDataPoint(timestamp, currentLatencies);
    }
  }

  private addLatencyDataPoint(timestamp: string, services: Record<string, number>) {
    const dataPoint: LatencyDataPoint = {
      timestamp,
      services: { ...services }
    };
    
    this.latencyHistory.push(dataPoint);
    
    // Keep only the last maxLatencyPoints (15 minutes worth of data)
    if (this.latencyHistory.length > this.maxLatencyPoints) {
      this.latencyHistory = this.latencyHistory.slice(-this.maxLatencyPoints);
    }
  }

  public async performManualPingTests() {
    this.record("ping", "Manual ping test initiated by user");
    try {
      await this.performPingTests();
      this.record("ping", "Manual ping test completed successfully");
    } catch (error) {
      this.record("ping", `Manual ping test failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public getLatencyHistory(): LatencyDataPoint[] {
    return [...this.latencyHistory];
  }

  public clearLatencyHistory() {
    this.latencyHistory = [];
  }

  public setActiveEndpoints(endpointIds: string[]) {
    this.activeEndpoints = endpointIds;
  }

  public setQueuedMessages(messages: QueuedMessageInfo[]) {
    this.queuedMessages = messages;
  }

  private broadcastSnapshot(summary: HealthSummary) {
    const payload = `event: snapshot\ndata: ${JSON.stringify(summary)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  private forward(op: ForwardedOp, args: any[]): boolean {
    if (!inWorker) return false;
    try {
      parentPort!.postMessage({ [WORKER_MSG]: true, op, args });
    } catch {
      // ignore: health reporting must never break the worker
    }
    return true;
  }

  /** Main thread: apply a health call forwarded from a worker thread. */
  public applyWorkerMessage(msg: any): boolean {
    if (!msg || msg[WORKER_MSG] !== true || !Array.isArray(msg.args)) return false;
    const [a, b, c] = msg.args;
    switch (msg.op as ForwardedOp) {
      case "increment": this.increment(a, b); break;
      case "decrement": this.decrement(a, b); break;
      case "setCounter": this.setCounter(a, b); break;
      case "record": this.record(a, b, c); break;
      default: return false;
    }
    return true;
  }

  public increment(counter: string, by: number = 1) {
    if (this.forward("increment", [counter, by])) return;
    this.counters[counter] = (this.counters[counter] || 0) + by;
    this.trackQueueSize(counter);
  }

  public decrement(counter: string, by: number = 1) {
    if (this.forward("decrement", [counter, by])) return;
    this.counters[counter] = Math.max(0, (this.counters[counter] || 0) - by);
  }

  public setCounter(counter: string, value: number) {
    if (this.forward("setCounter", [counter, value])) return;
    this.counters[counter] = value;
    this.trackQueueSize(counter);
  }

  public record(type: string, message: string, data?: any) {
    if (this.forward("record", [type, message, data])) return;
    const event: HealthEvent = {
      id: this.nextId++,
      time: new Date().toISOString(),
      type: redactText(type),
      message: redactText(message),
      data: data === undefined ? undefined : redactData(data),
    };
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    this.broadcast(event);
  }

  private broadcast(ev: HealthEvent) {
    // Unnamed SSE events reach EventSource.onmessage. A named event (event: <type>)
    // would only reach an addEventListener for that exact type, so the page would
    // never see it. Only heartbeats keep a name so they stay out of the event log.
    const eventLine = ev.type === "heartbeat" ? "event: heartbeat\n" : "";
    const payload = `id: ${ev.id}\n${eventLine}data: ${JSON.stringify(ev)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch {
        // drop on error
        this.clients.delete(res);
      }
    }
  }

  public addSSEClient(res: Response) {
    this.clients.add(res);
    res.on("close", () => {
      this.clients.delete(res);
    });
  }

  public updateServiceHealth(serviceKey: string, status: ServiceStatus, metadata?: { latencyMs?: number; error?: string | null; metadata?: Record<string, any> }) {
    if (this.services[serviceKey]) {
      this.services[serviceKey].status = status;
      this.services[serviceKey].lastCheck = new Date().toISOString();
      if (metadata?.latencyMs !== undefined) this.services[serviceKey].latencyMs = metadata.latencyMs;
      if (metadata?.error) this.services[serviceKey].error = metadata.error;
      if (metadata?.metadata) this.services[serviceKey].metadata = metadata.metadata;
    }
  }

  /** Queue/distribution status is derived from the live counters. */
  private refreshMessagingServices() {
    const queueSize = this.counters.messages_in_queue || 0;
    const activeEndpoints = this.counters.active_endpoints_with_work || 0;
    this.updateServiceHealth("queue_processor", queueSize > 100 ? "degraded" : "healthy", {
      metadata: { queueSize, activeEndpoints },
    });

    const enqueuedCount = this.counters.messages_enqueued || 0;
    const processedCount = this.counters.messages_processed || 0;
    // Degraded when messages are waiting but nothing has been delivered yet.
    const stalled = queueSize > 0 && processedCount === 0;
    this.updateServiceHealth("message_distribution", stalled ? "degraded" : "healthy", {
      metadata: { enqueuedCount, processedCount },
    });
  }

  public getSummary(): HealthSummary {
    this.refreshMessagingServices();
    return {
      startTime: new Date(this.start).toISOString(),
      uptimeSec: Math.floor((Date.now() - this.start) / 1000),
      counters: { ...this.counters },
      lastEventId: this.nextId - 1,
      services: { ...this.services },
      latencyHistory: [...this.latencyHistory],
      activeEndpoints: [...this.activeEndpoints],
      queuedMessages: [...this.queuedMessages],
    };
  }

  public getRecentEvents(limit = 100): HealthEvent[] {
    return this.events.slice(-limit);
  }
}

export const health = new HealthTracker();
