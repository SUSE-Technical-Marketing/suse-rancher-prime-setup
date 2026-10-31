import { z } from "zod";
import { haulManifestName } from "./hauler";
import { chartValues, Credentials, dnsLabel, dnsName, ipv4, quantity, secretOrString } from "./primitives";

/**
 * A profile's settings as written in its catalog file (DESIGN.md §16.10): a subset of JSON Schema.
 * `$ref` names one of the lab's own types (below), so their checks and messages are the same as
 * everywhere else. Objects reject unknown fields unless `additionalProperties` says otherwise.
 */
export interface SettingSchema {
    type?: "string" | "integer" | "number" | "boolean" | "object" | "array";
    description?: string;
    $ref?: string;
    enum?: (string | number | boolean)[];
    const?: string | number | boolean;
    anyOf?: SettingSchema[];
    oneOf?: SettingSchema[];
    default?: unknown;
    minimum?: number;
    maximum?: number;
    minLength?: number;
    pattern?: string;
    items?: SettingSchema;
    properties?: Record<string, SettingSchema>;
    required?: string[];
    /** On a map (no `properties`): its values' schema. A map's `default` is merged with what a lab gives. */
    additionalProperties?: boolean | SettingSchema;
}

/** The lab types a setting can `$ref`, with their TypeScript type for the generated settings. */
const REFS: Record<string, { zod: z.ZodType; ts: string }> = {
    dnsLabel: { zod: dnsLabel, ts: "string" },
    dnsName: { zod: dnsName, ts: "string" },
    quantity: { zod: quantity, ts: "string" },
    ipv4: { zod: ipv4, ts: "string" },
    url: { zod: z.url(), ts: "string" },
    secretOrString: { zod: secretOrString, ts: "string" },
    credentials: { zod: Credentials, ts: "Credentials" },
    chartValues: { zod: chartValues.unwrap(), ts: "Record<string, unknown>" },
    /** A HaulManifest's name: the resolver checks the catalog has it (`refsIn`). */
    haulManifest: { zod: haulManifestName, ts: "string" },
};
export const SETTING_REFS = Object.keys(REFS);

const KEYWORDS = new Set(["type", "description", "$ref", "enum", "const", "anyOf", "oneOf", "default", "minimum", "maximum", "minLength", "pattern", "items", "properties", "required", "additionalProperties"]);

/** Problems in a settings schema itself (an unknown keyword or `$ref`), as dot paths. */
export function checkSettingSchema(s: SettingSchema, at: string, problems: { at: string; message: string }[]): void {
    for (const key of Object.keys(s)) if (!KEYWORDS.has(key)) problems.push({ at: `${at}.${key}`, message: `unsupported keyword "${key}"` });
    if (s.$ref !== undefined && !REFS[s.$ref]) problems.push({ at: `${at}.$ref`, message: `unknown type "${s.$ref}"; one of ${SETTING_REFS.join(", ")}` });
    for (const [k, v] of Object.entries(s.properties ?? {})) checkSettingSchema(v, `${at}.properties.${k}`, problems);
    if (s.items) checkSettingSchema(s.items, `${at}.items`, problems);
    if (typeof s.additionalProperties === "object") checkSettingSchema(s.additionalProperties, `${at}.additionalProperties`, problems);
    [...(s.anyOf ?? []), ...(s.oneOf ?? [])].forEach((alt, i) => checkSettingSchema(alt, `${at}.anyOf[${i}]`, problems));
}

/** The zod schema for a (checked) settings schema. */
export function settingZod(s: SettingSchema): z.ZodType {
    let t: z.ZodType;
    const alts = s.anyOf ?? s.oneOf;
    if (s.$ref) t = REFS[s.$ref].zod;
    else if (alts) t = z.union(alts.map(settingZod) as [z.ZodType, z.ZodType, ...z.ZodType[]]);
    else if (s.const !== undefined) t = z.literal(s.const);
    else if (s.enum) t = s.enum.every(v => typeof v === "string") ? z.enum(s.enum as [string, ...string[]]) : z.union(s.enum.map(v => z.literal(v)) as unknown as [z.ZodType, z.ZodType]);
    else if (s.type === "string") {
        let str = z.string();
        if (s.minLength !== undefined) str = str.min(s.minLength);
        if (s.pattern) str = str.regex(new RegExp(s.pattern));
        t = str;
    } else if (s.type === "integer" || s.type === "number") {
        let n = s.type === "integer" ? z.int() : z.number();
        if (s.minimum !== undefined) n = n.min(s.minimum);
        if (s.maximum !== undefined) n = n.max(s.maximum);
        t = n;
    } else if (s.type === "boolean") t = z.boolean();
    else if (s.type === "array") t = z.array(s.items ? settingZod(s.items) : z.unknown());
    else if (s.type === "object" || s.properties) {
        const required = new Set(s.required ?? []);
        const shape = Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => {
            const field = settingZod(v);
            return [k, required.has(k) || v.default !== undefined ? field : field.optional()];
        }));
        if (!s.properties && typeof s.additionalProperties === "object") {
            t = z.record(z.string(), settingZod(s.additionalProperties));
            // A map with a default (Rancher's feature flags) is merged over it, not instead of it.
            const base = s.default;
            if (typeof base === "object" && base !== null && !Array.isArray(base)) {
                return t.optional().transform(v => ({ ...(base as Record<string, unknown>), ...(v as Record<string, unknown> | undefined) }));
            }
        } else if (s.additionalProperties === true) t = z.looseObject(shape);
        else t = z.strictObject(shape);
    } else t = z.unknown();
    return s.default !== undefined ? t.default(s.default as never) : t;
}

