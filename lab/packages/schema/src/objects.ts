import { z } from "zod";
import { Diagnostics } from "./diagnostics";
import { Credentials, dnsLabel, secretOrString } from "./primitives";
import { usesSecrets } from "./secrets";
import { isTemplate, renderTemplate } from "./templates";

// Secrets and ConfigMaps in the catalog (DESIGN.md §16.6): Kubernetes objects built from the lab's
// inputs, placed on host clusters, downstream clusters, or the Rancher cluster for Fleet.

/** Lab-level values a template can use, as `lab.<ref>`. */
export const LAB_REFS = ["tls.email", "tls.cloudflare", "domain"] as const;
export type LabRef = (typeof LAB_REFS)[number];

export type InputShape = "string" | "credentials";

const ObjectFields = {
    description: z.string().optional(),
    /** Where it goes unless a placement says otherwise. */
    namespace: z.string().min(1).optional(),
    labels: z.record(z.string(), z.string()).optional(),
    annotations: z.record(z.string(), z.string()).optional(),
    /** Capabilities the host it lands on must provide, like a profile's `requires` (Outrider: `downstream-secrets`). */
    requires: z.array(z.string().min(1)).optional(),
    /** The inputs it is built from: name -> shape. */
    inputs: z.record(dnsLabel, z.enum(["string", "credentials"])).optional(),
    /**
     * Key -> a single value, or a map or list stored as a YAML document (a values file). Strings
     * are Jinja2 templates over `inputs` (`{{ inputs.appco.username }}`) and `lab`
     * (`{{ lab.tls.email }}`). A key whose inputs aren't all given is left out; with no keys left,
     * the object isn't created.
     */
    data: z.record(z.string(), z.unknown()).optional(),
};

export const SecretInput = z.strictObject({ ...ObjectFields, type: z.string().min(1).optional() });
export type SecretInput = z.infer<typeof SecretInput>;

export const ConfigMapInput = z.strictObject(ObjectFields);
export type ConfigMapInput = z.infer<typeof ConfigMapInput>;

/** Values for the objects' inputs, by input name. */
export const Inputs = z.record(dnsLabel, z.union([Credentials, secretOrString]));
export type Inputs = z.infer<typeof Inputs>;

/** Where a host or downstream cluster wants an object: its name, or name plus namespace. */
export const Placement = z.union([dnsLabel, z.strictObject({ name: dnsLabel, namespace: z.string().min(1).optional() })]);
export type Placement = z.infer<typeof Placement>;

// ---------------------------------------------------------------------------------------------

export type ObjectKind = "Secret" | "ConfigMap";

/**
 * A template leaf after resolution: a literal, or a template the program renders once it has the
 * secrets, with the inputs and lab values it uses (literals, or refs to the lab's secrets).
 */
export type ObjectValue = string | ObjectTemplate;
export interface ObjectTemplate {
    $template: string;
    /** The inputs it uses: a value or secret template, or the credentials fields it uses. */
    inputs: Record<string, string | { username?: string; password?: string }>;
    lab: Partial<Record<LabRef, string>>;
}

/** What an object template renders with (`inputs`, `lab`), each secret template rendered by `secret`. */
export function objectTemplateContext(t: ObjectTemplate, secret: (template: string) => unknown): { inputs: Record<string, unknown>; lab: Record<string, unknown> } {
    const value = (v: unknown): unknown => typeof v === "string" && usesSecrets(v) ? secret(v) : isObject(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, value(x)])) : v;
    const lab: Record<string, any> = { tls: {} };
    for (const [ref, v] of Object.entries(t.lab)) {
        if (ref.startsWith("tls.")) lab.tls[ref.slice(4)] = value(v);
        else lab[ref] = value(v);
    }
    return { inputs: value(t.inputs) as Record<string, unknown>, lab };
}

const containsSecret = (v: unknown): boolean => (typeof v === "string" ? usesSecrets(v) : isObject(v) && Object.values(v).some(containsSecret));

/** The cluster an object goes to: a host's own cluster, or one Rancher provisions. */
export type ObjectTarget = { host: string } | { downstream: string };

export interface ResolvedObject {
    kind: ObjectKind;
    name: string;
    namespace: string;
    target: ObjectTarget;
    type?: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
    /** Key -> an `ObjectValue`, or a map/list of them that is stored as YAML. */
    data: Record<string, unknown>;
}

type Sourced<T> = { value: T; source: string };

export interface ObjectsContext {
    catalog: { secrets: Record<string, Sourced<SecretInput>>; configmaps: Record<string, Sourced<ConfigMapInput>> };
    /** Input values from the personal config, then the lab file (later wins). */
    inputs: { values: Inputs; source: string; at: string }[];
    lab: Partial<Record<LabRef, string>>;
    diags: Diagnostics;
    /** Register an input value with its shape (and warn about plain values in the lab file). */
    useSecret(value: Credentials, shape: InputShape, source: string, at: string): void;
    describeCapability(capability: string): string;
}

