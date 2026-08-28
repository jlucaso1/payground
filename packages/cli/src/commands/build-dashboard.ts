import { FAILURE, OK, USAGE_ERROR, flag, parseOptions, text } from '../args.ts';
import type { Env } from '../env.ts';

export const BUILD_DASHBOARD_USAGE = `Usage: payground build-dashboard [options]

  --out <dir>   Where to write the assets (default dist/dashboard)
  -h, --help    Show this help`;

export const DEFAULT_OUT = 'dist/dashboard';

export async function runBuildDashboard(argv: readonly string[], env: Env): Promise<number> {
  const parsed = parseOptions(argv, { out: { type: 'string' }, help: { type: 'boolean', short: 'h' } });
  if (!parsed.ok) {
    env.io.err(parsed.message);
    env.io.err(BUILD_DASHBOARD_USAGE);
    return USAGE_ERROR;
  }
  if (flag(parsed.values, 'help')) {
    env.io.out(BUILD_DASHBOARD_USAGE);
    return OK;
  }

  const outdir = text(parsed.values, 'out') ?? DEFAULT_OUT;

  // Imported lazily: the bundler and its Tailwind plugin are build-time only, so a published
  // install that already ships the assets never needs them.
  try {
    const { buildDashboard } = await import('../../../dashboard/src/build.ts');
    const result = await buildDashboard({ outdir });
    env.io.out(`dashboard built to ${result.outdir} (${result.files.length} files)`);
    return OK;
  } catch (error) {
    env.io.err(`dashboard build failed: ${error instanceof Error ? error.message : String(error)}`);
    env.io.err('the dashboard is built from source; run this from a checkout with dev dependencies installed');
    return FAILURE;
  }
}
