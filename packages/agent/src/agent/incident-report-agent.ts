import { Agent } from 'agents';
import type { Env, IncidentReport, ReportTimelineEntry, ReportAgentState, InvestigationReport, RemediationResult } from '../types';

interface GenerateRequest {
  incidentId: number;
  investigationReport: InvestigationReport;
  remediationResult: RemediationResult;
  statusUpdateTitle: string;
  statusUpdateBody: string;
}

interface ReportStep {
  section: string;
  status: 'generating' | 'complete' | 'failed';
  content?: string;
}

export class IncidentReportAgent extends Agent<Env, ReportAgentState> {
  initialState: ReportAgentState = { generating: false };

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/generate' && request.method === 'POST') {
      const body = await request.json() as GenerateRequest;
      const result = await this.generateReport(body);
      return Response.json(result);
    }

    return new Response('Not found', { status: 404 });
  }

  private async generateReport(req: GenerateRequest): Promise<{ report: IncidentReport; steps: ReportStep[] }> {
    const steps: ReportStep[] = [];
    const { incidentId, investigationReport: report, remediationResult, statusUpdateTitle, statusUpdateBody } = req;

    // 1. Build timeline from investigation evidence
    steps.push({ section: 'timeline', status: 'generating' });
    const timeline: ReportTimelineEntry[] = report.evidence.map(e => ({
      time: e.timestamp,
      event: e.action,
      details: e.result,
    }));
    timeline.push({
      time: new Date().toISOString(),
      event: 'Remediation executed',
      details: `${remediationResult.action}: ${remediationResult.message}`,
    });
    steps[steps.length - 1] = { section: 'timeline', status: 'complete' };

    // Context for AI prompts
    const context = `
Incident #${incidentId}
Affected endpoints: ${report.affectedEndpoints.join(', ')}
Root cause: ${report.rootCause} (confidence: ${(report.rootCauseConfidence * 100).toFixed(0)}%)
Severity: ${report.severity}
Remediation: ${remediationResult.action} — ${remediationResult.success ? 'successful' : 'partial'}
Status update: ${statusUpdateTitle}
Evidence steps: ${report.evidence.length}
`.trim();

    // 2-7: Generate each section via AI with fallback
    const executiveSummary = await this.generateSection(steps, 'executive_summary',
      `Write a 2-3 sentence executive summary of this incident:\n${context}`,
      `Incident #${incidentId} affected ${report.affectedEndpoints.join(', ')}. Root cause: ${report.rootCause}. ${remediationResult.success ? 'Successfully remediated.' : 'Partially remediated.'}`
    );

    const impactAnalysis = await this.generateSection(steps, 'impact_analysis',
      `Write a brief impact analysis (2-3 sentences) for this incident. What services were affected and how?\n${context}`,
      `The following services experienced ${report.severity} impact: ${report.affectedEndpoints.join(', ')}. ${report.severity === 'critical' ? 'All monitored services were affected.' : 'A subset of services was affected.'}`
    );

    const rootCauseDeepDive = await this.generateSection(steps, 'root_cause_deep_dive',
      `Write a technical root cause analysis (3-4 sentences) explaining why this incident happened:\n${context}\nEvidence:\n${report.evidence.map(e => `- ${e.action}: ${e.result}`).join('\n')}`,
      `The root cause was identified as ${report.rootCause} with ${(report.rootCauseConfidence * 100).toFixed(0)}% confidence. ${report.rootCause === 'bad_deploy' ? 'A recent deployment introduced breaking changes.' : report.rootCause === 'pool_exhaustion' ? 'Database connection pool was exhausted.' : 'System analysis identified the failure pattern.'}`
    );

    const remediationDetails = await this.generateSection(steps, 'remediation_details',
      `Write a brief description of the remediation steps taken:\n${context}\nAction: ${remediationResult.action}\nResult: ${remediationResult.message}\nRecovery verified: ${remediationResult.recoveryVerified}`,
      `Remediation action "${remediationResult.action.replace(/_/g, ' ')}" was executed. ${remediationResult.message}`
    );

    const lessonsLearned = await this.generateSection(steps, 'lessons_learned',
      `Write 2-3 lessons learned from this incident:\n${context}`,
      `This incident highlights the importance of deployment monitoring. The automated detection and remediation system responded within the expected timeframe.`
    );

    const actionItemsText = await this.generateSection(steps, 'action_items',
      `Generate a JSON array of 3-5 action items from this incident. Format: ["action item 1", "action item 2", ...]\n${context}`,
      '["Review deployment pipeline safeguards", "Improve monitoring alerting thresholds", "Document incident response runbook"]'
    );

    let actionItems: string[];
    try {
      const match = actionItemsText.match(/\[[\s\S]*\]/);
      actionItems = match ? JSON.parse(match[0]) : ['Review and improve monitoring'];
    } catch {
      actionItems = ['Review and improve monitoring', 'Update deployment safeguards'];
    }

    const incidentReport: IncidentReport = {
      incidentId,
      executiveSummary,
      timeline,
      impactAnalysis,
      rootCauseDeepDive,
      remediationDetails,
      lessonsLearned,
      actionItems,
    };

    // Store in D1
    await this.env.DB.prepare(
      `INSERT INTO incident_reports (incident_id, executive_summary, timeline, impact_analysis, root_cause_deep_dive, remediation_details, lessons_learned, action_items) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      incidentId,
      executiveSummary,
      JSON.stringify(timeline),
      impactAnalysis,
      rootCauseDeepDive,
      remediationDetails,
      lessonsLearned,
      JSON.stringify(actionItems),
    ).run();

    return { report: incidentReport, steps };
  }

  private async generateSection(steps: ReportStep[], section: string, prompt: string, fallback: string): Promise<string> {
    steps.push({ section, status: 'generating' });
    try {
      const aiResponse = await this.env.AI.run('@cf/meta/llama-4-scout-17b-16e-instruct' as keyof AiModels, {
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
      } as never);

      const aiText = typeof aiResponse === 'object' && aiResponse !== null && 'response' in aiResponse
        ? String((aiResponse as { response: unknown }).response || '') : '';

      const content = aiText.trim() || fallback;
      steps[steps.length - 1] = { section, status: 'complete', content };
      return content;
    } catch {
      steps[steps.length - 1] = { section, status: 'failed', content: fallback };
      return fallback;
    }
  }
}
