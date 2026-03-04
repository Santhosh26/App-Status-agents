export const dashboardHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>StatusAgent — Live Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace; background: #0d1117; color: #c9d1d9; min-height: 100vh; }
    .layout { display: grid; grid-template-columns: 1fr 340px; grid-template-rows: auto 1fr; height: 100vh; }
    header { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; padding: 12px 20px; background: #161b22; border-bottom: 1px solid #30363d; }
    header h1 { font-size: 16px; font-weight: 600; color: #58a6ff; }
    .header-actions { display: flex; gap: 8px; align-items: center; }
    .ws-status { font-size: 11px; padding: 4px 10px; border-radius: 12px; }
    .ws-connected { background: #0d4429; color: #3fb950; }
    .ws-disconnected { background: #4a1e1e; color: #f85149; }
    select, button { font-family: inherit; font-size: 12px; padding: 6px 12px; border-radius: 6px; border: 1px solid #30363d; background: #21262d; color: #c9d1d9; cursor: pointer; }
    button { background: #da3633; border-color: #da3633; color: #fff; font-weight: 600; }
    button:hover { background: #f85149; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-deploy { background: #d29922; border-color: #d29922; }
    .btn-deploy:hover { background: #e3b341; }
    .main { overflow-y: auto; padding: 16px 20px; }
    .sidebar { background: #161b22; border-left: 1px solid #30363d; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 16px; }
    .panel { background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 12px; }
    .panel h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #8b949e; margin-bottom: 10px; }
    .service-row { display: flex; align-items: center; justify-content: space-between; padding: 6px 0; font-size: 12px; border-bottom: 1px solid #1c2028; }
    .service-row:last-child { border-bottom: none; }
    .service-info { display: flex; flex-direction: column; gap: 2px; }
    .service-name { display: flex; align-items: center; gap: 6px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
    .dot-healthy { background: #3fb950; }
    .dot-degraded { background: #d29922; }
    .dot-down { background: #f85149; }
    .dot-unknown { background: #484f58; }
    .deploy-row { padding: 6px 0; font-size: 11px; border-bottom: 1px solid #1c2028; }
    .deploy-row:last-child { border-bottom: none; }
    .deploy-service { color: #58a6ff; font-weight: 600; }
    .deploy-version { color: #3fb950; }
    .deploy-meta { color: #484f58; font-size: 10px; }
    .timeline { display: flex; flex-direction: column; gap: 4px; }
    .event { padding: 8px 12px; border-radius: 6px; font-size: 12px; line-height: 1.5; border-left: 3px solid #30363d; background: #161b22; }
    .event-time { color: #484f58; font-size: 10px; margin-right: 8px; }
    .event-health_check { border-left-color: #3fb950; }
    .event-status_change { border-left-color: #58a6ff; }
    .event-investigation_step { border-left-color: #d29922; }
    .event-investigation_complete { border-left-color: #f0883e; }
    .event-remediation_step { border-left-color: #bc8cff; }
    .event-remediation_complete { border-left-color: #a371f7; }
    .event-status_update { border-left-color: #58a6ff; }
    .event-insight { border-left-color: #3fb950; }
    .event-error { border-left-color: #f85149; background: #1a0a0a; }
    .event-init { border-left-color: #484f58; }
    .event-report_step { border-left-color: #79c0ff; background: #0d1d30; }
    .event-report_complete { border-left-color: #58a6ff; background: #0d1d30; }
    .event-notification_step { border-left-color: #d2a8ff; background: #1a0d2e; }
    .event-notification_complete { border-left-color: #bc8cff; background: #1a0d2e; }
    .event-github_correlation { border-left-color: #8b949e; background: #161b22; }
    .event-github_issue_created { border-left-color: #3fb950; background: #0d2818; }
    .insight-item { font-size: 12px; padding: 6px 0; border-bottom: 1px solid #21262d; }
    .insight-item:last-child { border-bottom: none; }
    .empty { color: #484f58; font-size: 12px; font-style: italic; }
    .badge { font-size: 10px; padding: 2px 6px; border-radius: 4px; font-weight: 600; text-transform: uppercase; margin-left: 4px; }
    .badge-minor { background: #d29922; color: #0d1117; }
    .badge-major { background: #f0883e; color: #0d1117; }
    .badge-critical { background: #f85149; color: #fff; }
  </style>
</head>
<body>
  <div class="layout">
    <header>
      <h1>StatusAgent Dashboard</h1>
      <div class="header-actions">
        <span id="wsStatus" class="ws-status ws-disconnected">Disconnected</span>
        <button id="deployBadBtn" class="btn-deploy" onclick="deployBadVersion()">Deploy Bad Version</button>
      </div>
    </header>

    <div class="main">
      <div id="timeline" class="timeline">
        <div class="empty">Waiting for events...</div>
      </div>
    </div>

    <div class="sidebar">
      <div class="panel">
        <h3>Services</h3>
        <div id="servicePanel">
          <div class="service-row"><span class="service-name"><span class="dot dot-unknown"></span>Loading...</span></div>
        </div>
      </div>

      <div class="panel">
        <h3>Current Deployment</h3>
        <div id="deploymentsPanel">
          <div class="empty">Loading...</div>
        </div>
      </div>

      <div class="panel">
        <h3>Agent Insights</h3>
        <div id="insightsPanel">
          <div class="empty">No insights yet</div>
        </div>
      </div>

      <div class="panel">
        <h3>Connection</h3>
        <div id="connectionInfo" style="font-size:12px;color:#8b949e;">
          Connecting...
        </div>
      </div>
    </div>
  </div>

  <script>
    let ws = null;
    let events = [];
    let firstEvent = true;
    let currentDeployment = null;
    const ENDPOINT_NAMES = { '/api/orders': 'Orders API', '/api/auth': 'Auth Service', '/api/payments': 'Payments Service', '/api/database': 'Database' };

    function connect() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(proto + '//' + location.host + '/agents/status-agent/default');

      ws.onopen = () => {
        document.getElementById('wsStatus').className = 'ws-status ws-connected';
        document.getElementById('wsStatus').textContent = 'Connected';
        document.getElementById('connectionInfo').textContent = 'WebSocket connected to StatusAgent';
      };

      ws.onclose = () => {
        document.getElementById('wsStatus').className = 'ws-status ws-disconnected';
        document.getElementById('wsStatus').textContent = 'Disconnected';
        document.getElementById('connectionInfo').textContent = 'Reconnecting in 3s...';
        setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);

          if (msg.type && msg.type.startsWith('cf_agent_')) return;

          if (msg.type === 'init') {
            if (msg.data && msg.data.state) {
              updateServices(msg.data.state.statuses || {}, msg.data.state.endpoints || []);
              if (msg.data.state.currentDeployment) {
                currentDeployment = msg.data.state.currentDeployment;
                updateDeploymentsPanel(currentDeployment);
              }
            }
            addEvent({ type: 'init', data: { message: 'Connected to StatusAgent' }, timestamp: msg.timestamp });
            return;
          }

          if (msg.type === 'cf_agent_state') {
            if (msg.state) {
              updateServices(msg.state.statuses || {}, msg.state.endpoints || []);
              if (msg.state.currentDeployment) {
                currentDeployment = msg.state.currentDeployment;
                updateDeploymentsPanel(currentDeployment);
              }
            }
            return;
          }

          addEvent(msg);

          if (msg.type === 'health_check' && msg.data) {
            updateServicesFromCheck(msg.data);
          }
        } catch { /* ignore non-JSON */ }
      };
    }

    function addEvent(evt) {
      if (firstEvent) {
        document.getElementById('timeline').innerHTML = '';
        firstEvent = false;
      }
      events.unshift(evt);
      if (events.length > 200) events = events.slice(0, 200);

      const el = document.createElement('div');
      el.className = 'event event-' + (evt.type || 'unknown');
      const time = evt.timestamp ? new Date(evt.timestamp).toLocaleTimeString() : '';
      let content = '<span class="event-time">' + time + '</span>';
      content += '<strong>' + formatType(evt.type) + '</strong> ';
      content += formatData(evt);
      el.innerHTML = content;

      const timeline = document.getElementById('timeline');
      timeline.insertBefore(el, timeline.firstChild);
    }

    function formatType(type) {
      return (type || 'event').replace(/_/g, ' ').replace(/\\b\\w/g, c => c.toUpperCase());
    }

    function formatData(evt) {
      if (!evt.data) return '';
      const d = evt.data;
      switch (evt.type) {
        case 'health_check':
          if (d.results) {
            return d.results.map(r =>
              '<br>&nbsp;&nbsp;' + (ENDPOINT_NAMES[r.endpoint] || r.endpoint) + ': ' +
              (r.isHealthy ? '<span style="color:#3fb950">healthy</span>' : '<span style="color:#f85149">' + (r.statusCode || 'error') + '</span>') +
              ' (' + r.responseTimeMs + 'ms)'
            ).join('');
          }
          return '';
        case 'investigation_step':
          return '<br>&nbsp;&nbsp;Step ' + (d.step || '') + ': ' + (d.action || '') + '<br>&nbsp;&nbsp;Result: ' + (d.result || '').replace(/\\*\\*/g, '');
        case 'investigation_complete':
          return '<br>&nbsp;&nbsp;Root cause: <strong>' + (d.rootCause || 'unknown') + '</strong>' +
            ' (confidence: ' + ((d.rootCauseConfidence || 0) * 100).toFixed(0) + '%)' +
            '<span class="badge badge-' + (d.severity || 'minor') + '">' + (d.severity || 'minor') + '</span>';
        case 'remediation_step':
          return '<br>&nbsp;&nbsp;' + ((d.description || d.action || '').replace(/\\*\\*/g, ''));
        case 'remediation_complete':
          return (d.success ? '<span style="color:#3fb950">SUCCESS</span>' : '<span style="color:#f85149">FAILED</span>') +
            ' — ' + (d.message || '');
        case 'status_update':
          return '<br>&nbsp;&nbsp;<strong>' + (d.title || '') + '</strong><br>&nbsp;&nbsp;' + (d.body || '').substring(0, 200);
        case 'status_change':
          return 'Incident #' + (d.incidentId || '?') + ' — ' + (d.status || '');
        case 'insight':
          return d.message || '';
        case 'error':
          return '<span style="color:#f85149">' + (d.message || 'Unknown error') + '</span>';
        case 'report_step':
          return '<br>&nbsp;&nbsp;Section: <strong>' + (d.section || '') + '</strong> — ' +
            (d.status === 'complete' ? '<span style="color:#3fb950">complete</span>' :
             d.status === 'failed' ? '<span style="color:#f85149">failed</span>' :
             '<span style="color:#79c0ff">generating...</span>') +
            (d.message ? '<br>&nbsp;&nbsp;' + d.message : '');
        case 'report_complete':
          return '<br>&nbsp;&nbsp;<span style="color:#58a6ff">Post-mortem report generated for incident #' + (d.incidentId || '?') + '</span>';
        case 'notification_step':
          if (d.success !== undefined) {
            return '<br>&nbsp;&nbsp;' + (d.type || d.channel || '') + ': ' +
              (d.success ? '<span style="color:#3fb950">delivered</span>' : '<span style="color:#f85149">failed' + (d.error ? ' — ' + d.error : '') + '</span>');
          }
          return '<br>&nbsp;&nbsp;' + (d.message || d.channel || '');
        case 'notification_complete':
          return '<br>&nbsp;&nbsp;<span style="color:#bc8cff">' + (d.successful || 0) + '/' + (d.total || 0) + ' notifications delivered for incident #' + (d.incidentId || '?') + '</span>';
        case 'github_correlation':
          return '<br>&nbsp;&nbsp;Version: ' + ((d.versionId || '').substring(0, 8)) +
            (d.commits && d.commits.length > 0 ? '<br>&nbsp;&nbsp;Commits: ' + d.commits.map(function(c) { return c.sha.substring(0, 7) + ' — ' + c.message; }).join('<br>&nbsp;&nbsp;&nbsp;&nbsp;') : '') +
            (d.pullRequests && d.pullRequests.length > 0 ? '<br>&nbsp;&nbsp;PRs: ' + d.pullRequests.map(function(pr) { return '#' + pr.number + ' — ' + pr.title; }).join('<br>&nbsp;&nbsp;&nbsp;&nbsp;') : '');
        case 'github_issue_created':
          return '<br>&nbsp;&nbsp;<span style="color:#3fb950">GitHub Issue #' + (d.number || '?') + ' created</span>' +
            (d.url ? ' — <a href="' + d.url + '" target="_blank" style="color:#58a6ff">' + d.url + '</a>' : '');
        case 'init':
          return d.message || 'Initialized';
        default:
          return JSON.stringify(d).substring(0, 200);
      }
    }

    function updateServices(statuses, endpoints) {
      const el = document.getElementById('servicePanel');
      if (!endpoints || endpoints.length === 0) {
        el.innerHTML = '<div class="empty">No services</div>';
        return;
      }
      el.innerHTML = endpoints.map(ep => {
        const status = statuses[ep.path] || 'unknown';
        return '<div class="service-row"><div class="service-info"><span class="service-name"><span class="dot dot-' + status + '"></span>' +
          (ENDPOINT_NAMES[ep.path] || ep.name) + '</span></div><span>' + status + '</span></div>';
      }).join('');
    }

    function updateServicesFromCheck(data) {
      if (data.statuses) {
        const endpoints = Object.keys(data.statuses).map(path => ({ path, name: ENDPOINT_NAMES[path] || path }));
        updateServices(data.statuses, endpoints);
      }
    }

    function updateDeploymentsPanel(deploy) {
      const el = document.getElementById('deploymentsPanel');
      if (!deploy) {
        el.innerHTML = '<div class="empty">No deployment info</div>';
        return;
      }
      const age = Date.now() - new Date(deploy.createdOn).getTime();
      const ageStr = age < 3600000 ? Math.round(age / 60000) + 'm ago' : age < 86400000 ? Math.round(age / 3600000) + 'h ago' : Math.round(age / 86400000) + 'd ago';
      el.innerHTML = '<div class="deploy-row">' +
        '<span class="deploy-service">target-api</span> ' +
        '<span class="deploy-version">' + deploy.versionId.substring(0, 8) + '</span>' +
        '<br><span class="deploy-meta">by ' + deploy.author + ' via ' + deploy.source + ' · ' + ageStr + '</span>' +
        '</div>';
    }

    async function deployBadVersion() {
      const btn = document.getElementById('deployBadBtn');
      btn.disabled = true;
      btn.textContent = 'Deploying...';
      try {
        const res = await fetch('/api/deploy-bad', { method: 'POST' });
        const data = await res.json();
        addEvent({
          type: 'status_change',
          data: { message: data.success ? 'Bad version deployed: ' + data.message : 'Deploy failed: ' + data.message },
          timestamp: new Date().toISOString(),
        });
      } catch (e) {
        addEvent({ type: 'error', data: { message: 'Failed to deploy: ' + e.message }, timestamp: new Date().toISOString() });
      }
      setTimeout(() => { btn.disabled = false; btn.textContent = 'Deploy Bad Version'; }, 5000);
    }

    async function loadInsights() {
      try {
        const res = await fetch('/api/insights');
        const data = await res.json();
        const el = document.getElementById('insightsPanel');
        if (data.totalIncidents === 0) {
          el.innerHTML = '<div class="empty">No incidents recorded yet</div>';
          return;
        }
        let html = '<div class="insight-item">Total incidents: <strong>' + data.totalIncidents + '</strong></div>';
        if (data.topFailingEndpoints && data.topFailingEndpoints.length > 0) {
          html += '<div class="insight-item">Top failing:<br>' +
            data.topFailingEndpoints.map(e => '&nbsp;&nbsp;' + e.endpoint + ' (' + e.count + 'x)').join('<br>') + '</div>';
        }
        if (data.commonRootCauses && data.commonRootCauses.length > 0) {
          html += '<div class="insight-item">Root causes:<br>' +
            data.commonRootCauses.map(c => '&nbsp;&nbsp;' + c.cause.replace(/_/g, ' ') + ' (' + c.count + 'x)').join('<br>') + '</div>';
        }
        el.innerHTML = html;
      } catch { /* retry */ }
    }

    connect();
    loadInsights();
    setInterval(loadInsights, 30000);
  </script>
</body>
</html>`;
