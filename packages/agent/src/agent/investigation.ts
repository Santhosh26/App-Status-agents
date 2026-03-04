import type { Env, InvestigationReport, InvestigationStep, HealthCheckResult, DeployInfo } from '../types';
import * as cfApi from '../cloudflare-api';
import { getSimilarPatterns } from './learning';

type BroadcastFn = (type: string, data: unknown) => void;

export async function investigate(
  env: Env,
  broadcast: BroadcastFn,
  affectedEndpoints: string[],
  incidentId: number
): Promise<InvestigationReport> {
  const steps: InvestigationStep[] = [];
  let stepNum = 0;
  const targetUrl = env.TARGET_API_URL;

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
    console.log(JSON.stringify({ phase: 'investigation', event: 'step', step: stepNum, action, result: result.substring(0, 200) }));
  }

  // Step 1: Check all dependency endpoints via real HTTP
  emitStep('Checking all service dependencies', 'Starting dependency scan...');

  const dependencyResults: Record<string, HealthCheckResult> = {};
  const allEndpoints = ['/api/orders', '/api/auth', '/api/payments', '/api/database'];

  for (const ep of allEndpoints) {
    const start = Date.now();
    try {
      const res = await fetch(`${targetUrl}${ep}`, { signal: AbortSignal.timeout(10000) });
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

  // Step 2: Check Cloudflare deployment history via REST API
  emitStep('Querying Cloudflare deployment history', 'Checking recent deployments via Cloudflare API...');

  let deployHistory: DeployInfo[] = [];
  let currentDeployment: DeployInfo | null = null;
  let previousDeployment: DeployInfo | null = null;

  try {
    deployHistory = await cfApi.listDeployments(env);

    if (deployHistory.length > 0) {
      currentDeployment = deployHistory[0];
      const deployAge = Date.now() - new Date(currentDeployment.createdOn).getTime();
      const ageStr = deployAge < 3600000 ? `${Math.round(deployAge / 60000)} min ago` : `${Math.round(deployAge / 3600000)}h ago`;

      emitStep(
        `Current deployment: ${env.TARGET_WORKER_NAME}`,
        `Version **${currentDeployment.versionId.substring(0, 8)}** (deployed ${ageStr} by ${currentDeployment.author} via ${currentDeployment.source})`
      );

      // Check if deployment is recent (within 30 min) — suspicious timing
      if (deployAge < 1800000) {
        emitStep(
          'Deploy correlation detected',
          `Suspicious: new deployment ${currentDeployment.versionId.substring(0, 8)} was deployed ${Math.round(deployAge / 60000)} min ago, shortly before outage`
        );
      }
    }

    if (deployHistory.length > 1) {
      previousDeployment = deployHistory[1];
      const prevAge = Date.now() - new Date(previousDeployment.createdOn).getTime();
      const prevAgeStr = prevAge < 3600000 ? `${Math.round(prevAge / 60000)} min ago` : prevAge < 86400000 ? `${Math.round(prevAge / 3600000)}h ago` : `${Math.round(prevAge / 86400000)} days ago`;

      emitStep(
        `Previous deployment`,
        `Version **${previousDeployment.versionId.substring(0, 8)}** (deployed ${prevAgeStr} by ${previousDeployment.author})`
      );
    }

    if (deployHistory.length > 2) {
      emitStep(
        'Deployment history',
        `${deployHistory.length} total deployments found. Last 3: ${deployHistory.slice(0, 3).map(d => d.versionId.substring(0, 8)).join(', ')}`
      );
    }
  } catch (e) {
    emitStep('Cloudflare API check', `Failed to query deployments: ${e instanceof Error ? e.message : 'unknown'}`);
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
  const recentDeployAge = currentDeployment ? Date.now() - new Date(currentDeployment.createdOn).getTime() : Infinity;
  const isRecentDeploy = recentDeployAge < 1800000; // 30 min

  const deployContext = currentDeployment
    ? `Current deployment: version ${currentDeployment.versionId.substring(0, 8)}, deployed ${Math.round(recentDeployAge / 60000)} min ago by ${currentDeployment.author} via ${currentDeployment.source}.${isRecentDeploy ? ' RECENTLY DEPLOYED — possible cause.' : ''}`
    : 'No deployment data available';

  let rootCause = 'unknown';
  let rootCauseConfidence = 0.5;

  try {
    const prompt = `You are a Site Reliability Engineer analyzing a service outage. Analyze the following evidence and determine the root cause.

AFFECTED ENDPOINTS: ${affectedEndpoints.join(', ')}

DEPENDENCY CHECK RESULTS:
${Object.entries(dependencyResults).map(([ep, r]) => `- ${ep}: ${r.isHealthy ? 'HEALTHY' : 'UNHEALTHY'} (status=${r.statusCode}, ${r.responseTimeMs}ms)`).join('\n')}

DEPLOYMENT INFO:
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
      ? String((aiResponse as { response: unknown }).response || '') : '';
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
    if (isRecentDeploy) {
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

  // Set rollback target if bad_deploy — find last known-good version
  // Skip versions with the same versionId as current (same code), and look for
  // a different version that was previously working
  let rollbackTargetVersionId: string | undefined;
  if (rootCause === 'bad_deploy' && deployHistory.length > 1) {
    const currentVersionId = deployHistory[0]?.versionId;
    // Find the first deployment with a DIFFERENT version ID (different code)
    const candidate = deployHistory.find(d => d.versionId !== currentVersionId);
    if (candidate) {
      rollbackTargetVersionId = candidate.versionId;
      emitStep('Rollback target identified', `Found different version **${candidate.versionId.substring(0, 8)}** (deployed by ${candidate.author} on ${new Date(candidate.createdOn).toLocaleString()})`);
    }
  }

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
    rollbackTargetVersionId,
  };
}
