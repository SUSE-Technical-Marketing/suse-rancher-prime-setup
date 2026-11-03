// The lab UI's server: the catalog, lab files in ../labs, and checks with the lab engine itself
// (the same resolver as `lab validate` and the same summary as `lab plan`).
//
// Secrets never leave this process: the UI gets the *names* of the personal config's secrets,
// Harvesters and AWS sites, and which secrets a lab needs that aren't set. Values are never read for that:
// `cmd:` secrets would run a command on every check.

import * as fs from "node:fs";
import * as path from "node:path";
import { parseAllDocuments } from "yaml";
import {
    capabilityReport, defaultPersonalConfigPath, Diagnostics, documentFormSchemas, loadCatalog, loadLab, loadPersonal, profileTargets, renderLabSpec, withPersonalVars, type ResolvedCatalog,
} from "../../packages/schema/src/index.ts";
import { DEFAULT_DISTRO } from "../../packages/schema/src/clusters/common.ts";
import { CLUSTER_TYPES, clusterFormSchemas } from "../../packages/schema/src/clusters/index.ts";
import type {
    CapabilityReport, Catalog, CatalogProfile, CheckResult, FleetProfileInfo, HostRecipe, LabFileEntry, LabFileText, PersonalSecret, SecretShape,
} from "../src/api-types.ts";
import { renderPlan } from "../../cli/src/plan.ts";
import { secretEnvName } from "../../cli/src/secrets.ts";

const LAB_DIR = path.resolve(import.meta.dir, "..", "..");
const LABS_DIR = path.join(LAB_DIR, "labs");
const DIST_DIR = path.resolve(import.meta.dir, "..", "dist");
const PORT = Number(process.env.LAB_UI_PORT ?? 4173);
const personalConfig = process.env.LAB_CONFIG ?? defaultPersonalConfigPath();

/** `asgard-odin.yaml`: no paths, so a request can't reach outside the labs directory. */
const LAB_FILE = /^[a-z0-9][a-z0-9.-]*\.yaml$/;

const json = (body: unknown, status = 200) => Response.json(body, { status });
/** An answer of the API: typed by api-types.ts, which the UI reads it with. */
const reply = <T>(body: T, status = 200) => json(body, status);

function catalogInfo(catalog: ResolvedCatalog): Omit<Catalog, "personal"> {
    const inputs: Record<string, SecretShape> = {};
    for (const o of [...Object.values(catalog.secrets), ...Object.values(catalog.configmaps)]) {
        for (const [name, shape] of Object.entries(o.value.inputs ?? {})) inputs[name] = shape;
    }
    return {
        os: Object.values(catalog.os).map(({ value: o }) => ({ name: o.name, displayName: o.displayName, family: o.family, image: o.image, ami: !!o.ami })),
        profiles: Object.values(catalog.profiles).map((p): CatalogProfile => ({
            ...(p.status === "planned" ? { status: "planned" as const } : {}),
            kind: p.kind,
            name: p.name,
            description: p.description,
            icon: p.icon,
            distribution: p.distribution,
            provides: p.provides ?? [],
            requires: p.requires ?? [],
            conflicts: p.conflicts ?? [],
            fallback: p.fallback ?? [],
            hostKinds: p.hostKinds,
            targets: profileTargets(p),
            clusterRefs: p.clusterRefs ?? [],
            osFamilies: p.osFamilies,
            settings: p.settingsSchema,
        })),
        acme: Object.keys(catalog.acme).sort(),
        clusterForms: clusterFormSchemas() as Catalog["clusterForms"],
        documentForms: documentFormSchemas() as Catalog["documentForms"],
        rancherNeeds: Object.fromEntries(Object.entries(CLUSTER_TYPES).flatMap(([type, t]) => (t.rancherNeeds ? [[type, t.rancherNeeds]] : []))),
        distributions: Object.entries(catalog.components).sort(([a], [b]) => a.localeCompare(b)).flatMap(([name, { value }]) =>
            value.kind === "KubernetesDistribution" ? [{ name, description: value.description, cni: value.cni, default: name === DEFAULT_DISTRO }] : []),
        // The palette's standard hosts, in name order.
        recipes: Object.entries(catalog.recipes).sort(([a], [b]) => a.localeCompare(b)).map(([name, { value }]): HostRecipe => ({
            name, label: value.label ?? name, description: value.description ?? "", icon: value.icon, kind: value.kind, hostName: value.name ?? name, host: value.host,
        })),
        haulManifests: Object.entries(catalog.haulManifests).sort(([a], [b]) => a.localeCompare(b)).map(([name, { value }]) => ({ name, description: value.description })),
        fleetRepos: Object.entries(catalog.fleet.repos).map(([name, { value }]) => ({ name, description: value.description, default: !!value.default })),
        // Labels and annotations for downstream clusters; Fleet installs what they select.
        fleetProfiles: Object.entries(catalog.fleet.profiles).sort(([a], [b]) => a.localeCompare(b)).map(([name, { value }]): FleetProfileInfo => ({
            name, description: value.description ?? "", icon: value.icon,
            labels: value.labels ?? {}, annotations: value.annotations ?? {},
            requires: value.requires ?? [], provides: value.provides ?? [], conflicts: value.conflicts ?? [],
        })),
        inputs,
        defaults: catalog.defaults.value,
    };
}

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** A secret's shape as fields can use it; `other` for anything a lab can't (a list, a number). */
function shapeOf(v: unknown): "string" | "credentials" | "map" | "other" {
    if (typeof v === "string") return "string";
    if (!isMap(v)) return "other";
    return typeof v.username === "string" && typeof v.password === "string" ? "credentials" : "map";
}

