export const statusPageHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>StatusAgent — System Status</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8f9fa; color: #1a1a2e; }
    .container { max-width: 720px; margin: 0 auto; padding: 24px 16px; }
    header { text-align: center; padding: 40px 0 32px; }
    header h1 { font-size: 24px; font-weight: 600; margin-bottom: 8px; }
    .overall-banner { padding: 16px 24px; border-radius: 12px; text-align: center; font-size: 16px; font-weight: 600; margin-bottom: 32px; }
    .banner-operational { background: #d4edda; color: #155724; }
    .banner-partial { background: #fff3cd; color: #856404; }
    .banner-major { background: #f8d7da; color: #721c24; }
    .section { margin-bottom: 32px; }
    .section h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 1px; color: #6c757d; margin-bottom: 12px; }
    .service-list { background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .service-item { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid #f0f0f0; }
    .service-item:last-child { border-bottom: none; }
    .service-left { display: flex; flex-direction: column; gap: 2px; }
    .service-name { font-size: 15px; font-weight: 500; }
    .service-version { font-size: 12px; color: #adb5bd; }
    .status-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; margin-right: 8px; }
    .status-badge { display: flex; align-items: center; font-size: 14px; font-weight: 500; }
    .dot-healthy { background: #28a745; }
    .dot-degraded { background: #ffc107; }
    .dot-down { background: #dc3545; }
    .text-healthy { color: #28a745; }
    .text-degraded { color: #856404; }
    .text-down { color: #dc3545; }
    .incident-card { background: #fff; border-radius: 12px; padding: 20px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .incident-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .severity-badge { font-size: 11px; text-transform: uppercase; padding: 2px 8px; border-radius: 4px; font-weight: 700; }
    .sev-minor { background: #fff3cd; color: #856404; }
    .sev-major { background: #f8d7da; color: #721c24; }
    .sev-critical { background: #721c24; color: #fff; }
    .incident-title { font-size: 15px; font-weight: 600; }
    .incident-body { font-size: 14px; color: #495057; line-height: 1.5; margin-bottom: 8px; white-space: pre-line; }
    .incident-meta { font-size: 12px; color: #adb5bd; }
    .incident-status { font-size: 12px; text-transform: uppercase; font-weight: 600; }
    .status-resolved { color: #28a745; }
    .status-investigating { color: #dc3545; }
    .status-identified { color: #ffc107; }
    .status-remediated { color: #17a2b8; }
    .incident-action { font-size: 13px; color: #6c757d; margin-bottom: 4px; padding: 6px 10px; background: #f8f9fa; border-radius: 6px; }
    .empty-state { text-align: center; padding: 40px; color: #adb5bd; font-size: 14px; }
    footer { text-align: center; padding: 32px 0; font-size: 12px; color: #adb5bd; }
    footer a { color: #6c757d; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>StatusAgent</h1>
      <p style="color:#6c757d;font-size:14px;">AI-Powered System Status</p>
    </header>

    <div id="banner" class="overall-banner banner-operational">All Systems Operational</div>

    <div class="section">
      <h2>Services</h2>
      <div id="services" class="service-list">
        <div class="empty-state">Loading...</div>
      </div>
    </div>

    <div class="section">
      <h2>Recent Incidents</h2>
      <div id="incidents">
        <div class="empty-state">Loading...</div>
      </div>
    </div>

    <footer>
      Powered by <a href="/dashboard">StatusAgent</a> on Cloudflare Workers
    </footer>
  </div>

  <script>
    const STATUS_LABELS = { healthy: 'Operational', degraded: 'Degraded', down: 'Outage' };
    const ENDPOINT_NAMES = { '/api/orders': 'Orders API', '/api/auth': 'Auth Service', '/api/payments': 'Payments Service', '/api/database': 'Database' };
    const ENDPOINT_TO_SERVICE = { '/api/orders': 'orders-service', '/api/auth': 'auth-service', '/api/payments': 'payments-service', '/api/database': 'database-service' };
    let activeVersions = {};

    async function fetchStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        if (data.activeVersions) activeVersions = data.activeVersions;
        renderServices(data);
        updateBanner(data.statuses);
      } catch { /* retry next cycle */ }
    }

    async function fetchIncidents() {
      try {
        const res = await fetch('/api/incidents');
        const data = await res.json();
        renderIncidents(data.incidents);
      } catch { /* retry next cycle */ }
    }

    function renderServices(data) {
      const el = document.getElementById('services');
      if (!data.endpoints || data.endpoints.length === 0) {
        el.innerHTML = '<div class="empty-state">No services configured</div>';
        return;
      }
      el.innerHTML = data.endpoints.map(ep => {
        const status = data.statuses[ep.path] || 'healthy';
        const svc = ENDPOINT_TO_SERVICE[ep.path];
        const ver = (activeVersions && svc && activeVersions[svc]) ? activeVersions[svc] : null;
        const versionText = ver ? '<span class="service-version">' + ver.version + ' (' + ver.commitHash.substring(0,7) + ')</span>' : '';
        return '<div class="service-item">' +
          '<div class="service-left"><span class="service-name">' + (ENDPOINT_NAMES[ep.path] || ep.name) + '</span>' + versionText + '</div>' +
          '<span class="status-badge"><span class="status-dot dot-' + status + '"></span>' +
          '<span class="text-' + status + '">' + STATUS_LABELS[status] + '</span></span>' +
          '</div>';
      }).join('');
    }

    function updateBanner(statuses) {
      const banner = document.getElementById('banner');
      const values = Object.values(statuses || {});
      const hasDown = values.includes('down');
      const hasDegraded = values.includes('degraded');
      if (hasDown) {
        banner.className = 'overall-banner banner-major';
        banner.textContent = 'Major System Outage';
      } else if (hasDegraded) {
        banner.className = 'overall-banner banner-partial';
        banner.textContent = 'Partial System Degradation';
      } else {
        banner.className = 'overall-banner banner-operational';
        banner.textContent = 'All Systems Operational';
      }
    }

    function formatAction(action) {
      if (!action) return '';
      return action.replace(/_/g, ' ').replace(/\\b\\w/g, c => c.toUpperCase());
    }

    function renderIncidents(incidents) {
      const el = document.getElementById('incidents');
      if (!incidents || incidents.length === 0) {
        el.innerHTML = '<div class="empty-state">No recent incidents</div>';
        return;
      }
      el.innerHTML = incidents.slice(0, 10).map(inc => {
        const sev = inc.severity || 'minor';
        const status = inc.status || 'investigating';
        const time = new Date(inc.started_at).toLocaleString();
        const endpoints = Array.isArray(inc.affected_endpoints) ? inc.affected_endpoints.join(', ') : '';
        const rootCause = inc.root_cause ? inc.root_cause.replace(/_/g, ' ') : 'Investigating';

        // Build remediation description
        let actionText = '';
        if (inc.remediation_action) {
          actionText = formatAction(inc.remediation_action);
          if (inc.remediation_result) {
            actionText += ' — ' + inc.remediation_result;
          }
        }

        return '<div class="incident-card">' +
          '<div class="incident-header">' +
          '<span class="severity-badge sev-' + sev + '">' + sev + '</span>' +
          '<span class="incident-status status-' + status + '">' + status + '</span>' +
          '</div>' +
          '<div class="incident-title">' + rootCause + '</div>' +
          '<div class="incident-body">' + (endpoints ? 'Affected: ' + endpoints : '') + '</div>' +
          (actionText ? '<div class="incident-action">' + actionText + '</div>' : '') +
          '<div class="incident-meta">' + time + (inc.duration_seconds ? ' &middot; Duration: ' + inc.duration_seconds + 's' : '') + '</div>' +
          '</div>';
      }).join('');
    }

    // Initial load
    fetchStatus();
    fetchIncidents();
    // Poll
    setInterval(fetchStatus, 10000);
    setInterval(fetchIncidents, 30000);
  </script>
</body>
</html>`;
