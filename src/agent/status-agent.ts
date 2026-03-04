import { Agent } from 'agents';
import type { Connection } from 'agents';
import type { Env, StatusAgentState, WSEvent, EndpointStatus, HealthCheckResult, MonitoredEndpoint, ActiveVersion, DeploymentRecord } from '../types';
import { runHealthChecks } from './detection';
import { investigate } from './investigation';
import { remediate } from './remediation';
import { generateStatusUpdate } from './communication';
import { recordIncidentPattern, getInsights } from './learning';

const DEFAULT_ENDPOINTS: MonitoredEndpoint[] = [
  { path: '/api/orders', name: 'Orders API', expectedStatus: 200 },
  { path: '/api/auth', name: 'Auth Service', expectedStatus: 200 },
  { path: '/api/payments', name: 'Payments Service', expectedStatus: 200 },
  { path: '/api/database', name: 'Database', expectedStatus: 200 },
];

const BASELINE_DEPLOYMENTS = [
  { id: 'dep-baseline-001', service: 'orders-service', version: 'v1.8.0', commit_hash: 'b4e8f1a', author: 'ci-bot' },
  { id: 'dep-baseline-002', service: 'auth-service', version: 'v3.1.2', commit_hash: 'c7d2e9b', author: 'ci-bot' },
  { id: 'dep-baseline-003', service: 'payments-service', version: 'v2.4.0', commit_hash: 'd5f3a8c', author: 'ci-bot' },
  { id: 'dep-baseline-004', service: 'database-service', version: 'v4.0.1', commit_hash: 'e6g4b9d', author: 'ci-bot' },
];

// Historical deployments for richer rollback AI reasoning
const HISTORICAL_DEPLOYMENTS = [
  { id: 'dep-hist-001', service: 'orders-service', version: 'v1.7.2', commit_hash: 'f2a9c3e', author: 'dev-team', daysAgo: 5 },
  { id: 'dep-hist-002', service: 'orders-service', version: 'v1.7.0', commit_hash: '8b3d4e1', author: 'ci-bot', daysAgo: 14 },
  { id: 'dep-hist-003', service: 'auth-service', version: 'v3.1.0', commit_hash: 'a1b2c3d', author: 'ci-bot', daysAgo: 10 },
  { id: 'dep-hist-004', service: 'payments-service', version: 'v2.3.1', commit_hash: 'e4f5g6h', author: 'dev-team', daysAgo: 7 },
  { id: 'dep-hist-005', service: 'database-service', version: 'v4.0.0', commit_hash: 'i7j8k9l', author: 'ci-bot', daysAgo: 12 },
];

export class StatusAgent extends Agent<Env, StatusAgentState> {
  initialState: StatusAgentState = {
    endpoints: DEFAULT_ENDPOINTS,
    statuses: {},
    isInvestigating: false,
    activeIncidentId: null,
    lastCheckAt: null,
    activeVersions: {},
  };

