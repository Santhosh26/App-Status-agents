import { Hono } from 'hono';
import type { Env, ChaosMode, DeployEntry, DeploymentRecord } from '../types';

const mockApi = new Hono<{ Bindings: Env }>();

// Service-to-endpoint mapping
const SERVICE_ENDPOINT_MAP: Record<string, string> = {
  'orders-service': '/api/orders',
  'auth-service': '/api/auth',
  'payments-service': '/api/payments',
  'database-service': '/api/database',
};
const ENDPOINT_SERVICE_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(SERVICE_ENDPOINT_MAP).map(([k, v]) => [v, k])
);

async function getActiveDeployment(db: D1Database, service: string): Promise<DeploymentRecord | null> {
  return db.prepare(
    'SELECT * FROM deployments WHERE service = ? AND status = ? ORDER BY deployed_at DESC LIMIT 1'
  ).bind(service, 'active').first<DeploymentRecord>();
}

// Also check chaos_state as fallback (for pool_exhausted and slow scenarios that aren't deploy-driven)
async function getChaosMode(db: D1Database, endpoint: string): Promise<ChaosMode> {
  const row = await db.prepare('SELECT mode FROM chaos_state WHERE endpoint = ?').bind(endpoint).first<{ mode: string }>();
  return (row?.mode as ChaosMode) || 'healthy';
}

async function applyChaos(mode: ChaosMode): Promise<Response | null> {
  switch (mode) {
    case 'slow':
      await new Promise(r => setTimeout(r, 3000));
      return null;
    case 'timeout':
      await new Promise(r => setTimeout(r, 30000));
      return new Response(JSON.stringify({ error: 'Timeout' }), { status: 504 });
    case 'pool_exhausted':
      return new Response(JSON.stringify({ error: 'Connection pool exhausted', details: 'Max connections (100) reached', connections: { active: 100, idle: 0, max: 100 } }), { status: 503 });
    default:
      return null;
  }
}

// Helper: build response with version headers
function serviceResponse(data: object, deploy: DeploymentRecord | null): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (deploy) {
    headers['X-Service-Version'] = deploy.version;
    headers['X-Service-Commit'] = deploy.commit_hash;
  }
  return new Response(JSON.stringify(data), { headers });
}

// Orders endpoint
mockApi.get('/mock/api/orders', async (c) => {
  const service = 'orders-service';
  const deploy = await getActiveDeployment(c.env.DB, service);

  // Check if deployment is unhealthy (bad deploy scenario)
  if (deploy && !deploy.is_healthy) {
    return c.json({
      error: 'Service Unavailable',
      service,
      version: deploy.version,
      commit: deploy.commit_hash,
      message: `${service} ${deploy.version} is failing after deployment`,
    }, 503);
  }

  // Check chaos_state for non-deploy failures (slow, timeout)
  const chaos = await getChaosMode(c.env.DB, '/api/orders');
  const chaosResponse = await applyChaos(chaos);
  if (chaosResponse) return chaosResponse;

  return serviceResponse({
    orders: [
      { id: 'ORD-001', status: 'completed', total: 49.99 },
      { id: 'ORD-002', status: 'processing', total: 129.50 },
      { id: 'ORD-003', status: 'shipped', total: 89.00 },
    ],
    total: 3,
    service,
    version: deploy?.version || 'unknown',
    healthy: true,
  }, deploy);
});

// Auth endpoint
mockApi.get('/mock/api/auth', async (c) => {
  const service = 'auth-service';
  const deploy = await getActiveDeployment(c.env.DB, service);

  if (deploy && !deploy.is_healthy) {
    return c.json({ error: 'Service Unavailable', service, version: deploy.version, commit: deploy.commit_hash }, 503);
  }

  const chaos = await getChaosMode(c.env.DB, '/api/auth');
  const chaosResponse = await applyChaos(chaos);
  if (chaosResponse) return chaosResponse;

  return serviceResponse({ status: 'ok', service, version: deploy?.version || 'unknown', uptime: '99.99%', healthy: true }, deploy);
});

