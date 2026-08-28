export type Route =
  | { name: 'sandboxes' }
  | { name: 'payments'; sandboxId: string }
  | { name: 'payment'; sandboxId: string; paymentId: string }
  | { name: 'webhooks'; sandboxId: string }
  | { name: 'faults'; sandboxId: string }
  | { name: 'notFound'; hash: string };

export function parseRoute(hash: string): Route {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const path = raw.split('?')[0] ?? '';
  const segments = path.split('/').filter((s) => s !== '');

  if (segments.length === 0) return { name: 'sandboxes' };

  const [head, ...rest] = segments;
  if (head === 'sandboxes' && rest.length === 0) return { name: 'sandboxes' };

  if (head === 's' && rest.length >= 2) {
    const sandboxId = decodeURIComponent(rest[0] ?? '');
    const section = rest[1];
    if (sandboxId !== '') {
      if (section === 'payments' && rest.length === 2) return { name: 'payments', sandboxId };
      if (section === 'payments' && rest.length === 3) {
        return { name: 'payment', sandboxId, paymentId: decodeURIComponent(rest[2] ?? '') };
      }
      if (section === 'webhooks' && rest.length === 2) return { name: 'webhooks', sandboxId };
      if (section === 'faults' && rest.length === 2) return { name: 'faults', sandboxId };
    }
  }

  return { name: 'notFound', hash: raw };
}

export function routeToHash(route: Route): string {
  const enc = encodeURIComponent;
  switch (route.name) {
    case 'sandboxes':
      return '#/sandboxes';
    case 'payments':
      return `#/s/${enc(route.sandboxId)}/payments`;
    case 'payment':
      return `#/s/${enc(route.sandboxId)}/payments/${enc(route.paymentId)}`;
    case 'webhooks':
      return `#/s/${enc(route.sandboxId)}/webhooks`;
    case 'faults':
      return `#/s/${enc(route.sandboxId)}/faults`;
    case 'notFound':
      return `#${route.hash}`;
  }
}

export function routeSandboxId(route: Route): string | null {
  switch (route.name) {
    case 'payments':
    case 'payment':
    case 'webhooks':
    case 'faults':
      return route.sandboxId;
    default:
      return null;
  }
}
