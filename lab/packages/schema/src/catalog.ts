import { Diagnostics } from "./diagnostics";
import { docAt } from "./documents";
import { OsLayerEntry, ResolvedOs, resolveOsProfiles } from "./os";
import { ClusterSelector, FleetRepoInput } from "./fleet";
import { ConfigMapInput, SecretInput } from "./objects";
import { ProfileDefinition, ProfileInput, ProfileRegistry } from "./profiles";
import { checkSettingSchema, SettingSchema, settingZod } from "./settings-schema";
import { renderTemplates } from "./templates";
import { VersionValue } from "./schema";

/** How a Kubernetes distribution is installed and run (a KubernetesDistribution's `spec`, DESIGN.md §16.2). */
export interface DistributionSpec {
    /** Install command, run as root; a template with `version`. */
    install: string;
    configFile: string;
    config: Record<string, unknown>;
    /** Merged into `config` when another profile on the host provides the capability. */
    withCapability: Record<string, Record<string, unknown>>;
    kubeconfig: string;
    kubectl: string;
    dataDir: string;
    uninstall: string[];
    cni: string;
}

/** A component as the catalog layers carry it: the merged `spec` of a HelmChart, Manifest or KubernetesDistribution. */
export interface ComponentInput extends Partial<DistributionSpec> {
    version?: VersionValue;
    repo?: string;
    chart?: string;
    manifest?: string;
    namespace?: string;
}

/** An ACME server certificates come from (an AcmeServer's `spec`). */
export interface AcmeServerInput {
    url?: string;
    ca?: string;
    description?: string;
}

export interface ResolvedAcmeServer {
    name: string;
    url: string;
    /** PEM roots when nothing trusts the CA by default. */
    ca?: string;
    description?: string;
}

/** The UI plugin documents of one layer. */
export interface PluginsInput {
    repo?: { name?: string; gitRepo?: string; branch?: string };
    versions?: Record<string, string>;
    defaults?: Record<string, boolean>;
    repositories?: Record<string, string>;
}

/**
 * One layer of the catalog (DESIGN.md §16, §17): the built-in documents, the personal config's, or
 * the lab file's, in the per-section shape the resolver merges.
 */
export interface CatalogLayer {
    /** The layer's directory or file, for entries without a file of their own. */
    source: string;
    components: Record<string, ComponentInput>;
    componentSources?: Record<string, string>;
    componentDescriptions?: Record<string, string>;
    componentKinds?: Record<string, "HelmChart" | "Manifest" | "KubernetesDistribution">;
    /** Host profiles, only in the built-in catalog: their rules are what the engine's builders expect. */
    profiles?: Record<string, { profile: ProfileInput; description: string; source: string }>;
    /** Secret and configmap templates built from inputs (§16.6), each with the file it came from. */
    secrets: Record<string, Sourced<SecretInput>>;
    configmaps: Record<string, Sourced<ConfigMapInput>>;
    /** Fleet groups and repos, each with the file it came from. */
    fleet: FleetLayer;
    plugins: PluginsInput;
    /** Where each plugin document (and `repo`) came from. */
    pluginSources?: Record<string, string>;
    /** OS profiles, each with the file it came from. */
    os: Record<string, OsLayerEntry>;
    /** ACME servers, each with the file it came from. */
    acme: Record<string, Sourced<AcmeServerInput>>;
}

export interface FleetLayer {
    groups: Record<string, Sourced<ClusterSelector>>;
    repos: Record<string, Sourced<FleetRepoInput>>;
}

/** A value and the layer that set it, for `lab catalog` and error messages. */
export interface Sourced<T> {
    value: T;
    source: string;
}

/**
 * Something the lab installs, at a version: a Helm chart (`repo` unless it's an `oci://` chart),
 * a manifest URL template, or a Kubernetes distribution the engine installs itself.
 */
export type ResolvedComponent =
    | { kind: "HelmChart"; chart: string; repo?: string; version: VersionValue; namespace?: string; description?: string }
    | { kind: "Manifest"; manifest: string; version: VersionValue; description?: string }
    | ({ kind: "KubernetesDistribution"; version: VersionValue; description?: string } & DistributionSpec);

