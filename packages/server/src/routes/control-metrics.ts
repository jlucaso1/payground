import { sandboxId } from '@payground/core';
import {
  CONTENT_TYPE,
  HELP,
  asReader,
  exposition,
  snapshot,
  summarise,
  webhookStats,
} from '../metrics/index.ts';
import type { RouteModule } from './module.ts';

/** Metrics exposition for the control API. Control routes serve no spec operation, so both lists stay empty. */
export const controlMetrics: RouteModule = {
  name: 'control-metrics',
  operations: [],
  pending: [],
  routes: ({ runtime, storage, admin, param }) => ({
    '/_payground/metrics': {
      GET: admin((request) => {
        const reader = asReader(runtime.metrics);
        if (reader === null) return Response.json({ error: 'metrics are not being collected' }, { status: 503 });
        if (new URL(request.url).searchParams.get('format') === 'json') {
          return Response.json(summarise(reader, { at: runtime.clock.now() }));
        }
        return new Response(exposition(snapshot(reader, storage), HELP), {
          headers: { 'content-type': CONTENT_TYPE },
        });
      }),
    },
    '/_payground/sandboxes/:id/metrics': {
      GET: admin((request) => {
        const reader = asReader(runtime.metrics);
        if (reader === null) return Response.json({ error: 'metrics are not being collected' }, { status: 503 });
        const id = sandboxId(param(request, 'id'));
        if (storage.sandboxes.get(id) === null) return Response.json({ error: 'sandbox not found' }, { status: 404 });
        return Response.json({
          sandbox: id,
          ...summarise(reader, { at: runtime.clock.now(), sandbox: id }),
          webhooks: webhookStats(storage, id),
        });
      }),
    },
  }),
};
