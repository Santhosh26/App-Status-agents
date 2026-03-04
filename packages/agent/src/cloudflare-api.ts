import type { Env, CfDeployment, CfVersion, DeployInfo } from './types';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

function headers(env: Env) {
  return {
    'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

function scriptPath(env: Env) {
  return `${CF_API_BASE}/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/${env.TARGET_WORKER_NAME}`;
}

export async function listDeployments(env: Env): Promise<DeployInfo[]> {
  const res = await fetch(`${scriptPath(env)}/deployments`, {
    headers: headers(env),
  });

  if (!res.ok) {
    const text = await res.text();
    console.log(JSON.stringify({ phase: 'cloudflare-api', event: 'list_deployments_error', status: res.status, body: text }));
    throw new Error(`CF API error listing deployments: ${res.status}`);
  }

  const data = await res.json() as { result: { deployments: CfDeployment[] } };
  const deployments = data.result?.deployments || [];

  return deployments.map(d => ({
    id: d.id,
    versionId: d.versions?.[0]?.version_id || '',
    author: d.author_email || d.source || 'unknown',
    createdOn: d.created_on,
    source: d.source,
  }));
}

export async function listVersions(env: Env, limit = 10): Promise<CfVersion[]> {
  const res = await fetch(`${scriptPath(env)}/versions?per_page=${limit}`, {
    headers: headers(env),
  });

  if (!res.ok) {
    const text = await res.text();
    console.log(JSON.stringify({ phase: 'cloudflare-api', event: 'list_versions_error', status: res.status, body: text }));
    throw new Error(`CF API error listing versions: ${res.status}`);
  }

  const data = await res.json() as { result: CfVersion[] };
  return data.result || [];
}

export async function getCurrentDeployment(env: Env): Promise<DeployInfo | null> {
  const deployments = await listDeployments(env);
  if (deployments.length === 0) return null;
  return deployments[0];
}

export async function rollbackToVersion(env: Env, versionId: string): Promise<DeployInfo> {
  console.log(JSON.stringify({ phase: 'cloudflare-api', event: 'rollback_start', targetVersionId: versionId }));

  const res = await fetch(`${scriptPath(env)}/deployments`, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify({
      strategy: 'percentage',
      versions: [
        { version_id: versionId, percentage: 100 },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.log(JSON.stringify({ phase: 'cloudflare-api', event: 'rollback_error', status: res.status, body: text }));
    throw new Error(`CF API error creating deployment (rollback): ${res.status}`);
  }

  const data = await res.json() as { result: CfDeployment };
  const d = data.result;

  console.log(JSON.stringify({ phase: 'cloudflare-api', event: 'rollback_success', deploymentId: d.id, versionId }));

  return {
    id: d.id,
    versionId: d.versions?.[0]?.version_id || versionId,
    author: d.author_email || d.source || 'rollback',
    createdOn: d.created_on,
    source: d.source,
  };
}

export async function deployBadVersion(env: Env): Promise<{ success: boolean; message: string; versionId?: string }> {
  // Get versions and find one to deploy that's known to be broken
  // For the demo, we upload a broken version first, then deploy it
  // However, since we can't upload code via the deployments API alone,
  // the "deploy bad version" flow works by listing versions and deploying
  // the current one tagged as broken, or the most recent non-current version.
  //
  // In practice, the demo flow is:
  // 1. Push broken code via git → GH Actions deploys broken version
  // 2. Agent detects failure
  // 3. Agent rolls back to previous version
  //
  // The "quick demo" button can redeploy the current (broken) version if one exists,
  // or simply return info for the user to push broken code.

  const deployments = await listDeployments(env);
  if (deployments.length < 2) {
    return { success: false, message: 'Need at least 2 deployments for quick demo. Push broken code via git instead.' };
  }

  // Deploy the second-most-recent version (which may have been the broken one that was rolled back)
  // This simulates "re-deploying a bad version"
  const targetVersion = deployments[1];

  const res = await fetch(`${scriptPath(env)}/deployments`, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify({
      strategy: 'percentage',
      versions: [
        { version_id: targetVersion.versionId, percentage: 100 },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    return { success: false, message: `Failed to deploy version: ${res.status} ${text}` };
  }

  return {
    success: true,
    message: `Deployed version ${targetVersion.versionId.substring(0, 8)} (previously deployed on ${targetVersion.createdOn})`,
    versionId: targetVersion.versionId,
  };
}
