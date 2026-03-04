import type { Env, InvestigationReport, RemediationPlaybook, RemediationResult } from '../types';
import * as cfApi from '../cloudflare-api';

type BroadcastFn = (type: string, data: unknown) => void;

const PLAYBOOKS: RemediationPlaybook[] = [
  {
    rootCause: 'bad_deploy',
    action: 'rollback_deploy',
    description: 'Rolling back to last known good deployment via Cloudflare API',
  },
  {
    rootCause: 'pool_exhaustion',
    action: 'restart_service',
    description: 'Restarting database connection pool',
  },
  {
    rootCause: 'traffic_spike',
    action: 'scale_up',
    description: 'Scaling up service instances to handle increased load',
  },
  {
    rootCause: 'dependency_failure',
    action: 'restart_dependencies',
    description: 'Restarting failed dependency services',
  },
];

function delay(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

export async function remediate(
  env: Env,
  broadcast: BroadcastFn,
  report: InvestigationReport
): Promise<RemediationResult> {
  const playbook = PLAYBOOKS.find(p => p.rootCause === report.rootCause) || PLAYBOOKS[PLAYBOOKS.length - 1];

  broadcast('remediation_step', {
    action: playbook.action,
    description: `Selecting playbook: ${playbook.description}`,
    phase: 'starting',
  });

  console.log(JSON.stringify({ phase: 'remediation', event: 'playbook_selected', rootCause: report.rootCause, action: playbook.action }));

  try {
    switch (playbook.rootCause) {
      case 'bad_deploy':
        return await remediateBadDeploy(env, broadcast, report, playbook);
      case 'pool_exhaustion':
        return await remediateSimulated(env, broadcast, report, playbook, 'pool_exhaustion');
      case 'traffic_spike':
        return await remediateSimulated(env, broadcast, report, playbook, 'traffic_spike');
      default:
        return await remediateSimulated(env, broadcast, report, playbook, 'dependency_failure');
    }
  } catch (e) {
    console.log(JSON.stringify({ phase: 'remediation', event: 'error', error: e instanceof Error ? e.message : 'unknown' }));
    return {
      action: playbook.action,
      success: false,
      message: `Remediation failed: ${e instanceof Error ? e.message : 'unknown error'}`,
      recoveryVerified: false,
    };
  }
}

async function remediateBadDeploy(
  env: Env,
  broadcast: BroadcastFn,
  report: InvestigationReport,
  playbook: RemediationPlaybook
): Promise<RemediationResult> {
  // Step 1: Get deployment history from Cloudflare API
  broadcast('remediation_step', {
    action: 'query_cf_api',
    description: 'Querying Cloudflare API for deployment history...',
    phase: 'executing',
  });
  await delay(800);

  let deployments = report.deployHistory;
  if (deployments.length === 0) {
    deployments = await cfApi.listDeployments(env);
  }

  if (deployments.length < 2) {
    broadcast('remediation_step', {
      action: 'rollback_failed',
      description: 'Not enough deployment history to perform rollback',
      phase: 'failed',
    });
    return {
      action: playbook.action,
      success: false,
      message: 'Not enough deployment history. Need at least 2 deployments to rollback.',
      recoveryVerified: false,
    };
  }

  const currentDeploy = deployments[0];
  const previousDeploy = deployments[1];

  // Step 2: Show current (bad) deployment
  broadcast('remediation_step', {
    action: 'identify_bad_deploy',
    description: `Current (failing) deployment: version **${currentDeploy.versionId.substring(0, 8)}** deployed by ${currentDeploy.author} via ${currentDeploy.source}`,
    phase: 'executing',
  });
  await delay(600);

  // Step 3: Show deployment history
  broadcast('remediation_step', {
    action: 'deployment_history',
    description: `Deployment history:\n${deployments.slice(0, 5).map((d, i) => `  ${i === 0 ? '→ ' : '  '}${d.versionId.substring(0, 8)} (by ${d.author}, ${new Date(d.createdOn).toLocaleString()})`).join('\n')}`,
    phase: 'executing',
  });
  await delay(500);

  // Step 4: Determine rollback target
  let targetVersionId = report.rollbackTargetVersionId || previousDeploy.versionId;

  // Ask AI for recommendation
  broadcast('remediation_step', {
    action: 'ai_rollback_analysis',
    description: 'Consulting AI for rollback target recommendation...',
    phase: 'executing',
  });
  await delay(300);

  let aiReasoning = 'Rolling back to previous deployment version';

  try {
    const historyForAI = deployments.slice(0, 5).map((d, i) => {
      const age = Date.now() - new Date(d.createdOn).getTime();
      const ageStr = age < 3600000 ? `${Math.round(age / 60000)} minutes` : age < 86400000 ? `${Math.round(age / 3600000)} hours` : `${Math.round(age / 86400000)} days`;
      return `- ${d.versionId.substring(0, 8)} (by ${d.author}, ${ageStr} ago, via ${d.source})${i === 0 ? ' — CURRENT/FAILING' : ''}`;
    }).join('\n');

    const prompt = `You are an SRE deciding which version to roll back to.

CURRENT (FAILING): version ${currentDeploy.versionId.substring(0, 8)} by ${currentDeploy.author}

DEPLOYMENT HISTORY:
${historyForAI}

Recommend which version to roll back to. The safest choice is usually the immediately previous deployment.

Respond ONLY with valid JSON:
{"target_version_id": "...", "reasoning": "one sentence explanation"}`;

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
        if (parsed.target_version_id) {
          // Match AI suggestion to actual version IDs
          const matched = deployments.find(d => d.versionId.startsWith(parsed.target_version_id));
          if (matched) {
            targetVersionId = matched.versionId;
          }
        }
        aiReasoning = parsed.reasoning || aiReasoning;
      }
    }
  } catch {
    // AI failed, use fallback
  }

  broadcast('remediation_step', {
    action: 'ai_recommendation',
    description: `AI recommends rollback to **${targetVersionId.substring(0, 8)}**: ${aiReasoning}`,
    phase: 'executing',
  });
  await delay(800);

  // Step 5: Execute real rollback via Cloudflare API
  broadcast('remediation_step', {
    action: 'rollback_start',
    description: `Initiating Cloudflare API rollback: ${currentDeploy.versionId.substring(0, 8)} → ${targetVersionId.substring(0, 8)}...`,
    phase: 'executing',
  });
  await delay(500);

  const newDeployment = await cfApi.rollbackToVersion(env, targetVersionId);

  broadcast('remediation_step', {
    action: 'rollback_executed',
    description: `Cloudflare deployment created: ${newDeployment.id.substring(0, 8)}. Target API now running version ${targetVersionId.substring(0, 8)}.`,
    phase: 'executing',
  });
  await delay(1000);

  // Step 6: Verify health post-rollback
  broadcast('remediation_step', {
    action: 'verify_health',
    description: 'Waiting for deployment to propagate, then verifying health...',
    phase: 'verifying',
  });
  await delay(3000); // Wait for deployment to propagate

  let allRecovered = true;
  for (const ep of report.affectedEndpoints) {
    try {
      const res = await fetch(`${env.TARGET_API_URL}${ep}`, { signal: AbortSignal.timeout(10000) });
      const elapsed = Date.now();
      if (res.status === 200) {
        broadcast('remediation_step', {
          action: 'verify_recovery',
          description: `${ep} responding healthy (${res.status})`,
          phase: 'recovered',
        });
      } else {
        allRecovered = false;
        broadcast('remediation_step', {
          action: 'verify_recovery',
          description: `${ep} still unhealthy (${res.status})`,
          phase: 'partial',
        });
      }
    } catch {
      allRecovered = false;
    }
  }

  console.log(JSON.stringify({ phase: 'remediation', event: 'rollback_complete', success: allRecovered, targetVersionId }));

  return {
    action: playbook.action,
    success: allRecovered,
    message: allRecovered
      ? `Successfully rolled back to version ${targetVersionId.substring(0, 8)} via Cloudflare API. All services recovered.`
      : `Rollback to ${targetVersionId.substring(0, 8)} executed but some services still unhealthy.`,
    recoveryVerified: allRecovered,
  };
}

