import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { unzipSync, zipSync, type Zippable } from "fflate";
import { stackPackFile, type ResolvedCatalog, type ResolvedLab } from "@lab/schema";

// StackPacks built from source (DESIGN.md §9.6): SUSE doesn't publish the suse-ai StackPack as a
// .sts, so `lab stackpacks` builds it from its tag's archive, before `up`, which uploads the file.
// Built here rather than in the StackPack's provider: that is serialized into the Pulumi state.

/** What a .sts holds of the StackPack's directory, as its packaging script takes it (scripts/package-stackpack.sh). */
const STS_ENTRIES = ["README.md", "stackpack.yaml", "settings", "resources", "icons", "includes"];

/**
 * A .sts from a source archive (a GitHub tag's zip, one top directory): the StackPack's directory
 * `dir`, its files sorted and stored (not compressed) with one timestamp, so the same source gives
 * the same bytes. Its version is its stackpack.yaml's.
 */
export function buildStackPack(archive: Uint8Array, dir: string): { sts: Uint8Array; version: string; sha256: string } {
    const files = unzipSync(archive);
    const top = Object.keys(files)[0]?.split("/")[0];
    const prefix = `${top}/${dir.replace(/^\/+|\/+$/g, "")}/`;
    const names = Object.keys(files)
        .filter(n => n.startsWith(prefix) && !n.endsWith("/"))
        .map(n => n.slice(prefix.length))
        .filter(n => STS_ENTRIES.some(e => n === e || n.startsWith(`${e}/`)))
        .sort();
    if (!names.includes("stackpack.yaml")) throw new Error(`the archive has no ${prefix}stackpack.yaml`);
    const version = /^version: (\d+\.\d+\.\d+)$/m.exec(new TextDecoder().decode(files[prefix + "stackpack.yaml"]))?.[1];
    if (!version) throw new Error(`${prefix}stackpack.yaml has no version`);
    // The script's fixed timestamp (1980-01-01, the zip epoch), as local time: fflate writes DOS times in local time.
    const mtime = new Date(1980, 0, 1);
    const zippable: Zippable = {};
    for (const n of names) zippable[n] = [files[prefix + n], { level: 0, mtime }];
    const sts = zipSync(zippable);
    return { sts, version, sha256: sha256Of(sts) };
}

const sha256Of = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/** The catalog's StackPacks built from source. */
const fromSource = (catalog: ResolvedCatalog) => Object.entries(catalog.components)
    .flatMap(([name, { value }]) => value.kind === "StackPack" && value.archive ? [{ name, ...value, archive: value.archive, version: value.version!, sha256: value.sha256!, path: value.path! }] : []);

/**
 * Build every StackPack of the catalog that comes from source into `lab/.cache/stackpacks/`, unless
 * it's there with its pinned sha256. A build that doesn't give that sha256 is refused (the tag's
 * content changed): nothing is written. Returns what it did, a line per StackPack.
 */
export async function buildCatalogStackPacks(
    catalog: ResolvedCatalog,
    opts: { force?: boolean; fetch?: typeof fetch; fileOf?: typeof stackPackFile } = {},
): Promise<string[]> {
    const done: string[] = [];
    for (const sp of fromSource(catalog)) {
        const file = (opts.fileOf ?? stackPackFile)(sp.name, sp.version);
        if (!opts.force && fs.existsSync(file) && sha256Of(fs.readFileSync(file)) === sp.sha256) {
            done.push(`${sp.name} ${sp.version}: built already (${file})`);
            continue;
        }
        const url = sp.archive.replace(/\{version\}/g, sp.version);
        const res = await (opts.fetch ?? fetch)(url);
        if (!res.ok) throw new Error(`StackPack ${sp.name}: downloading ${url} failed: HTTP ${res.status}`);
        const built = buildStackPack(new Uint8Array(await res.arrayBuffer()), sp.path);
        if (built.version !== sp.version) throw new Error(`StackPack ${sp.name}: ${url} holds version ${built.version}, not ${sp.version}`);
        if (built.sha256 !== sp.sha256) {
            throw new Error(`StackPack ${sp.name} ${sp.version}: the .sts built from ${url} has sha256 ${built.sha256}, not the catalog's ${sp.sha256}: has its source changed? (A new version: set version and sha256 together.)`);
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, built.sts);
        done.push(`${sp.name} ${sp.version}: built (${file}, sha256 ${built.sha256})`);
    }
    return done;
}

/** What's wrong with the lab's StackPacks built from source: not built, or not the pinned ones. */
export function stackPackProblems(lab: ResolvedLab): string[] {
    return lab.stackPacks.flatMap(sp => {
        if (!sp.file) return [];
        const what = `StackPack ${sp.name} ${sp.stackPack.version} (on ${sp.observer})`;
        if (!fs.existsSync(sp.file)) return [`${what} isn't built: run "lab stackpacks" (mise run stackpacks)`];
        const sha256 = sha256Of(fs.readFileSync(sp.file));
        return sha256 === sp.stackPack.sha256 ? [] : [`${what}: ${sp.file} has sha256 ${sha256}, not the catalog's ${sp.stackPack.sha256}: run "lab stackpacks --force"`];
    });
}
