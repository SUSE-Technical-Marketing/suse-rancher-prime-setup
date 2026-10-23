import * as pulumi from "@pulumi/pulumi";
import type { Credentials, ObjectValue, SecretRef } from "@lab/schema";

// The CLI hands the resolved secret values over as one secret stack config object.
// Read on first use, so the module can be loaded outside a Pulumi run (tests).
let cached: pulumi.Output<Record<string, unknown>> | undefined;
const secrets = () => (cached ??= new pulumi.Config("lab").requireSecretObject<Record<string, unknown>>("secrets"));

const isRef = (v: unknown): v is SecretRef => typeof v === "object" && v !== null && "$secret" in v;

/** A `{ $secret }` reference or a plain value, as a secret output. */
export function secretString(v: SecretRef | string): pulumi.Output<string> {
    return isRef(v) ? secrets().apply(s => s[v.$secret] as string) : pulumi.secret(pulumi.output(v));
}

/** Credentials, either a whole `{ $secret }` or a username with a password reference. */
export function credentials(c: Credentials): { username: pulumi.Output<string>; password: pulumi.Output<string> } {
    if (isRef(c)) {
        const value = secrets().apply(s => s[c.$secret] as { username: string; password: string });
        return { username: pulumi.unsecret(value.apply(v => v.username)), password: value.apply(v => v.password) };
    }
    return { username: pulumi.output(c.username), password: secretString(c.password) };
}

/**
 * A profile's chart `values` with every `{ $secret }` in it replaced by the secret's value. The
 * result is a secret output when it holds any secret, so it stays out of plain-text state.
 */
export function chartValuesWithSecrets(values: Record<string, unknown> | undefined): pulumi.Input<Record<string, unknown>> | undefined {
    if (!values) return undefined;
    let found = false;
    const walk = (v: unknown): unknown => {
        if (isRef(v)) {
            found = true;
            return secrets().apply(s => s[v.$secret]);
        }
        if (Array.isArray(v)) return v.map(walk);
        if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
        return v;
    };
    const resolved = walk(values) as Record<string, unknown>;
    return found ? pulumi.secret(pulumi.output(resolved).apply(v => v as Record<string, unknown>)) : resolved;
}

/** A catalog object's template leaf (DESIGN.md §16.6): a literal, or a secret or one field of a credentials secret. */
export function objectValue(leaf: ObjectValue): pulumi.Input<string> {
    if (typeof leaf === "string") return leaf;
    return secrets().apply(s => {
        const value = s[leaf.$secret];
        return leaf.key ? (value as Record<string, string>)[leaf.key] : value as string;
    });
}
