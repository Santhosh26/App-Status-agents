-- Health check results
CREATE TABLE IF NOT EXISTS health_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL,
  status_code INTEGER,
  response_time_ms INTEGER,
  is_healthy BOOLEAN,
  checked_at TEXT DEFAULT (datetime('now'))
);

-- Incidents
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT DEFAULT 'investigating',
  severity TEXT DEFAULT 'minor',
  affected_endpoints TEXT,
  root_cause TEXT,
  root_cause_confidence REAL,
  evidence TEXT,
  remediation_action TEXT,
  remediation_result TEXT,
  started_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT,
  duration_seconds INTEGER
);

-- AI-generated status updates
CREATE TABLE IF NOT EXISTS status_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER REFERENCES incidents(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  severity TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Agent memory / learned patterns
CREATE TABLE IF NOT EXISTS agent_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern_type TEXT,
  pattern_key TEXT,
  pattern_data TEXT,
  occurrence_count INTEGER DEFAULT 1,
  last_seen TEXT DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_health_checks_endpoint ON health_checks(endpoint, checked_at);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
CREATE INDEX IF NOT EXISTS idx_agent_memory_type ON agent_memory(pattern_type, pattern_key);
