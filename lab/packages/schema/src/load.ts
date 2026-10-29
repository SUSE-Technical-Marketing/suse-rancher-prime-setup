import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CatalogLayer, ResolvedCatalog, resolveCatalog } from "./catalog";
import { Diagnostics } from "./diagnostics";
import { CatalogDocument, docAt, documentsLayer, FileKind, LabDocument, LabKind, parseDocuments } from "./documents";
import { resolveLab, ResolveResult } from "./resolve";
import { LabFile, LabSpec, PersonalConfig } from "./schema";

/** Default location of the personal config; `LAB_CONFIG` overrides it. */
export function defaultPersonalConfigPath(env = process.env): string {
    return env.LAB_CONFIG ?? path.join(os.homedir(), ".config", "lab", "config.yaml");
}

/** The built-in catalog shipped in `lab/catalog/` (DESIGN.md §16, §17). */
export const BUILTIN_CATALOG_DIR = path.resolve(__dirname, "..", "..", "..", "catalog");

/** Every `*.yaml` under a file or directory, in a stable order. */
function yamlFiles(target: string): string[] {
    if (!fs.existsSync(target)) return [];
    if (fs.statSync(target).isFile()) return [target];
    return fs.readdirSync(target, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))
        .flatMap(e => (e.isDirectory() ? yamlFiles(path.join(target, e.name)) : e.name.endsWith(".yaml") ? [path.join(target, e.name)] : []));
}

/** The documents in files or directories (none of them may be a lab file or personal config). */
function readDocuments(targets: string[], diags: Diagnostics, from?: { source: string; at: string }): { documents: CatalogDocument[]; labDocuments: LabDocument[] } {
    const documents: CatalogDocument[] = [];
    const labDocuments: LabDocument[] = [];
    targets.forEach((target, i) => {
        if (!fs.existsSync(target)) {
            if (from) diags.error(from.source, `${from.at}[${i}]`, `no such file or directory: ${target}`);
            return;
        }
        for (const file of yamlFiles(target)) {
            const parsed = parseDocuments(fs.readFileSync(file, "utf8"), file, diags);
            documents.push(...parsed.documents);
            labDocuments.push(...parsed.labDocuments);
        }
    });
    return { documents, labDocuments };
}

/** Lab documents somewhere other than a lab file and its includes. */
function rejectLabDocuments(docs: LabDocument[], where: string, diags: Diagnostics): void {
    for (const d of docs) diags.error(d.source, docAt(d.kind, d.name), `${d.kind} documents belong in a lab file (or a file it includes), not in ${where}`);
}

/** The built-in catalog: every document under `lab/catalog/`. */
export function loadBuiltinCatalog(dir: string, diags: Diagnostics): CatalogLayer {
    const { documents, labDocuments } = readDocuments([dir], diags);
    rejectLabDocuments(labDocuments, "the engine's catalog", diags);
    return documentsLayer(documents, dir, diags, true);
}

export interface ConfigFile<T> {
    value: T;
    /** Its `include` documents, then the documents after the first one in the file. */
    layers: CatalogLayer[];
    /** The lab documents among them (a lab file's Harvesters, hosts and clusters). */
    labDocuments: LabDocument[];
}

/**
 * A lab file or the personal config: its first document is the `Lab` / `PersonalConfig`, checked
 * with `toValue`; any further documents, and those in `spec.include`, are catalog documents layered
 * on top of the built-in ones, or (for a lab) the lab's own Harvesters, hosts and clusters.
 */
function loadConfigFile<T>(
    source: string, text: string, kind: FileKind, diags: Diagnostics,
    toValue: (main: { name: string; spec: unknown }) => { ok: true; value: T; include: string[] } | { ok: false },
): ConfigFile<T> | undefined {
    const parsed = parseDocuments(text, source, diags, kind);
    if (!parsed.main) {
        if (diags.ok) diags.error(source, "", `must start with a document of kind: ${kind}`);
        return undefined;
    }
    const value = toValue(parsed.main);
    if (!value.ok) return undefined;
    const dir = path.dirname(path.resolve(source));
    const included = readDocuments(value.include.map(p => path.resolve(dir, p.replace(/^~(?=$|\/)/, os.homedir()))), diags, { source, at: "spec.include" });
    return {
        value: value.value,
        layers: [documentsLayer(included.documents, source, diags, false), documentsLayer(parsed.documents, source, diags, false)],
        labDocuments: [...included.labDocuments, ...parsed.labDocuments],
    };
}

