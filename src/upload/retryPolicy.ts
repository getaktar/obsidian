/**
 * When a failed upload goes again. A dropped connection gets a few quick
 * tries, then waits for the device to come back online, the next start or
 * the next round, so a captive portal or a provider that was down for an
 * hour doesn't leave a placeholder behind. Keys, permissions or a missing
 * bucket won't fix themselves, so those stop until asked.
 */

export const RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 5 * 60_000];

/** How often uploads that ran out of quick tries go again. */
export const RESUME_EVERY_MS = 15 * 60_000;

export type AfterFailure = { retryIn: number } | { resumable: boolean };

export function afterFailure(attempts: number, transient: boolean): AfterFailure {
  if (!transient) return { resumable: false };
  if (attempts <= RETRY_DELAYS_MS.length) return { retryIn: RETRY_DELAYS_MS[attempts - 1] };
  return { resumable: true };
}