/**
 * A secret and every field in it, by path (`cloudflare`, `cloudflare.token`, `cloudflare.tunnel.id`):
 * shapes and a map's field names, never values.
 */
function secretPaths(at: string[], v: unknown): PersonalSecret[] {
    const here = { name: at.join("."), path: at, shape: shapeOf(v), ...(isMap(v) ? { fields: Object.keys(v).sort() } : {}) };
    return isMap(v) ? [here, ...Object.entries(v).flatMap(([k, x]) => secretPaths([...at, k], x))] : [here];
}

function personalInfo(): Catalog["personal"] {
    const diags = new Diagnostics();
    const personal = loadPersonal(personalConfig, diags)?.value;
    return {
        source: personalConfig,
        secrets: Object.entries(personal?.secrets ?? {}).flatMap(([name, v]) => secretPaths([name], v)),
        harvesters: Object.keys(personal?.harvesters ?? {}),
        awsSites: Object.entries(personal?.awsSites ?? {}).map(([name, s]) => ({ name, region: s.region })),
        problems: diags.items.map(d => `${d.path ? `${d.path}: ` : ""}${d.message}`),
    };
}

/** Check a lab's text as `lab validate` and `lab plan` would, from a file next to the real labs (relative `file:` paths work). */
/**
 * The Lab document's values as templates see them (`lab`): rendered, references between them filled
 * in, so the composer's completion shows what `{{ lab.vars.b }}` gives. Whatever else is wrong.
 */
function labValues(text: string): { name?: string; spec?: unknown } | undefined {
    try {
        const doc = parseAllDocuments(text).map(d => d.toJS()).find(d => d?.kind === "Lab");
        if (!doc) return undefined;
        // With the personal config's vars under the lab's, as the engine has them.
        const vars = loadPersonal(personalConfig, new Diagnostics())?.value.vars;
        return { name: doc.metadata?.name, spec: renderLabSpec(doc.metadata?.name, withPersonalVars(doc.spec, vars), "spec", () => {}) };
    } catch {
        return undefined;
    }
}

/** The profiles' targets by document kind: lab hosts, downstream clusters, Harvesters. */
const TARGETS: Record<string, "host" | "cluster" | "harvester"> = { HarvesterVM: "host", Machine: "host", DownstreamCluster: "cluster", Harvester: "harvester" };

/**
 * Each host's, cluster's and Harvester's capabilities by the engine's own rules (what `validate`
 * checks), from the text as it is: also while the lab has errors, when the composer needs them most.
 */
function capabilities(text: string, labFile: string): Record<string, CapabilityReport> {
    const catalog = loadCatalog({ labFile, labText: text, personalConfig }).catalog ?? loadCatalog({ personalConfig }).catalog;
    if (!catalog) return {};
    const fleetKnown = Object.fromEntries(Object.entries(catalog.fleet.profiles).map(([n, { value }]) => [n, value]));
    const out: Record<string, CapabilityReport> = {};
    let docs: any[];
    try {
        docs = parseAllDocuments(text).map(d => d.toJS());
    } catch {
        return {};
    }
    for (const doc of docs) {
        const target = TARGETS[doc?.kind];
        const name = doc?.metadata?.name;
        if (!target || typeof name !== "string") continue;
        // `rancher:` with nothing after it is a profile with its default settings.
        const profiles = Object.fromEntries(Object.entries(isMap(doc.spec?.profiles) ? doc.spec.profiles : {}).map(([n, v]) => [n, isMap(v) ? v : {}]));
        const fleet = target === "cluster" ? { names: Object.keys(isMap(doc.spec?.fleetProfiles) ? doc.spec.fleetProfiles : {}), known: fleetKnown } : undefined;
        out[`${doc.kind}/${name}`] = capabilityReport(catalog.profiles, target, profiles, fleet);
    }
    return out;
}

