# StatusAgent — AI-Powered Self-Healing Status Page

## What We're Building

A demo of an autonomous AI status monitoring agent built entirely on the **Cloudflare stack**. The agent monitors endpoints, investigates failures, auto-remediates, posts AI-generated status updates, and learns from past incidents — all without human intervention.

This is a single deployable Cloudflare Workers project that demonstrates all 5 phases of StatusAgent.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                   Cloudflare Workers                     │
│                                                          │
│  ┌──────────────┐    ┌──────────────────────────────┐   │
│  │  Main Worker  │───▶│  StatusAgent (Durable Object) │   │
│  │  (API Router) │◀───│  - Cron alarms (30s checks)   │   │
│  └──────┬───────┘    │  - WebSocket (live feed)       │   │
│         │            │  - Investigation engine         │   │
│         │            │  - Remediation playbooks        │   │
│         │            │  - Incident memory              │   │
│         │            └──────────┬───────────────────┘   │
│         │                       │                        │
│  ┌──────▼───────┐    ┌─────────▼────────┐              │
│  │  Mock Target  │    │   D1 Database     │              │
│  │  API (Worker) │    │  - Incidents      │              │
│  │  /api/orders  │    │  - Health history │              │
│  │  /api/auth    │    │  - Agent memory   │              │
│  │  /api/payments│    │  - Status updates │              │
│  │  /api/db/health│   └──────────────────┘              │
│  └──────────────┘                                        │
│                                                          │
│  ┌──────────────┐                                        │
│  │ Status Page   │  (Static HTML served by Worker)       │
│  │ + Dashboard   │  (WebSocket for live investigation)   │
│  └──────────────┘                                        │
└─────────────────────────────────────────────────────────┘
```

---

## Cloudflare Stack — What We Use and Why

| Component | Purpose |
|---|---|
| **Workers** | Main API router, serves status page, hosts mock target API |
| **Durable Objects** | StatusAgent — per-customer isolated agent with persistent state |
| **Agents SDK** (`agents` npm package) | Agent framework for building the Durable Object agent |
| **Alarms** (via Durable Objects) | Scheduled health checks every 30s without a user present |
| **WebSockets** (via Durable Objects) | Real-time dashboard showing investigation steps as they happen |
| **D1** | SQLite database for incidents, health check history, agent memory |
| **KV** (optional) | Cache for public status page data |
| **AI Gateway / Workers AI** | LLM calls for investigation reasoning and status update generation |

---

## What Needs to Be Built

### 1. Project Scaffolding

- `wrangler.toml` — Worker config with Durable Object bindings, D1 binding, cron triggers, AI binding
- `package.json` — Dependencies: `agents`, `hono` (routing), `zod` (validation)
- `tsconfig.json` — TypeScript config
- `schema.sql` — D1 database schema

### 2. Mock Target API (`src/mock-api/`)

A simulated set of microservice endpoints that the agent monitors. These must support **chaos mode** — the ability to inject failures on demand for the demo.

**Endpoints to create:**
- `GET /mock/api/orders` — Returns order data (can be set to 503, slow, or timeout)
- `GET /mock/api/auth` — Auth service health (usually healthy)
- `GET /mock/api/payments` — Payments service health (usually healthy)
- `GET /mock/api/database/health` — DB health check (can simulate connection pool exhaustion)
- `GET /mock/api/deploy-history` — Returns fake recent deploys (simulates GitHub API)

**Chaos controls:**
- `POST /mock/chaos` — Set failure scenarios: `{ "endpoint": "/api/orders", "mode": "503" | "slow" | "timeout" | "healthy" }`
- Failure modes: `503`, `slow` (3s+ delay), `timeout` (no response), `pool_exhausted`, `healthy`
- Store chaos state in the Durable Object or D1 so it persists

### 3. StatusAgent Durable Object (`src/agent/`)

The core agent, built with the `agents` SDK's `Agent` class (extends `Agent` from `agents` package).

**State (stored in Durable Object storage + D1):**
- List of endpoints to monitor (configured per agent)
- Baseline metrics (avg response time, normal status codes)
- Current status of each endpoint
- Active incidents
- Incident history
- Learned patterns (which endpoints fail together, common root causes)

**Phase 1 — Detection (`src/agent/detection.ts`):**
- On alarm (every 30s), hit all configured endpoints
- Record response time, status code, response body hash
- Compare against baseline — detect anomalies (not just "is it 200?")
- If anomaly detected, trigger Phase 2

**Phase 2 — Investigation (`src/agent/investigation.ts`):**
- Run a diagnostic chain:
  1. Check all dependency endpoints
  2. Identify which specific services are failing
  3. Check mock deploy history for recent changes
  4. Use Workers AI to reason about the root cause given all collected evidence
- Emit each investigation step over WebSocket in real-time
- Produce an `InvestigationReport` object with: affected services, root cause hypothesis, confidence level, evidence

**Phase 3 — Remediation (`src/agent/remediation.ts`):**
- Based on the investigation report, select a remediation action from configured playbooks
- Playbooks are simple rule-based mappings:
  - `root_cause: "bad_deploy"` → action: `rollback_deploy`
  - `root_cause: "pool_exhaustion"` → action: `restart_service`
  - `root_cause: "traffic_spike"` → action: `scale_up`
- Execute the action (in demo: call mock API to reset chaos state = "auto-heal")
- Monitor recovery — keep checking until endpoint returns to healthy
- Emit remediation steps over WebSocket

**Phase 4 — Communication (`src/agent/communication.ts`):**
- Use Workers AI to generate a human-readable status update from the investigation report
- Post the update to D1 (status updates table)
- Broadcast update over WebSocket to all connected dashboard clients
- Status update includes: title, severity, timeline, root cause explanation, resolution

**Phase 5 — Learning (`src/agent/learning.ts`):**
- After each incident, store a structured incident record in D1
- Track patterns: which endpoints fail most, common root causes, time-of-day patterns, recovery times
- On future incidents, query past incidents for similar patterns to speed up investigation
- Expose learned insights via API

### 4. API Router (`src/index.ts`)

Main Worker entry point using Hono for routing.

**Routes:**
- `GET /` — Serve the public status page (static HTML)
- `GET /dashboard` — Serve the live investigation dashboard (static HTML + WebSocket)
- `GET /api/status` — Current status of all monitored endpoints
- `GET /api/incidents` — List of past incidents with details
- `GET /api/incidents/:id` — Single incident detail
- `GET /api/insights` — Agent's learned patterns and insights
- `POST /api/endpoints` — Configure endpoints to monitor
- `POST /mock/chaos` — Trigger chaos scenarios (demo control)
- `GET /ws` — WebSocket upgrade, proxied to Durable Object

### 5. D1 Database Schema (`schema.sql`)

```sql
-- Health check results
CREATE TABLE health_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL,
  status_code INTEGER,
  response_time_ms INTEGER,
  is_healthy BOOLEAN,
  checked_at TEXT DEFAULT (datetime('now'))
);

