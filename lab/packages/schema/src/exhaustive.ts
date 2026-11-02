/**
 * The branch for a case no other branch handles: it only compiles when `value` can't be anything
 * (every case of a union handled before it), so a new member (a downstream cluster type) fails to
 * compile wherever it's missing instead of falling into another member's branch.
 */
export function assertNever(value: never, what: string): never {
    throw new Error(`unhandled ${what}: ${JSON.stringify(value)}`);
}
