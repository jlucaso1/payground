import { existsSync } from 'node:fs';
import { join } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Serves the prebuilt dashboard. Assets are built at publish time, never at runtime. */
export function dashboardHandler(root: string) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const relative = url.pathname.replace(/^\/_payground\/?/, '') || 'index.html';
    if (relative.includes('..')) return new Response('not found', { status: 404 });

    const target = join(root, relative);
    const file = Bun.file(existsSync(target) ? target : join(root, 'index.html'));
    if (!(await file.exists())) {
      return new Response('dashboard assets not built — run `payground build-dashboard`', { status: 503 });
    }

    const extension = relative.slice(relative.lastIndexOf('.'));
    return new Response(file, {
      headers: { 'content-type': MIME[extension] ?? 'application/octet-stream' },
    });
  };
}
