import { parseAllDocuments } from "yaml";
import { z } from "zod";
import { AcmeServerInput, CatalogLayer, DefaultsInput } from "./catalog";
import { Diagnostics } from "./diagnostics";
import { ClusterSelector, FleetHelmOpInput, FleetRepoInput } from "./fleet";
import { ConfigMapInput, SecretInput } from "./objects";
import { awsZone, cidr, dnsLabel, duration, osName, quantity, TIMEOUTS } from "./primitives";
import { ProfileInput } from "./profiles";
import { AwsSiteInput, DownstreamInput, HarvesterInput, HarvesterVMSpec, MachineSpec, OsProfileInput, VersionValue } from "./schema";

// Catalog, lab and personal config files are Kubernetes-style documents (DESIGN.md §17):
// `apiVersion`, `kind`, `metadata`, `spec`. A file can hold several, separated by `---`.

export const API_VERSION = "lab.geeko.me/v1alpha1";

const Metadata = (name: z.ZodType<string>) => z.strictObject({
    name,
    /** One line for `lab catalog` / `lab profiles`. */
    description: z.string().optional(),
    labels: z.record(z.string(), z.string()).optional(),
});

const ObjectTemplate = (withType: boolean) => z.strictObject({
    metadata: z.strictObject({
        namespace: z.string().min(1).optional(),
        labels: z.record(z.string(), z.string()).optional(),
        annotations: z.record(z.string(), z.string()).optional(),
    }).optional(),
    ...(withType ? { type: z.string().min(1).optional() } : {}),
    data: z.record(z.string(), z.unknown()).optional(),
});
const ObjectTemplateSpec = (withType: boolean) => z.strictObject({
    inputs: z.record(dnsLabel, z.enum(["string", "credentials"])).optional(),
    requires: z.array(z.string().min(1)).optional(),
    template: ObjectTemplate(withType).optional(),
});

/** Each catalog kind: the `metadata.name` it allows and its `spec`. */
export const CATALOG_KINDS = {
    HelmChart: {
        name: dnsLabel,
        spec: z.strictObject({
            repo: z.string().min(1).optional(),
            chart: z.string().min(1).optional(),
            version: VersionValue.optional(),
            /** Where `charts:` on a host installs it unless the placement says otherwise. */
            namespace: z.string().min(1).optional(),
        }),
    },
    Manifest: {
        name: dnsLabel,
        spec: z.strictObject({ url: z.string().min(1).optional(), version: VersionValue.optional() }),
    },
    KubernetesDistribution: {
        name: dnsLabel,
        spec: z.strictObject({
            version: VersionValue.optional(),
            /** Install command, run as root; a template with `version`. */
            install: z.string().min(1).optional(),
            /** Where the engine writes `config` before installing. */
            configFile: z.string().min(1).optional(),
            config: z.record(z.string(), z.unknown()).optional(),
            /** Merged into `config` when another profile on the host provides the capability (`load-balancer`, `cloud-provider`). */
            withCapability: z.record(z.string().min(1), z.record(z.string(), z.unknown())).optional(),
            kubeconfig: z.string().min(1).optional(),
            /** kubectl on the host, with whatever it needs to find the kubeconfig. */
            kubectl: z.string().min(1).optional(),
            dataDir: z.string().min(1).optional(),
            /** Uninstall scripts, run on a metal cluster's existing machines; missing ones are skipped. */
            uninstall: z.array(z.string().min(1)).optional(),
            /** Downstream clusters' default CNI. */
            cni: z.string().min(1).optional(),
        }),
    },
    AcmeServer: {
        name: dnsLabel,
        spec: z.strictObject({
            /** The ACME directory. */
            url: z.url().optional(),
            /** PEM roots for a CA nothing trusts (Let's Encrypt staging): servers hand them to their clients. */
            ca: z.string().min(1).optional(),
        }),
    },
    /** The engine's defaults for what a lab leaves out; one, named `default`, overridable field by field. */
    Defaults: {
        name: z.literal("default", { error: 'must be "default": there is one Defaults document, which later layers override' }),
        spec: z.strictObject({
            ssh: z.strictObject({ user: z.string().min(1).optional() }).optional(),
            vm: z.strictObject({ cpu: z.int().min(1).optional(), memory: quantity.optional(), disk: quantity.optional() }).optional(),
            harvester: z.strictObject({
                clusterNetwork: z.string().min(1).optional(),
                storageClass: z.strictObject({
                    name: dnsLabel.optional(),
                    replicas: z.int().min(1).max(3).optional(),
                    /** Longhorn StorageClass parameters besides numberOfReplicas. */
                    parameters: z.record(z.string(), z.string()).optional(),
                }).optional(),
            }).optional(),
            aws: z.strictObject({
                vpcCidr: cidr.optional(),
                zones: z.array(awsZone).min(1).optional(),
                instanceType: z.string().min(1).optional(),
                eksVersion: z.string().regex(/^1\.\d+$/).optional(),
            }).optional(),
            timeouts: z.strictObject(Object.fromEntries(TIMEOUTS.map(t => [t, duration.optional()]))).optional(),
            images: z.strictObject({ kubectl: z.string().min(1).optional() }).optional(),
        }),
    },
    Profile: { name: dnsLabel, spec: ProfileInput },
    SecretTemplate: { name: dnsLabel, spec: ObjectTemplateSpec(true) },
    ConfigMapTemplate: { name: dnsLabel, spec: ObjectTemplateSpec(false) },
    FleetRepo: { name: dnsLabel, spec: FleetRepoInput },
    FleetHelmOp: { name: dnsLabel, spec: FleetHelmOpInput },
    ClusterGroup: { name: dnsLabel, spec: z.strictObject({ selector: ClusterSelector.optional() }) },
    UiPluginRepository: {
        name: dnsLabel,
        spec: z.strictObject({ gitRepo: z.url().optional(), branch: z.string().min(1).optional() }),
    },
    UiPlugin: {
        name: z.string().min(1),
        spec: z.strictObject({
            repository: dnsLabel.optional(),
            version: z.union([z.string().min(1), z.number()]).transform(String).optional(),
            /** Installed by a `rancher` profile that doesn't list `plugins`. */
            default: z.boolean().optional(),
        }),
    },
    OperatingSystem: { name: osName, spec: OsProfileInput.omit({ name: true, displayName: true }) },
} as const;
export type CatalogKind = keyof typeof CATALOG_KINDS;

