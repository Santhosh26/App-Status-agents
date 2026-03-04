export interface Env {
  DB: D1Database;
  AI: Ai;
  STATUS_AGENT: DurableObjectNamespace;
  TARGET_API_URL: string;
  CF_ACCOUNT_ID: string;
  TARGET_WORKER_NAME: string;
  CLOUDFLARE_API_TOKEN: string;
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
  | 'error';

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
