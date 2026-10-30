import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { rancherLogin, rancherRequest } from "@lab/kube";
import type { Timeouts } from "@lab/schema";
import { toGiB } from "./node-driver-cluster";
import { RancherAccess } from "./server";

/** An EKS managed node group. */
export interface EksNodeGroup {
    name: string;
    quantity: number;
    min: number;
    max: number;
    instanceType: string;
    disk: string;
    /** The subnets its nodes go in, one per zone. */
    subnetIds: pulumi.Input<string>[];
    labels?: Record<string, string>;
}

export interface EksClusterArgs {
    rancher: RancherAccess;
    region: string;
    /** EKS Kubernetes minor, `1.34`. */
    kubernetesVersion: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
    /** `cattle-global-data:cc-xxxxx` of the site's Amazon cloud credential. */
    cloudCredential: pulumi.Input<string>;
    /** The control plane's subnets: two zones at least. */
    subnetIds: pulumi.Input<string>[];
    /** On the EKS cluster and every node group's resources, so leftovers can be found by them. */
    tags: Record<string, string>;
    publicAccessSources?: string[];
    logging?: string[];
    nodeGroups: EksNodeGroup[];
    /** What has to exist first and outlive the cluster: its network, the credential. */
    after?: pulumi.Resource[];
    timeouts: Pick<Timeouts, "downstreamReady" | "downstreamDelete">;
}

interface Inputs {
    url: string;
    insecure: boolean;
    username: string;
    password: string;
    /** Its name in Rancher, which is the EKS cluster's name too. */
    name: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
    /** The management cluster's `eksConfig`. */
    eksConfig: Record<string, any>;
    /** Seconds to wait for it to be active, and to be gone. */
    readySeconds: number;
    deleteSeconds: number;
}

type Outputs = Inputs & {
    /** Management cluster id, `c-xxxxx`. */
    clusterId: string;
    kubeconfig: string;
};

/** What the eks-operator can't change on a cluster: changing them makes another. */
const NO_UPDATE = ["region", "subnets", "securityGroups", "serviceRole", "secretsEncryption", "kmsKey", "ipFamily"];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Requests to Rancher that log in again when the session runs out: creating a cluster outlasts it. */
function session(i: Inputs) {
    const endpoint = { url: i.url, insecure: i.insecure };
    let token: string | undefined;
    const login = async () => {
        token = await rancherLogin(endpoint, i.username, i.password);
        if (!token) throw new Error(`logging in to Rancher at ${i.url} as ${i.username} failed`);
    };
    return async (method: string, path: string, body?: unknown) => {
        if (!token) await login();
        let res = await rancherRequest(endpoint, method, path, body, token);
        if (res.status === 401) {
            await login();
            res = await rancherRequest(endpoint, method, path, body, token);
        }
        return res;
    };
}
type Request = ReturnType<typeof session>;

/** Waits until Rancher reports the cluster active: EKS takes a quarter of an hour or so. */
async function waitActive(request: Request, id: string, i: Inputs) {
    const deadline = Date.now() + i.readySeconds * 1000;
    let last = "";
    for (;;) {
        const res = await request("GET", `/v3/clusters/${id}`);
        if (res.status === 200) {
            if (res.body.state === "active") return;
            last = `${res.body.state}${res.body.transitioningMessage ? `: ${res.body.transitioningMessage}` : ""}`;
        } else {
            last = `HTTP ${res.status}`;
        }
        if (Date.now() > deadline) throw new Error(`EKS cluster ${i.name} (${id}) wasn't active after ${i.readySeconds}s; last: ${last}`);
        await sleep(20000);
    }
}