/**
 * What a lab consists of (§17): its Harvesters and AWS sites, the hosts on them or elsewhere, and
 * the clusters Rancher creates. Only in a lab file and the files it includes.
 */
export const LAB_KINDS = {
    Harvester: { name: dnsLabel, spec: HarvesterInput },
    AwsSite: { name: dnsLabel, spec: AwsSiteInput },
    HarvesterVM: { name: dnsLabel, spec: HarvesterVMSpec },
    Machine: { name: dnsLabel, spec: MachineSpec },
    DownstreamCluster: { name: dnsLabel, spec: DownstreamInput },
} as const;
export type LabKind = keyof typeof LAB_KINDS;

export interface LabDocument {
    kind: LabKind;
    name: string;
    spec: Record<string, unknown>;
    source: string;
}

/** Kinds that are a file's main document, not catalog entries. */
export const FILE_KINDS = ["Lab", "PersonalConfig"] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export interface CatalogDocument {
    kind: CatalogKind;
    name: string;
    description?: string;
    spec: Record<string, unknown>;
    source: string;
}

/** `Kind/name`: how messages point at a document. */
export const docAt = (kind: string, name: string, field?: string) => `${kind}/${name}${field ? `.${field}` : ""}`;

const Header = z.object({
    apiVersion: z.string().optional(),
    kind: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).optional(),
    spec: z.unknown().optional(),
});

function yamlDocuments(text: string, source: string, diags: Diagnostics): unknown[] {
    const docs = parseAllDocuments(text);
    const result: unknown[] = [];
    for (const doc of Array.isArray(docs) ? docs : [docs]) {
        for (const err of doc.errors) {
            const line = err.linePos?.[0];
            const message = err.message.split("\n")[0].replace(/ at line \d+, column \d+:?$/, "");
            diags.error(source, "", `YAML syntax error${line ? ` at line ${line.line}, column ${line.col}` : ""}: ${message}`);
        }
        if (doc.errors.length === 0) {
            const value = doc.toJS();
            if (value !== null && value !== undefined) result.push(value);
        }
    }
    return result;
}

