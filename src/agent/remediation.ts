import type { Env, InvestigationReport, RemediationPlaybook, RemediationResult, DeploymentRecord } from '../types';
import { mockApi } from '../mock-api/index';

type BroadcastFn = (type: string, data: unknown) => void;

const ENDPOINT_SERVICE_MAP: Record<string, string> = {
  '/api/orders': 'orders-service',
  '/api/auth': 'auth-service',
  '/api/payments': 'payments-service',
  '/api/database': 'database-service',
};

const PLAYBOOKS: RemediationPlaybook[] = [
  {
    rootCause: 'bad_deploy',
    action: 'rollback_deploy',
    description: 'Rolling back to last known good deployment',
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

  try {
    switch (playbook.rootCause) {
      case 'bad_deploy':
        return await remediateBadDeploy(env, broadcast, report, playbook);
      case 'pool_exhaustion':
        return await remediatePoolExhaustion(env, broadcast, report, playbook);
      case 'traffic_spike':
        return await remediateTrafficSpike(env, broadcast, report, playbook);
      default:
        return await remediateDependencyFailure(env, broadcast, report, playbook);
    }
  } catch (e) {
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
  // Step 1: Query deployment registry
  broadcast('remediation_step', {
    action: 'query_registry',
    description: 'Querying deployment registry for affected services...',
    phase: 'executing',
  });
  await delay(800);

  // Find the bad deployments
  const affectedServices: string[] = [];
  for (const ep of report.affectedEndpoints) {
    const svc = ENDPOINT_SERVICE_MAP[ep];
    if (svc) affectedServices.push(svc);
  }

  for (const service of affectedServices) {
    const badDeploy = await env.DB.prepare(
      "SELECT * FROM deployments WHERE service = ? AND status = 'active' AND is_healthy = 0 ORDER BY deployed_at DESC LIMIT 1"
    ).bind(service).first<DeploymentRecord>();

    if (!badDeploy) continue;

    const deployAge = Date.now() - new Date(badDeploy.deployed_at).getTime();
    const ageStr = deployAge < 3600000 ? `${Math.round(deployAge / 60000)} min ago` : `${Math.round(deployAge / 3600000)}h ago`;

    // Step 2: Identify bad deployment
    broadcast('remediation_step', {
      action: 'identify_bad_deploy',
      description: `Identified bad deployment: **${service} ${badDeploy.version}** (commit ${badDeploy.commit_hash}) deployed ${ageStr} by ${badDeploy.author}`,
      phase: 'executing',
    });
    await delay(600);

    // Step 3: Retrieve full deployment history
    broadcast('remediation_step', {
      action: 'fetch_history',
      description: `Retrieving deployment history for ${service}...`,
      phase: 'executing',
    });
    await delay(700);

    const allVersions = await env.DB.prepare(
      'SELECT * FROM deployments WHERE service = ? ORDER BY deployed_at DESC LIMIT 10'
    ).bind(service).all<DeploymentRecord>();

    const historyLines = (allVersions.results || []).map(d => {
      const age = Date.now() - new Date(d.deployed_at).getTime();
      const ageStr2 = age < 3600000 ? `${Math.round(age / 60000)} min ago` : age < 86400000 ? `${Math.round(age / 3600000)}h ago` : `${Math.round(age / 86400000)} days ago`;
      return `${d.version} (commit ${d.commit_hash}, by ${d.author}, ${ageStr2}, ${d.status}${d.is_healthy ? ', healthy' : ', UNHEALTHY'})`;
    });

    broadcast('remediation_step', {
      action: 'deployment_history',
      description: `Deployment history for ${service}:\n${historyLines.map(l => `  • ${l}`).join('\n')}`,
      phase: 'executing',
    });
    await delay(500);

    // Step 4: AI Rollback Decision
    broadcast('remediation_step', {
      action: 'ai_rollback_analysis',
      description: 'Consulting AI for rollback target recommendation...',
      phase: 'executing',
    });
    await delay(300);

    let targetVersion: string | null = null;
    let targetCommit: string | null = null;
    let aiReasoning: string | null = null;

    try {
      const historyForAI = (allVersions.results || []).map(d => {
        const age = Date.now() - new Date(d.deployed_at).getTime();
        const runTime = age < 3600000 ? `${Math.round(age / 60000)} minutes` : age < 86400000 ? `${Math.round(age / 3600000)} hours` : `${Math.round(age / 86400000)} days`;
        return `- ${d.version} (commit ${d.commit_hash}, by ${d.author}, deployed ${runTime} ago, status: ${d.status}, healthy: ${d.is_healthy ? 'yes' : 'NO'})`;
      }).join('\n');

      const prompt = `You are an SRE deciding which version to roll back to.

CURRENT (FAILING): ${service} ${badDeploy.version} (commit ${badDeploy.commit_hash}, by ${badDeploy.author}, deployed ${ageStr}, UNHEALTHY)

DEPLOYMENT HISTORY:
${historyForAI}

Analyze the options and recommend which version to roll back to. Consider:
1. The most recent healthy version is safest (minimal feature regression)
2. CI-bot deployments are more reliable than manual ones
3. Versions that ran longer without issues are more proven

Respond ONLY with valid JSON:
{"target_version": "...", "target_commit": "...", "reasoning": "one sentence explanation"}`;

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
          targetVersion = parsed.target_version || null;
          targetCommit = parsed.target_commit || null;
          aiReasoning = parsed.reasoning || null;
        }
      }
    } catch {
      // AI failed, fall through to fallback
    }

    // Fallback: pick most recent healthy superseded version
    if (!targetVersion) {
      const fallback = await env.DB.prepare(
        "SELECT * FROM deployments WHERE service = ? AND status = 'superseded' AND is_healthy = 1 ORDER BY deployed_at DESC LIMIT 1"
      ).bind(service).first<DeploymentRecord>();
      if (fallback) {
        targetVersion = fallback.version;
        targetCommit = fallback.commit_hash;
        aiReasoning = 'Fallback selection: most recent healthy version';
      }
    }

    if (!targetVersion) {
      broadcast('remediation_step', {
        action: 'rollback_failed',
        description: `No healthy version found to roll back to for ${service}`,
        phase: 'failed',
      });
      continue;
    }

    // Step 5: Broadcast AI reasoning
    broadcast('remediation_step', {
      action: 'ai_recommendation',
      description: `AI recommends rollback to **${targetVersion}** (commit ${targetCommit}): ${aiReasoning}`,
      phase: 'executing',
    });
    await delay(800);

    // Step 6: Initiate rollback
    broadcast('remediation_step', {
      action: 'rollback_start',
      description: `Initiating rollback: ${badDeploy.version} → ${targetVersion}...`,
      phase: 'executing',
    });
    await delay(1000);

    // Step 7: Mark bad version as rolled_back
    broadcast('remediation_step', {
      action: 'mark_rolled_back',
      description: `Marking ${badDeploy.version} as rolled_back in deployment registry`,
      phase: 'executing',
    });

    await mockApi.fetch(
      new Request('http://internal/mock/deploy/rollback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service, target_version: targetVersion }),
      }),
      env
    );
    await delay(700);

    // Step 8: Confirm reactivation
    broadcast('remediation_step', {
      action: 'reactivate_version',
      description: `Reactivating ${targetVersion} as active deployment`,
      phase: 'executing',
    });
    await delay(500);

    // Step 9: Verify health
    broadcast('remediation_step', {
      action: 'verify_health',
      description: 'Verifying service health post-rollback...',
      phase: 'verifying',
    });
    await delay(1500);
  }

  // Final verification of all affected endpoints
  let allRecovered = true;
  for (const ep of report.affectedEndpoints) {
    try {
      const res = await mockApi.fetch(new Request(`http://internal/mock${ep}`), env);
      const elapsed = 5; // fast internal check
      if (res.status === 200) {
        broadcast('remediation_step', {
          action: 'verify_recovery',
          description: `${ENDPOINT_SERVICE_MAP[ep] || ep} responding healthy (${res.status}, ${elapsed}ms)`,
          phase: 'recovered',
        });
      } else {
        allRecovered = false;
        broadcast('remediation_step', {
          action: 'verify_recovery',
          description: `${ENDPOINT_SERVICE_MAP[ep] || ep} still unhealthy (${res.status})`,
          phase: 'partial',
        });
      }
    } catch {
      allRecovered = false;
    }
  }

  return {
    action: playbook.action,
    success: allRecovered,
    message: allRecovered
      ? `Successfully rolled back affected services. All services recovered.`
      : `Rollback executed but some services are still unhealthy.`,
    recoveryVerified: allRecovered,
  };
}

