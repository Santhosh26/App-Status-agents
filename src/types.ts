export interface Env {
  DB: D1Database;
  AI: Ai;
  STATUS_AGENT: DurableObjectNamespace;
}

export type ChaosMode = 'healthy' | '503' | 'slow' | 'timeout' | 'pool_exhausted';

export interface ChaosConfig {
  endpoint: string;
  mode: ChaosMode;
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

export interface InvestigationReport {
  incidentId: number;
  affectedEndpoints: string[];
  dependencyResults: Record<string, HealthCheckResult>;
  deployHistory: DeployEntry[];
  pastPatterns: AgentPattern[];
  rootCause: string;
  rootCauseConfidence: number;
  evidence: InvestigationStep[];
  severity: 'minor' | 'major' | 'critical';
}

export interface DeployEntry {
  id: string;
  service: string;
  version: string;
  commit_hash: string;
  deployedAt: string;
  author: string;
  status: 'active' | 'rolled_back' | 'superseded';
  is_healthy: boolean;
  rolled_back_at?: string;
}

export interface DeploymentRecord {
  id: string;
  service: string;
  version: string;
  commit_hash: string;
  author: string;
  status: 'active' | 'rolled_back' | 'superseded';
  is_healthy: number;
  deployed_at: string;
  rolled_back_at: string | null;
}

export interface ActiveVersion {
  version: string;
  commitHash: string;
  deployedAt: string;
  author: string;
}

export interface Incident {
  id: number;
  status: 'investigating' | 'identified' | 'remediated' | 'resolved';
  severity: 'minor' | 'major' | 'critical';
  affectedEndpoints: string[];
  rootCause: string | null;
  rootCauseConfidence: number | null;
  evidence: InvestigationStep[];
  remediationAction: string | null;
  remediationResult: string | null;
  startedAt: string;
  resolvedAt: string | null;
  durationSeconds: number | null;
}

export interface StatusUpdate {
  id?: number;
  incidentId: number;
  title: string;
  body: string;
  severity: string;
  createdAt?: string;
}

export interface StatusAgentState {
  endpoints: MonitoredEndpoint[];
  statuses: Record<string, EndpointStatus>;
  isInvestigating: boolean;
  activeIncidentId: number | null;
  lastCheckAt: string | null;
  activeVersions: Record<string, ActiveVersion>;
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