export interface ParsedFile {
    /** The file's main document, when it is a Lab or PersonalConfig. */
    main?: { kind: FileKind; name: string; description?: string; spec: unknown };
    documents: CatalogDocument[];
    labDocuments: LabDocument[];
}

/**
 * Parse a file of documents. `main` says which file kind the first document must be (a lab file
 * starts with `kind: Lab`); every other document is a catalog document.
 */
export function parseDocuments(text: string, source: string, diags: Diagnostics, main?: FileKind): ParsedFile {
    const result: ParsedFile = { documents: [], labDocuments: [] };
    yamlDocuments(text, source, diags).forEach((raw, i) => {
        const header = Header.safeParse(raw);
        const where = `document ${i + 1}`;
        if (!header.success) {
            diags.error(source, where, main && i === 0
                ? `must be a document with apiVersion: ${API_VERSION}, kind: ${main}, metadata and spec`
                : "must be a document with apiVersion, kind, metadata and spec");
            return;
        }
        const { apiVersion, kind, metadata, spec } = header.data;
        if (apiVersion !== undefined && apiVersion !== API_VERSION) diags.error(source, `${where}.apiVersion`, `must be ${API_VERSION}`);
        const extra = Object.keys(raw as object).filter(k => !["apiVersion", "kind", "metadata", "spec"].includes(k));
        for (const k of extra) diags.error(source, `${where}.${k}`, `unknown field "${k}"; a document has apiVersion, kind, metadata and spec`);

        if (main && i === 0) {
            if (kind !== main) {
                diags.error(source, `${where}.kind`, `the first document must be kind: ${main}`);
                return;
            }
            const meta = Metadata(main === "Lab" ? dnsLabel : z.string().min(1)).partial({ name: true }).safeParse(metadata ?? {});
            if (!meta.success) {
                diags.addZodError(source, meta.error, ["metadata"]);
                return;
            }
            result.main = { kind: main, name: meta.data.name ?? "", description: meta.data.description, spec: spec ?? {} };
            return;
        }
        if ((FILE_KINDS as readonly string[]).includes(kind)) {
            diags.error(source, `${where}.kind`, `${kind} can only be the first document of its own file`);
            return;
        }
        const labDef = LAB_KINDS[kind as LabKind];
        if (labDef) {
            const meta = Metadata(labDef.name as z.ZodType<string>).safeParse(metadata ?? {});
            if (!meta.success) {
                diags.addZodError(source, meta.error, [`${kind}/${String((metadata as { name?: unknown })?.name ?? `(document ${i + 1})`)}`, "metadata"]);
                return;
            }
            const parsedSpec = (labDef.spec as z.ZodType).safeParse(spec ?? {});
            if (!parsedSpec.success) {
                diags.addZodError(source, parsedSpec.error, [docAt(kind, meta.data.name), "spec"]);
                return;
            }
            result.labDocuments.push({ kind: kind as LabKind, name: meta.data.name, spec: parsedSpec.data as Record<string, unknown>, source });
            return;
        }
        const def = CATALOG_KINDS[kind as CatalogKind];
        if (!def) {
            diags.error(source, `${where}.kind`, `unknown kind "${kind}"; one of ${[...Object.keys(CATALOG_KINDS), ...Object.keys(LAB_KINDS)].join(", ")}`);
            return;
        }
        const meta = Metadata(def.name as z.ZodType<string>).safeParse(metadata ?? {});
        if (!meta.success) {
            diags.addZodError(source, meta.error, [`${kind}/${String((metadata as { name?: unknown })?.name ?? `(document ${i + 1})`)}`, "metadata"]);
            return;
        }
        const parsedSpec = (def.spec as z.ZodType).safeParse(spec ?? {});
        if (!parsedSpec.success) {
            diags.addZodError(source, parsedSpec.error, [docAt(kind, meta.data.name), "spec"]);
            return;
        }
        result.documents.push({ kind: kind as CatalogKind, name: meta.data.name, description: meta.data.description, spec: parsedSpec.data as Record<string, unknown>, source });
    });
    return result;
}

/**
 * Turn catalog documents into a catalog layer (the merged, per-section shape the resolver uses).
 * `builtin`: the engine's own catalog, where Profiles live and a name may be defined only once.
 */