/** The personal config (a missing file is an empty one), with its catalog documents. */
export function loadPersonal(source: string, diags: Diagnostics): ConfigFile<PersonalConfig> | undefined {
    if (!fs.existsSync(source)) return { value: PersonalConfig.parse({}), layers: [], labDocuments: [] };
    const file = loadConfigFile<PersonalConfig>(source, fs.readFileSync(source, "utf8"), "PersonalConfig", diags, ({ spec }) => {
        const parsed = PersonalConfig.safeParse(spec ?? {});
        if (!parsed.success) {
            diags.addZodError(source, parsed.error, ["spec"]);
            return { ok: false };
        }
        return { ok: true, value: parsed.data, include: parsed.data.include };
    });
    if (file) rejectLabDocuments(file.labDocuments, "the personal config", diags);
    return file;
}

/** Where each of a lab's Harvesters, hosts and clusters is defined, for messages. */
type LabIndex = Map<string, { kind: LabKind; name: string; source: string }>;

function loadLabFile(source: string, text: string, diags: Diagnostics): (ConfigFile<LabFile> & { index: LabIndex }) | undefined {
    const file = loadConfigFile<LabSpec>(source, text, "Lab", diags, ({ name, spec }) => {
        if (!name) {
            diags.error(source, "metadata.name", "required: the lab's name");
            return { ok: false };
        }
        const parsed = LabSpec.safeParse(spec ?? {});
        if (!parsed.success) {
            diags.addZodError(source, parsed.error, ["spec"]);
            return { ok: false };
        }
        return { ok: true, value: { ...parsed.data, lab: name } as LabSpec & { lab: string }, include: parsed.data.include };
    });
    if (!file) return undefined;
    // The lab's own documents, by the section of the lab they fill. Hosts of both kinds share names.
    const lab = { ...(file.value as LabSpec & { lab: string }), harvesters: {}, hosts: {}, downstream: {} } as LabFile;
    const index: LabIndex = new Map();
    for (const d of file.labDocuments) {
        const section = d.kind === "Harvester" ? "harvesters" : d.kind === "DownstreamCluster" ? "downstream" : "hosts";
        const key = `${section}.${d.name}`;
        const other = index.get(key);
        if (other) {
            diags.error(d.source, docAt(d.kind, d.name), other.kind === d.kind ? `is defined twice (also in ${other.source})` : `has the same name as ${other.kind}/${d.name} (in ${other.source})`);
            continue;
        }
        index.set(key, { kind: d.kind, name: d.name, source: d.source });
        if (d.kind === "HarvesterVM") {
            const { harvester, ...rest } = d.spec;
            lab.hosts[d.name] = { ...rest, on: harvester } as LabFile["hosts"][string];
        } else if (d.kind === "Machine") {
            lab.hosts[d.name] = { ...d.spec, on: "ssh" } as LabFile["hosts"][string];
        } else {
            (lab[section] as Record<string, unknown>)[d.name] = d.spec;
        }
    }
    return { ...file, value: lab, index };
}

/**
 * The resolver reports a lab's fields by their place in the lab (`hosts.vm.os`). In the files a
 * host is its own document (`HarvesterVM/vm.spec.os`, perhaps in an included file), and the lab's
 * own fields are under `spec:`.
 */
