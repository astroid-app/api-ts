# Quick Start Guide - Health Monitoring

## Starting the Server

### Option 1: Using npm (default port 9921)
```
npm run start
```

### Option 2: Custom port
```
npm run start -p 3000
npm run start -p 3000
```

### Option 3: Using the start script
```
chmod +x start.sh
./start.sh
```

## Accessing the Health Dashboard

Once the server is running, you'll see:
```
✓ Server listening at http://localhost:9921
Health URL:            http://localhost:9921/viewhealth
```

Open your browser to: **http://localhost:9921/viewhealth**

## What You'll See

### Initial State (first 5 seconds)
- Services show as "Unknown" (gray dots)
- Metrics start at 0
- Event log is empty

### After 5 seconds
- Health checks run automatically
- Services update to Healthy/Degraded/Down
- Green pulsing dots appear for healthy services
- Latency metrics populate

### During Operation
- Metrics increment in real-time
- Event log shows live activity
- Service status updates every 30s
- Dashboard refreshes automatically via SSE

## Health Check Results

### ✅ All Healthy
```
System Status: ● All Systems Operational (green)

PostgreSQL       ● HEALTHY    ⚡ 3ms
SurrealDB        ● HEALTHY    ⚡ 5ms
Queue Processor  ● HEALTHY    ℹ queueSize: 0
Message Dist.    ● HEALTHY    ℹ processed: 42
```

### ⚠️ Degraded
```
System Status: ● Degraded Performance (yellow)

PostgreSQL       ● HEALTHY     ⚡ 3ms
Queue Processor  ● DEGRADED    ℹ queueSize: 150  ← High queue
```

### 🔴 Service Down
```
System Status: ● Service Disruption (red)

PostgreSQL       ● DOWN        ⚠ Connection refused
SurrealDB        ● HEALTHY     ⚡ 5ms
```

## API Endpoints

### Health Summary (JSON)
```bash
curl http://localhost:9921/health
```

### Recent Events (JSON)
```bash
curl http://localhost:9921/health/events?limit=20
```

### Live Stream (SSE)
```bash
curl -N http://localhost:9921/health/stream
```

## Troubleshooting

### Dashboard shows "Unknown" for all services
**Wait 5 seconds** - Initial health check runs after startup delay

### "Connection refused" for databases
1. Check PostgreSQL is running: `systemctl status postgresql`
2. Check SurrealDB is running: `systemctl status surrealdb`
3. Verify environment variables in `.env`

### No events appearing
1. Make some API requests to generate activity
2. Send a test message to trigger queue processing
3. Check browser console for errors

### SSE connection errors
1. Check firewall settings
2. Try different browser (Chrome/Firefox recommended)
3. Check server logs for connection issues

## Testing the Dashboard

### Generate test traffic
```
# Make some API requests
curl http://localhost:9921/statistics

# Create test endpoint (requires MASTER_TOKEN)
curl -X POST "http://localhost:9921/create?token=YOUR_MASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"endpointId": "123456789"}'

# Check endpoint health
curl "http://localhost:9921/healthcheck/123456789?token=YOUR_TOKEN"
```

### Watch events in real-time
Open the dashboard and trigger actions:
- Each API call increments request counter
- Queue operations appear in event log
- Service checks update every 30s
- Metrics refresh automatically

## Next Steps

1. **Customize checks**: Add your own service health checks in `checkServiceHealth()`
2. **Add security**: Gate dashboard with a token (see HEALTH_MONITORING.md)
3. **Add metrics**: Track custom counters with `health.increment()`
4. **Export data**: Use `/health` endpoint for external monitoring tools

## Monitoring in Production

### Prometheus Integration (future)
The health metrics can be exported in Prometheus format for grafana/alerting.

### External Health Checks
Use `/health` endpoint for:
- Load balancer health checks
- Uptime monitoring services (UptimeRobot, Pingdom)
- Status page automation (Statuspage.io)

### Alerting Rules
Set up alerts based on:
- Service status changes to "down"
- Queue size exceeds threshold
- Auth failure rate spike
- Message processing lag
