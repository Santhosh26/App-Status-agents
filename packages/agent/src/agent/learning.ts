import type { InvestigationReport, AgentPattern, Env } from '../types';

type BroadcastFn = (type: string, data: unknown) => void;

export async function recordIncidentPattern(
  env: Env,
  broadcast: BroadcastFn,
  report: InvestigationReport,
  incidentId: number
): Promise<void> {
  for (const ep of report.affectedEndpoints) {
    await upsertPattern(env, 'endpoint_failure', ep, {
      lastRootCause: report.rootCause,
      lastSeverity: report.severity,
      lastIncidentId: incidentId,
    });
  }

  await upsertPattern(env, 'root_cause', report.rootCause, {
    affectedEndpoints: report.affectedEndpoints,
    confidence: report.rootCauseConfidence,
    lastIncidentId: incidentId,
  });

  const hour = new Date().getUTCHours().toString();
  await upsertPattern(env, 'time_pattern', `hour_${hour}`, {
    rootCause: report.rootCause,
    affectedEndpoints: report.affectedEndpoints,
    lastIncidentId: incidentId,
  });

  broadcast('insight', {
    message: `Recorded ${report.affectedEndpoints.length} endpoint pattern(s), root cause pattern, and time correlation`,
  });

  console.log(JSON.stringify({ phase: 'learning', event: 'patterns_recorded', endpoints: report.affectedEndpoints.length, rootCause: report.rootCause }));
}

async function upsertPattern(
  env: Env,
  patternType: string,
  patternKey: string,
  patternData: Record<string, unknown>
): Promise<void> {
  const existing = await env.DB.prepare(
    'SELECT id, occurrence_count FROM agent_memory WHERE pattern_type = ? AND pattern_key = ?'
  ).bind(patternType, patternKey).first<{ id: number; occurrence_count: number }>();

  if (existing) {
    await env.DB.prepare(
      'UPDATE agent_memory SET pattern_data = ?, occurrence_count = ?, last_seen = datetime(\'now\') WHERE id = ?'
    ).bind(JSON.stringify(patternData), existing.occurrence_count + 1, existing.id).run();
  } else {
    await env.DB.prepare(
      'INSERT INTO agent_memory (pattern_type, pattern_key, pattern_data, occurrence_count) VALUES (?, ?, ?, 1)'
    ).bind(patternType, patternKey, JSON.stringify(patternData)).run();
  }
}

export async function getSimilarPatterns(
  env: Env,
  endpoints: string[]
): Promise<AgentPattern[]> {
  if (endpoints.length === 0) return [];

  const placeholders = endpoints.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `SELECT * FROM agent_memory WHERE pattern_type = 'endpoint_failure' AND pattern_key IN (${placeholders}) ORDER BY occurrence_count DESC LIMIT 10`
  ).bind(...endpoints).all<{
    id: number;
    pattern_type: string;
    pattern_key: string;
    pattern_data: string;
    occurrence_count: number;
    last_seen: string;
  }>();

  return rows.results.map(r => ({
    id: r.id,
    patternType: r.pattern_type,
    patternKey: r.pattern_key,
    patternData: JSON.parse(r.pattern_data),
    occurrenceCount: r.occurrence_count,
    lastSeen: r.last_seen,
  }));
}

export async function getInsights(env: Env): Promise<{
  totalIncidents: number;
  patterns: AgentPattern[];
  topFailingEndpoints: { endpoint: string; count: number }[];
  commonRootCauses: { cause: string; count: number }[];
}> {
  const [incidentCount, patterns, endpointFailures, rootCauses] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) as count FROM incidents').first<{ count: number }>(),
    env.DB.prepare('SELECT * FROM agent_memory ORDER BY occurrence_count DESC LIMIT 20').all<{
      id: number;
      pattern_type: string;
      pattern_key: string;
      pattern_data: string;
      occurrence_count: number;
      last_seen: string;
    }>(),
    env.DB.prepare(
      "SELECT pattern_key as endpoint, occurrence_count as count FROM agent_memory WHERE pattern_type = 'endpoint_failure' ORDER BY occurrence_count DESC LIMIT 5"
    ).all<{ endpoint: string; count: number }>(),
    env.DB.prepare(
      "SELECT pattern_key as cause, occurrence_count as count FROM agent_memory WHERE pattern_type = 'root_cause' ORDER BY occurrence_count DESC LIMIT 5"
    ).all<{ cause: string; count: number }>(),
  ]);

  return {
    totalIncidents: incidentCount?.count || 0,
    patterns: patterns.results.map(r => ({
      id: r.id,
      patternType: r.pattern_type,
      patternKey: r.pattern_key,
      patternData: JSON.parse(r.pattern_data),
      occurrenceCount: r.occurrence_count,
      lastSeen: r.last_seen,
    })),
    topFailingEndpoints: endpointFailures.results,
    commonRootCauses: rootCauses.results,
  };
}
