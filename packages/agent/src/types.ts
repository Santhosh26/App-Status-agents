export interface Env {
  DB: D1Database;
  AI: Ai;
  STATUS_AGENT: DurableObjectNamespace;
  INCIDENT_REPORT_AGENT: DurableObjectNamespace;
  COMMUNICATION_AGENT: DurableObjectNamespace;
  TARGET_API_URL: string;
  CF_ACCOUNT_ID: string;
  TARGET_WORKER_NAME: string;
  CLOUDFLARE_API_TOKEN: string;
  SLACK_WEBHOOK_URL?: string;
  DISCORD_WEBHOOK_URL?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  NOTIFICATION_EMAILS?: string;
  GITHUB_TOKEN?: string;
  GITHUB_OWNER?: string;
  GITHUB_REPO?: string;
}

export interface HealthCheckResult {
  endpoint: string;
  statusCode: number | null;
  responseTimeMs: number;
  isHealthy: boolean;
  error?: string;
  checkedAt: string;
}

export interface MonitoredEndpoint {
  path: string;
  name: string;
  expectedStatus: number;
}

export type EndpointStatus = 'healthy' | 'degraded' | 'down';

export interface InvestigationStep {
  step: number;
  action: string;
  result: string;
  timestamp: string;
}

export interface CfDeployment {
  id: string;
  source: string;
  strategy: string;
  author_email: string;
  created_on: string;
  versions: CfDeploymentVersion[];
}

export interface CfDeploymentVersion {
  version_id: string;
  percentage: number;
}

export interface CfVersion {
  id: string;
  number: number;
  metadata: {
    author_email: string;
    author_id: string;
    source: string;
    created_on: string;
    modified_on: string;
  };
}

export interface DeployInfo {
  id: string;
  versionId: string;
  author: string;
  createdOn: string;
  source: string;
}

export interface InvestigationReport {
  incidentId: number;
  affectedEndpoints: string[];
  dependencyResults: Record<string, HealthCheckResult>;
  deployHistory: DeployInfo[];
  pastPatterns: AgentPattern[];
  rootCause: string;
  rootCauseConfidence: number;
  evidence: InvestigationStep[];
  severity: 'minor' | 'major' | 'critical';
  rollbackTargetVersionId?: string;
  githubCorrelation?: GitHubCorrelation;
}

export interface StatusAgentState {
  endpoints: MonitoredEndpoint[];
  statuses: Record<string, EndpointStatus>;
  isInvestigating: boolean;
  activeIncidentId: number | null;
  lastCheckAt: string | null;
  currentDeployment: DeployInfo | null;
}

export type WSEventType =
  | 'health_check'
  | 'status_change'
  | 'investigation_step'
  | 'investigation_complete'
  | 'remediation_step'
  | 'remediation_complete'
  | 'status_update'
  | 'insight'
  | 'error'
  | 'report_step'
  | 'report_complete'
  | 'notification_step'
  | 'notification_complete'
  | 'github_correlation'
  | 'github_issue_created'
  | 'github_revert_pr';

export interface WSEvent {
  type: WSEventType;
  data: unknown;
  timestamp: string;
}

export interface RemediationPlaybook {
  rootCause: string;
  action: string;
  description: string;
}

export interface AgentPattern {
  id?: number;
  patternType: string;
  patternKey: string;
  patternData: Record<string, unknown>;
  occurrenceCount: number;
  lastSeen: string;
}

export interface RemediationResult {
  action: string;
  success: boolean;
  message: string;
  recoveryVerified: boolean;
}

export interface StatusUpdate {
  id?: number;
  incidentId: number;
  title: string;
  body: string;
  severity: string;
  createdAt?: string;
}

// --- Incident Report Agent types ---

export interface IncidentReport {
  id?: number;
  incidentId: number;
  executiveSummary: string;
  timeline: ReportTimelineEntry[];
  impactAnalysis: string;
  rootCauseDeepDive: string;
  remediationDetails: string;
  lessonsLearned: string;
  actionItems: string[];
  createdAt?: string;
}

export interface ReportTimelineEntry {
  time: string;
  event: string;
  details?: string;
}

export interface ReportAgentState {
  generating: boolean;
}

// --- Communication Agent types ---

export interface NotificationChannel {
  id?: number;
  type: 'slack' | 'discord' | 'email';
  name: string;
  config: Record<string, string>;
  enabled: boolean;
  createdAt?: string;
}

export interface NotificationPayload {
  incidentId: number;
  title: string;
  body: string;
  severity: string;
  rootCause: string;
  affectedEndpoints: string[];
  remediationAction: string;
  resolved: boolean;
}

export interface NotificationResult {
  channel: string;
  type: string;
  success: boolean;
  error?: string;
}

export interface CommAgentState {
  sending: boolean;
}

// --- GitHub Integration types ---

export interface GitHubCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
  url: string;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  url: string;
  mergedAt: string;
  author: string;
}

export interface GitHubCorrelation {
  deploymentVersionId: string;
  commits: GitHubCommit[];
  pullRequests: GitHubPullRequest[];
}

export interface GitHubIssue {
  number: number;
  title: string;
  url: string;
}

export interface GitHubRevertPR {
  prNumber: number;
  prUrl: string;
  branchName: string;
  badCommitSha: string;
}