  async onStart() {
    // Initialize D1 tables (idempotent)
    await this.env.DB.exec(`
      CREATE TABLE IF NOT EXISTS health_checks (id INTEGER PRIMARY KEY AUTOINCREMENT, endpoint TEXT NOT NULL, status_code INTEGER, response_time_ms INTEGER, is_healthy BOOLEAN, checked_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS incidents (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT DEFAULT 'investigating', severity TEXT DEFAULT 'minor', affected_endpoints TEXT, root_cause TEXT, root_cause_confidence REAL, evidence TEXT, remediation_action TEXT, remediation_result TEXT, started_at TEXT DEFAULT (datetime('now')), resolved_at TEXT, duration_seconds INTEGER);
      CREATE TABLE IF NOT EXISTS status_updates (id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id INTEGER REFERENCES incidents(id), title TEXT NOT NULL, body TEXT NOT NULL, severity TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS agent_memory (id INTEGER PRIMARY KEY AUTOINCREMENT, pattern_type TEXT, pattern_key TEXT, pattern_data TEXT, occurrence_count INTEGER DEFAULT 1, last_seen TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS chaos_state (endpoint TEXT PRIMARY KEY, mode TEXT DEFAULT 'healthy', updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS deployments (id TEXT PRIMARY KEY, service TEXT NOT NULL, version TEXT NOT NULL, commit_hash TEXT NOT NULL, author TEXT NOT NULL, status TEXT DEFAULT 'active', is_healthy BOOLEAN DEFAULT 1, deployed_at TEXT DEFAULT (datetime('now')), rolled_back_at TEXT);
      CREATE INDEX IF NOT EXISTS idx_deployments_service ON deployments(service, status);
    `);

    // Seed baseline deployments if table is empty
    const count = await this.env.DB.prepare('SELECT COUNT(*) as cnt FROM deployments').first<{ cnt: number }>();
    if (!count || count.cnt === 0) {
      // Insert historical deployments first (older, superseded)
      for (const h of HISTORICAL_DEPLOYMENTS) {
        const deployedAt = new Date(Date.now() - h.daysAgo * 86400000).toISOString().replace('T', ' ').slice(0, 19);
        await this.env.DB.prepare(
          'INSERT INTO deployments (id, service, version, commit_hash, author, status, is_healthy, deployed_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)'
        ).bind(h.id, h.service, h.version, h.commit_hash, h.author, 'superseded', deployedAt).run();
      }

      // Insert current active deployments (2 days ago baseline)
      for (const d of BASELINE_DEPLOYMENTS) {
        const deployedAt = new Date(Date.now() - 2 * 86400000).toISOString().replace('T', ' ').slice(0, 19);
        await this.env.DB.prepare(
          'INSERT INTO deployments (id, service, version, commit_hash, author, status, is_healthy, deployed_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)'
        ).bind(d.id, d.service, d.version, d.commit_hash, d.author, 'active', deployedAt).run();
      }
    }

    // Load active versions into state
    await this.refreshActiveVersions();

    // Schedule health checks every 30 seconds
    await this.schedule(30, 'performHealthCheck');
  }

  async refreshActiveVersions() {
    const rows = await this.env.DB.prepare(
      "SELECT * FROM deployments WHERE status = 'active'"
    ).all<DeploymentRecord>();

    const activeVersions: Record<string, ActiveVersion> = {};
    for (const r of rows.results || []) {
      activeVersions[r.service] = {
        version: r.version,
        commitHash: r.commit_hash,
        deployedAt: r.deployed_at,
        author: r.author,
      };
    }

    this.setState({ ...this.state, activeVersions });
  }

  async onConnect(connection: Connection) {
    // Send current state to newly connected client
    connection.send(JSON.stringify({
      type: 'init',
      data: {
        state: this.state,
      },
      timestamp: new Date().toISOString(),
    }));
  }

  async onMessage(connection: Connection, message: unknown) {
    try {
      const msg = typeof message === 'string' ? JSON.parse(message) : message;

      // Filter out Agent SDK internal messages
      if (typeof msg === 'object' && msg !== null && 'type' in msg) {
        const msgType = (msg as { type: string }).type;
        if (msgType.startsWith('cf_agent_')) return;
      }

      if (msg.type === 'trigger_check') {
        await this.performHealthCheck();
      } else if (msg.type === 'configure_endpoints') {
        this.setState({ ...this.state, endpoints: msg.endpoints });
      }
    } catch {
      // Ignore unparseable messages
    }
  }

  async performHealthCheck() {
    const results = await runHealthChecks(this.state.endpoints, this.env);
    const newStatuses: Record<string, EndpointStatus> = {};
    const unhealthy: HealthCheckResult[] = [];

    for (const r of results) {
      if (r.isHealthy) {
        newStatuses[r.endpoint] = 'healthy';
      } else if (r.statusCode !== null && r.responseTimeMs > 2000) {
        newStatuses[r.endpoint] = 'degraded';
        unhealthy.push(r);
      } else {
        newStatuses[r.endpoint] = 'down';
        unhealthy.push(r);
      }
    }

    // Refresh active versions on each check
    await this.refreshActiveVersions();

    this.setState({
      ...this.state,
      statuses: newStatuses,
      lastCheckAt: new Date().toISOString(),
    });

    this.broadcastEvent('health_check', { results, statuses: newStatuses });

    // If unhealthy endpoints and not already investigating, trigger investigation
    if (unhealthy.length > 0 && !this.state.isInvestigating) {
      await this.triggerInvestigation(unhealthy);
    }

    // Re-schedule for 30s
    await this.schedule(30, 'performHealthCheck');
  }