-- Incidents
CREATE TABLE incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT DEFAULT 'investigating', -- investigating, identified, remediated, resolved
  severity TEXT DEFAULT 'minor',       -- minor, major, critical
  affected_endpoints TEXT,             -- JSON array
  root_cause TEXT,
  root_cause_confidence REAL,
  evidence TEXT,                       -- JSON object
  remediation_action TEXT,
  remediation_result TEXT,
  started_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT,
  duration_seconds INTEGER
);

-- AI-generated status updates
CREATE TABLE status_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER REFERENCES incidents(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  severity TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Agent memory / learned patterns
CREATE TABLE agent_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern_type TEXT,     -- 'endpoint_failure', 'deploy_correlation', 'time_pattern'
  pattern_key TEXT,
  pattern_data TEXT,     -- JSON
  occurrence_count INTEGER DEFAULT 1,
  last_seen TEXT DEFAULT (datetime('now'))
);
```

### 6. Frontend — Status Page & Dashboard (`src/frontend/`)

Two simple HTML pages served by the Worker (no build step, inline or bundled).

**Public Status Page (`status-page.html`):**
- Clean, minimal status page (like statuspage.io)
- Shows each monitored endpoint with current status (green/yellow/red)
- Lists recent incidents with AI-generated descriptions
- Auto-refreshes or uses SSE/polling

**Live Dashboard (`dashboard.html`):**
- WebSocket-connected real-time view
- Shows the agent's investigation steps as they happen (like a terminal/log feed)
- Timeline of: detection → investigation steps → root cause → remediation → recovery
- "Trigger Incident" button that calls `/mock/chaos` to start a demo scenario
- Shows agent insights/memory panel

---

## Demo Flow

The demo script for showcasing StatusAgent:

1. **Open the dashboard** — Show the agent running, all endpoints green, health checks ticking every 30s
2. **Trigger chaos** — Click "Trigger Incident" (or `POST /mock/chaos` with `orders` endpoint set to `503`)
3. **Watch the agent work** — In real-time on the dashboard:
   - Agent detects `/api/orders` is returning 503
   - Agent checks dependencies one by one
   - Agent finds database health is down
   - Agent checks deploy history, finds recent deploy
   - Agent reasons about root cause using AI
   - Agent executes rollback (resets mock chaos)
   - Agent monitors recovery
   - Agent posts AI-generated status update
4. **Check the status page** — Show the public status page with the incident timeline and AI-written explanation
5. **Show insights** — Agent has learned from the incident and added it to its memory

---

## File Structure

```
CF-agents/
├── CLAUDE.md                  # This file
├── wrangler.toml              # Cloudflare Worker config
├── package.json               # Dependencies
├── tsconfig.json              # TypeScript config
├── schema.sql                 # D1 database schema
├── src/
│   ├── index.ts               # Main Worker entry point (Hono router)
│   ├── types.ts               # Shared TypeScript types
│   ├── mock-api/
│   │   └── index.ts           # Mock target API with chaos controls
│   ├── agent/
│   │   ├── status-agent.ts    # StatusAgent Durable Object class
│   │   ├── detection.ts       # Phase 1: Health check logic
│   │   ├── investigation.ts   # Phase 2: Diagnostic chain
│   │   ├── remediation.ts     # Phase 3: Auto-fix playbooks
│   │   ├── communication.ts   # Phase 4: AI status update generation
│   │   └── learning.ts        # Phase 5: Pattern memory
│   └── frontend/
│       ├── status-page.html   # Public status page
│       └── dashboard.html     # Live investigation dashboard
```

---

## Key Design Decisions

1. **Single Worker deployment** — The mock API, agent, and frontend all live in one Worker project for simplicity. In production these would be separate.
2. **Durable Object alarms** — Used instead of cron triggers for per-agent scheduling. Each agent manages its own 30s alarm loop.
3. **Workers AI** — Used for root cause reasoning and status update generation. Model: `@cf/meta/llama-3.1-8b-instruct` or similar available model.
4. **No external dependencies** — Everything stays on Cloudflare. No GitHub API, no PagerDuty, no external services. The mock API simulates everything.
5. **Demo-first** — This is a demonstration, not a production system. Prioritize visual impact and clear agent behavior over robustness.

---

## Build Order

1. Project scaffolding (wrangler.toml, package.json, tsconfig, schema.sql)
2. Mock Target API with chaos controls
3. StatusAgent Durable Object — detection (alarm loop + health checks)
4. StatusAgent — investigation engine
5. StatusAgent — remediation with playbooks
6. StatusAgent — AI communication (status updates)
7. StatusAgent — learning/memory
8. API routes (Hono)
9. Frontend — status page
10. Frontend — live dashboard with WebSocket
11. Integration testing — full demo flow
