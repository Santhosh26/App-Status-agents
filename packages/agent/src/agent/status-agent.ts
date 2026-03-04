import { Agent, getAgentByName } from 'agents';
import type { Connection } from 'agents';
import type { Env, StatusAgentState, WSEvent, EndpointStatus, HealthCheckResult, MonitoredEndpoint, DeployInfo, NotificationPayload } from '../types';
import { runHealthChecks } from './detection';
import { investigate } from './investigation';
import { remediate } from './remediation';
import { generateStatusUpdate } from './communication';
import { recordIncidentPattern, getInsights } from './learning';
import * as cfApi from '../cloudflare-api';

const DEFAULT_ENDPOINTS: MonitoredEndpoint[] = [
  { path: '/api/orders', name: 'Orders API', expectedStatus: 200 },
  { path: '/api/auth', name: 'Auth Service', expectedStatus: 200 },
  { path: '/api/payments', name: 'Payments Service', expectedStatus: 200 },
  { path: '/api/database', name: 'Database', expectedStatus: 200 },
];

export class StatusAgent extends Agent<Env, StatusAgentState> {
  initialState: StatusAgentState = {
    endpoints: DEFAULT_ENDPOINTS,
    statuses: {},
    isInvestigating: false,
    activeIncidentId: null,
    lastCheckAt: null,
    currentDeployment: null,
  };

  async onStart() {
    // Initialize D1 tables (idempotent)
    await this.env.DB.exec(`
      CREATE TABLE IF NOT EXISTS health_checks (id INTEGER PRIMARY KEY AUTOINCREMENT, endpoint TEXT NOT NULL, status_code INTEGER, response_time_ms INTEGER, is_healthy BOOLEAN, checked_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS incidents (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT DEFAULT 'investigating', severity TEXT DEFAULT 'minor', affected_endpoints TEXT, root_cause TEXT, root_cause_confidence REAL, evidence TEXT, remediation_action TEXT, remediation_result TEXT, started_at TEXT DEFAULT (datetime('now')), resolved_at TEXT, duration_seconds INTEGER);
      CREATE TABLE IF NOT EXISTS status_updates (id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id INTEGER REFERENCES incidents(id), title TEXT NOT NULL, body TEXT NOT NULL, severity TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS agent_memory (id INTEGER PRIMARY KEY AUTOINCREMENT, pattern_type TEXT, pattern_key TEXT, pattern_data TEXT, occurrence_count INTEGER DEFAULT 1, last_seen TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS incident_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id INTEGER REFERENCES incidents(id), executive_summary TEXT, timeline TEXT, impact_analysis TEXT, root_cause_deep_dive TEXT, remediation_details TEXT, lessons_learned TEXT, action_items TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS notification_channels (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, name TEXT NOT NULL, config TEXT, enabled BOOLEAN DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS notification_log (id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id INTEGER REFERENCES incidents(id), channel_id INTEGER, channel_type TEXT, notification_type TEXT, success BOOLEAN, error TEXT, sent_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS deployment_commits (id INTEGER PRIMARY KEY AUTOINCREMENT, version_id TEXT, commit_sha TEXT, commit_message TEXT, commit_author TEXT, commit_date TEXT, pr_number INTEGER, pr_title TEXT, pr_url TEXT, correlated_at TEXT DEFAULT (datetime('now')));
    `);

    // Try to load current deployment info from Cloudflare API
    await this.refreshDeploymentInfo();

    // Schedule health checks every 30 seconds
    await this.schedule(30, 'performHealthCheck');

    console.log(JSON.stringify({ phase: 'agent', event: 'started', targetApiUrl: this.env.TARGET_API_URL }));
  }

  async refreshDeploymentInfo() {
    try {
      if (this.env.CLOUDFLARE_API_TOKEN && this.env.CF_ACCOUNT_ID) {
        const current = await cfApi.getCurrentDeployment(this.env);
        this.setState({ ...this.state, currentDeployment: current });
      }
    } catch (e) {
      console.log(JSON.stringify({ phase: 'agent', event: 'deployment_info_error', error: e instanceof Error ? e.message : 'unknown' }));
    }
  }

