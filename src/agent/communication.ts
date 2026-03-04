import type { Env, InvestigationReport, RemediationResult, StatusUpdate } from '../types';

type BroadcastFn = (type: string, data: unknown) => void;

export async function generateStatusUpdate(
  env: Env,
  broadcast: BroadcastFn,
  report: InvestigationReport,
  remediationResult: RemediationResult,
  incidentId: number
): Promise<StatusUpdate> {
  let title = '';
  let body = '';

  try {
    const prompt = `You are a technical writer for a status page. Write a clear, professional status update for a service incident.

INCIDENT DETAILS:
- Affected services: ${report.affectedEndpoints.join(', ')}
- Root cause: ${report.rootCause} (confidence: ${(report.rootCauseConfidence * 100).toFixed(0)}%)
- Severity: ${report.severity}
- Remediation action: ${remediationResult.action}
- Recovery status: ${remediationResult.success ? 'All services recovered' : 'Partial recovery'}

Write a JSON response with:
{"title": "short incident title (under 80 chars)", "body": "2-3 paragraph status update explaining what happened, what was done, and current status"}`;

    const aiResponse = await env.AI.run('@cf/meta/llama-4-scout-17b-16e-instruct' as keyof AiModels, {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
    } as never);

    const aiText = typeof aiResponse === 'object' && aiResponse !== null && 'response' in aiResponse
      ? (aiResponse as { response: string }).response : '';
    if (aiText) {
      const jsonMatch = aiText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        title = parsed.title || '';
        body = parsed.body || '';
      }
    }
  } catch {
    // Fallback to template
  }

  if (!title || !body) {
    const endpointNames = report.affectedEndpoints.map(e => e.replace('/api/', '')).join(', ');
    const rootCauseMap: Record<string, string> = {
      bad_deploy: 'a faulty deployment',
      pool_exhaustion: 'database connection pool exhaustion',
      traffic_spike: 'an unexpected traffic spike',
      dependency_failure: 'a dependency service failure',
      unknown: 'an unidentified issue',
    };

    title = `${report.severity === 'critical' ? 'Major' : 'Partial'} Service Disruption — ${endpointNames}`;
    body = `Our monitoring system detected an issue affecting ${endpointNames} services. ` +
      `The root cause was identified as ${rootCauseMap[report.rootCause] || report.rootCause}.\n\n` +
      `Our automated remediation system executed a ${remediationResult.action.replace(/_/g, ' ')} action. ` +
      `${remediationResult.success ? 'All affected services have been restored to normal operation.' : 'Recovery is ongoing and we are continuing to monitor the situation.'}\n\n` +
      `We apologize for any inconvenience. Our system has recorded this incident pattern to improve future response times.`;
  }

  const statusUpdate: StatusUpdate = {
    incidentId,
    title,
    body,
    severity: report.severity,
  };

  await env.DB.prepare(
    'INSERT INTO status_updates (incident_id, title, body, severity) VALUES (?, ?, ?, ?)'
  ).bind(incidentId, title, body, report.severity).run();

  broadcast('status_update', statusUpdate);

  return statusUpdate;
}
