export interface RetryPolicy {
  maxAttempts: number;
  /** Delay before the first retry; doubles each time up to maxDelayMs. */
  initialDelayMs: number;
  maxDelayMs: number;
}

/**
 * The documented cadence is a retry every 15 minutes after a 22 second acknowledgement
 * window. We back off from a shorter first retry up to that cadence so tests do not have
 * to wait, and cap the number of attempts.
 * https://www.mercadopago.com.br/developers/en/docs/your-integrations/notifications/webhooks
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 6,
  initialDelayMs: 30_000,
  maxDelayMs: 15 * 60_000,
};

export const ACK_TIMEOUT_MS = 22_000;

/** Returns when the next attempt is due, or null when the delivery is exhausted. */
export function nextAttemptAt(attempts: number, now: number, policy = DEFAULT_RETRY_POLICY): number | null {
  if (attempts >= policy.maxAttempts) return null;
  const delay = Math.min(policy.initialDelayMs * 2 ** (attempts - 1), policy.maxDelayMs);
  return now + delay;
}