export type ResolvedDistribution = Extract<ResolvedComponent, { kind: "KubernetesDistribution" }>;

export interface ResolvedPlugins {
    repo: { name: string; gitRepo: string; branch: string };
    /** Plugin name -> version. */
    versions: Record<string, string>;
    default: string[];
}

export interface ResolvedCatalog {
    components: Record<string, Sourced<ResolvedComponent>>;
    profiles: ProfileRegistry;
    secrets: Record<string, Sourced<SecretInput>>;
    configmaps: Record<string, Sourced<ConfigMapInput>>;
    fleet: FleetLayer;
    plugins: Sourced<ResolvedPlugins>;
    os: Record<string, Sourced<ResolvedOs>>;
    acme: Record<string, Sourced<ResolvedAcmeServer>>;
}

/**
 * Merge the layers, later ones winning. A document overriding one of the same kind and name merges
 * its `spec` field by field (a lab can change just a `version` or a `branch`; a per-Harvester
 * version map is replaced whole); OS profiles also resolve `extends` (§6).
 */
export function resolveCatalog(layers: CatalogLayer[], diags: Diagnostics): ResolvedCatalog {
    const inputs: Record<string, Sourced<ComponentInput>> = {};
    const kinds: Record<string, "HelmChart" | "Manifest" | "KubernetesDistribution"> = {};
    const descriptions: Record<string, string> = {};
    const osSource: Record<string, string> = {};
    const fleet: FleetLayer = { groups: {}, repos: {} };
    const secrets: Record<string, Sourced<SecretInput>> = {};
    const configmaps: Record<string, Sourced<ConfigMapInput>> = {};
    const plugins: Required<PluginsInput> = { repo: {}, versions: {}, defaults: {}, repositories: {} };
    const pluginSources: Record<string, string> = {};
    const acmeInputs: Record<string, Sourced<AcmeServerInput>> = {};
    for (const layer of layers) {
        for (const [name, entry] of Object.entries(layer.acme)) {
            acmeInputs[name] = { value: { ...acmeInputs[name]?.value, ...entry.value }, source: entry.source };
        }
        const p = layer.plugins;
        if (p.repo) {
            if (plugins.repo.name && p.repo.name && p.repo.name !== plugins.repo.name) {
                diags.error(layer.pluginSources?.repo ?? layer.source, docAt("UiPluginRepository", p.repo.name), `only one UiPluginRepository is supported (there is ${plugins.repo.name})`);
            } else plugins.repo = { ...plugins.repo, ...p.repo };
        }
        Object.assign(plugins.versions, p.versions);
        Object.assign(plugins.defaults, p.defaults);
        Object.assign(plugins.repositories, p.repositories);
        Object.assign(pluginSources, layer.pluginSources);
        // Repos, secrets and configmaps merge field by field; a group's selector is replaced whole.
        for (const [name, entry] of Object.entries(layer.fleet.groups)) fleet.groups[name] = entry;
        for (const [name, entry] of Object.entries(layer.secrets)) {
            secrets[name] = { value: { ...secrets[name]?.value, ...entry.value }, source: entry.source };
        }
        for (const [name, entry] of Object.entries(layer.configmaps)) {
            configmaps[name] = { value: { ...configmaps[name]?.value, ...entry.value }, source: entry.source };
        }
        for (const [name, entry] of Object.entries(layer.fleet.repos)) {
            fleet.repos[name] = { value: { ...fleet.repos[name]?.value, ...entry.value }, source: entry.source };
        }
        for (const [key, value] of Object.entries(layer.components)) {
            const kind = layer.componentKinds?.[key];
            if (kind && kinds[key] && kinds[key] !== kind) {
                diags.error(layer.componentSources?.[key] ?? layer.source, docAt(kind, key), `overrides ${kinds[key]}/${key}; an override must have the same kind`);
                continue;
            }
            if (kind) kinds[key] = kind;
            if (layer.componentDescriptions?.[key]) descriptions[key] = layer.componentDescriptions[key];
            inputs[key] = { value: { ...inputs[key]?.value, ...value }, source: layer.componentSources?.[key] ?? layer.source };
        }
        for (const [name, entry] of Object.entries(layer.os)) osSource[name] = entry.source;
    }

    const components: Record<string, Sourced<ResolvedComponent>> = {};
    for (const [key, { value, source }] of Object.entries(inputs)) {
        const kind = kinds[key] ?? "HelmChart";
        const at = (field?: string) => docAt(kind, key, field);
        const { version, manifest, chart, repo, namespace } = value;
        const description = descriptions[key] ? { description: descriptions[key] } : {};
        if (version === undefined) {
            diags.error(source, at("spec.version"), "required");
        } else if (kind === "Manifest") {
            if (manifest === undefined) diags.error(source, at("spec.url"), "required");
            else components[key] = { value: { kind, manifest, version, ...description }, source };
        } else if (kind === "KubernetesDistribution") {
            const d = value;
            const missing = (["install", "configFile", "kubeconfig", "kubectl", "dataDir", "cni"] as const).filter(f => d[f] === undefined);
            for (const f of missing) diags.error(source, at(`spec.${f}`), "required");
            if (d.install !== undefined) renderTemplates(d.install, { version: "v0.0.0" }, "", (_p, message) => diags.error(source, at("spec.install"), message));
            if (missing.length === 0) {
                components[key] = {
                    value: {
                        kind, version, ...description,
                        install: d.install!, configFile: d.configFile!, kubeconfig: d.kubeconfig!, kubectl: d.kubectl!, dataDir: d.dataDir!, cni: d.cni!,
                        config: d.config ?? {},
                        withCapability: d.withCapability ?? {},
                        uninstall: d.uninstall ?? [],
                    },
                    source,
                };
            }
        } else if (chart === undefined) {
            diags.error(source, at("spec.chart"), "required");
        } else if (repo === undefined && !chart.startsWith("oci://")) {
            diags.error(source, at("spec.repo"), `chart "${chart}" needs a repo, or must be an oci:// reference`);
        } else {
            components[key] = {
                value: { kind, chart, version, ...(repo !== undefined ? { repo } : {}), ...(namespace !== undefined ? { namespace } : {}), ...description },
                source,
            };
        }
    }

    // Host profiles: the built-in Profile documents, with their settings compiled.
    const profiles: ProfileRegistry = {};
    for (const layer of layers) {
        for (const [name, { profile, description, source }] of Object.entries(layer.profiles ?? {})) {
            const { settings, distribution, ...rules } = profile;
            const schema: SettingSchema = settings ?? { type: "object", properties: {} };
            const problems: { at: string; message: string }[] = [];
            checkSettingSchema(schema, "spec.settings", problems);
            for (const r of schema.required ?? []) if (!schema.properties?.[r]) problems.push({ at: "spec.settings.required", message: `"${r}" isn't one of the settings` });
            (rules.charts ?? []).forEach((e, i) => {
                const at = `spec.charts[${i}]`;
                if ((e.chart === undefined) === (e.manifest === undefined)) problems.push({ at, message: "needs exactly one of chart and manifest" });
                else if (e.chart !== undefined) {
                    if (components[e.chart]?.value.kind !== "HelmChart") problems.push({ at: `${at}.chart`, message: `no HelmChart "${e.chart}"` });
                    if (!e.namespace) problems.push({ at: `${at}.namespace`, message: "required for a chart" });
                    if (e.vars) problems.push({ at: `${at}.vars`, message: "only for a manifest" });
                } else {
                    if (components[e.manifest!]?.value.kind !== "Manifest") problems.push({ at: `${at}.manifest`, message: `no Manifest "${e.manifest}"` });
                    for (const f of ["namespace", "values", "lockedValues"] as const) if (e[f] !== undefined) problems.push({ at: `${at}.${f}`, message: "only for a chart" });
                }
            });
            if (distribution !== undefined && components[distribution]?.value.kind !== "KubernetesDistribution") problems.push({ at: "spec.distribution", message: `no KubernetesDistribution "${distribution}"` });
            for (const p of problems) diags.error(source, docAt("Profile", name, p.at), p.message);
            if (problems.length > 0) continue;
            const capabilities = [name, ...(rules.provides ?? []), ...(rules.fallback ?? [])];
            for (const cap of Object.keys(rules.outputs ?? {}).filter(c => !capabilities.includes(c))) {
                diags.error(source, docAt("Profile", name, `spec.outputs.${cap}`), `isn't a capability of this profile; it provides ${capabilities.join(", ")}`);
            }
            // The first chart is the profile's own: the lab's `values` go to it.
            const main = (rules.charts ?? []).find(e => e.chart !== undefined);
            profiles[name] = {
                ...rules, name, description, source,
                protectedValues: valuePaths(main?.lockedValues ?? {}),
                settingsSchema: schema,
                settings: settingZod(schema),
                ...(main ? { chart: main.chart } : {}),
                ...(distribution !== undefined ? { distribution } : {}),
            } satisfies ProfileDefinition;
        }
    }
    // A capability named after a profile must be that profile's own.
    for (const def of Object.values(profiles)) {
        for (const cap of def.provides ?? []) {
            if (profiles[cap] && cap !== def.name) diags.error(def.source, docAt("Profile", def.name, "spec.provides"), `"${cap}" is the name of another profile`);
        }
    }

    const { name, gitRepo, branch } = plugins.repo;
    const repoSource = pluginSources.repo ?? layers[0]?.source ?? "catalog";
    if (!name || !gitRepo) diags.error(repoSource, docAt("UiPluginRepository", name ?? "?"), "a UiPluginRepository with a gitRepo is needed for the UI plugins");
    for (const [plugin, repoName] of Object.entries(plugins.repositories)) {
        if (repoName !== name) diags.error(pluginSources[plugin] ?? repoSource, docAt("UiPlugin", plugin, "spec.repository"), `no UiPluginRepository "${repoName}"`);
    }
    for (const plugin of Object.keys(plugins.defaults)) {
        if (!plugins.versions[plugin]) diags.error(pluginSources[plugin] ?? repoSource, docAt("UiPlugin", plugin, "spec.version"), "required");
    }

    const acme: Record<string, Sourced<ResolvedAcmeServer>> = {};
    for (const [name, { value, source }] of Object.entries(acmeInputs)) {
        if (!value.url) {
            diags.error(source, docAt("AcmeServer", name, "spec.url"), "required");
            continue;
        }
        acme[name] = { value: { name, url: value.url, ...(value.ca ? { ca: value.ca } : {}), ...(value.description ? { description: value.description } : {}) }, source };
    }

    const os = resolveOsProfiles(layers.map(l => l.os), diags);
    return {
        acme,
        components,
        profiles,
        plugins: {
            value: {
                repo: { name: name ?? "", gitRepo: gitRepo ?? "", branch: branch ?? "main" },
                versions: plugins.versions,
                default: Object.keys(plugins.defaults).filter(p => plugins.defaults[p]).sort(),
            },
            source: repoSource,
        },
        secrets,
        configmaps,
        fleet,
        os: Object.fromEntries(Object.entries(os).map(([n, value]) => [n, { value, source: osSource[n] }])),
    };
}

/** Dot paths of the leaves of a values map: scalars, lists and empty maps. */
export function valuePaths(value: Record<string, unknown>, prefix = ""): string[] {
    return Object.entries(value).flatMap(([key, v]) => {
        const at = prefix ? `${prefix}.${key}` : key;
        const nested = typeof v === "object" && v !== null && !Array.isArray(v) && !("$secret" in v) && Object.keys(v).length > 0;
        return nested ? valuePaths(v as Record<string, unknown>, at) : [at];
    });
}

/** Strip the sources: what the program gets. */
export function catalogValues<T>(entries: Record<string, Sourced<T>>): Record<string, T> {
    return Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, v.value]));
}
