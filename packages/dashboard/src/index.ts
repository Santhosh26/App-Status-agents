import { Hono } from 'hono';
import { statusPageHtml } from './status-page';
import { dashboardHtml } from './dashboard';

interface Env {
  AGENT: Fetcher;
}

const app = new Hono<{ Bindings: Env }>();

// Status page
app.get('/', (c) => {
  return c.html(statusPageHtml);
});

// Dashboard
app.get('/dashboard', (c) => {
  return c.html(dashboardHtml);
});

// Proxy API calls to agent via service binding
app.all('/api/*', (c) => {
  return c.env.AGENT.fetch(c.req.raw);
});

// Proxy WebSocket upgrades to agent via service binding
app.all('/agents/*', (c) => {
  return c.env.AGENT.fetch(c.req.raw);
});

export default app;