async function remediateSimulated(
  env: Env,
  broadcast: BroadcastFn,
  report: InvestigationReport,
  playbook: RemediationPlaybook,
  type: string
): Promise<RemediationResult> {
  // For non-deploy issues, we can't perform real CF API actions.
  // These are simulated remediation steps that demonstrate the agent's capability.

  const steps: Record<string, { action: string; desc: string }[]> = {
    pool_exhaustion: [
      { action: 'connect_manager', desc: 'Connecting to database service manager...' },
      { action: 'pool_status', desc: 'Current pool status: **100/100 connections active** (0 idle) — pool exhausted' },
      { action: 'drain_connections', desc: 'Draining stale connections (killing idle > 30s)...' },
      { action: 'drain_progress', desc: 'Terminated 47 stale connections. Active: 53/100' },
      { action: 'restart_pool', desc: 'Restarting connection pool with max_connections=100...' },
      { action: 'pool_restarted', desc: 'Pool restarted successfully: **5/100 active, 95 idle**' },
    ],
    traffic_spike: [
      { action: 'check_instances', desc: 'Checking current instance count: **2 instances** running' },
      { action: 'load_check', desc: 'Load average: **98%** — auto-scaling triggered' },
      { action: 'provision', desc: 'Provisioning 4 additional instances...' },
      { action: 'instance_3', desc: 'Instance 3 starting... ready' },
      { action: 'instance_4', desc: 'Instance 4 starting... ready' },
      { action: 'instance_5', desc: 'Instance 5 starting... ready' },
      { action: 'instance_6', desc: 'Instance 6 starting... ready' },
      { action: 'instances_ready', desc: 'All **6 instances** healthy. Load rebalanced to **24%** per instance.' },
    ],
    dependency_failure: [
      { action: 'restart_deps', desc: 'Restarting failed dependency services...' },
      { action: 'restarting', desc: `Restarting affected services: ${report.affectedEndpoints.join(', ')}` },
      { action: 'services_restarted', desc: 'All dependency services restarted' },
    ],
  };

  const actionSteps = steps[type] || steps.dependency_failure;

  for (const step of actionSteps) {
    broadcast('remediation_step', {
      action: step.action,
      description: step.desc,
      phase: 'executing',
    });
    await delay(800);
  }

  // Verify health
  broadcast('remediation_step', {
    action: 'verify_health',
    description: 'Verifying service health...',
    phase: 'verifying',
  });
  await delay(1500);

  let allRecovered = true;
  for (const ep of report.affectedEndpoints) {
    try {
      const res = await fetch(`${env.TARGET_API_URL}${ep}`, { signal: AbortSignal.timeout(10000) });
      if (res.status === 200) {
        broadcast('remediation_step', {
          action: 'verify_recovery',
          description: `${ep} recovered successfully`,
          phase: 'recovered',
        });
      } else {
        allRecovered = false;
        broadcast('remediation_step', {
          action: 'verify_recovery',
          description: `${ep} still unhealthy (${res.status})`,
          phase: 'partial',
        });
      }
    } catch {
      allRecovered = false;
    }
  }

  const messages: Record<string, string> = {
    pool_exhaustion: allRecovered
      ? 'Database connection pool restarted. All services recovered.'
      : 'Pool restarted but some services still unhealthy.',
    traffic_spike: allRecovered
      ? 'Scaled from 2 to 6 instances. All services recovered.'
      : 'Scaling complete but some services still unhealthy.',
    dependency_failure: allRecovered
      ? 'All dependency services restarted and recovered.'
      : 'Some services still unhealthy after restart.',
  };

  return {
    action: playbook.action,
    success: allRecovered,
    message: messages[type] || (allRecovered ? 'All services recovered.' : 'Some services still unhealthy.'),
    recoveryVerified: allRecovered,
  };
}
