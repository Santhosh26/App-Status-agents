import type { Env, InvestigationReport, InvestigationStep, HealthCheckResult, DeployEntry, DeploymentRecord } from '../types';
import { mockApi } from '../mock-api/index';
import { getSimilarPatterns } from './learning';

type BroadcastFn = (type: string, data: unknown) => void;

const ENDPOINT_SERVICE_MAP: Record<string, string> = {
  '/api/orders': 'orders-service',
  '/api/auth': 'auth-service',
  '/api/payments': 'payments-service',
  '/api/database': 'database-service',
};

export async function investigate(
  env: Env,
  broadcast: BroadcastFn,
  affectedEndpoints: string[],
  incidentId: number
): Promise<InvestigationReport> {
  const steps: InvestigationStep[] = [];
  let stepNum = 0;

  function emitStep(action: string, result: string) {
    stepNum++;
    const step: InvestigationStep = {
      step: stepNum,
      action,
      result,
      timestamp: new Date().toISOString(),
    };
    steps.push(step);
    broadcast('investigation_step', step);
  }

  // Step 1: Check all dependency endpoints individually
  emitStep('Checking all service dependencies', 'Starting dependency scan...');

  const dependencyResults: Record<string, HealthCheckResult> = {};
  const allEndpoints = ['/api/orders', '/api/auth', '/api/payments', '/api/database'];

  for (const ep of allEndpoints) {
    const start = Date.now();
    try {
      const res = await mockApi.fetch(new Request(`http://internal/mock${ep}`), env);
      const elapsed = Date.now() - start;
      const isHealthy = res.status === 200 && elapsed < 5000;
      dependencyResults[ep] = {
        endpoint: ep,
        statusCode: res.status,
        responseTimeMs: elapsed,
        isHealthy,
        checkedAt: new Date().toISOString(),
      };
      emitStep(
        `Checking ${ep}`,
        isHealthy ? `Healthy (${res.status}, ${elapsed}ms)` : `UNHEALTHY (${res.status}, ${elapsed}ms)`
      );
    } catch (e) {
      dependencyResults[ep] = {
        endpoint: ep,
        statusCode: null,
        responseTimeMs: Date.now() - start,
        isHealthy: false,
        error: e instanceof Error ? e.message : 'Unknown error',
        checkedAt: new Date().toISOString(),
      };
      emitStep(`Checking ${ep}`, `ERROR: ${e instanceof Error ? e.message : 'Connection failed'}`);
    }
  }

  // Step 2: Check deployment registry (real data from D1)
  emitStep('Querying deployment registry', 'Checking active versions and recent deployments...');

  let deployHistory: DeployEntry[] = [];
  const recentBadDeploys: DeploymentRecord[] = [];

  try {
    // Get all deployments from registry
    const allDeploys = await env.DB.prepare(
      'SELECT * FROM deployments ORDER BY deployed_at DESC LIMIT 20'
    ).all<DeploymentRecord>();

    deployHistory = (allDeploys.results || []).map(r => ({
      id: r.id,
      service: r.service,
      version: r.version,
      commit_hash: r.commit_hash,
      deployedAt: r.deployed_at,
      author: r.author,
      status: r.status as DeployEntry['status'],
      is_healthy: !!r.is_healthy,
    }));

    // Show current active versions for affected services
    for (const ep of affectedEndpoints) {
      const service = ENDPOINT_SERVICE_MAP[ep];
      if (!service) continue;

      const activeDeploy = await env.DB.prepare(
        "SELECT * FROM deployments WHERE service = ? AND status = 'active' ORDER BY deployed_at DESC LIMIT 1"
      ).bind(service).first<DeploymentRecord>();

      if (activeDeploy) {
        const deployAge = Date.now() - new Date(activeDeploy.deployed_at).getTime();
        const ageStr = deployAge < 3600000 ? `${Math.round(deployAge / 60000)} min ago` : `${Math.round(deployAge / 3600000)}h ago`;

        emitStep(
          `Current active version: ${service}`,
          `**${activeDeploy.version}** (commit ${activeDeploy.commit_hash}, deployed ${ageStr} by ${activeDeploy.author})${activeDeploy.is_healthy ? '' : ' — UNHEALTHY'}`
        );

        if (!activeDeploy.is_healthy) {
          recentBadDeploys.push(activeDeploy);
        }

        // Show previous stable version
        const prevDeploy = await env.DB.prepare(
          "SELECT * FROM deployments WHERE service = ? AND status = 'superseded' AND is_healthy = 1 ORDER BY deployed_at DESC LIMIT 1"
        ).bind(service).first<DeploymentRecord>();

        if (prevDeploy) {
          const prevAge = Date.now() - new Date(prevDeploy.deployed_at).getTime();
          const prevAgeStr = prevAge < 3600000 ? `${Math.round(prevAge / 60000)} min ago` : `${Math.round(prevAge / 86400000)} days ago`;

          emitStep(
            `Previous stable version: ${service}`,
            `**${prevDeploy.version}** (commit ${prevDeploy.commit_hash}, deployed ${prevAgeStr}, was healthy)`
          );
        }

        // Correlate timing
        if (!activeDeploy.is_healthy) {
          emitStep(
            'Deploy correlation detected',
            `Suspicious: ${activeDeploy.version} deployed shortly before outage started`
          );
        }
      }
    }

    // Summary of recent deploys
    const recentDeploys = (allDeploys.results || []).filter(d => {
      const deployAge = Date.now() - new Date(d.deployed_at).getTime();
      return deployAge < 3600000;
    });
    if (recentDeploys.length > 0) {
      emitStep(
        'Recent deployment activity',
        `${recentDeploys.length} deployment(s) in the last hour: ${recentDeploys.map(d => `${d.service} ${d.version} by ${d.author}`).join(', ')}`
      );
    }
  } catch {
    emitStep('Deploy registry check', 'Failed to query deployment registry');
  }

  // Step 3: Query past patterns
  emitStep('Checking agent memory for similar incidents', 'Querying learned patterns...');
  const pastPatterns = await getSimilarPatterns(env, affectedEndpoints);
  if (pastPatterns.length > 0) {
    emitStep(
      'Found relevant past patterns',
      `${pastPatterns.length} pattern(s): ${pastPatterns.map(p => `${p.patternKey} (${p.occurrenceCount}x)`).join(', ')}`
    );
  } else {
    emitStep('Pattern check', 'No similar past incidents found');
  }

  // Step 4: AI reasoning
  emitStep('Analyzing evidence with AI', 'Running root cause analysis...');

  const unhealthyServices = Object.entries(dependencyResults)
    .filter(([, r]) => !r.isHealthy)
    .map(([ep, r]) => `${ep}: status=${r.statusCode}, time=${r.responseTimeMs}ms, error=${r.error || 'none'}`);

  // Build deploy context for AI
  const deployContext = recentBadDeploys.length > 0
    ? recentBadDeploys.map(d => `- ${d.service} ${d.version} (commit ${d.commit_hash}) by ${d.author}, deployed at ${d.deployed_at}, UNHEALTHY`).join('\n')
    : 'No unhealthy deployments detected';

  let rootCause = 'unknown';
  let rootCauseConfidence = 0.5;

  try {
    const prompt = `You are a Site Reliability Engineer analyzing a service outage. Analyze the following evidence and determine the root cause.

AFFECTED ENDPOINTS: ${affectedEndpoints.join(', ')}

DEPENDENCY CHECK RESULTS:
${Object.entries(dependencyResults).map(([ep, r]) => `- ${ep}: ${r.isHealthy ? 'HEALTHY' : 'UNHEALTHY'} (status=${r.statusCode}, ${r.responseTimeMs}ms)`).join('\n')}

DEPLOYMENT REGISTRY:
${deployContext}

PAST PATTERNS:
${pastPatterns.length > 0 ? pastPatterns.map(p => `- ${p.patternType}: ${p.patternKey} (seen ${p.occurrenceCount} times)`).join('\n') : 'None'}

Respond ONLY with valid JSON in this exact format:
{"root_cause": "bad_deploy|pool_exhaustion|traffic_spike|dependency_failure|unknown", "confidence": 0.0-1.0, "explanation": "brief explanation"}`;

    const aiResponse = await env.AI.run('@cf/meta/llama-4-scout-17b-16e-instruct' as keyof AiModels, {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 200,
    } as never);

    const aiText = typeof aiResponse === 'object' && aiResponse !== null && 'response' in aiResponse
      ? (aiResponse as { response: string }).response : '';
    if (aiText) {
      const jsonMatch = aiText.match(/\{[\s\S]*?\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        rootCause = parsed.root_cause || 'unknown';
        rootCauseConfidence = parsed.confidence || 0.5;
        emitStep('AI analysis complete', `Root cause: ${rootCause} (confidence: ${(rootCauseConfidence * 100).toFixed(0)}%) — ${parsed.explanation || ''}`);
      }
    }
  } catch (e) {
    emitStep('AI analysis failed, using heuristic', `Error: ${e instanceof Error ? e.message : 'unknown'}`);
  }

  // Heuristic fallback
  if (rootCause === 'unknown') {
    if (recentBadDeploys.length > 0) {
      rootCause = 'bad_deploy';
      rootCauseConfidence = 0.85;
    } else if (dependencyResults['/api/database'] && !dependencyResults['/api/database'].isHealthy) {
      rootCause = 'pool_exhaustion';
      rootCauseConfidence = 0.75;
    } else if (unhealthyServices.length > 2) {
      rootCause = 'traffic_spike';
      rootCauseConfidence = 0.6;
    } else {
      rootCause = 'dependency_failure';
      rootCauseConfidence = 0.5;
    }
    emitStep('Heuristic analysis', `Root cause: ${rootCause} (confidence: ${(rootCauseConfidence * 100).toFixed(0)}%)`);
  }

  // Determine severity
  const unhealthyCount = Object.values(dependencyResults).filter(r => !r.isHealthy).length;
  const severity = unhealthyCount >= 3 ? 'critical' : unhealthyCount >= 2 ? 'major' : 'minor';

  return {
    incidentId,
    affectedEndpoints,
    dependencyResults,
    deployHistory,
    pastPatterns,
    rootCause,
    rootCauseConfidence,
    evidence: steps,
    severity,
  };
}
