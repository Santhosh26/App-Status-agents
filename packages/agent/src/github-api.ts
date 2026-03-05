import type { Env, GitHubCommit, GitHubPullRequest, GitHubCorrelation, GitHubIssue, GitHubRevertPR } from './types';

const GH_API_BASE = 'https://api.github.com';

function headers(env: Env) {
  return {
    'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'StatusAgent/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function repoPath(env: Env) {
  return `${GH_API_BASE}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
}

export function isConfigured(env: Env): boolean {
  return !!(env.GITHUB_TOKEN && env.GITHUB_OWNER && env.GITHUB_REPO);
}

export async function getRecentCommits(env: Env, since?: string, limit = 10): Promise<GitHubCommit[]> {
  const params = new URLSearchParams({ per_page: String(limit) });
  if (since) params.set('since', since);

  const res = await fetch(`${repoPath(env)}/commits?${params}`, {
    headers: headers(env),
  });

  if (!res.ok) {
    console.log(JSON.stringify({ phase: 'github-api', event: 'get_commits_error', status: res.status }));
    return [];
  }

  const data = await res.json() as Array<{
    sha: string;
    commit: { message: string; author: { name: string; date: string } };
    html_url: string;
  }>;

  return data.map(c => ({
    sha: c.sha,
    message: c.commit.message.split('\n')[0],
    author: c.commit.author.name,
    date: c.commit.author.date,
    url: c.html_url,
  }));
}

export async function getRecentPRs(env: Env, limit = 5): Promise<GitHubPullRequest[]> {
  const params = new URLSearchParams({
    state: 'closed',
    sort: 'updated',
    direction: 'desc',
    per_page: String(limit),
  });

  const res = await fetch(`${repoPath(env)}/pulls?${params}`, {
    headers: headers(env),
  });

  if (!res.ok) {
    console.log(JSON.stringify({ phase: 'github-api', event: 'get_prs_error', status: res.status }));
    return [];
  }

  const data = await res.json() as Array<{
    number: number;
    title: string;
    html_url: string;
    merged_at: string | null;
    user: { login: string };
  }>;

  return data
    .filter(pr => pr.merged_at)
    .map(pr => ({
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      mergedAt: pr.merged_at!,
      author: pr.user.login,
    }));
}

export async function correlateDeploymentWithCommits(
  env: Env,
  deployCreatedOn: string,
  windowMinutes = 30
): Promise<GitHubCorrelation> {
  const deployTime = new Date(deployCreatedOn).getTime();
  const windowMs = windowMinutes * 60 * 1000;
  const since = new Date(deployTime - windowMs).toISOString();

  const [commits, prs] = await Promise.all([
    getRecentCommits(env, since, 20),
    getRecentPRs(env, 10),
  ]);

  // Filter commits within the time window
  const correlatedCommits = commits.filter(c => {
    const commitTime = new Date(c.date).getTime();
    return Math.abs(commitTime - deployTime) <= windowMs;
  });

  // Filter PRs merged within the time window
  const correlatedPRs = prs.filter(pr => {
    const mergeTime = new Date(pr.mergedAt).getTime();
    return Math.abs(mergeTime - deployTime) <= windowMs;
  });

  return {
    deploymentVersionId: '',
    commits: correlatedCommits,
    pullRequests: correlatedPRs,
  };
}

export async function createRevertBranch(
  env: Env,
  commitSha: string,
  baseBranch = 'main'
): Promise<{ branchName: string; parentSha: string } | null> {
  // Get the parent commit SHA of the bad commit
  const commitRes = await fetch(`${repoPath(env)}/commits/${commitSha}`, {
    headers: headers(env),
  });

  if (!commitRes.ok) {
    console.log(JSON.stringify({ phase: 'github-api', event: 'get_commit_error', status: commitRes.status, sha: commitSha }));
    return null;
  }

  const commitData = await commitRes.json() as {
    parents: Array<{ sha: string }>;
  };

  if (!commitData.parents || commitData.parents.length === 0) {
    console.log(JSON.stringify({ phase: 'github-api', event: 'no_parent_commit', sha: commitSha }));
    return null;
  }

  const parentSha = commitData.parents[0].sha;
  const branchName = `auto-revert-${commitSha.substring(0, 7)}`;

  // Create a new branch pointing at the parent commit
  const refRes = await fetch(`${repoPath(env)}/git/refs`, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify({
      ref: `refs/heads/${branchName}`,
      sha: parentSha,
    }),
  });

  if (!refRes.ok) {
    const text = await refRes.text();
    console.log(JSON.stringify({ phase: 'github-api', event: 'create_branch_error', status: refRes.status, body: text }));
    return null;
  }

  console.log(JSON.stringify({ phase: 'github-api', event: 'revert_branch_created', branch: branchName, parentSha }));
  return { branchName, parentSha };
}

export async function createRevertPR(
  env: Env,
  branchName: string,
  badCommitSha: string,
  incidentDetails: { severity: string; affectedEndpoints: string[]; rootCause: string },
  baseBranch = 'main'
): Promise<GitHubRevertPR | null> {
  const shortSha = badCommitSha.substring(0, 7);

  const res = await fetch(`${repoPath(env)}/pulls`, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify({
      title: `[Auto-Revert] Revert bad deploy ${shortSha}`,
      head: branchName,
      base: baseBranch,
      body: `## Auto-Revert: Bad Deploy \`${shortSha}\`

This PR was automatically created by **StatusAgent** to revert a bad deployment.

### Incident Details
- **Severity:** ${incidentDetails.severity}
- **Affected endpoints:** ${incidentDetails.affectedEndpoints.join(', ')}
- **Root cause:** ${incidentDetails.rootCause.replace(/_/g, ' ')}

### What happened
The Cloudflare deployment containing commit \`${badCommitSha}\` caused service degradation. StatusAgent performed an immediate CF API rollback to restore service, and created this PR to keep the GitHub repository in sync.

### Action required
Merge this PR to ensure the next deploy from \`main\` does not re-deploy the broken code.

---
*Auto-generated by StatusAgent*`,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.log(JSON.stringify({ phase: 'github-api', event: 'create_revert_pr_error', status: res.status, body: text }));
    return null;
  }

  const data = await res.json() as {
    number: number;
    html_url: string;
  };

  console.log(JSON.stringify({ phase: 'github-api', event: 'revert_pr_created', number: data.number, branch: branchName }));

  return {
    prNumber: data.number,
    prUrl: data.html_url,
    branchName,
    badCommitSha,
  };
}

export async function createIncidentIssue(
  env: Env,
  title: string,
  body: string,
  labels: string[] = ['incident', 'auto-generated']
): Promise<GitHubIssue | null> {
  const res = await fetch(`${repoPath(env)}/issues`, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify({ title, body, labels }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.log(JSON.stringify({ phase: 'github-api', event: 'create_issue_error', status: res.status, body: text }));
    return null;
  }

  const data = await res.json() as {
    number: number;
    title: string;
    html_url: string;
  };

  console.log(JSON.stringify({ phase: 'github-api', event: 'issue_created', number: data.number }));

  return {
    number: data.number,
    title: data.title,
    url: data.html_url,
  };
}
