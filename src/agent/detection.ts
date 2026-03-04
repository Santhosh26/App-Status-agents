import type { Env, HealthCheckResult, MonitoredEndpoint } from '../types';
import { mockApi } from '../mock-api/index';

export async function runHealthChecks(
  endpoints: MonitoredEndpoint[],
  env: Env
): Promise<HealthCheckResult[]> {
  const results: HealthCheckResult[] = [];

  for (const ep of endpoints) {
    const start = Date.now();
    let statusCode: number | null = null;
    let isHealthy = false;
    let error: string | undefined;

    try {
      const url = `http://internal/mock${ep.path}`;
      const req = new Request(url);
      const res = await mockApi.fetch(req, env);
      statusCode = res.status;
      const elapsed = Date.now() - start;

      // Healthy if correct status and responded within 5s
      isHealthy = statusCode === ep.expectedStatus && elapsed < 5000;

      if (!isHealthy && statusCode !== ep.expectedStatus) {
        const body = await res.text();
        error = `Expected ${ep.expectedStatus}, got ${statusCode}: ${body.substring(0, 200)}`;
      } else if (elapsed >= 5000) {
        error = `Response too slow: ${elapsed}ms`;
      }

      results.push({
        endpoint: ep.path,
        statusCode,
        responseTimeMs: elapsed,
        isHealthy,
        error,
        checkedAt: new Date().toISOString(),
      });
    } catch (e) {
      results.push({
        endpoint: ep.path,
        statusCode: null,
        responseTimeMs: Date.now() - start,
        isHealthy: false,
        error: e instanceof Error ? e.message : 'Unknown error',
        checkedAt: new Date().toISOString(),
      });
    }
  }

  // Store results in D1
  for (const r of results) {
    await env.DB.prepare(
      'INSERT INTO health_checks (endpoint, status_code, response_time_ms, is_healthy, checked_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(r.endpoint, r.statusCode, r.responseTimeMs, r.isHealthy ? 1 : 0, r.checkedAt).run();
  }

  return results;
}
