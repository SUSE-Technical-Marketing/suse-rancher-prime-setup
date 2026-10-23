import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Credentials, SecretRef, SecretShape, SecretValue } from "@lab/schema";

export type ResolvedSecret = string | { username: string; password: string };

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

function checkShape(name: string, value: unknown, shape: SecretShape): ResolvedSecret {
    if (shape === "string") {
        if (typeof value !== "string" || value === "") throw new Error(`secret "${name}" must be a non-empty string`);
        return value;
    }
    const v = value as { username?: unknown; password?: unknown };
    if (typeof v !== "object" || v === null || typeof v.username !== "string" || typeof v.password !== "string") {
        throw new Error(`secret "${name}" must have a username and a password`);
    }
    return { username: v.username, password: v.password };
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
                // Credentials in an environment variable are JSON: {"username":"...","password":"..."}.
                raw = shape === "credentials" ? JSON.parse(fromEnv) : fromEnv;
            } else if (name in personal) {
                const configured = personal[name];
                raw = typeof configured === "string"
                    ? resolveLeaf(configured, { env, configDir: opts.configDir })
                    : Object.fromEntries(Object.entries(configured).map(([k, v]) => [k, resolveLeaf(v, { env, configDir: opts.configDir })]));
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
    const isRef = (v: unknown): v is SecretRef => typeof v === "object" && v !== null && "$secret" in v;
    if (isRef(creds)) {
        const v = secrets[creds.$secret];
        if (typeof v !== "object") throw new Error(`secret "${creds.$secret}" is not resolved`);
        return v;
    }
    const password = isRef(creds.password) ? secrets[creds.password.$secret] : creds.password;
    if (typeof password !== "string") throw new Error("password secret is not resolved");
    return { username: creds.username, password };
}