/** The TypeScript type of a settings value after parsing (defaults applied), for generated code. */
export function settingTs(s: SettingSchema, indent = ""): string {
    const alts = s.anyOf ?? s.oneOf;
    if (s.$ref) return REFS[s.$ref].ts;
    if (alts) return alts.map(a => settingTs(a, indent)).join(" | ");
    if (s.const !== undefined) return JSON.stringify(s.const);
    if (s.enum) return s.enum.map(v => JSON.stringify(v)).join(" | ");
    if (s.type === "string") return "string";
    if (s.type === "integer" || s.type === "number") return "number";
    if (s.type === "boolean") return "boolean";
    if (s.type === "array") {
        const item = s.items ? settingTs(s.items, indent) : "unknown";
        return item.includes(" | ") ? `(${item})[]` : `${item}[]`;
    }
    if (s.type === "object" || s.properties) {
        if (!s.properties && typeof s.additionalProperties === "object") return `Record<string, ${settingTs(s.additionalProperties, indent)}>`;
        const required = new Set(s.required ?? []);
        const inner = `${indent}    `;
        const fields = Object.entries(s.properties ?? {}).map(([k, v]) => {
            const optional = !required.has(k) && v.default === undefined;
            const doc = v.description ? `${inner}/** ${v.description} */\n` : "";
            const key = /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);
            return `${doc}${inner}${key}${optional ? "?" : ""}: ${settingTs(v, inner)};`;
        });
        if (fields.length === 0) return "Record<string, never>";
        return `{\n${fields.join("\n")}\n${indent}}`;
    }
    return "unknown";
}

const pascal = (name: string) => name.replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());

/**
 * TypeScript for every profile's settings (after parsing), and a name -> settings map the
 * program's builders are typed against. Written to `program/generated/profile-settings.ts` by
 * `mise run profile-types`; a test keeps it in step with the catalog.
 */
export function generateProfileSettingsTs(profiles: Record<string, { settingsSchema: SettingSchema; description: string }>): string {
    const names = Object.keys(profiles).sort();
    const out = [
        "// Generated from the Profile documents in lab/catalog/ by `mise run profile-types`. Don't edit.",
        'import type { Credentials } from "@lab/schema";',
        "",
    ];
    for (const name of names) {
        out.push(`/** Settings of the \`${name}\` profile: ${profiles[name].description} */`);
        out.push(`export type ${pascal(name)}Settings = ${settingTs(profiles[name].settingsSchema)};`, "");
    }
    out.push("/** Profile name -> its settings. */", "export interface ProfileSettings {");
    for (const name of names) out.push(`    ${JSON.stringify(name)}: ${pascal(name)}Settings;`);
    out.push("}", "");
    return out.join("\n");
}

/**
 * The values in parsed settings that a schema types as `$ref: <ref>`, with their dot paths: for
 * checks against the catalog (a HaulManifest's name). Unions are skipped; nothing uses one for these.
 */
export function refsIn(s: SettingSchema, value: unknown, ref: string, at = ""): { at: string; value: unknown }[] {
    if (value === undefined || value === null) return [];
    if (s.$ref === ref) return [{ at, value }];
    if (s.type === "array" && s.items && Array.isArray(value)) return value.flatMap((v, i) => refsIn(s.items!, v, ref, `${at}[${i}]`));
    if (typeof value !== "object" || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    const join = (k: string) => (at ? `${at}.${k}` : k);
    if (s.properties) return Object.entries(s.properties).flatMap(([k, sub]) => refsIn(sub, record[k], ref, join(k)));
    if (typeof s.additionalProperties === "object") return Object.entries(record).flatMap(([k, v]) => refsIn(s.additionalProperties as SettingSchema, v, ref, join(k)));
    return [];
}
