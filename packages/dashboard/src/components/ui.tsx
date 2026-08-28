import { useState, type ReactNode } from 'react';
import type { ApiError } from '../api/client.ts';

export function Button(props: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string | undefined;
  variant?: 'default' | 'primary' | 'danger';
}): ReactNode {
  const variant = props.variant ?? 'default';
  const tone =
    variant === 'primary'
      ? 'bg-neutral-900 text-white hover:bg-neutral-700'
      : variant === 'danger'
        ? 'bg-white text-red-700 border border-red-300 hover:bg-red-50'
        : 'bg-white text-neutral-800 border border-neutral-300 hover:bg-neutral-100';
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled === true}
      title={props.title}
      className={`rounded px-3 py-1.5 text-sm ${tone} disabled:cursor-not-allowed disabled:opacity-40`}
    >
      {props.children}
    </button>
  );
}

export function ErrorBox({ error }: { error: ApiError }): ReactNode {
  return (
    <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
      <span className="font-medium">{error.kind}</span>
      {error.status === null ? null : <span> {error.status}</span>}
      <span>: {error.message}</span>
    </div>
  );
}

export function Loading(): ReactNode {
  return <p className="text-sm text-neutral-500">Loading…</p>;
}

export function Empty({ children }: { children: ReactNode }): ReactNode {
  return <p className="text-sm text-neutral-500">{children}</p>;
}

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }): ReactNode {
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-semibold text-neutral-900">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-neutral-600">{label}</span>
      {children}
    </label>
  );
}

export const inputClass =
  'rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none';

export function CopyButton({ value, label }: { value: string; label?: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-xs text-neutral-700 hover:bg-neutral-100"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      }}
    >
      {copied ? 'Copied' : (label ?? 'Copy')}
    </button>
  );
}

export function Mono({ children }: { children: ReactNode }): ReactNode {
  return <span className="font-mono text-xs text-neutral-800">{children}</span>;
}

export function Badge({ children }: { children: ReactNode }): ReactNode {
  return (
    <span className="rounded border border-neutral-300 bg-neutral-50 px-1.5 py-0.5 text-xs text-neutral-700">
      {children}
    </span>
  );
}

export function Pre({ children }: { children: string }): ReactNode {
  return (
    <pre className="max-h-64 overflow-auto rounded border border-neutral-200 bg-neutral-50 p-2 font-mono text-xs whitespace-pre-wrap text-neutral-800">
      {children}
    </pre>
  );
}

export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text) as unknown, null, 2);
  } catch {
    return text;
  }
}
