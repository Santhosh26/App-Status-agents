import type { Env, HealthCheckResult, MonitoredEndpoint } from '../types';

export async function runHealthChecks(
  endpoints: MonitoredEndpoint[],
  env: Env
): Promise<HealthCheckResult[]> {
  const results: HealthCheckResult[] = [];
  const targetUrl = env.TARGET_API_URL;

  for (const ep of endpoints) {
    const start = Date.now();
    let statusCode: number | null = null;
    let isHealthy = false;
    let error: string | undefined;

    try {
      const url = `${targetUrl}${ep.path}`;
      console.log(JSON.stringify({ phase: 'detection', event: 'health_check_start', endpoint: ep.path, url }));

      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
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

      console.log(JSON.stringify({ phase: 'detection', event: 'health_check', endpoint: ep.path, status: statusCode, responseTimeMs: elapsed, isHealthy }));

      results.push({
        endpoint: ep.path,
        statusCode,
        responseTimeMs: elapsed,
        isHealthy,
        error,
        checkedAt: new Date().toISOString(),
      });
    } catch (e) {
      const elapsed = Date.now() - start;
      const errMsg = e instanceof Error ? e.message : 'Unknown error';
      console.log(JSON.stringify({ phase: 'detection', event: 'health_check_error', endpoint: ep.path, error: errMsg, responseTimeMs: elapsed }));

      results.push({
        endpoint: ep.path,
        statusCode: null,
        responseTimeMs: elapsed,
        isHealthy: false,
        error: errMsg,
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