// Payments endpoint
mockApi.get('/mock/api/payments', async (c) => {
  const service = 'payments-service';
  const deploy = await getActiveDeployment(c.env.DB, service);

  if (deploy && !deploy.is_healthy) {
    return c.json({ error: 'Service Unavailable', service, version: deploy.version, commit: deploy.commit_hash }, 503);
  }

  const chaos = await getChaosMode(c.env.DB, '/api/payments');
  const chaosResponse = await applyChaos(chaos);
  if (chaosResponse) return chaosResponse;

  return serviceResponse({ status: 'ok', service, version: deploy?.version || 'unknown', provider: 'stripe', healthy: true }, deploy);
});

// Database health endpoint
mockApi.get('/mock/api/database', async (c) => {
  const service = 'database-service';
  const deploy = await getActiveDeployment(c.env.DB, service);

  if (deploy && !deploy.is_healthy) {
    return c.json({ error: 'Service Unavailable', service, version: deploy.version, commit: deploy.commit_hash }, 503);
  }

  const chaos = await getChaosMode(c.env.DB, '/api/database');
  const chaosResponse = await applyChaos(chaos);
  if (chaosResponse) return chaosResponse;

  return serviceResponse({
    status: 'ok',
    service,
    version: deploy?.version || 'unknown',
    connections: { active: 12, idle: 88, max: 100 },
    healthy: true,
  }, deploy);
});

// Deploy history — reads from real deployments table
mockApi.get('/mock/api/deploy-history', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT * FROM deployments ORDER BY deployed_at DESC LIMIT 20'
  ).all<DeploymentRecord>();

  const deploys: DeployEntry[] = (rows.results || []).map(r => ({
    id: r.id,
    service: r.service,
    version: r.version,
    commit_hash: r.commit_hash,
    deployedAt: r.deployed_at,
    author: r.author,
    status: r.status as DeployEntry['status'],
    is_healthy: !!r.is_healthy,
  }));

  return c.json({ deploys });
});

// Simulate a bad deployment
mockApi.post('/mock/deploy', async (c) => {
  const body = await c.req.json<{ service: string; version: string; commit_hash: string; author: string; is_healthy?: boolean }>();
  const { service, version, commit_hash, author, is_healthy = false } = body;
  const id = `dep-${Date.now()}`;

  // Mark current active as superseded
  await c.env.DB.prepare(
    "UPDATE deployments SET status = 'superseded' WHERE service = ? AND status = 'active'"
  ).bind(service).run();

  // Insert new deployment
  await c.env.DB.prepare(
    'INSERT INTO deployments (id, service, version, commit_hash, author, status, is_healthy, deployed_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime(\'now\'))'
  ).bind(id, service, version, commit_hash, author, 'active', is_healthy ? 1 : 0).run();

  return c.json({ success: true, deployment: { id, service, version, commit_hash, author, status: 'active', is_healthy } });
});

// Rollback a deployment — mark bad version as rolled_back, reactivate previous good version
mockApi.post('/mock/deploy/rollback', async (c) => {
  const body = await c.req.json<{ service: string; target_version?: string }>();
  const { service, target_version } = body;

  // Mark current active as rolled_back
  await c.env.DB.prepare(
    "UPDATE deployments SET status = 'rolled_back', rolled_back_at = datetime('now') WHERE service = ? AND status = 'active'"
  ).bind(service).run();

  if (target_version) {
    // Reactivate specific version
    await c.env.DB.prepare(
      "UPDATE deployments SET status = 'active', is_healthy = 1 WHERE service = ? AND version = ? AND status IN ('superseded', 'rolled_back')"
    ).bind(service, target_version).run();
  } else {
    // Reactivate the most recent superseded healthy version
    const prev = await c.env.DB.prepare(
      "SELECT id FROM deployments WHERE service = ? AND status = 'superseded' AND is_healthy = 1 ORDER BY deployed_at DESC LIMIT 1"
    ).bind(service).first<{ id: string }>();
    if (prev) {
      await c.env.DB.prepare(
        "UPDATE deployments SET status = 'active' WHERE id = ?"
      ).bind(prev.id).run();
    }
  }

  // Also clear any chaos_state for this service's endpoint
  const endpoint = SERVICE_ENDPOINT_MAP[service];
  if (endpoint) {
    await c.env.DB.prepare('DELETE FROM chaos_state WHERE endpoint = ?').bind(endpoint).run();
  }

  return c.json({ success: true, service, rolled_back_to: target_version || 'previous' });
});

