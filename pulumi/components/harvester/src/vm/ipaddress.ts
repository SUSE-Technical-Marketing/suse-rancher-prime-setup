import * as pulumi from "@pulumi/pulumi";
import * as dynamic from "@pulumi/pulumi/dynamic";
import got from "got";
import * as yaml from "js-yaml";
import https from "https";
import { waitFor, kubeConfigToHttp } from "@suse-tmm/utils";

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

        const ip = await waitFor(() => this.getVmiIp(kubeconfig, namespace, name), {
            intervalMs: 5_000,
            timeoutMs: timeout * 1000,
        }).catch(err => {
            pulumi.log.error(`Failed to get IP for VMI ${namespace}/${name}: ${err.message}`);
            throw new Error(`Failed to get IP for VMI ${namespace}/${name}: ${err.message}`);
        });

        return {
            id: `${namespace}/${name}`,
            outs: { ...inputs, ipAddress: ip },
        };
    }

    async update(id: string, olds: VmIpAddressProviderOutputs, news: VmIpAddressProviderInputs): Promise<pulumi.dynamic.UpdateResult<VmIpAddressProviderOutputs>> {
        return this.create(news);
    }

    async getVmiIp(kubeconfigYaml: string, namespace: string, vmName: string): Promise<string | undefined> {

        // 2️⃣  parse the kubeconfig -------------------------------------------------
        const httpConfig = kubeConfigToHttp(kubeconfigYaml);
        // 4️⃣  call the VMI endpoint ------------------------------------------------
        const url = `${httpConfig.server}/apis/kubevirt.io/v1/namespaces/${namespace}/virtualmachineinstances/${vmName}`;

        const res: any = await got.get(url, {
            agent: { https: httpConfig.agent },
            headers: httpConfig.headers,
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
