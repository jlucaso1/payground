import { buildDashboard } from './build.ts';

const outdir = Bun.argv[2] ?? new URL('../dist/', import.meta.url).pathname;
const result = await buildDashboard({ outdir });
console.log(`dashboard built to ${result.outdir} (${result.files.length} files)`);
