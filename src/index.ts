/**
 * Relay LLM — Entry point
 * Thin, transparent LLM proxy with zero format translation.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serve } from '@hono/node-server';
import { proxyHandler } from './proxy/handler.js';
import { authMiddleware } from './auth/jwt.js';
import { adminAuthMiddleware } from './admin/middleware.js';
import { adminApp } from './admin/handler.js';
import { budgetMiddleware } from './billing/budget.js';
import { pruneAllUsers } from './billing/run-admission.js';
import { loadEnv } from './config/env.js';

const env = loadEnv();
const app = new Hono();

// Global middleware
app.use('*', cors());
app.use('*', logger());

// Health check (no auth)
app.get('/health', (c) => c.json({ status: 'ok', version: '0.3.0' }));

// Admin API — protected by admin secret
// Reason: Middleware must be registered before routes in Hono,
// so we wrap adminApp in a parent Hono that applies auth first.
const adminRoutes = new Hono();
adminRoutes.use('*', adminAuthMiddleware);
adminRoutes.route('/', adminApp);
app.route('/admin', adminRoutes);

// LLM proxy routes — JWT auth + budget check + passthrough
app.all('/v1/openai/*', authMiddleware, budgetMiddleware, proxyHandler('openai'));
app.all('/v1/anthropic/*', authMiddleware, budgetMiddleware, proxyHandler('anthropic'));
app.all('/v1/google/*', authMiddleware, budgetMiddleware, proxyHandler('google'));

// 404 for everything else
app.notFound((c) => c.json({ error: 'Not found' }, 404));

// Start server
const port = env.PORT;
console.log(`[Relay] Starting on port ${port}`);

serve({ fetch: app.fetch, port }, () => {
  console.log(`[Relay] Listening on http://localhost:${port}`);
});

// Reason: reclaim admission buckets of users who were admitted once and never returned.
// The request paths only prune a user on that user's next call, so on a long-lived
// instance the bucket count would otherwise grow with every distinct user ever admitted.
// .unref() so this timer never keeps the process alive on its own.
const ADMISSION_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
setInterval(() => pruneAllUsers(), ADMISSION_SWEEP_INTERVAL_MS).unref();
