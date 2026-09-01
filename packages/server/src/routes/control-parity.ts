import { sandboxId } from '@payground/core';
import { buildReport, readHistory } from '../parity/report.ts';
import { recorderFor } from '../parity/recorder.ts';
import type { RouteModule } from './module.ts';

/** Parity report and strict-mode diagnostics for the control API. Control routes serve no spec operation, so both lists stay empty. */
export const controlParity: RouteModule = {
  name: "control-parity",
  operations: [],
  pending: [],
  routes: ({ runtime, storage, admin }) => ({
    '/_payground/parity': {
      GET: admin((request) => {
        const sandbox = new URL(request.url).searchParams.get('sandbox');
        // A stale sandbox id must not read as a clean bill of health.
        if (sandbox !== null && storage.sandboxes.get(sandboxId(sandbox)) === null) {
          return Response.json({ message: 'sandbox not found', error: 'not_found', status: 404 }, { status: 404 });
        }
        const now = runtime.clock.now();
        return Response.json(
          buildReport({
            entries: readHistory(storage.requests, sandbox, now),
            now,
            sandbox,
            drift: recorderFor(runtime)?.snapshot() ?? [],
          }),
        );
      }),
    },
  }),
};