async function remediatePoolExhaustion(
  env: Env,
  broadcast: BroadcastFn,
  report: InvestigationReport,
  playbook: RemediationPlaybook
): Promise<RemediationResult> {
  // Step 1
  broadcast('remediation_step', {
    action: 'connect_manager',
    description: 'Connecting to database service manager...',
    phase: 'executing',
  });
  await delay(800);

  // Step 2
  broadcast('remediation_step', {
    action: 'pool_status',
    description: 'Current pool status: **100/100 connections active** (0 idle) — pool exhausted',
    phase: 'executing',
  });
  await delay(600);

  // Step 3
  broadcast('remediation_step', {
    action: 'drain_connections',
    description: 'Draining stale connections (killing idle > 30s)...',
    phase: 'executing',
  });
  await delay(1200);

  broadcast('remediation_step', {
    action: 'drain_progress',
    description: 'Terminated 47 stale connections. Active: 53/100',
    phase: 'executing',
  });
  await delay(800);

  // Step 4
  broadcast('remediation_step', {
    action: 'restart_pool',
    description: 'Restarting connection pool with max_connections=100...',
    phase: 'executing',
  });

  // Reset chaos state for database
  await mockApi.fetch(
    new Request('http://internal/mock/chaos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: '/api/database', mode: 'healthy' }),
    }),
    env
  );
  await delay(1500);

  // Step 5
  broadcast('remediation_step', {
    action: 'pool_restarted',
    description: 'Pool restarted successfully: **5/100 active, 95 idle**',
    phase: 'executing',
  });
  await delay(600);

  // Step 6: Verify
  broadcast('remediation_step', {
    action: 'verify_health',
    description: 'Verifying database health...',
    phase: 'verifying',
  });
  await delay(1000);

  let allRecovered = true;
  for (const ep of report.affectedEndpoints) {
    try {
      const res = await mockApi.fetch(new Request(`http://internal/mock${ep}`), env);
      if (res.status === 200) {
        broadcast('remediation_step', {
          action: 'verify_recovery',
          description: `${ENDPOINT_SERVICE_MAP[ep] || ep} recovered successfully`,
          phase: 'recovered',
        });
      } else {
        allRecovered = false;
        broadcast('remediation_step', {
          action: 'verify_recovery',
          description: `${ENDPOINT_SERVICE_MAP[ep] || ep} still unhealthy (${res.status})`,
          phase: 'partial',
        });
      }
    } catch {
      allRecovered = false;
    }
  }

  return {
    action: playbook.action,
    success: allRecovered,
    message: allRecovered
      ? 'Database connection pool restarted. All services recovered.'
      : 'Pool restarted but some services still unhealthy.',
    recoveryVerified: allRecovered,
  };
}

