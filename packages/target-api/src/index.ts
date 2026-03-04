import { Hono } from 'hono';

const app = new Hono();

// Health check
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'status-agent-target-api',
    timestamp: new Date().toISOString(),
  });
});

// Orders API
app.get('/api/orders', (c) => {
  return c.json({ error: 'Service misconfigured', service: 'orders-service' }, 503);
}); 

// Auth service
app.get('/api/auth', (c) => {
  console.log(JSON.stringify({ endpoint: '/api/auth', event: 'request', status: 200 }));
  return c.json({
    status: 'ok',
    service: 'auth-service',
    uptime: '99.99%',
    healthy: true,
  });
});

// Payments service
app.get('/api/payments', (c) => {
  console.log(JSON.stringify({ endpoint: '/api/payments', event: 'request', status: 200 }));
  return c.json({
    status: 'ok',
    service: 'payments-service',
    provider: 'stripe',
    healthy: true,
  });
});

// Database health
app.get('/api/database', (c) => {
  console.log(JSON.stringify({ endpoint: '/api/database', event: 'request', status: 200 }));
  return c.json({
    status: 'ok',
    service: 'database-service',
    connections: { active: 12, idle: 88, max: 100 },
    healthy: true,
  });
});

export default app;
