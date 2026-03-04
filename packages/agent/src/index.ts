import { Hono } from 'hono';
import { routeAgentRequest, getAgentByName } from 'agents';
import type { Env } from './types';

// Re-export Durable Object classes
export { StatusAgent } from './agent/status-agent';
export { IncidentReportAgent } from './agent/incident-report-agent';
export { CommunicationAgent } from './agent/communication-agent';

const app = new Hono<{ Bindings: Env }>();

// API: Current status — proxy to DO
app.get('/api/status', async (c) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stub = await getAgentByName(c.env.STATUS_AGENT as any, 'default');
  return stub.fetch(new Request('http://agent/api/status'));
});

// API: List incidents from D1
app.get('/api/incidents', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT * FROM incidents ORDER BY started_at DESC LIMIT 50'
  ).all();
  const incidents = rows.results.map((r: Record<string, unknown>) => ({
    ...r,
    affected_endpoints: r.affected_endpoints ? JSON.parse(r.affected_endpoints as string) : [],
    evidence: r.evidence ? JSON.parse(r.evidence as string) : [],
  }));
  return c.json({ incidents });
});

// API: Single incident detail
app.get('/api/incidents/:id', async (c) => {
  const incidentId = c.req.param('id');
  const [incident, updates] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM incidents WHERE id = ?').bind(incidentId).first(),
    c.env.DB.prepare('SELECT * FROM status_updates WHERE incident_id = ? ORDER BY created_at DESC').bind(incidentId).all(),
  ]);

  if (!incident) return c.json({ error: 'Not found' }, 404);

  return c.json({
    incident: {
      ...incident,
      affected_endpoints: incident.affected_endpoints ? JSON.parse(incident.affected_endpoints as string) : [],
      evidence: incident.evidence ? JSON.parse(incident.evidence as string) : [],
    },
    statusUpdates: updates.results,
  });
});

// API: Insights — proxy to DO
app.get('/api/insights', async (c) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stub = await getAgentByName(c.env.STATUS_AGENT as any, 'default');
  return stub.fetch(new Request('http://agent/api/insights'));
});

// API: Configure endpoints — proxy to DO
app.post('/api/endpoints', async (c) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stub = await getAgentByName(c.env.STATUS_AGENT as any, 'default');
  return stub.fetch(new Request('http://agent/api/endpoints', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(await c.req.json()),
  }));
});

// API: List Cloudflare deployments — proxy to DO
app.get('/api/deployments', async (c) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stub = await getAgentByName(c.env.STATUS_AGENT as any, 'default');
  return stub.fetch(new Request('http://agent/api/deployments'));
});

// API: Reset agent state (unstick investigation)
app.post('/api/reset', async (c) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stub = await getAgentByName(c.env.STATUS_AGENT as any, 'default');
  return stub.fetch(new Request('http://agent/api/reset', { method: 'POST' }));
});

// API: Deploy bad version (quick demo) — proxy to DO
app.post('/api/deploy-bad', async (c) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stub = await getAgentByName(c.env.STATUS_AGENT as any, 'default');
  return stub.fetch(new Request('http://agent/api/deploy-bad', { method: 'POST' }));
});

// API: Get post-mortem report for an incident
app.get('/api/reports/:incidentId', async (c) => {
  const incidentId = c.req.param('incidentId');
  const report = await c.env.DB.prepare(
    'SELECT * FROM incident_reports WHERE incident_id = ?'
  ).bind(incidentId).first();

  if (!report) return c.json({ error: 'No report found for this incident' }, 404);

  return c.json({
    report: {
      ...report,
      timeline: report.timeline ? JSON.parse(report.timeline as string) : [],
      action_items: report.action_items ? JSON.parse(report.action_items as string) : [],
    },
  });
});

// API: Notification delivery log
app.get('/api/notifications', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT * FROM notification_log ORDER BY sent_at DESC LIMIT 100'
  ).all();
  return c.json({ notifications: rows.results });
});

// API: List notification channels — proxy to CommunicationAgent DO
app.get('/api/notifications/channels', async (c) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stub = await getAgentByName(c.env.COMMUNICATION_AGENT as any, 'default');
  return stub.fetch(new Request('http://agent/channels'));
});

// API: Add notification channel — proxy to CommunicationAgent DO
app.post('/api/notifications/channels', async (c) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stub = await getAgentByName(c.env.COMMUNICATION_AGENT as any, 'default');
  return stub.fetch(new Request('http://agent/channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(await c.req.json()),
  }));
});

// API: GitHub commit correlations for a deployment version
app.get('/api/github/commits/:versionId', async (c) => {
  const versionId = c.req.param('versionId');
  const rows = await c.env.DB.prepare(
    'SELECT * FROM deployment_commits WHERE version_id = ? ORDER BY commit_date DESC'
  ).bind(versionId).all();
  return c.json({ commits: rows.results });
});

// Default export — handle agent WebSocket routing first, then fall back to Hono
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Let the agents SDK handle /agents/* routes (WebSocket upgrades)
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    // Fall through to Hono for everything else
    return app.fetch(request, env, ctx);
  },
};
