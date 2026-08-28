import tailwind from 'bun-plugin-tailwind';

export interface BuildDashboardOptions {
  outdir: string;
  minify?: boolean;
  sourcemap?: boolean;
}

export interface BuildDashboardResult {
  outdir: string;
  files: string[];
}

export const DASHBOARD_ENTRY = new URL('./index.html', import.meta.url).pathname;

export async function buildDashboard(options: BuildDashboardOptions): Promise<BuildDashboardResult> {
  const result = await Bun.build({
    entrypoints: [DASHBOARD_ENTRY],
    outdir: options.outdir,
    target: 'browser',
    minify: options.minify ?? true,
    sourcemap: options.sourcemap === true ? 'linked' : 'none',
    plugins: [tailwind],
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  });

  if (!result.success) {
    throw new AggregateError(result.logs, 'Failed to build the payground dashboard');
  }

  return { outdir: options.outdir, files: result.outputs.map((output) => output.path) };
}