function check(text: string, name: string): CheckResult {
    // As if saved in the labs directory: its relative paths (local images) start there.
    const shown = name || "lab.yaml";
    const labFile = path.join(LABS_DIR, shown);
    const result = loadLab({ labFile, labText: text, personalConfig });
    const diagnostics = result.diagnostics.items.map(d => ({ ...d, source: d.source === labFile ? shown : d.source }));
    const lab = labValues(text);
    const caps = capabilities(text, labFile);
    if (!result.lab || !result.personal) return { ok: false, diagnostics, missingSecrets: [], plan: undefined, lab, capabilities: caps };
    const set = new Set(Object.keys(result.personal.secrets));
    const missing = Object.keys(result.lab.secrets).filter(s => !set.has(s) && process.env[secretEnvName(s)] === undefined);
    return {
        ok: result.diagnostics.errors.length === 0,
        diagnostics,
        missingSecrets: missing,
        plan: renderPlan(result.lab, new Set(missing)).replaceAll(labFile, shown),
        lab,
        capabilities: caps,
    };
}

async function api(req: Request, url: URL): Promise<Response> {
    const route = url.pathname.replace(/^\/api/, "");
    if (route === "/catalog" && req.method === "GET") {
        let { diagnostics, catalog } = loadCatalog({ personalConfig });
        // A broken personal config (or a file it includes) doesn't stop the composer: the built-in
        // catalog without it, and the personal config's problems shown.
        if (!catalog) {
            const without = loadCatalog({ personalConfig, withoutPersonal: true });
            if (without.catalog) ({ diagnostics, catalog } = without);
        }
        if (!catalog) return json({ error: diagnostics.items.map(d => `${d.source}: ${d.path}: ${d.message}`).join("\n") }, 500);
        return reply<Catalog>({ ...catalogInfo(catalog), personal: personalInfo() });
    }
    if (route === "/labs" && req.method === "GET") {
        const files = fs.readdirSync(LABS_DIR).filter(f => LAB_FILE.test(f)).sort();
        return reply<LabFileEntry[]>(files.map(file => ({ file })));
    }
    const lab = /^\/labs\/([^/]+)$/.exec(route);
    if (lab) {
        const file = decodeURIComponent(lab[1]);
        if (!LAB_FILE.test(file)) return json({ error: "a lab file is a lowercase name ending in .yaml" }, 400);
        const full = path.join(LABS_DIR, file);
        if (req.method === "GET") {
            if (!fs.existsSync(full)) return json({ error: `${file} doesn't exist` }, 404);
            return reply<LabFileText>({ file, text: fs.readFileSync(full, "utf8") });
        }
        if (req.method === "PUT") {
            const body = await req.json() as { text?: string; overwrite?: boolean };
            if (typeof body.text !== "string") return json({ error: "text is required" }, 400);
            if (fs.existsSync(full) && !body.overwrite) return json({ error: `${file} exists`, exists: true }, 409);
            fs.writeFileSync(full, body.text.endsWith("\n") ? body.text : `${body.text}\n`);
            return reply<LabFileEntry>({ file });
        }
    }
    if (route === "/check" && req.method === "POST") {
        const body = await req.json() as { text?: string; name?: string };
        if (typeof body.text !== "string") return json({ error: "text is required" }, 400);
        return reply<CheckResult>(check(body.text, body.name ?? ""));
    }
    return json({ error: "not found" }, 404);
}

Bun.serve({
    port: PORT,
    // Only this machine: the UI reads and writes lab files and knows which secrets you have.
    hostname: "127.0.0.1",
    async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.startsWith("/api/")) {
            try {
                return await api(req, url);
            } catch (e) {
                return json({ error: (e as Error).message }, 500);
            }
        }
        // The built UI (`mise run build`); in development Vite serves it and proxies /api here.
        const file = path.join(DIST_DIR, path.normalize(url.pathname).replace(/^\/+/, ""));
        if (file.startsWith(DIST_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) return new Response(Bun.file(file));
        const index = path.join(DIST_DIR, "index.html");
        if (fs.existsSync(index)) return new Response(Bun.file(index));
        return new Response("The UI isn't built yet: run `mise run build` in lab/ui, or `mise run dev`.", { status: 503 });
    },
});

console.log(`lab UI on http://127.0.0.1:${PORT} (labs in ${LABS_DIR}, personal config ${personalConfig})`);
