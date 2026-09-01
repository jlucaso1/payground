import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDashboard } from '../src/build.ts';

const outdir = await mkdtemp(join(tmpdir(), 'payground-dashboard-'));

afterAll(async () => {
  await rm(outdir, { recursive: true, force: true });
});

test(
  'buildDashboard emits html, js and tailwind css',
  async () => {
    const result = await buildDashboard({ outdir, minify: false });

    // Chunks live under assets/ with root-absolute URLs, because the dashboard is served
    // from /_payground and a relative ./chunk.js would resolve to /chunk.js.
    const files = await readdir(outdir, { recursive: true });
    const html = files.filter((name) => name.endsWith('.html'));
    const css = files.filter((name) => name.endsWith('.css'));
    const js = files.filter((name) => name.endsWith('.js'));

    expect(html).toEqual(['index.html']);
    expect(css).toHaveLength(1);
    expect(js.length).toBeGreaterThan(0);
    for (const chunk of [...css, ...js]) expect(chunk.startsWith('assets/')).toBe(true);
    expect(result.files.length).toBe(css.length + js.length + html.length);

    const cssName = css[0];
    if (cssName === undefined) throw new Error('missing output');

    const htmlText = await Bun.file(join(outdir, 'index.html')).text();
    expect(htmlText).toContain('<div id="root">');
    expect(htmlText).toContain('/_payground/assets/');
    expect(htmlText).not.toContain('"./chunk');

    const cssText = await Bun.file(join(outdir, cssName)).text();
    expect(cssText).toContain('@layer theme');
    expect(cssText).toContain('--tw-border-style');
    expect(cssText).toContain('.max-w-5xl');
    expect(cssText).toContain('.min-h-screen');
  },
  { timeout: 60_000 },
);
