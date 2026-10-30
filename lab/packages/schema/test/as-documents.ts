import { parse, stringify } from "yaml";
import { API_VERSION } from "../src";

// Most resolver tests write a lab (or personal config) compactly, the way the files looked before
// they became documents: top-level fields, and catalog overrides under `catalog:` by section.
// These turn that into the real format, so the tests stay about resolution, not syntax.

const KIND_OF_COMPONENT: Record<string, string> = { k3s: "KubernetesDistribution", rke2: "KubernetesDistribution", "gateway-api": "Manifest" };

function catalogDocuments(catalog: Record<string, any> = {}): object[] {
    const doc = (kind: string, name: string, spec: object, description?: string) =>
        ({ apiVersion: API_VERSION, kind, metadata: { name, ...(description ? { description } : {}) }, spec });
    const docs: object[] = [];
    for (const [name, c] of Object.entries<any>(catalog.components ?? {})) {
        const kind = c.manifest ? "Manifest" : c.chart || c.repo ? "HelmChart" : KIND_OF_COMPONENT[name] ?? "HelmChart";
        const { manifest, ...rest } = c;
        docs.push(doc(kind, name, manifest ? { ...rest, url: manifest } : rest));
    }
    for (const [name, s] of Object.entries<any>(catalog.secrets ?? {})) {
        const { namespace, labels, annotations, type, data, description, ...rest } = s;
        docs.push(doc("SecretTemplate", name, { ...rest, template: { ...(namespace ? { metadata: { namespace } } : {}), ...(type ? { type } : {}), ...(data ? { data } : {}) } }, description));
    }
    for (const [name, s] of Object.entries<any>(catalog.configmaps ?? {})) {
        const { namespace, data, ...rest } = s;
        docs.push(doc("ConfigMapTemplate", name, { ...rest, template: { ...(namespace ? { metadata: { namespace } } : {}), ...(data ? { data } : {}) } }));
    }
    for (const [name, selector] of Object.entries<any>(catalog.fleet?.groups ?? {})) docs.push(doc("ClusterGroup", name, { selector }));
    for (const [name, repo] of Object.entries<any>(catalog.fleet?.repos ?? {})) docs.push(doc("FleetRepo", name, repo));
    for (const [name, os] of Object.entries<any>(catalog.os ?? {})) {
        const { displayName, ...rest } = os;
        docs.push(doc("OperatingSystem", name, rest, displayName));
    }
    return docs;
}

const render = (main: object, catalog?: Record<string, any>) =>
    [main, ...catalogDocuments(catalog)].map(d => stringify(d)).join("---\n");

/** A lab's Harvesters, hosts and downstream clusters as their own documents. */
function labDocuments(harvesters: Record<string, any> = {}, hosts: Record<string, any> = {}, downstream: Record<string, any> = {}, awsSites: Record<string, any> = {}): object[] {
    const doc = (kind: string, name: string, spec: object) => ({ apiVersion: API_VERSION, kind, metadata: { name }, spec });
    return [
        ...Object.entries(harvesters).map(([name, spec]) => doc("Harvester", name, spec ?? {})),
        ...Object.entries(awsSites).map(([name, spec]) => doc("AwsSite", name, spec ?? {})),
        ...Object.entries(hosts).map(([name, { on, ...spec }]) => (on === "ssh" ? doc("Machine", name, spec) : doc("HarvesterVM", name, { harvester: on, ...spec }))),
        ...Object.entries(downstream).map(([name, spec]) => doc("DownstreamCluster", name, spec)),
    ];
}

/** A compact lab (`lab: name`, its fields, `catalog:` by section) as a lab file of documents. */
export function labDocument(yaml: string): string {
    const { lab, catalog, harvesters, awsSites, hosts, downstream, ...spec } = parse(yaml) ?? {};
    return [{ apiVersion: API_VERSION, kind: "Lab", metadata: { name: lab }, spec }, ...labDocuments(harvesters, hosts, downstream, awsSites), ...catalogDocuments(catalog)]
        .map(d => stringify(d)).join("---\n");
}

/**
 * A message's path as the resolver knows it (`hosts.vm.os`), for tests about resolution: in the
 * files that's `HarvesterVM/vm.spec.os`, and a lab's own fields are under `spec.`.
 */
export function resolverPath(path: string): string {
    return path
        .replace(/^HarvesterVM\/([^.]+)\.spec\.harvester(?=$|[.[])/, "hosts.$1.on")
        .replace(/^(HarvesterVM|Machine)\/([^.]+)(\.spec)?/, "hosts.$2")
        .replace(/^Harvester\/([^.]+)(\.spec)?/, "harvesters.$1")
        .replace(/^AwsSite\/([^.]+)(\.spec)?/, "awsSites.$1")
        .replace(/^DownstreamCluster\/([^.]+)(\.spec)?/, "downstream.$1")
        .replace(/^spec\./, "");
}

/** A compact personal config as a PersonalConfig document file. */
export function personalDocument(yaml: string): string {
    const { catalog, ...spec } = parse(yaml) ?? {};
    return render({ apiVersion: API_VERSION, kind: "PersonalConfig", metadata: { name: "test" }, spec }, catalog);
}
