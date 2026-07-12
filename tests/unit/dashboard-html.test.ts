import { describe, expect, it } from 'vitest';

import { renderDashboardHtml } from '../../src/dashboard/html.js';

describe('renderDashboardHtml', () => {
  const html = renderDashboardHtml();

  it('returns a complete, self-contained HTML document', () => {
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('</html>');
    expect(html).toContain('<style>');
    expect(html).toContain('<script>');
  });

  it('polls the stats endpoint from the inline runtime', () => {
    expect(html).toContain('/dashboard/stats.json');
  });

  it('makes no external network references beyond the JSON endpoint', () => {
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
    expect(html).not.toMatch(/<link\b/);
    expect(html).not.toMatch(/src\s*=\s*["']https?:/);
  });

  it('wires the KPI, breakdown, chart and recent-request anchors', () => {
    for (const id of [
      'kpi-saved',
      'kpi-savings',
      'kpi-requests',
      'seg-dedup',
      'seg-pxpipe',
      'chart',
      'errors',
      'recent-body',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('exposes granularity toggles for hourly and daily views', () => {
    expect(html).toContain('data-gran="hourly"');
    expect(html).toContain('data-gran="daily"');
  });

  it('includes a theme toggle backed by localStorage', () => {
    expect(html).toContain('id="theme-toggle"');
    expect(html).toContain('rc-theme');
  });

  it('is deterministic across invocations', () => {
    expect(renderDashboardHtml()).toBe(html);
  });
});