  async onConnect(connection: Connection) {
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

    // Refresh deployment info on each check
    await this.refreshDeploymentInfo();

    this.setState({
      ...this.state,
      statuses: newStatuses,
      lastCheckAt: new Date().toISOString(),
    });

    this.broadcastEvent('health_check', { results, statuses: newStatuses });

    // Safety: reset stuck investigation state (stale for >3 min)
    if (this.state.isInvestigating && this.state.lastCheckAt) {
      const staleMs = Date.now() - new Date(this.state.lastCheckAt).getTime();
      if (staleMs > 180000) {
        console.log(JSON.stringify({ phase: 'agent', event: 'reset_stale_investigation' }));
        this.setState({ ...this.state, isInvestigating: false, activeIncidentId: null });
      }
    }

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

      // Refresh deployment info after remediation (rollback may have changed it)
      await this.refreshDeploymentInfo();

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
      const statusUpdate = await generateStatusUpdate(this.env, broadcast, report, remediationResult, incidentId);

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

      // Phase 6: Post-Mortem Report via IncidentReportAgent
      try {
        this.broadcastEvent('report_step', { section: 'starting', status: 'generating', message: 'Generating post-mortem report...' });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const reportStub = await getAgentByName(this.env.INCIDENT_REPORT_AGENT as any, 'default');
        const reportRes = await reportStub.fetch(new Request('http://agent/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            incidentId,
            investigationReport: report,
            remediationResult,
            statusUpdateTitle: statusUpdate.title,
            statusUpdateBody: statusUpdate.body,
          }),
        }));

        if (reportRes.ok) {
          const reportData = await reportRes.json() as { report: unknown; steps: unknown[] };
          // Broadcast each report step
          for (const step of reportData.steps) {
            this.broadcastEvent('report_step', step);
          }
          this.broadcastEvent('report_complete', { incidentId, report: reportData.report });
        }
      } catch (e) {
        console.log(JSON.stringify({ phase: 'agent', event: 'report_generation_error', error: e instanceof Error ? e.message : 'unknown' }));
        this.broadcastEvent('report_step', { section: 'error', status: 'failed', message: e instanceof Error ? e.message : 'Report generation failed' });
      }

      // Phase 7: Notifications via CommunicationAgent
      try {
        this.broadcastEvent('notification_step', { channel: 'all', status: 'sending', message: 'Sending notifications...' });

        const notificationPayload: NotificationPayload = {
          incidentId,
          title: statusUpdate.title,
          body: statusUpdate.body,
          severity: report.severity,
          rootCause: report.rootCause,
          affectedEndpoints: report.affectedEndpoints,
          remediationAction: remediationResult.action,
          resolved: remediationResult.success,
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const commStub = await getAgentByName(this.env.COMMUNICATION_AGENT as any, 'default');
        const commRes = await commStub.fetch(new Request('http://agent/notify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ payload: notificationPayload }),
        }));

        if (commRes.ok) {
          const commData = await commRes.json() as { results: Array<{ channel: string; type: string; success: boolean; error?: string }> };
          for (const result of commData.results) {
            this.broadcastEvent('notification_step', {
              channel: result.channel,
              type: result.type,
              success: result.success,
              error: result.error,
            });
          }
          this.broadcastEvent('notification_complete', {
            incidentId,
            total: commData.results.length,
            successful: commData.results.filter(r => r.success).length,
          });
        }
      } catch (e) {
        console.log(JSON.stringify({ phase: 'agent', event: 'notification_error', error: e instanceof Error ? e.message : 'unknown' }));
        this.broadcastEvent('notification_step', { channel: 'all', status: 'failed', message: e instanceof Error ? e.message : 'Notifications failed' });
      }
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

  // Handle API requests forwarded from the main worker or dashboard
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/status') {
      return Response.json({
        endpoints: this.state.endpoints,
        statuses: this.state.statuses,
        lastCheckAt: this.state.lastCheckAt,
        isInvestigating: this.state.isInvestigating,
        activeIncidentId: this.state.activeIncidentId,
        currentDeployment: this.state.currentDeployment,
      });
    }

    if (url.pathname === '/api/reset' && request.method === 'POST') {
      this.setState({ ...this.state, isInvestigating: false, activeIncidentId: null });
      return Response.json({ success: true, message: 'Agent state reset' });
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

    if (url.pathname === '/api/deployments') {
      try {
        const deployments = await cfApi.listDeployments(this.env);
        return Response.json({ deployments });
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : 'Failed to fetch deployments' }, { status: 500 });
      }
    }

    if (url.pathname === '/api/deploy-bad' && request.method === 'POST') {
      try {
        const result = await cfApi.deployBadVersion(this.env);
        return Response.json(result);
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : 'Failed to deploy bad version' }, { status: 500 });
      }
    }

    return new Response('Not found', { status: 404 });
  }
}
