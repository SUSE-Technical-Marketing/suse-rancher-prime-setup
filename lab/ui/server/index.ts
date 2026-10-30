// The lab UI's server: the catalog, lab files in ../labs, and checks with the lab engine itself
// (the same resolver as `lab validate` and the same summary as `lab plan`).
//
// Secrets never leave this process: the UI gets the *names* of the personal config's secrets,
// Harvesters and AWS sites, and which secrets a lab needs that aren't set. Values are never read for that:
// `cmd:` secrets would run a command on every check.

import * as fs from "node:fs";
import * as path from "node:path";
import {
    defaultPersonalConfigPath, Diagnostics, loadCatalog, loadLab, loadPersonal, type ResolvedCatalog,
} from "../../packages/schema/src/index.ts";
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

function catalogInfo(catalog: ResolvedCatalog) {
    const inputs: Record<string, string> = {};
    for (const o of [...Object.values(catalog.secrets), ...Object.values(catalog.configmaps)]) {
        for (const [name, shape] of Object.entries(o.value.inputs ?? {})) inputs[name] = shape;
    }
    return {
        os: Object.values(catalog.os).map(({ value: o }) => ({ name: o.name, displayName: o.displayName, family: o.family, image: o.image, ami: !!o.ami })),
        profiles: Object.values(catalog.profiles).map(p => ({
            name: p.name,
            description: p.description,
            icon: p.icon,
            distribution: p.distribution,
            provides: p.provides ?? [],
            requires: p.requires ?? [],
            conflicts: p.conflicts ?? [],
            fallback: p.fallback ?? [],
            hostKinds: p.hostKinds,
            osFamilies: p.osFamilies,
            secretFields: p.secretFields ?? [],
            settings: p.settingsSchema,
        })),
        acme: Object.keys(catalog.acme).sort(),
        fleetRepos: Object.entries(catalog.fleet.repos).map(([name, { value }]) => ({ name, description: value.description, default: !!value.default })),
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

function personalInfo() {
    const diags = new Diagnostics();
    const personal = loadPersonal(personalConfig, diags)?.value;
    return {
        source: personalConfig,
        secrets: Object.entries(personal?.secrets ?? {}).map(([name, v]) => ({
            name,
            shape: shapeOf(v),
            // A map's field names (never its values): `accessKey`, `secretKey`.
            ...(isMap(v) ? { fields: Object.keys(v).sort() } : {}),
        })),
        harvesters: Object.keys(personal?.harvesters ?? {}),
        awsSites: Object.entries(personal?.awsSites ?? {}).map(([name, s]) => ({ name, region: s.region })),
        problems: diags.items.map(d => `${d.path ? `${d.path}: ` : ""}${d.message}`),
    };
}

/** Check a lab's text as `lab validate` and `lab plan` would, from a file next to the real labs (relative `file:` paths work). */
function check(text: string, name: string) {
    const tmp = path.join(LABS_DIR, `.ui-check-${process.pid}-${Math.random().toString(36).slice(2)}.yaml`);
    fs.writeFileSync(tmp, text);
    try {
        const result = loadLab({ labFile: tmp, personalConfig });
        const shown = name || "lab.yaml";
        const diagnostics = result.diagnostics.items.map(d => ({ ...d, source: d.source === tmp ? shown : d.source }));
        if (!result.lab || !result.personal) return { ok: false, diagnostics, missingSecrets: [], plan: undefined };
        const set = new Set(Object.keys(result.personal.secrets));
        const missing = Object.keys(result.lab.secrets).filter(s => !set.has(s) && process.env[secretEnvName(s)] === undefined);
        return {
            ok: result.diagnostics.errors.length === 0,
            diagnostics,
            missingSecrets: missing,
            plan: renderPlan(result.lab, new Set(missing)).replaceAll(tmp, shown),
        };
    } finally {
        fs.rmSync(tmp, { force: true });
    }
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
        return json({ ...catalogInfo(catalog), personal: personalInfo() });
    }
    if (route === "/labs" && req.method === "GET") {
        const files = fs.readdirSync(LABS_DIR).filter(f => LAB_FILE.test(f)).sort();
        return json(files.map(file => ({ file })));
    }
    const lab = /^\/labs\/([^/]+)$/.exec(route);
    if (lab) {
        const file = decodeURIComponent(lab[1]);
        if (!LAB_FILE.test(file)) return json({ error: "a lab file is a lowercase name ending in .yaml" }, 400);
        const full = path.join(LABS_DIR, file);
        if (req.method === "GET") {
            if (!fs.existsSync(full)) return json({ error: `${file} doesn't exist` }, 404);
            return json({ file, text: fs.readFileSync(full, "utf8") });
        }
        if (req.method === "PUT") {
            const body = await req.json() as { text?: string; overwrite?: boolean };
            if (typeof body.text !== "string") return json({ error: "text is required" }, 400);
            if (fs.existsSync(full) && !body.overwrite) return json({ error: `${file} exists`, exists: true }, 409);
            fs.writeFileSync(full, body.text.endsWith("\n") ? body.text : `${body.text}\n`);
            return json({ file });
        }
    }
    if (route === "/check" && req.method === "POST") {
        const body = await req.json() as { text?: string; name?: string };
        if (typeof body.text !== "string") return json({ error: "text is required" }, 400);
        return json(check(body.text, body.name ?? ""));
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
