import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { stringify } from "yaml";

/** A template leaf: a literal, or a template the program renders with the lab's secrets. */
export type ObjectLeaf = string | { $template: string };

/** A Secret or ConfigMap from the catalog (DESIGN.md §16.6), with its inputs resolved to leaves. */
export interface ClusterObject {
    kind: "Secret" | "ConfigMap";
    name: string;
    namespace: string;
    type?: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
    /** Key -> a leaf, or a map/list of leaves that is stored as a YAML document. */
    data: Record<string, unknown>;
}

export interface ClusterObjectsArgs {
    objects: ClusterObject[];
    /** The value of a leaf: literals as they are, secret refs from the lab's secrets. */
    value(leaf: ObjectLeaf): pulumi.Input<string>;
}

const isLeafRef = (v: unknown): v is { $template: string } => typeof v === "object" && v !== null && "$template" in v;

/** Namespaces every cluster has; the others are created (or adopted) first. */
const BUILT_IN_NAMESPACES = new Set(["default", "kube-system", "kube-public"]);

/**
 * Catalog Secrets and ConfigMaps on one cluster, and the namespaces they go in. Values are filled
 * in from the lab's secrets; map and list values are rendered as YAML documents (values files).
 */
export class ClusterObjects extends pulumi.ComponentResource {
    /** By `<namespace>/<name>`, for resources that have to wait for one. */
    readonly secrets: Record<string, k8s.core.v1.Secret> = {};
    readonly resources: pulumi.Resource[] = [];

    constructor(name: string, args: ClusterObjectsArgs, opts: pulumi.ComponentResourceOptions & { provider: pulumi.ProviderResource }) {
        super("lab:kubernetes:ClusterObjects", name, {}, opts);
        const o: pulumi.CustomResourceOptions = { parent: this, provider: opts.provider, deletedWith: opts.deletedWith };

        // A template with its secret refs filled in, as an output of plain data.
        const fill = (template: unknown): pulumi.Output<unknown> => {
            if (isLeafRef(template) || typeof template === "string") return pulumi.output(args.value(template as ObjectLeaf));
            if (Array.isArray(template)) return pulumi.all(template.map(fill));
            if (typeof template === "object" && template !== null) {
                return pulumi.all(Object.fromEntries(Object.entries(template).map(([k, v]) => [k, fill(v)])));
            }
            return pulumi.output(template);
        };
        const isDocument = (t: unknown) => typeof t === "object" && t !== null && !isLeafRef(t);

        const namespaces: Record<string, pulumi.Resource> = {};
        for (const ns of new Set(args.objects.map(x => x.namespace).filter(ns => !BUILT_IN_NAMESPACES.has(ns)))) {
            // A patch (server-side apply) creates the namespace, or shares one that is already there
            // (Rancher's fleet-default, a chart's); it stays when the objects go.
            namespaces[ns] = new k8s.core.v1.NamespacePatch(`${name}/namespace/${ns}`, { metadata: { name: ns } }, { ...o, retainOnDelete: true });
        }

        for (const x of args.objects) {
            const data = pulumi.all(Object.entries(x.data).map(([key, t]) => fill(t).apply(v => [key, isDocument(t) ? stringify(v) : String(v)] as const)))
                .apply(entries => Object.fromEntries(entries));
            // Empty maps are dropped by the API server and would show as a change on every run.
            const metadata = {
                name: x.name,
                namespace: x.namespace,
                ...(Object.keys(x.labels).length > 0 ? { labels: x.labels } : {}),
                ...(Object.keys(x.annotations).length > 0 ? { annotations: x.annotations } : {}),
            };
            const ro = { ...o, dependsOn: namespaces[x.namespace] ? [namespaces[x.namespace]] : [] };
            if (x.kind === "Secret") {
                const secret = new k8s.core.v1.Secret(`${name}/secret/${x.namespace}/${x.name}`, { metadata, type: x.type, stringData: pulumi.secret(data) }, ro);
                this.secrets[`${x.namespace}/${x.name}`] = secret;
                this.resources.push(secret);
            } else {
                this.resources.push(new k8s.core.v1.ConfigMap(`${name}/configmap/${x.namespace}/${x.name}`, { metadata, data }, ro));
            }
        }
        this.registerOutputs({});
    }
}