  async triggerInvestigation(unhealthyResults: HealthCheckResult[]) {
    this.setState({ ...this.state, isInvestigating: true });

    try {
      // Create incident in D1
      const affectedEndpoints = unhealthyResults.map(r => r.endpoint);
      const result = await this.env.DB.prepare(
        'INSERT INTO incidents (status, affected_endpoints) VALUES (?, ?)'
      ).bind('investigating', JSON.stringify(affectedEndpoints)).run();

      const incidentId = result.meta.last_row_id as number;
      this.setState({ ...this.state, activeIncidentId: incidentId });

      this.broadcastEvent('status_change', {
        incidentId,
        status: 'investigating',
        affectedEndpoints,
      });

      const broadcast = (type: string, data: unknown) => this.broadcastEvent(type, data);

      // Phase 2: Investigation
      const report = await investigate(this.env, broadcast, affectedEndpoints, incidentId);

      // Update incident with investigation results
      await this.env.DB.prepare(
        'UPDATE incidents SET status = ?, severity = ?, root_cause = ?, root_cause_confidence = ?, evidence = ? WHERE id = ?'
      ).bind('identified', report.severity, report.rootCause, report.rootCauseConfidence, JSON.stringify(report.evidence), incidentId).run();

      this.broadcastEvent('investigation_complete', report);

      // Phase 3: Remediation
      const remediationResult = await remediate(this.env, broadcast, report);

      // Refresh active versions after remediation (rollback may have changed them)
      await this.refreshActiveVersions();

      // Update incident with remediation
      await this.env.DB.prepare(
        'UPDATE incidents SET status = ?, remediation_action = ?, remediation_result = ? WHERE id = ?'
      ).bind(
        remediationResult.success ? 'remediated' : 'identified',
        remediationResult.action,
        remediationResult.message,
        incidentId
      ).run();

      this.broadcastEvent('remediation_complete', remediationResult);

      // Phase 4: Communication
      await generateStatusUpdate(this.env, broadcast, report, remediationResult, incidentId);

      // Phase 5: Learning
      await recordIncidentPattern(this.env, broadcast, report, incidentId);

      // Resolve incident
      const resolvedAt = new Date().toISOString();
      const startedAtRow = await this.env.DB.prepare('SELECT started_at FROM incidents WHERE id = ?').bind(incidentId).first<{ started_at: string }>();
      const duration = startedAtRow ? Math.round((new Date(resolvedAt).getTime() - new Date(startedAtRow.started_at).getTime()) / 1000) : 0;

      await this.env.DB.prepare(
        'UPDATE incidents SET status = ?, resolved_at = ?, duration_seconds = ? WHERE id = ?'
      ).bind('resolved', resolvedAt, duration, incidentId).run();

      this.broadcastEvent('status_change', {
        incidentId,
        status: 'resolved',
        duration,
      });
    } catch (err) {
      this.broadcastEvent('error', {
        message: err instanceof Error ? err.message : 'Investigation failed',
      });
    } finally {
      this.setState({
        ...this.state,
        isInvestigating: false,
        activeIncidentId: null,
      });
    }
  }

  broadcastEvent(type: string, data: unknown) {
    const event: WSEvent = {
      type: type as WSEvent['type'],
      data,
      timestamp: new Date().toISOString(),
    };
    this.broadcast(JSON.stringify(event));
  }

  // Handle API requests forwarded from the main worker
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/status') {
      return Response.json({
        endpoints: this.state.endpoints,
        statuses: this.state.statuses,
        lastCheckAt: this.state.lastCheckAt,
        isInvestigating: this.state.isInvestigating,
        activeIncidentId: this.state.activeIncidentId,
        activeVersions: this.state.activeVersions,
      });
    }

    if (url.pathname === '/api/insights') {
      const insights = await getInsights(this.env);
      return Response.json(insights);
    }

    if (url.pathname === '/api/endpoints' && request.method === 'POST') {
      const body = await request.json() as { endpoints: StatusAgentState['endpoints'] };
      this.setState({ ...this.state, endpoints: body.endpoints });
      return Response.json({ success: true, endpoints: body.endpoints });
    }

    return new Response('Not found', { status: 404 });
  }
}
