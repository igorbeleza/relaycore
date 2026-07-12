import type { FastifyInstance } from 'fastify';

import type { AppConfig } from '../config/env.js';
import { renderDashboardHtml } from '../dashboard/html.js';
import type { DashboardService } from '../dashboard/service.js';

/**
 * Registers the savings dashboard: a static HTML shell at `/dashboard` and its
 * live JSON feed at `/dashboard/stats.json`. Both are no-ops when the dashboard
 * is disabled via config. The HTML is rendered once at startup and served from
 * memory; the JSON reflects the aggregator's current snapshot on every poll.
 */
export function registerDashboardRoute(
  app: FastifyInstance,
  config: AppConfig,
  dashboard: DashboardService,
): void {
  if (!config.dashboardEnabled) return;

  const html = renderDashboardHtml();

  app.get('/dashboard', async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(html);
  });

  app.get('/dashboard/stats.json', async (_request, reply) => {
    return reply
      .header('cache-control', 'no-store')
      .type('application/json; charset=utf-8')
      .send(dashboard.snapshot());
  });
}