// Get current active versions for all services
mockApi.get('/mock/deploy/active', async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT * FROM deployments WHERE status = 'active' ORDER BY service"
  ).all<DeploymentRecord>();

  const versions: Record<string, { version: string; commitHash: string; deployedAt: string; author: string }> = {};
  for (const r of rows.results || []) {
    versions[r.service] = {
      version: r.version,
      commitHash: r.commit_hash,
      deployedAt: r.deployed_at,
      author: r.author,
    };
  }

  return c.json({ versions });
});

// Set chaos mode — for non-deploy failures, wraps deploy for 503 scenarios
mockApi.post('/mock/chaos', async (c) => {
  const body = await c.req.json<{ endpoint: string; mode: ChaosMode }>();
  const { endpoint, mode } = body;

  if (mode === '503') {
    // For 503, simulate a bad deployment instead
    const service = ENDPOINT_SERVICE_MAP[endpoint];
    if (service) {
      // Mark current active as superseded
      await c.env.DB.prepare(
        "UPDATE deployments SET status = 'superseded' WHERE service = ? AND status = 'active'"
      ).bind(service).run();

      // Insert bad deployment
      const id = `dep-${Date.now()}`;
      await c.env.DB.prepare(
        "INSERT INTO deployments (id, service, version, commit_hash, author, status, is_healthy, deployed_at) VALUES (?, ?, ?, ?, ?, 'active', 0, datetime('now'))"
      ).bind(id, service, 'v1.9.0-rc1', 'a3f7c2d', 'junior-dev').run();

      return c.json({ success: true, endpoint, mode, method: 'bad_deploy', deployment_id: id });
    }
  }

  // For other modes (slow, timeout, pool_exhausted), use chaos_state
  await c.env.DB.prepare(
    "INSERT INTO chaos_state (endpoint, mode, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(endpoint) DO UPDATE SET mode = ?, updated_at = datetime('now')"
  ).bind(endpoint, mode, mode).run();

  return c.json({ success: true, endpoint, mode });
});

// Reset all chaos
mockApi.post('/mock/chaos/reset', async (c) => {
  await c.env.DB.prepare('DELETE FROM chaos_state').run();
  // Also reset any unhealthy deploys by rolling them back
  const unhealthy = await c.env.DB.prepare(
    "SELECT DISTINCT service FROM deployments WHERE status = 'active' AND is_healthy = 0"
  ).all<{ service: string }>();
  for (const row of unhealthy.results || []) {
    await c.env.DB.prepare(
      "UPDATE deployments SET status = 'rolled_back', rolled_back_at = datetime('now') WHERE service = ? AND status = 'active' AND is_healthy = 0"
    ).bind(row.service).run();
    // Reactivate previous
    const prev = await c.env.DB.prepare(
      "SELECT id FROM deployments WHERE service = ? AND status = 'superseded' AND is_healthy = 1 ORDER BY deployed_at DESC LIMIT 1"
    ).bind(row.service).first<{ id: string }>();
    if (prev) {
      await c.env.DB.prepare("UPDATE deployments SET status = 'active' WHERE id = ?").bind(prev.id).run();
    }
  }
  return c.json({ success: true, message: 'All chaos cleared' });
});

// Get current chaos state
mockApi.get('/mock/chaos', async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM chaos_state').all<{ endpoint: string; mode: string }>();
  const unhealthy = await c.env.DB.prepare(
    "SELECT service, version, commit_hash FROM deployments WHERE status = 'active' AND is_healthy = 0"
  ).all<{ service: string; version: string; commit_hash: string }>();
  return c.json({ chaosState: rows.results, unhealthyDeploys: unhealthy.results });
});

export { mockApi };
