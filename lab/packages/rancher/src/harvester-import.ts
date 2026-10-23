import * as pulumi from "@pulumi/pulumi";
import { kubeRequest } from "@lab/kube";

interface Inputs {
    /** The Rancher cluster's kubeconfig (JSON). */
    rancherKubeconfig: string;
    /** Context of the Harvester in the run's kubeconfig. */
    harvester: string;
    /** Name of the cluster in Rancher. */
    name: string;
    /** Harvester fetches the registration manifest without checking Rancher's certificate. */
    insecure: boolean;
}

interface Outputs extends Inputs {
    /** Rancher's management cluster id (`c-xxxxx`). */
    clusterId: string;
}

const CLUSTERS = "/apis/provisioning.cattle.io/v1/namespaces/fleet-default/clusters";
const SETTING = "/apis/harvesterhci.io/v1beta1/settings/cluster-registration-url";
const TOKEN_PLACEHOLDER = "{token}";

/**
 * Imports a Harvester into Rancher (Virtualization Management): a cluster labelled as a Harvester,
 * whose registration URL goes into the Harvester's `cluster-registration-url` setting. Harvester
 * then installs Rancher's agent itself. Done once Rancher reports the cluster Ready.
 *
 * On delete the setting is reset and the cluster removed from Rancher, which removes its agent
 * from the Harvester.
 */
const provider: pulumi.dynamic.ResourceProvider = {
    async create(inputs: Inputs) {
        const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
        const rancher = { kubeconfig: inputs.rancherKubeconfig };
        const harvester = { context: inputs.harvester };
        const until = async <T>(what: string, minutes: number, probe: () => Promise<T | undefined>): Promise<T> => {
            const deadline = Date.now() + minutes * 60 * 1000;
            while (Date.now() < deadline) {
                const value = await probe();
                if (value !== undefined) return value;
                await sleep(5000);
            }
            throw new Error(`importing harvester ${inputs.harvester}: ${what} within ${minutes} minutes`);
        };

        const created = await kubeRequest(rancher, "POST", CLUSTERS, {
            apiVersion: "provisioning.cattle.io/v1",
            kind: "Cluster",
            metadata: { name: inputs.name, namespace: "fleet-default", labels: { "provider.cattle.io": "harvester" } },
            spec: {},
        });
        if (created.status !== 201 && created.status !== 409) {
            throw new Error(`creating cluster ${inputs.name} in Rancher failed: HTTP ${created.status} ${JSON.stringify(created.body).slice(0, 300)}`);
        }

        const clusterId = await until("Rancher didn't assign a cluster id", 5, async () =>
            (await kubeRequest(rancher, "GET", `${CLUSTERS}/${inputs.name}`)).body?.status?.clusterName || undefined);

        // Newer Rancher keeps the token out of the manifest URL and in a Secret next to it.
        const url = await until("no registration token appeared", 5, async () => {
            const crt = (await kubeRequest(rancher, "GET", `/apis/management.cattle.io/v3/namespaces/${clusterId}/clusterregistrationtokens/default-token`)).body;
            const manifestUrl: string | undefined = crt?.status?.manifestUrl;
            if (!manifestUrl) return undefined;
            if (!manifestUrl.includes(TOKEN_PLACEHOLDER)) return manifestUrl;
            const secretName = crt.status.tokenSecretName;
            if (!secretName) return undefined;
            const encoded = (await kubeRequest(rancher, "GET", `/api/v1/namespaces/${clusterId}/secrets/${secretName}`)).body?.data?.token;
            return encoded ? manifestUrl.replace(TOKEN_PLACEHOLDER, Buffer.from(encoded, "base64").toString("utf8").trim()) : undefined;
        });

        const set = await kubeRequest(harvester, "PATCH", SETTING, { value: JSON.stringify({ url, insecureSkipTLSVerify: inputs.insecure }) });
        if (set.status !== 200) throw new Error(`setting cluster-registration-url on ${inputs.harvester} failed: HTTP ${set.status} ${JSON.stringify(set.body).slice(0, 300)}`);

        await until("the cluster didn't become Ready (is Rancher reachable from the Harvester?)", 20, async () => {
            const cluster = (await kubeRequest(rancher, "GET", `/apis/management.cattle.io/v3/clusters/${clusterId}`)).body;
            return cluster?.status?.conditions?.some((c: any) => c.type === "Ready" && c.status === "True") ? true : undefined;
        });
        return { id: `${inputs.harvester}/${inputs.name}`, outs: { ...inputs, clusterId } };
    },
    async diff(_id: string, olds: Outputs, news: Inputs) {
        const replaces = (["harvester", "name"] as const).filter(k => olds[k] !== news[k]);
        return { changes: replaces.length > 0 || olds.insecure !== news.insecure, replaces, deleteBeforeReplace: true };
    },
    async update(_id: string, olds: Outputs, news: Inputs) {
        return { outs: { ...news, clusterId: olds.clusterId } };
    },
    async delete(_id: string, props: Outputs) {
        const rancher = { kubeconfig: props.rancherKubeconfig };
        await kubeRequest({ context: props.harvester }, "PATCH", SETTING, { value: "" });
        const res = await kubeRequest(rancher, "DELETE", `${CLUSTERS}/${props.name}`);
        if (res.status === 404) return;
        const deadline = Date.now() + 10 * 60 * 1000;
        while (Date.now() < deadline) {
            if ((await kubeRequest(rancher, "GET", `${CLUSTERS}/${props.name}`)).status === 404) return;
            await new Promise(r => setTimeout(r, 5000));
        }
        throw new Error(`cluster ${props.name} wasn't removed from Rancher within 10 minutes`);
    },
};

export interface HarvesterImportArgs {
    rancherKubeconfig: pulumi.Input<string>;
    harvester: string;
    name: string;
    insecure: boolean;
}

export class HarvesterImport extends pulumi.dynamic.Resource {
    declare readonly clusterId: pulumi.Output<string>;

    constructor(name: string, args: HarvesterImportArgs, opts?: pulumi.CustomResourceOptions) {
        super(provider, name, { ...args, rancherKubeconfig: pulumi.secret(args.rancherKubeconfig), clusterId: undefined }, opts, "lab", "HarvesterImport");
    }
}
