import * as pulumi from "@pulumi/pulumi";
import * as dynamic from "@pulumi/pulumi/dynamic";
import got from "got";
import * as yaml from "js-yaml";
import https from "https";

export interface VmIpAddressProviderInputs {
    kubeconfig: string; // Kubeconfig to access the Kubernetes cluster
    namespace: string;
    name: string;
    timeout?: number; // Optional timeout in seconds
}

export interface VmIpAddressProviderOutputs extends VmIpAddressProviderInputs {
    ipAddress: string; // The IP address of the VM
}

export interface VmIpAddressInputs {
    kubeconfig: pulumi.Input<string>; // Kubeconfig to access the Kubernetes cluster
    namespace: pulumi.Input<string>;
    name: pulumi.Input<string>;
    timeout?: pulumi.Input<number>; // Optional timeout in seconds
}

class VmIpAddressProvider implements dynamic.ResourceProvider<VmIpAddressProviderInputs, VmIpAddressProviderOutputs> {
    async create(inputs: VmIpAddressProviderInputs): Promise<pulumi.dynamic.CreateResult<VmIpAddressProviderOutputs>> {
        const { kubeconfig, namespace, name, timeout = 30 } = inputs;

        const deadline = Date.now() + timeout * 1000;

        while (Date.now() < deadline) {
            const ip = await this.getVmiIp(kubeconfig, namespace, name);
            if (ip) {
                return {
                    id: `${namespace}/${name}`,
                    outs: { ...inputs, ipAddress: ip },
                };
            }
            await new Promise(r => setTimeout(r, 5_000));   // wait 5 s
        }

        throw new Error(`Timed out waiting for IP on VMI ${namespace}/${name}`);
    }

    async update(id: string, olds: VmIpAddressProviderOutputs, news: VmIpAddressProviderInputs): Promise<pulumi.dynamic.UpdateResult<VmIpAddressProviderOutputs>> {
        return this.create(news);
    }

    async getVmiIp(kubeconfigYaml: string, namespace: string, vmName: string): Promise<string | undefined> {

        // 2️⃣  parse the kubeconfig -------------------------------------------------
        const kc: any = yaml.load(kubeconfigYaml);
        const ctxName: string = kc["current-context"] ?? kc.contexts[0].name;
        const ctx: any = kc.contexts.find((c: any) => c.name === ctxName).context;

        const cluster: any = kc.clusters.find((c: any) => c.name === ctx.cluster).cluster;
        const server = cluster.server.replace(/\/$/, "");
        const insecure = cluster["insecure-skip-tls-verify"] === true;
        const ca = cluster["certificate-authority-data"]
        ? Buffer.from(cluster["certificate-authority-data"], "base64")
        : undefined;

        const user: any = kc.users.find((u: any) => u.name === ctx.user).user;
        const cert = user["client-certificate-data"]
            ? Buffer.from(user["client-certificate-data"], "base64")
            : undefined;
        const key = user["client-key-data"]
            ? Buffer.from(user["client-key-data"], "base64")
            : undefined;

        // token takes precedence over basic auth
        const token = user.token
            || user["auth-provider"]?.config?.["access-token"];

        const basicUser = user.username;
        const basicPass = user.password;

        // 3️⃣  build HTTPS agent + headers -----------------------------------------
        const agent = new https.Agent({
            ca,
            cert,
            key,
            rejectUnauthorized: !insecure,
        });

        const headers: Record<string, string> = {};
        if (token) {
            headers["Authorization"] = `Bearer ${token}`;
        } else if (basicUser && basicPass) {
            const creds = Buffer.from(`${basicUser}:${basicPass}`).toString("base64");
            headers["Authorization"] = `Basic ${creds}`;
        }

        // 4️⃣  call the VMI endpoint ------------------------------------------------
        const url = `${server}/apis/kubevirt.io/v1/namespaces/${namespace}/virtualmachineinstances/${vmName}`;

        const res: any = await got.get(url, {
            agent: { https: agent },
            headers,
            responseType: "json",
            timeout: { request: 10000 },
            retry: { limit: 2 },
        });

        return res.body?.status?.interfaces?.[0]?.ipAddress;
    }
}

export class VmIpAddress extends dynamic.Resource {
    public readonly ipAddress!: pulumi.Output<string>;

    constructor(name: string, args: VmIpAddressInputs, opts?: pulumi.ComponentResourceOptions) {
        super(new VmIpAddressProvider(), name, { ...args, ipAddress: undefined }, opts);
    }
}
