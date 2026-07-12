import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import * as PImage from 'pureimage';

import { FONT_SIZE_PX, LINE_HEIGHT_PX, PAGE_WIDTH_PX } from './estimator.js';

// pureimage@0.4.13 re-exports `./image` and `./context` without file extensions in its
// index.d.ts, which fails to resolve under this project's `moduleResolution: "NodeNext"`.
// As a result `make` and `encodePNGToStream` (both declared in image.d.ts) are missing
// from the resolved namespace type. Restore them here via declaration merging so the
// runtime API (which does export them) can be used with full type safety.
declare module 'pureimage' {
  export function make(width: number, height: number): PImage.Bitmap;
  export function encodePNGToStream(
    bitmap: PImage.Bitmap,
    outstream: NodeJS.WritableStream,
  ): Promise<void>;
}

const FONT_FAMILY = 'DejaVuSansMono';
const FONT_PATH = fileURLToPath(new URL('../../assets/fonts/DejaVuSansMono.ttf', import.meta.url));

export type RenderedPage = Readonly<{
  png: Buffer;
  width: number;
  height: number;
}>;

export interface TextRenderer {
  renderPages(pages: readonly (readonly string[])[]): Promise<RenderedPage[]>;
}

export class PureImageRenderer implements TextRenderer {
  private fontLoaded: Promise<void> | undefined;

  private ensureFont(): Promise<void> {
    if (!this.fontLoaded) {
      const font = PImage.registerFont(FONT_PATH, FONT_FAMILY);
      this.fontLoaded = font.load().then(() => undefined);
    }
    return this.fontLoaded;
  }

  public async renderPages(pages: readonly (readonly string[])[]): Promise<RenderedPage[]> {
    await this.ensureFont();
    const rendered: RenderedPage[] = [];
    for (const lines of pages) {
      const height = Math.max(LINE_HEIGHT_PX, lines.length * LINE_HEIGHT_PX);
      const bitmap = PImage.make(PAGE_WIDTH_PX, height);
      const context = bitmap.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, PAGE_WIDTH_PX, height);
      context.fillStyle = '#000000';
      context.font = `${FONT_SIZE_PX}px ${FONT_FAMILY}`;
      lines.forEach((line, index) => {
        if (line.length > 0) {
          context.fillText(line, 2, (index + 1) * LINE_HEIGHT_PX - 3);
        }
      });
      const stream = new PassThrough();
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      await PImage.encodePNGToStream(bitmap, stream);
      rendered.push({ png: Buffer.concat(chunks), width: PAGE_WIDTH_PX, height });
    }
    return rendered;
  }
}
