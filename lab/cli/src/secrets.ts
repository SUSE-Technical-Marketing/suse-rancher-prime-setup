import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { credentialsOf, Credentials, fieldAt, renderSecretTemplate, SecretShape, shapeFields, SecretValue } from "@lab/schema";

/** A string, or a map of strings (credentials, AWS keys), maybe nested (`cloudflare.tunnel.token`). */
export type ResolvedSecret = string | { [field: string]: string | ResolvedSecret };

export interface SecretResolution {
    values: Record<string, ResolvedSecret>;
    /** One line per secret that is missing or has the wrong shape. */
    problems: string[];
}

/** `LAB_SECRET_<NAME>`: upper case, anything not a letter or digit becomes `_`. */
export function secretEnvName(name: string): string {
    return `LAB_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/**
 * Resolve one leaf of a personal-config secret. `env:`, `file:` and `cmd:` are only honoured here,
 * in the user's own config, never in a (shareable) lab file.
 */
function resolveLeaf(value: string, ctx: { env: NodeJS.ProcessEnv; configDir: string }): string {
    if (value.startsWith("env:")) {
        const name = value.slice(4);
        const v = ctx.env[name];
        if (v === undefined) throw new Error(`environment variable ${name} is not set`);
        return v;
    }
    if (value.startsWith("file:")) {
        const raw = value.slice(5);
        const file = path.resolve(ctx.configDir, raw === "~" || raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(1)) : raw);
        try {
            return fs.readFileSync(file, "utf8").trimEnd();
        } catch {
            throw new Error(`can't read ${file}`);
        }
    }
    if (value.startsWith("cmd:")) {
        const command = value.slice(4);
        try {
            return execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
        } catch (e) {
            const stderr = String((e as { stderr?: string }).stderr ?? "").trim().split("\n")[0];
            throw new Error(`command failed: ${command}${stderr ? ` (${stderr})` : ""}`);
        }
    }
    return value;
}

/** What a value is, for messages: never the value itself. */
const kindOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "a list" : typeof v === "object" ? "a map" : `a ${typeof v}`);

/** A copy of a map with a field, by its dotted path, set. */
function withField(map: Record<string, unknown>, field: string, value: unknown): Record<string, unknown> {
    const [key, ...rest] = field.split(".");
    const inner = map[key];
    return { ...map, [key]: rest.length ? withField(typeof inner === "object" && inner !== null ? inner as Record<string, unknown> : {}, rest.join("."), value) : value };
}

/**
 * A personal-config secret's value as the lab uses it, its leaves resolved: only the fields the lab
 * uses, so a field it doesn't (a `cmd:` it needn't run, a nested map) is left alone.
 */
function fromConfig(name: string, configured: unknown, shape: SecretShape, ctx: { env: NodeJS.ProcessEnv; configDir: string }): unknown {
    if (shape === "string") {
        if (typeof configured !== "string") throw new Error(`secret "${name}" must be a string, and it's ${kindOf(configured)}`);
        return resolveLeaf(configured, ctx);
    }
    if (typeof configured !== "object" || configured === null || Array.isArray(configured)) return configured;
    // The other fields stay unresolved: checkShape names them in a message, then drops them.
    let map = configured as Record<string, unknown>;
    for (const f of shapeFields(shape)) {
        const v = fieldAt(map, f);
        if (v === undefined) continue;
        if (typeof v !== "string") throw new Error(`secret "${name}": field ${f} must be a string, and it's ${kindOf(v)}`);
        map = withField(map, f, resolveLeaf(v, ctx));
    }
    return map;
}

function checkShape(name: string, value: unknown, shape: SecretShape): ResolvedSecret {
    if (shape === "string") {
        if (typeof value !== "string" || value === "") throw new Error(`secret "${name}" must be a non-empty string`);
        return value;
    }
    const fields = shapeFields(shape);
    const v = value as Record<string, unknown>;
    if (typeof v !== "object" || v === null || fields.some(f => typeof fieldAt(v, f) !== "string")) {
        throw new Error(shape === "credentials"
            ? `secret "${name}" must have a username and a password`
            : `secret "${name}" must be a map with ${fields.join(", ")}${typeof v === "object" && v !== null ? ` (it has ${Object.keys(v).sort().join(", ") || "no fields"})` : ""}`);
    }
    // Only the fields the lab uses travel on to the program.
    return fields.reduce<Record<string, unknown>>((out, f) => withField(out, f, fieldAt(v, f)), {}) as ResolvedSecret;
}

export function resolveSecrets(
    required: Record<string, SecretShape>,
    personal: Record<string, SecretValue>,
    opts: { env?: NodeJS.ProcessEnv; configDir: string },
): SecretResolution {
    const env = opts.env ?? process.env;
    const values: Record<string, ResolvedSecret> = {};
    const problems: string[] = [];

    for (const [name, shape] of Object.entries(required).sort(([a], [b]) => a.localeCompare(b))) {
        const envName = secretEnvName(name);
        try {
            let raw: unknown;
            const fromEnv = env[envName];
            if (fromEnv !== undefined) {
                // A map in an environment variable is JSON: {"username":"...","password":"..."}.
                raw = shape === "string" ? fromEnv : JSON.parse(fromEnv);
            } else if (name in personal) {
                raw = fromConfig(name, personal[name], shape, { env, configDir: opts.configDir });
            } else {
                problems.push(`secret "${name}" is not set: add it under secrets: in the personal config, or set ${envName}`);
                continue;
            }
            values[name] = checkShape(name, raw, shape);
        } catch (e) {
            problems.push(`secret "${name}": ${(e as Error).message}`);
        }
    }
    return { values, problems };
}

/** Turn a credentials value from the lab into a username and password, using resolved secrets. */
export function credentialsFrom(creds: Credentials, secrets: Record<string, ResolvedSecret>): { username: string; password: string } {
    return credentialsOf(creds, t => renderSecretTemplate(t, secrets));
}
