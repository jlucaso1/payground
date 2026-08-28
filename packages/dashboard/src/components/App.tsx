import type { ReactNode } from 'react';
import { api } from '../api/instance.ts';
import { useAsync } from '../hooks/useAsync.ts';
import { useRoute } from '../hooks/useRoute.ts';
import { formatDuration } from '../lib/format.ts';
import { routeSandboxId, routeToHash, type Route } from '../lib/router.ts';
import { FaultsScreen } from './FaultsScreen.tsx';
import { PaymentDetailScreen } from './PaymentDetailScreen.tsx';
import { PaymentsScreen } from './PaymentsScreen.tsx';
import { SandboxesScreen } from './SandboxesScreen.tsx';
import { WebhooksScreen } from './WebhooksScreen.tsx';

function Header(): ReactNode {
  const { state } = useAsync(() => api.getHealth(), []);
  return (
    <div className="text-xs text-neutral-500">
      {state.status === 'ready'
        ? `v${state.value.version} · up ${formatDuration(state.value.uptime_ms)}`
        : state.status === 'error'
          ? 'server unreachable'
          : '…'}
    </div>
  );
}

function NavLink({ route, current, label }: { route: Route; current: Route; label: string }): ReactNode {
  const active = current.name === route.name;
  return (
    <a
      href={routeToHash(route)}
      className={`rounded px-3 py-1.5 text-sm ${
        active ? 'bg-neutral-900 text-white' : 'text-neutral-700 hover:bg-neutral-200'
      }`}
    >
      {label}
    </a>
  );
}

function Screen({ route, navigate }: { route: Route; navigate: (next: Route) => void }): ReactNode {
  switch (route.name) {
    case 'sandboxes':
      return <SandboxesScreen navigate={navigate} />;
    case 'payments':
      return <PaymentsScreen sandboxId={route.sandboxId} navigate={navigate} />;
    case 'payment':
      return <PaymentDetailScreen sandboxId={route.sandboxId} paymentId={route.paymentId} />;
    case 'webhooks':
      return <WebhooksScreen sandboxId={route.sandboxId} />;
    case 'faults':
      return <FaultsScreen sandboxId={route.sandboxId} />;
    case 'notFound':
      return <p className="text-sm text-neutral-600">Unknown route: {route.hash}</p>;
  }
}

export function App(): ReactNode {
  const { route, navigate } = useRoute();
  const sandboxId = routeSandboxId(route);

  return (
    <div className="min-h-screen bg-white text-neutral-900">
      <header className="border-b border-neutral-200">
        <div className="mx-auto flex max-w-5xl items-center gap-4 px-6 py-3">
          <a href="#/sandboxes" className="text-sm font-semibold">
            payground
          </a>
          <nav className="flex items-center gap-1">
            <NavLink route={{ name: 'sandboxes' }} current={route} label="Sandboxes" />
            {sandboxId === null ? null : (
              <>
                <NavLink
                  route={{ name: 'payments', sandboxId }}
                  current={route}
                  label="Payments"
                />
                <NavLink
                  route={{ name: 'webhooks', sandboxId }}
                  current={route}
                  label="Webhooks"
                />
                <NavLink route={{ name: 'faults', sandboxId }} current={route} label="Faults" />
              </>
            )}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            {sandboxId === null ? null : (
              <span className="font-mono text-xs text-neutral-500">{sandboxId}</span>
            )}
            <Header />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-6">
        <Screen route={route} navigate={navigate} />
      </main>
    </div>
  );
}
