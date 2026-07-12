export type RenderedPage = Readonly<{
  png: Buffer;
  width: number;
  height: number;
}>;

export interface TextRenderer {
  renderPages(pages: readonly (readonly string[])[]): Promise<RenderedPage[]>;
}
