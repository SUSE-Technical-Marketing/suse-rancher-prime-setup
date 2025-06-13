/**
 * Poll the supplied `probe` until it returns a *truthy* value (or throws),
 * or until `timeoutMs` expires.
 *
 * @param probe     async function that resolves <T | undefined>
 * @param intervalMs  how long to wait between attempts   (default 5 s)
 * @param timeoutMs overall timeout in milliseconds     (default 5 min)
 * @returns the first non-undefined result
 * @throws  if timeout is reached or `probe` throws
 */
export async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  {
    intervalMs  = 5_000,
    timeoutMs = 300_000,
  }: {
    intervalMs?:  number;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const v = await probe();
    if (v !== undefined && v !== null) return v;

    if (Date.now() >= deadline) {
      throw new Error("waitFor: timed out");
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}
