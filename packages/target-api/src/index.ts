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
  console.log(JSON.stringify({ endpoint: '/api/orders', event: 'request', status: 200 }));
  return c.json({
    orders: [
      { id: 'ORD-001', status: 'completed', total: 49.99 },
      { id: 'ORD-002', status: 'processing', total: 129.50 },
      { id: 'ORD-003', status: 'shipped', total: 89.00 },
    ],
    total: 3,
    service: 'orders-service',
    healthy: true,
  });
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