export interface PlaceOptions {
    target: ObjectTarget;
    /** The target's capabilities, for `requires`; downstream clusters have none to check. */
    capabilities?: { has(capability: string): boolean };
    namespace?: string;
    /** Asked for by name (not only used by a Fleet repo): missing inputs are an error. */
    required: boolean;
    source: string;
    at: string;
}

export interface Objects {
    /** Place an object on a cluster; whether it is created, and what it waits for if not. */
    place(kind: ObjectKind, name: string, opts: PlaceOptions): { ok: boolean; missing: string[] };
    exists(kind: ObjectKind, name: string): boolean;
    objects: ResolvedObject[];
    /** What isn't created, and what it waits for (shown by `lab plan`). */
    skipped: { what: string; missing: string[] }[];
}

const DEFAULT_NAMESPACE = "default";
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const label = (kind: ObjectKind) => (kind === "Secret" ? "secret" : "configmap");
const targetName = (t: ObjectTarget) => ("host" in t ? t.host : `downstream ${t.downstream}`);

/** Check the inputs and return a builder that places catalog objects on clusters. */
export function createObjects(ctx: ObjectsContext): Objects {
    const { diags, catalog } = ctx;
    const defs = (kind: ObjectKind) => (kind === "Secret" ? catalog.secrets : catalog.configmaps) as Record<string, Sourced<SecretInput>>;

    // Every input any object declares, with one shape.
    const shapes: Record<string, { shape: InputShape; owner: string }> = {};
    for (const kind of ["Secret", "ConfigMap"] as const) {
        for (const [name, { value, source }] of Object.entries(defs(kind))) {
            for (const [input, shape] of Object.entries(value.inputs ?? {})) {
                const other = shapes[input];
                const at = `catalog.${kind === "Secret" ? "secrets" : "configmaps"}.${name}.inputs.${input}`;
                if (other && other.shape !== shape) diags.error(source, at, `is ${shape} here but ${other.shape} in ${other.owner}`);
                else shapes[input] = { shape, owner: `${label(kind)} ${name}` };
            }
        }
    }

    const provided: Record<string, Credentials> = {};
    for (const layer of ctx.inputs) {
        for (const [input, value] of Object.entries(layer.values)) {
            const valueAt = `${layer.at}.${input}`;
            const decl = shapes[input];
            if (!decl) {
                diags.error(layer.source, valueAt, `no catalog secret or configmap takes input "${input}"; known: ${Object.keys(shapes).sort().join(", ") || "none"}`);
                continue;
            }
            if (decl.shape === "string" && isObject(value)) diags.error(layer.source, valueAt, "must be a single value, not a username and password");
            else if (decl.shape === "credentials" && typeof value === "string" && !isTemplate(value)) diags.error(layer.source, valueAt, "must be credentials: \"{{ secrets.name }}\" or { username, password }");
            else {
                ctx.useSecret(value, decl.shape, layer.source, valueAt);
                provided[input] = value;
            }
        }
    }

    // Template strings -> ObjectValue leaves. Each is rendered once against placeholders, which
    // checks it and finds what it uses; a missing input or lab value is collected, not an error.
    const fill = (template: unknown, inputs: Record<string, InputShape>, owner: string, source: string, tAt: string, missing: Set<string>): unknown => {
        if (Array.isArray(template)) return template.map((v, j) => fill(v, inputs, owner, source, `${tAt}[${j}]`, missing));
        if (isObject(template)) return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, fill(v, inputs, owner, source, `${tAt}.${k}`, missing)]));
        if (typeof template !== "string" || !isTemplate(template)) return template;

        const problems = new Set<string>();
        const used: ObjectTemplate = { $template: template, inputs: {}, lab: {} };
        const keyMissing = new Set<string>();
        const inputsCtx = new Proxy({}, {
            get(_t, input) {
                if (typeof input !== "string") return undefined;
                const shape = inputs[input];
                if (!shape) {
                    problems.add(`refers to input "${input}", which ${owner} doesn't list under inputs`);
                    return undefined;
                }
                const value = provided[input];
                if (value === undefined) keyMissing.add(input);
                if (shape === "string") {
                    if (value !== undefined) used.inputs[input] = value as string;
                    return "x";
                }
                // Credentials are used by field (a whole secret ref goes as it is); on their own
                // they'd render as "[object Object]".
                const field = (f: "username" | "password") => {
                    if (value !== undefined) {
                        used.inputs[input] = typeof value === "string" ? value
                            : { ...(used.inputs[input] as object | undefined), [f]: (value as { username: string; password: string })[f] };
                    }
                    return "x";
                };
                return {
                    get username() { return field("username"); },
                    get password() { return field("password"); },
                    toString: () => { throw new Error(`input "${input}" is credentials: use inputs.${input}.username or inputs.${input}.password`); },
                };
            },
        });
        const labValue = (ref: LabRef) => {
            const value = ctx.lab[ref];
            if (value === undefined) keyMissing.add(`lab ${ref}`);
            else used.lab[ref] = value;
            return "x";
        };
        const labCtx = {
            get domain() { return labValue("domain"); },
            tls: { get email() { return labValue("tls.email"); }, get cloudflare() { return labValue("tls.cloudflare"); } },
        };
        let rendered: unknown;
        try {
            rendered = renderTemplate(template, { inputs: inputsCtx, lab: labCtx });
        } catch (e) {
            if (problems.size === 0) problems.add((e as Error).message);
        }
        if (problems.size === 0 && typeof rendered === "object" && rendered !== null) problems.add("renders to a map or list; a template must give a single value");
        for (const p of problems) diags.error(source, tAt, p);
        if (problems.size > 0) return "";
        for (const m of keyMissing) missing.add(m);
        if (keyMissing.size > 0) return "";
        // Without secrets in it, it renders here; with them, the program renders it.
        if (containsSecret(used.inputs) || containsSecret(used.lab)) return used;
        return String(renderTemplate(template, objectTemplateContext(used, () => undefined)) ?? "");
    };

    // Each object's data is built once, however often it is placed.
    const builds = new Map<string, { data: Record<string, unknown>; missing: string[] }>();
    const build = (kind: ObjectKind, name: string) => {
        const key = `${kind}/${name}`;
        const cached = builds.get(key);
        if (cached) return cached;
        const { value: def, source } = defs(kind)[name];
        const at = `catalog.${kind === "Secret" ? "secrets" : "configmaps"}.${name}`;
        const data: Record<string, unknown> = {};
        const keysMissing: [string, string[]][] = [];
        for (const [k, template] of Object.entries(def.data ?? {})) {
            const keyMissing = new Set<string>();
            const value = fill(template, def.inputs ?? {}, `${label(kind)} ${name}`, source, `${at}.data.${k}`, keyMissing);
            if (keyMissing.size > 0) keysMissing.push([k, [...keyMissing]]);
            else data[k] = value;
        }
        // No keys left: the object isn't created (reported where it's placed); else each left-out key is.
        const hasData = Object.keys(data).length > 0 || keysMissing.length === 0;
        if (hasData) for (const [k, m] of keysMissing) result.skipped.push({ what: `${label(kind)} ${name}/${k}`, missing: m });
        const outcome = { data, missing: hasData ? [] : [...new Set(keysMissing.flatMap(([, m]) => m))] };
        builds.set(key, outcome);
        return outcome;
    };

    const placed = new Set<string>();
    const result: Objects = {
        objects: [],
        skipped: [],
        exists: (kind, name) => Boolean(defs(kind)[name]),
        place(kind, name, opts) {
            const entry = defs(kind)[name];
            if (!entry) {
                const known = Object.keys(defs(kind)).sort().join(", ") || "none";
                diags.error(opts.source, opts.at, `unknown ${label(kind)} "${name}"; known: ${known}`);
                return { ok: false, missing: [] };
            }
            const def = entry.value;
            const built = build(kind, name);
            const missing = [...built.missing];
            // `requires` is about the host it lands on; downstream clusters have no profiles to check.
            const unmet = opts.capabilities ? (def.requires ?? []).filter(n => !opts.capabilities!.has(n)) : [];
            if (missing.length === 0 && unmet.length > 0) {
                const what = unmet.map(ctx.describeCapability).join(", ");
                // Asked for by name: an error. Wanted by a Fleet repo: left out, and reported.
                if (opts.required) diags.error(opts.source, opts.at, `${label(kind)} ${name} needs ${what} on ${targetName(opts.target)}`);
                missing.push(`${what} on ${targetName(opts.target)}`);
            } else if (missing.length > 0 && opts.required) {
                diags.error(opts.source, opts.at, `${label(kind)} ${name} needs input${missing.length > 1 ? "s" : ""} ${missing.join(", ")}; set them under inputs`);
            }
            const namespace = opts.namespace ?? def.namespace ?? DEFAULT_NAMESPACE;
            const where = `${label(kind)} ${namespace}/${name} on ${targetName(opts.target)}`;
            if (missing.length > 0) {
                if (!result.skipped.some(s => s.what === where)) result.skipped.push({ what: where, missing });
                return { ok: false, missing };
            }
            if (!placed.has(where)) {
                placed.add(where);
                result.objects.push({
                    kind, name, namespace, target: opts.target,
                    ...(kind === "Secret" && def.type ? { type: def.type } : {}),
                    labels: def.labels ?? {}, annotations: def.annotations ?? {}, data: built.data,
                });
            }
            return { ok: true, missing: [] };
        },
    };
    return result;
}

/** A placement entry as `{ name, namespace? }`. */
export function placementOf(p: Placement): { name: string; namespace?: string } {
    return typeof p === "string" ? { name: p } : p;
}
