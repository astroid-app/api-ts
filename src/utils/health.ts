import { Response } from "express";
import { stat } from "fs";

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

  constructor() {
    this.initializeServices();
    this.startHeartbeat();
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
          this.updateServiceHealth(serviceKey, status, {
            error
          });
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

  public increment(counter: string, by: number = 1) {
    this.counters[counter] = (this.counters[counter] || 0) + by;
  }

  public decrement(counter: string, by: number = 1) {
    this.counters[counter] = (this.counters[counter] || 0) - by;
  }

  public setCounter(counter: string, value: number) {
    this.counters[counter] = value;
  }

  public record(type: string, message: string, data?: any) {
    const event: HealthEvent = {
      id: this.nextId++,
      time: new Date().toISOString(),
      type,
      message,
      data,
    };
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    this.broadcast(event);
  }

  private broadcast(ev: HealthEvent) {
    const payload = `id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
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

  public getSummary(): HealthSummary {
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