async function remediateTrafficSpike(
  env: Env,
  broadcast: BroadcastFn,
  report: InvestigationReport,
  playbook: RemediationPlaybook
): Promise<RemediationResult> {
  // Step 1
  broadcast('remediation_step', {
    action: 'check_instances',
    description: 'Checking current instance count: **2 instances** running',
    phase: 'executing',
  });
  await delay(700);

  // Step 2
  broadcast('remediation_step', {
    action: 'load_check',
    description: 'Load average: **98%** — auto-scaling triggered',
    phase: 'executing',
  });
  await delay(600);

  // Step 3
  broadcast('remediation_step', {
    action: 'provision',
    description: 'Provisioning 4 additional instances...',
    phase: 'executing',
  });
  await delay(1000);

  // Step 4: Instance startup sequence
  const instances = [3, 4, 5, 6];
  for (const inst of instances) {
    broadcast('remediation_step', {
      action: 'instance_start',
      description: `Instance ${inst} starting... ready`,
      phase: 'executing',
    });
    await delay(500);
  }

  // Reset chaos for traffic spike endpoints
  for (const ep of ['/api/orders', '/api/auth', '/api/payments']) {
    await mockApi.fetch(
      new Request('http://internal/mock/chaos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: ep, mode: 'healthy' }),
      }),
      env
    );
  }

  // Step 5
  broadcast('remediation_step', {
    action: 'instances_ready',
    description: 'All **6 instances** healthy. Load rebalanced to **24%** per instance.',
    phase: 'executing',
  });
  await delay(800);

  // Step 6: Verify
  broadcast('remediation_step', {
    action: 'verify_health',
    description: 'Verifying service health...',
    phase: 'verifying',
  });
  await delay(1000);

  let allRecovered = true;
  for (const ep of report.affectedEndpoints) {
    try {
      const res = await mockApi.fetch(new Request(`http://internal/mock${ep}`), env);
      if (res.status === 200) {
        broadcast('remediation_step', {
          action: 'verify_recovery',
          description: `${ENDPOINT_SERVICE_MAP[ep] || ep} recovered successfully`,
          phase: 'recovered',
        });
      } else {
        allRecovered = false;
      }
    } catch {
      allRecovered = false;
    }
  }

  return {
    action: playbook.action,
    success: allRecovered,
    message: allRecovered
      ? 'Scaled from 2 to 6 instances. All services recovered.'
      : 'Scaling complete but some services still unhealthy.',
    recoveryVerified: allRecovered,
  };
}

