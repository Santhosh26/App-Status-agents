import { Agent } from 'agents';
import type { Env, NotificationChannel, NotificationPayload, NotificationResult, CommAgentState } from '../types';

export class CommunicationAgent extends Agent<Env, CommAgentState> {
  initialState: CommAgentState = { sending: false };

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/notify' && request.method === 'POST') {
      const body = await request.json() as { payload: NotificationPayload };
      const results = await this.sendNotifications(body.payload);
      return Response.json({ results });
    }

    if (url.pathname === '/channels' && request.method === 'GET') {
      const channels = await this.getChannels();
      return Response.json({ channels });
    }

    if (url.pathname === '/channels' && request.method === 'POST') {
      const channel = await request.json() as Omit<NotificationChannel, 'id' | 'createdAt'>;
      await this.env.DB.prepare(
        'INSERT INTO notification_channels (type, name, config, enabled) VALUES (?, ?, ?, ?)'
      ).bind(channel.type, channel.name, JSON.stringify(channel.config), channel.enabled ? 1 : 0).run();
      return Response.json({ success: true });
    }

    return new Response('Not found', { status: 404 });
  }

  private async getChannels(): Promise<NotificationChannel[]> {
    const rows = await this.env.DB.prepare('SELECT * FROM notification_channels WHERE enabled = 1').all();
    const channels: NotificationChannel[] = rows.results.map((r: Record<string, unknown>) => ({
      id: r.id as number,
      type: r.type as NotificationChannel['type'],
      name: r.name as string,
      config: r.config ? JSON.parse(r.config as string) : {},
      enabled: !!(r.enabled as number),
      createdAt: r.created_at as string,
    }));

    // Also check env var secrets as fallback channels
    if (this.env.SLACK_WEBHOOK_URL && !channels.some(c => c.type === 'slack')) {
      channels.push({ type: 'slack', name: 'Slack (env)', config: { webhookUrl: this.env.SLACK_WEBHOOK_URL }, enabled: true });
    }
    if (this.env.DISCORD_WEBHOOK_URL && !channels.some(c => c.type === 'discord')) {
      channels.push({ type: 'discord', name: 'Discord (env)', config: { webhookUrl: this.env.DISCORD_WEBHOOK_URL }, enabled: true });
    }
    if (this.env.RESEND_API_KEY && this.env.NOTIFICATION_EMAILS && !channels.some(c => c.type === 'email')) {
      channels.push({
        type: 'email',
        name: 'Email (env)',
        config: {
          apiKey: this.env.RESEND_API_KEY,
          fromEmail: this.env.RESEND_FROM_EMAIL || 'StatusAgent <onboarding@resend.dev>',
          toEmails: this.env.NOTIFICATION_EMAILS,
        },
        enabled: true,
      });
    }

    return channels;
  }

  private async sendNotifications(payload: NotificationPayload): Promise<NotificationResult[]> {
    const channels = await this.getChannels();
    const results: NotificationResult[] = [];

    for (const channel of channels) {
      let result: NotificationResult;
      try {
        switch (channel.type) {
          case 'slack':
            result = await this.sendSlack(channel, payload);
            break;
          case 'discord':
            result = await this.sendDiscord(channel, payload);
            break;
          case 'email':
            result = await this.sendEmail(channel, payload);
            break;
          default:
            result = { channel: channel.name, type: channel.type, success: false, error: 'Unknown channel type' };
        }
      } catch (e) {
        result = { channel: channel.name, type: channel.type, success: false, error: e instanceof Error ? e.message : 'Unknown error' };
      }

      results.push(result);

      // Log delivery attempt
      await this.env.DB.prepare(
        'INSERT INTO notification_log (incident_id, channel_id, channel_type, notification_type, success, error) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(
        payload.incidentId,
        channel.id || null,
        channel.type,
        payload.resolved ? 'resolved' : 'incident',
        result.success ? 1 : 0,
        result.error || null,
      ).run();
    }

    return results;
  }

  private async sendSlack(channel: NotificationChannel, payload: NotificationPayload): Promise<NotificationResult> {
    const webhookUrl = channel.config.webhookUrl;
    if (!webhookUrl) return { channel: channel.name, type: 'slack', success: false, error: 'No webhook URL configured' };

    const severityEmoji: Record<string, string> = { critical: ':red_circle:', major: ':large_orange_circle:', minor: ':large_yellow_circle:' };
    const emoji = severityEmoji[payload.severity] || ':white_circle:';

    const slackPayload = {
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: `${payload.resolved ? 'Resolved' : 'Incident'}: ${payload.title}` },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Severity:*\n${emoji} ${payload.severity.toUpperCase()}` },
            { type: 'mrkdwn', text: `*Root Cause:*\n${payload.rootCause.replace(/_/g, ' ')}` },
            { type: 'mrkdwn', text: `*Affected:*\n${payload.affectedEndpoints.join(', ')}` },
            { type: 'mrkdwn', text: `*Remediation:*\n${payload.remediationAction.replace(/_/g, ' ')}` },
          ],
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: payload.body.substring(0, 2000) },
        },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `Incident #${payload.incidentId} | StatusAgent` }],
        },
      ],
    };

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(slackPayload),
    });

    return {
      channel: channel.name,
      type: 'slack',
      success: res.ok,
      error: res.ok ? undefined : `Slack webhook returned ${res.status}`,
    };
  }

  private async sendDiscord(channel: NotificationChannel, payload: NotificationPayload): Promise<NotificationResult> {
    const webhookUrl = channel.config.webhookUrl;
    if (!webhookUrl) return { channel: channel.name, type: 'discord', success: false, error: 'No webhook URL configured' };

    const severityColor: Record<string, number> = { critical: 0xf85149, major: 0xf0883e, minor: 0xd29922 };

    const discordPayload = {
      embeds: [{
        title: `${payload.resolved ? 'Resolved' : 'Incident'}: ${payload.title}`,
        description: payload.body.substring(0, 2000),
        color: severityColor[payload.severity] || 0x8b949e,
        fields: [
          { name: 'Severity', value: payload.severity.toUpperCase(), inline: true },
          { name: 'Root Cause', value: payload.rootCause.replace(/_/g, ' '), inline: true },
          { name: 'Affected', value: payload.affectedEndpoints.join(', '), inline: false },
          { name: 'Remediation', value: payload.remediationAction.replace(/_/g, ' '), inline: true },
        ],
        footer: { text: `Incident #${payload.incidentId} | StatusAgent` },
        timestamp: new Date().toISOString(),
      }],
    };

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(discordPayload),
    });

    return {
      channel: channel.name,
      type: 'discord',
      success: res.ok || res.status === 204,
      error: res.ok || res.status === 204 ? undefined : `Discord webhook returned ${res.status}`,
    };
  }

  private async sendEmail(channel: NotificationChannel, payload: NotificationPayload): Promise<NotificationResult> {
    const { apiKey, fromEmail, toEmails } = channel.config;
    if (!apiKey || !toEmails) return { channel: channel.name, type: 'email', success: false, error: 'Missing Resend config' };

    const recipients = toEmails.split(',').map((e: string) => e.trim());

    const severityColor: Record<string, string> = { critical: '#f85149', major: '#f0883e', minor: '#d29922' };
    const color = severityColor[payload.severity] || '#8b949e';

    const htmlBody = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto;">
  <div style="background: ${color}; color: white; padding: 16px 24px; border-radius: 8px 8px 0 0;">
    <h2 style="margin: 0;">${payload.resolved ? 'Resolved' : 'Incident'}: ${payload.title}</h2>
  </div>
  <div style="border: 1px solid #e1e4e8; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
    <table style="width: 100%; margin-bottom: 16px;">
      <tr><td><strong>Severity:</strong></td><td>${payload.severity.toUpperCase()}</td></tr>
      <tr><td><strong>Root Cause:</strong></td><td>${payload.rootCause.replace(/_/g, ' ')}</td></tr>
      <tr><td><strong>Affected:</strong></td><td>${payload.affectedEndpoints.join(', ')}</td></tr>
      <tr><td><strong>Remediation:</strong></td><td>${payload.remediationAction.replace(/_/g, ' ')}</td></tr>
    </table>
    <p>${payload.body.replace(/\n/g, '<br>')}</p>
    <hr style="border: none; border-top: 1px solid #e1e4e8; margin: 16px 0;">
    <p style="color: #8b949e; font-size: 12px;">Incident #${payload.incidentId} | StatusAgent</p>
  </div>
</div>`;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail || 'StatusAgent <onboarding@resend.dev>',
        to: recipients,
        subject: `[${payload.severity.toUpperCase()}] ${payload.title}`,
        html: htmlBody,
      }),
    });

    return {
      channel: channel.name,
      type: 'email',
      success: res.ok,
      error: res.ok ? undefined : `Resend returned ${res.status}`,
    };
  }
}
