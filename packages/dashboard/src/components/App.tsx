import { useState, type ReactNode } from 'react';
import { api } from '../api/instance.ts';
import { writeToken } from '../api/token.ts';
import { useAsync } from '../hooks/useAsync.ts';
import { useRoute } from '../hooks/useRoute.ts';
import { useSession } from '../hooks/useSession.ts';
import { formatDuration } from '../lib/format.ts';
import { routeSandboxId, routeToHash, type Route } from '../lib/router.ts';
import { AdminScreen } from './AdminScreen.tsx';
import { FaultsScreen } from './FaultsScreen.tsx';
import { HistoryScreen } from './HistoryScreen.tsx';
import { MetricsScreen } from './MetricsScreen.tsx';
import { PaymentDetailScreen } from './PaymentDetailScreen.tsx';
import { PaymentsScreen } from './PaymentsScreen.tsx';
import { SandboxesScreen } from './SandboxesScreen.tsx';
import { ResourcesScreen } from './ResourcesScreen.tsx';
import { WebhooksScreen } from './WebhooksScreen.tsx';
import { Button, inputClass } from './ui.tsx';

/** Keeps the current section while pointing it at another sandbox. */
export function switchSandbox(route: Route, sandboxId: string): Route {
  switch (route.name) {
    case 'payments':
    case 'payment':
      return { name: 'payments', sandboxId };
    case 'webhooks':
      return { name: 'webhooks', sandboxId };
    case 'faults':
      return { name: 'faults', sandboxId };
    case 'resources':
      return { name: 'resources', sandboxId };
    default:
      return { name: 'payments', sandboxId };
  }
}

function Health(): ReactNode {
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

function SandboxPicker({
  route,
  navigate,
  nonce,
}: {
  route: Route;
  navigate: (next: Route) => void;
  nonce: number;
}): ReactNode {
  const { state } = useAsync(() => api.listSandboxes(), [nonce]);
  const current = routeSandboxId(route) ?? '';

  if (state.status !== 'ready' || state.value.length === 0) {
    return current === '' ? null : <span className="font-mono text-xs text-neutral-500">{current}</span>;
  }

  const known = state.value.some((sandbox) => sandbox.id === current);

  return (
    <select
      aria-label="Sandbox"
      className={inputClass}
      value={current}
      onChange={(event) => {
        const id = event.target.value;
        if (id !== '') navigate(switchSandbox(route, id));
      }}
    >
      {known ? null : <option value={current}>{current === '' ? 'Select sandbox' : current}</option>}
      {state.value.map((sandbox) => (
        <option key={sandbox.id} value={sandbox.id}>
          {sandbox.name}
        </option>
      ))}
    </select>
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

function TokenPrompt({ rejected }: { rejected: boolean }): ReactNode {
  const [value, setValue] = useState('');
  return (
    <form
      className="mx-auto max-w-md rounded border border-neutral-200 p-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim() !== '') writeToken(value.trim());
      }}
    >
      <h2 className="mb-2 text-base font-semibold text-neutral-900">Admin token required</h2>
      <p className="mb-4 text-sm text-neutral-600">
        {rejected ? 'That token was rejected. ' : ''}
        The control API is protected. Paste the token printed by <code>payground start</code>, or the
        one set with <code>--admin-token</code> / <code>PAYGROUND_ADMIN_TOKEN</code>.
      </p>
      <div className="flex items-center gap-2">
        <input
          type="password"
          autoFocus
          className={`${inputClass} flex-1`}
          placeholder="Admin token"
          aria-label="Admin token"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <button
          type="submit"
          disabled={value.trim() === ''}
          className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-40"
        >
          Continue
        </button>
      </div>
    </form>
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
    case 'resources':
      return <ResourcesScreen sandboxId={route.sandboxId} />;
    case 'metrics':
      return <MetricsScreen />;
    case 'history':
      return <HistoryScreen />;
    case 'admin':
      return <AdminScreen />;
    case 'notFound':
      return <p className="text-sm text-neutral-600">Unknown route: {route.hash}</p>;
  }
}

export function App(): ReactNode {
  const { route, navigate } = useRoute();
  const session = useSession();
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
            <NavLink route={{ name: 'metrics' }} current={route} label="Metrics" />
            <NavLink route={{ name: 'history' }} current={route} label="History" />
            <NavLink route={{ name: 'admin' }} current={route} label="Admin" />
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
                <NavLink route={{ name: 'resources', sandboxId }} current={route} label="Resources" />
              </>
            )}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            {session.unauthorized ? null : (
              <SandboxPicker route={route} navigate={navigate} nonce={session.nonce} />
            )}
            {session.token === null ? null : (
              <Button onClick={() => writeToken(null)}>Sign out</Button>
            )}
            <Health />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-6">
        {session.unauthorized ? (
          <TokenPrompt rejected={session.token !== null} />
        ) : (
          <Screen key={session.nonce} route={route} navigate={navigate} />
        )}
      </main>
    </div>
  );
}