async function remediateDependencyFailure(
  env: Env,
  broadcast: BroadcastFn,
  report: InvestigationReport,
  playbook: RemediationPlaybook
): Promise<RemediationResult> {
  broadcast('remediation_step', {
    action: 'restart_deps',
    description: 'Restarting failed dependency services...',
    phase: 'executing',
  });
  await delay(800);

  for (const ep of report.affectedEndpoints) {
    broadcast('remediation_step', {
      action: 'restarting',
      description: `Restarting ${ENDPOINT_SERVICE_MAP[ep] || ep}...`,
      phase: 'executing',
    });

    await mockApi.fetch(
      new Request('http://internal/mock/chaos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: ep, mode: 'healthy' }),
      }),
      env
    );
    await delay(1000);
  }

  broadcast('remediation_step', {
    action: 'verify_health',
    description: 'Verifying service health post-restart...',
    phase: 'verifying',
  });
  await delay(1500);

  let allRecovered = true;
  for (const ep of report.affectedEndpoints) {
    try {
      const res = await mockApi.fetch(new Request(`http://internal/mock${ep}`), env);
      if (res.status === 200) {
        broadcast('remediation_step', {
          action: 'verify_recovery',
          description: `${ENDPOINT_SERVICE_MAP[ep] || ep} recovered successfully`,
          phase: 'recovered',
        });
      } else {
        allRecovered = false;
      }
    } catch {
      allRecovered = false;
    }
  }

  return {
    action: playbook.action,
    success: allRecovered,
    message: allRecovered
      ? 'All dependency services restarted and recovered.'
      : 'Some services still unhealthy after restart.',
    recoveryVerified: allRecovered,
  };
}