function mapLabPaths(diags: Diagnostics, labSource: string, index: LabIndex): void {
    for (const d of diags.items) {
        if (d.source !== labSource || !d.path) continue;
        const m = /^(harvesters|hosts|downstream)\.([^.[]+)(.*)$/.exec(d.path);
        const doc = m && index.get(`${m[1]}.${m[2]}`);
        if (!doc) continue;
        let rest = m![3];
        if (doc.kind === "HarvesterVM") rest = rest.replace(/^\.on(?=$|[.[])/, ".harvester");
        d.source = doc.source;
        d.path = `${doc.kind}/${doc.name}${rest ? `.spec${rest}` : ""}`;
    }
}

/**
 * The resolver reports a lab file's or personal config's own fields by their place in the spec
 * (`tls.email`); in the file they're under `spec:`.
 */
function prefixSpecPaths(diags: Diagnostics, sources: string[]): void {
    for (const d of diags.items) {
        if (!sources.includes(d.source) || !d.path) continue;
        if (/^(spec|metadata|apiVersion|kind)(\.|$)|^document \d|\//.test(d.path)) continue;
        d.path = `spec.${d.path}`;
    }
}

export interface LoadOptions {
    labFile: string;
    /** Personal config path; a missing file is fine and means "empty". */
    personalConfig?: string;
    catalogDir?: string;
    env?: NodeJS.ProcessEnv;
}

export interface CatalogResult {
    diagnostics: Diagnostics;
    catalog?: ResolvedCatalog;
}

/** The effective catalog: built-in, the personal config's documents and, when given, a lab file's. */
export function loadCatalog(opts: Omit<LoadOptions, "labFile"> & { labFile?: string }): CatalogResult {
    const diags = new Diagnostics();
    const personalSource = opts.personalConfig ?? defaultPersonalConfigPath(opts.env);
    const layers = [loadBuiltinCatalog(opts.catalogDir ?? BUILTIN_CATALOG_DIR, diags)];
    const personal = loadPersonal(personalSource, diags);
    if (personal) layers.push(...personal.layers);
    if (opts.labFile) {
        const lab = loadLabFile(opts.labFile, fs.readFileSync(opts.labFile, "utf8"), diags);
        if (lab) layers.push(...lab.layers);
    }
    if (!diags.ok) return { diagnostics: diags };
    const catalog = resolveCatalog(layers, diags);
    prefixSpecPaths(diags, [personalSource, ...(opts.labFile ? [opts.labFile] : [])]);
    return { diagnostics: diags, catalog };
}

export interface LoadResult extends ResolveResult {
    labFile?: LabFile;
    personal?: PersonalConfig;
    personalSource: string;
}

/** Read the lab file, the personal config and the catalog, and resolve them into a lab. */
export function loadLab(opts: LoadOptions): LoadResult {
    const diags = new Diagnostics();
    const labSource = opts.labFile;
    const personalSource = opts.personalConfig ?? defaultPersonalConfigPath(opts.env);

    let labText: string | undefined;
    try {
        labText = fs.readFileSync(labSource, "utf8");
    } catch (e) {
        diags.error(labSource, "", `can't read lab file: ${(e as Error).message}`);
    }
    const lab = labText === undefined ? undefined : loadLabFile(labSource, labText, diags);
    const personal = loadPersonal(personalSource, diags);
    const builtin = loadBuiltinCatalog(opts.catalogDir ?? BUILTIN_CATALOG_DIR, diags);

    if (!lab || !personal || !diags.ok) {
        if (lab) mapLabPaths(diags, labSource, lab.index);
        prefixSpecPaths(diags, [labSource, personalSource]);
        return { diagnostics: diags, labFile: lab?.value, personal: personal?.value, personalSource };
    }

    const result = resolveLab({
        lab: lab.value,
        labSource,
        personal: personal.value,
        personalSource,
        catalogLayers: [builtin, ...personal.layers, ...lab.layers],
        labDir: path.dirname(path.resolve(labSource)),
        personalDir: path.dirname(path.resolve(personalSource)),
        home: os.homedir(),
        fs: { exists: p => fs.existsSync(p), read: p => fs.readFileSync(p, "utf8") },
    }, diags);
    mapLabPaths(diags, labSource, lab.index);
    prefixSpecPaths(diags, [labSource, personalSource]);
    return { ...result, labFile: lab.value, personal: personal.value, personalSource };
}
