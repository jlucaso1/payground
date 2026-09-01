/**
 * Points the official Mercado Pago SDKs at a payground instance.
 *
 * Usage: `bun --preload payground/preload test`, with PAYGROUND_URL set.
 *
 * The Node SDK hard-codes its base URL and does not export AppConfig, so there is no
 * supported override, see docs. `readonly` there is compile-time only, so the property
 * is writable at runtime. We assert the shape and fail loudly if the SDK layout changes.
 */
const target = process.env['PAYGROUND_URL'];

if (target !== undefined && target !== '') {
  // Resolve from the consuming project, not from wherever this file happens to live.
  const specifier = ((): string | undefined => {
    try {
      return Bun.resolveSync('mercadopago/dist/utils/config', process.cwd());
    } catch {
      return undefined;
    }
  })();

  if (specifier === undefined) {
    throw new Error('payground/preload: the `mercadopago` package is not installed');
  }

  const mod: unknown = await import(specifier);

  const config = (mod as { AppConfig?: { BASE_URL?: unknown } }).AppConfig;
  if (config === undefined || typeof config.BASE_URL !== 'string') {
    throw new Error(
      'payground/preload: mercadopago SDK layout changed, AppConfig.BASE_URL not found. ' +
        'Pin the SDK version or update the preload.',
    );
  }

  config.BASE_URL = target.replace(/\/$/, '');
}