export function documentsLayer(docs: CatalogDocument[], source: string, diags: Diagnostics, builtin: boolean): CatalogLayer {
    const layer: CatalogLayer = {
        source,
        components: {}, componentSources: {}, componentDescriptions: {}, profiles: {},
        secrets: {}, configmaps: {}, fleet: { groups: {}, repos: {}, helmOps: {} }, plugins: {}, pluginSources: {}, os: {}, acme: {},
    };
    const seen = new Map<string, string>();
    for (const d of docs) {
        const key = `${d.kind}/${d.name}`;
        // Charts, manifests and distributions share one namespace: profiles and the engine refer to them by name.
        const ns = ["HelmChart", "Manifest", "KubernetesDistribution"].includes(d.kind) ? `component/${d.name}` : key;
        const other = seen.get(ns);
        if (other !== undefined && (builtin || other !== d.kind)) {
            diags.error(d.source, docAt(d.kind, d.name), other === d.kind ? "is defined twice" : `has the same name as ${other}/${d.name}`);
            continue;
        }
        seen.set(ns, d.kind);
        const spec = d.spec as Record<string, any>;
        switch (d.kind) {
            case "HelmChart":
            case "Manifest":
            case "KubernetesDistribution": {
                const { url, ...rest } = spec;
                layer.components[d.name] = d.kind === "Manifest" ? { ...rest, ...(url !== undefined ? { manifest: url } : {}) } : rest;
                layer.componentSources![d.name] = d.source;
                if (d.description) layer.componentDescriptions![d.name] = d.description;
                layer.componentKinds = { ...layer.componentKinds, [d.name]: d.kind };
                break;
            }
            case "Profile":
                if (!builtin) {
                    diags.error(d.source, docAt(d.kind, d.name), "Profiles can only be defined in the engine's catalog (lab/catalog/): their builders are written against them");
                    break;
                }
                layer.profiles![d.name] = { profile: spec as ProfileInput, description: d.description ?? d.name, source: d.source };
                break;
            case "SecretTemplate":
            case "ConfigMapTemplate": {
                const { template, ...rest } = spec;
                const value = {
                    ...rest,
                    ...(d.description ? { description: d.description } : {}),
                    ...(template?.metadata?.namespace ? { namespace: template.metadata.namespace } : {}),
                    ...(template?.metadata?.labels ? { labels: template.metadata.labels } : {}),
                    ...(template?.metadata?.annotations ? { annotations: template.metadata.annotations } : {}),
                    ...(template?.type ? { type: template.type } : {}),
                    ...(template?.data ? { data: template.data } : {}),
                };
                const target = d.kind === "SecretTemplate" ? layer.secrets : layer.configmaps;
                target[d.name] = { value: value as SecretInput & ConfigMapInput, source: d.source };
                break;
            }
            case "FleetRepo":
                layer.fleet.repos[d.name] = { value: spec as FleetRepoInput, source: d.source };
                break;
            case "FleetHelmOp":
                layer.fleet.helmOps[d.name] = { value: spec as FleetHelmOpInput, source: d.source };
                break;
            case "ClusterGroup":
                if (spec.selector) layer.fleet.groups[d.name] = { value: spec.selector as ClusterSelector, source: d.source };
                break;
            case "UiPluginRepository":
                layer.plugins = { ...layer.plugins, repo: { ...layer.plugins.repo, name: d.name, ...spec } };
                layer.pluginSources![`repo`] = d.source;
                break;
            case "UiPlugin": {
                if (spec.version !== undefined) layer.plugins = { ...layer.plugins, versions: { ...layer.plugins.versions, [d.name]: spec.version } };
                if (spec.default !== undefined) layer.plugins = { ...layer.plugins, defaults: { ...layer.plugins.defaults, [d.name]: spec.default } };
                if (spec.repository !== undefined) layer.plugins = { ...layer.plugins, repositories: { ...layer.plugins.repositories, [d.name]: spec.repository } };
                layer.pluginSources![d.name] = d.source;
                break;
            }
            case "Defaults":
                layer.defaults = { value: spec as DefaultsInput, source: d.source };
                break;
            case "AcmeServer":
                layer.acme[d.name] = { value: { ...spec, ...(d.description ? { description: d.description } : {}) } as AcmeServerInput, source: d.source };
                break;
            case "OperatingSystem":
                layer.os[d.name] = {
                    profile: { ...(spec as OsProfileInput), ...(d.description ? { displayName: d.description } : {}) },
                    source: d.source,
                };
                break;
        }
    }
    return layer;
}
