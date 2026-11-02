// Waiting for something another system does (an add-on deploying, Rancher making a token, an API
// answering): one helper for every dynamic provider. Self-contained, like kubeRequest, since
// dynamic providers are serialized into the state.

export interface PollOptions {
    timeoutSeconds: number;
    /** Between tries; default 5 seconds. */
    everyMs?: number;
    /** The error once time is up, from the last thing `check` saw. */
    failure(last: string): string;
}

/**
 * Run `check` until it returns a value (anything but undefined), every `everyMs`, for up to
 * `timeoutSeconds`; then fail with `failure(last)`. `check` says what it saw with `seen`, for that
 * error. An error it throws ends the wait at once: catch it inside `check` to retry instead.
 */
export async function poll<T>(check: (seen: (what: string) => void) => Promise<T | undefined>, opts: PollOptions): Promise<T> {
    const deadline = Date.now() + opts.timeoutSeconds * 1000;
    let last = "nothing yet";
    const seen = (what: string) => { last = what; };
    for (;;) {
        const value = await check(seen);
        if (value !== undefined) return value;
        if (Date.now() >= deadline) throw new Error(opts.failure(last));
        await new Promise(r => setTimeout(r, opts.everyMs ?? 5000));
    }
}