/** A kubeconfig through Rancher's proxy, from Rancher's generateKubeconfig action, as JSON. */
async function kubeconfigOf(request: Request, id: string, i: Inputs): Promise<string> {
    const res = await request("POST", `/v3/clusters/${id}?action=generateKubeconfig`, {});
    const text: string | undefined = res.body?.config;
    if (res.status !== 200 || !text) throw new Error(`generating a kubeconfig for ${i.name} (${id}) failed: HTTP ${res.status}`);
    const token = /^\s*token:\s*"?([^"\s]+)"?\s*$/m.exec(text)?.[1];
    if (!token) throw new Error(`the kubeconfig Rancher generated for ${i.name} has no token`);
    return JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters: [{ name: i.name, cluster: { server: `${i.url.replace(/\/+$/, "")}/k8s/clusters/${id}`, ...(i.insecure ? { "insecure-skip-tls-verify": true } : {}) } }],
        users: [{ name: i.name, user: { token } }],
        contexts: [{ name: i.name, context: { cluster: i.name, user: i.name } }],
        "current-context": i.name,
    });
}

/**
 * A hosted EKS cluster, created the way Rancher's UI does it: a management cluster with an
 * `eksConfig`, which Rancher's eks-operator turns into the EKS cluster, its node groups, and the
 * IAM roles both need (CloudFormation stacks named after the cluster). Rancher deletes all of
 * that when the cluster goes.
 */
