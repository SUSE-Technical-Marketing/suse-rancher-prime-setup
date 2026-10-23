import * as pulumi from "@pulumi/pulumi";
import type { Credentials, SecretRef } from "@lab/schema";

// The CLI hands the resolved secret values over as one secret stack config object.
const secrets = new pulumi.Config("lab").requireSecretObject<Record<string, unknown>>("secrets");

const isRef = (v: unknown): v is SecretRef => typeof v === "object" && v !== null && "$secret" in v;

/** A `{ $secret }` reference or a plain value, as a secret output. */
export function secretString(v: SecretRef | string): pulumi.Output<string> {
    return isRef(v) ? secrets.apply(s => s[v.$secret] as string) : pulumi.secret(pulumi.output(v));
}

/** Credentials, either a whole `{ $secret }` or a username with a password reference. */
export function credentials(c: Credentials): { username: pulumi.Output<string>; password: pulumi.Output<string> } {
    if (isRef(c)) {
        const value = secrets.apply(s => s[c.$secret] as { username: string; password: string });
        return { username: pulumi.unsecret(value.apply(v => v.username)), password: value.apply(v => v.password) };
    }
    return { username: pulumi.output(c.username), password: secretString(c.password) };
}
