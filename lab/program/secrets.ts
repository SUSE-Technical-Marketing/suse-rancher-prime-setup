import * as pulumi from "@pulumi/pulumi";
import { credentialsOf, isTemplate, objectTemplateContext, renderSecretTemplate, renderTemplate, usesSecrets, type Credentials, type ObjectValue } from "@lab/schema";

// The CLI hands the resolved secret values over as one secret stack config object; secret fields
// are templates over them ("{{ secrets['ssh-key'] }}"), rendered here.
// Read on first use, so the module can be loaded outside a Pulumi run (tests).
let cached: pulumi.Output<Record<string, unknown>> | undefined;
export const secrets = () => (cached ??= new pulumi.Config("lab").requireSecretObject<Record<string, unknown>>("secrets"));

/** A secret field (a template over `secrets`, or a plain value), as a secret output. */
export function secretString(v: string): pulumi.Output<string> {
    return isTemplate(v) ? secrets().apply(s => String(renderSecretTemplate(v, s))) : pulumi.secret(pulumi.output(v));
}

/** Credentials (one secret, or a username with a password), the password a secret output. */
export function credentials(c: Credentials): { username: pulumi.Output<string>; password: pulumi.Output<string> } {
    const value = secrets().apply(s => credentialsOf(c, t => renderSecretTemplate(t, s)));
    return { username: pulumi.unsecret(value.apply(v => v.username)), password: value.apply(v => v.password) };
}

/**
 * A profile's chart `values` with every string that uses secrets rendered. The result is a secret
 * output when it holds any secret, so it stays out of plain-text state.
 */
export function chartValuesWithSecrets(values: Record<string, unknown> | undefined): pulumi.Input<Record<string, unknown>> | undefined {
    if (!values) return undefined;
    let found = false;
    const walk = (v: unknown): unknown => {
        if (typeof v === "string" && usesSecrets(v)) {
            found = true;
            return secrets().apply(s => renderSecretTemplate(v, s));
        }
        if (Array.isArray(v)) return v.map(walk);
        if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
        return v;
    };
    const resolved = walk(values) as Record<string, unknown>;
    return found ? pulumi.secret(pulumi.output(resolved).apply(v => v as Record<string, unknown>)) : resolved;
}

/** A catalog object's template leaf (DESIGN.md §16.6): a literal, or a template rendered with the secrets it uses. */
export function objectValue(leaf: ObjectValue): pulumi.Input<string> {
    if (typeof leaf === "string") return leaf;
    return secrets().apply(s => String(renderTemplate(leaf.$template, objectTemplateContext(leaf, t => renderSecretTemplate(t, s))) ?? ""));
}