const provider: pulumi.dynamic.ResourceProvider = {
    async create(inputs: Inputs) {
        const request = session(inputs);
        // A create that failed after Rancher took the cluster left it there: take it over.
        const existing = await request("GET", `/v3/clusters?name=${encodeURIComponent(inputs.name)}`);
        let id: string | undefined = existing.body?.data?.[0]?.id;
        if (!id) {
            const res = await request("POST", "/v3/clusters", {
                type: "cluster",
                name: inputs.name,
                labels: inputs.labels,
                annotations: inputs.annotations,
                fleetWorkspaceName: "fleet-default",
                eksConfig: inputs.eksConfig,
            });
            if (res.status !== 201) throw new Error(`creating EKS cluster ${inputs.name} in Rancher failed: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
            id = res.body.id as string;
        }
        await waitActive(request, id, inputs);
        return { id, outs: { ...inputs, clusterId: id, kubeconfig: await kubeconfigOf(request, id, inputs) } };
    },
    async diff(_id: string, olds: Outputs, news: Inputs) {
        const replaces = [
            ...(["url", "name"] as const).filter(k => olds[k] !== news[k]),
            ...NO_UPDATE.filter(k => JSON.stringify(olds.eksConfig[k]) !== JSON.stringify(news.eksConfig[k])).map(k => `eksConfig.${k}`),
        ];
        const changes = replaces.length > 0
            || (["password", "insecure"] as const).some(k => olds[k] !== news[k])
            || (["labels", "annotations", "eksConfig"] as const).some(k => JSON.stringify(olds[k]) !== JSON.stringify(news[k]));
        return { changes, replaces, deleteBeforeReplace: true };
    },
    async update(id: string, olds: Outputs, news: Inputs) {
        const request = session(news);
        const current = await request("GET", `/v3/clusters/${id}`);
        if (current.status !== 200) throw new Error(`reading cluster ${id} from Rancher failed: HTTP ${current.status}`);
        // Rancher's own labels and annotations stay; the lab's replace what it set before.
        const own = (now: Record<string, string> = {}, before: Record<string, string>, after: Record<string, string>) =>
            ({ ...Object.fromEntries(Object.entries(now).filter(([k]) => !(k in before))), ...after });
        const res = await request("PUT", `/v3/clusters/${id}`, {
            ...current.body,
            labels: own(current.body.labels, olds.labels, news.labels),
            annotations: own(current.body.annotations, olds.annotations, news.annotations),
            eksConfig: { ...current.body.eksConfig, ...news.eksConfig },
        });
        if (res.status !== 200) throw new Error(`updating EKS cluster ${news.name} failed: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
        // Node groups and versions change in place, a while after Rancher takes the change.
        await sleep(30000);
        await waitActive(request, id, news);
        return { outs: { ...news, clusterId: id, kubeconfig: await kubeconfigOf(request, id, news) } };
    },
    async delete(id: string, props: Outputs) {
        const request = session(props);
        const res = await request("DELETE", `/v3/clusters/${id}`);
        if (res.status === 404) return;
        if (res.status >= 300) throw new Error(`deleting EKS cluster ${props.name} (${id}) failed: HTTP ${res.status}`);
        // Rancher removes the node groups, the EKS cluster and the IAM stacks before the cluster object.
        const deadline = Date.now() + props.deleteSeconds * 1000;
        for (;;) {
            const left = await request("GET", `/v3/clusters/${id}`);
            if (left.status === 404) return;
            if (Date.now() > deadline) throw new Error(`EKS cluster ${props.name} (${id}) was still in Rancher after ${props.deleteSeconds}s: ${left.body?.transitioningMessage ?? left.body?.state ?? `HTTP ${left.status}`}`);
            await sleep(20000);
        }
    },
};

class EksClusterResource extends pulumi.dynamic.Resource {
    declare readonly clusterId: pulumi.Output<string>;
    declare readonly kubeconfig: pulumi.Output<string>;

    constructor(name: string, args: Omit<Inputs, "password"> & { password: pulumi.Input<string>; eksConfig: pulumi.Input<Record<string, any>> }, opts?: pulumi.CustomResourceOptions) {
        super(provider, name, { ...args, password: pulumi.secret(args.password), clusterId: undefined, kubeconfig: undefined }, { ...opts, additionalSecretOutputs: ["kubeconfig"] }, "lab", "EksCluster");
    }
}

/** Graviton instance families (m7g, t4g, c7gn) need the arm64 AMI. */
const isArm = (instanceType: string) => /^[a-z]+\d+g/.test(instanceType);

/**
 * An EKS cluster Rancher creates and manages, in the lab's VPC on the site. Rancher makes its
 * IAM roles; its nodes get no lab login (EKS nodes take no user data from the lab).
 */
export class EksCluster extends pulumi.ComponentResource {
    readonly cluster: pulumi.Resource;
    readonly provider: k8s.Provider;
    readonly clusterId: pulumi.Output<string>;

    constructor(name: string, args: EksClusterArgs, opts?: pulumi.ComponentResourceOptions) {
        super("lab:rancher:EksCluster", name, {}, opts);
        const clusterName = name.split("/").pop()!;
        const eksConfig = pulumi.all([args.cloudCredential, pulumi.all(args.subnetIds), pulumi.all(args.nodeGroups.map(g => pulumi.all(g.subnetIds)))])
            .apply(([credential, subnets, groupSubnets]) => ({
                amazonCredentialSecret: credential,
                displayName: clusterName,
                imported: false,
                region: args.region,
                kubernetesVersion: args.kubernetesVersion,
                tags: args.tags,
                secretsEncryption: false,
                publicAccess: true,
                privateAccess: true,
                publicAccessSources: args.publicAccessSources ?? ["0.0.0.0/0"],
                loggingTypes: args.logging ?? [],
                ebsCSIDriver: true,
                subnets,
                // EKS makes the cluster security group itself; Rancher makes the roles.
                securityGroups: [],
                nodeGroups: args.nodeGroups.map((g, i) => ({
                    nodegroupName: g.name,
                    version: args.kubernetesVersion,
                    instanceType: g.instanceType,
                    arm: isArm(g.instanceType),
                    gpu: false,
                    diskSize: toGiB(g.disk),
                    desiredSize: g.quantity,
                    minSize: g.min,
                    maxSize: g.max,
                    subnets: groupSubnets[i],
                    labels: g.labels ?? {},
                    tags: {},
                    resourceTags: args.tags,
                    ec2SshKey: "",
                    requestSpotInstances: false,
                })),
            }));

        const cluster = new EksClusterResource(name, {
            url: args.rancher.url,
            insecure: args.rancher.insecure,
            username: args.rancher.username,
            password: args.rancher.password,
            name: clusterName,
            labels: args.labels,
            annotations: args.annotations,
            eksConfig,
            readySeconds: args.timeouts.downstreamReady,
            deleteSeconds: args.timeouts.downstreamDelete,
        }, { parent: this, dependsOn: [...args.rancher.ready, ...(args.after ?? [])] });
        this.cluster = cluster;
        this.clusterId = cluster.clusterId;
        this.provider = new k8s.Provider(`${name}/provider`, { kubeconfig: cluster.kubeconfig, suppressHelmHookWarnings: true }, { parent: this });
        this.registerOutputs({});
    }
}
