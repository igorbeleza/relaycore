import { describe, expect, it } from 'vitest';

import { LINE_HEIGHT_PX, PAGE_WIDTH_PX } from '../../src/pxpipe/estimator.js';
import { PureImageRenderer } from '../../src/pxpipe/renderer.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('PureImageRenderer', () => {
  it('renders lines to a PNG page with the expected geometry', async () => {
    const renderer = new PureImageRenderer();
    const [rendered] = await renderer.renderPages([['const answer = 42;', 'export {};']]);
    expect(rendered.png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    expect(rendered.width).toBe(PAGE_WIDTH_PX);
    expect(rendered.height).toBe(2 * LINE_HEIGHT_PX);
  }, 30_000);

  it('produces byte-identical output for identical input', async () => {
    const renderer = new PureImageRenderer();
    const [first] = await renderer.renderPages([['deterministic output']]);
    const [second] = await renderer.renderPages([['deterministic output']]);
    expect(first.png.equals(second.png)).toBe(true);
  }, 30_000);
});
