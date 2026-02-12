import * as pulumi from "@pulumi/pulumi";
import * as dynamic from "@pulumi/pulumi/dynamic";
import { waitFor } from "@suse-tmm/utils";
import { RancherClient } from "@suse-tmm/utils";
export interface VmIpAddressProviderInputs {
    kubeconfig: string; // Kubeconfig to access the Kubernetes cluster
    namespace: string;
    name: string;
    networkName?: string;
    timeout?: number; // Optional timeout in seconds
}

export interface VmIpAddressProviderOutputs extends VmIpAddressProviderInputs {
    ipAddress: string; // The IP address of the VM
}

export interface VmIpAddressInputs {
    kubeconfig: pulumi.Input<string>; // Kubeconfig to access the Kubernetes cluster
    namespace: pulumi.Input<string>;
    name: pulumi.Input<string>;
    networkName?: pulumi.Input<string>;
    timeout?: pulumi.Input<number>; // Optional timeout in seconds
}

class VmIpAddressProvider implements dynamic.ResourceProvider<VmIpAddressProviderInputs, VmIpAddressProviderOutputs> {
    async create(inputs: VmIpAddressProviderInputs): Promise<pulumi.dynamic.CreateResult<VmIpAddressProviderOutputs>> {
        const { kubeconfig, namespace, name, networkName, timeout = 30 } = inputs;

        return waitFor(() => this.getVmiIp(kubeconfig, namespace, name, networkName), {
            intervalMs: 5_000,
            timeoutMs: timeout * 1000,
        }).catch(err => {
            pulumi.log.error(`Failed to get IP for VMI ${namespace}/${name} ${networkName ? `interface ${networkName}` : ""}: ${err.message}`);
            throw new Error(`Failed to get IP for VMI ${namespace}/${name} ${networkName ? `interface ${networkName}` : ""}: ${err.message}`);
        }).then(ip => {
            return {
                id: `${namespace}/${name}`,
                outs: { ...inputs, ipAddress: ip },
            };
        });
    }

    async update(id: string, olds: VmIpAddressProviderOutputs, news: VmIpAddressProviderInputs): Promise<pulumi.dynamic.UpdateResult<VmIpAddressProviderOutputs>> {
        return this.create(news);
    }

    // Needs to be a valid IPv4 address, but without using net.isIPv4 as that is not serializable
    isIPv4Address(ip: string): boolean {
        if (!ip) {
            return false;
        }
        const parts = ip.split(".");
        if (parts.length !== 4) {
            return false;
        }
        for (const part of parts) {
            const num = Number(part);
            if (isNaN(num) || num < 0 || num > 255) {
                return false;
            }
        }
        return true;
    }


    async getVmiIp(kubeconfigYaml: string, namespace: string, vmName: string, interfaceName?: string): Promise<string | undefined> {
        // call the VMI endpoint ------------------------------------------------
        const url = `apis/kubevirt.io/v1/namespaces/${namespace}/virtualmachineinstances/${vmName}`;

        return RancherClient.fromKubeconfig(kubeconfigYaml).then(async (client) => {
            return client.get(url);
        }).then(res => {
            if (res.status?.interfaces) {
                if (interfaceName) {
                    const iface = res.status.interfaces.find((i: any) => i.name === interfaceName);

                    // If iface is set and iface.ipAddress is an IPv4 address, return it
                    if (iface && this.isIPv4Address(iface.ipAddress)) {
                        return iface.ipAddress;
                    } else {
                        return undefined;
                    }
                } else {
                    const iface = res.body.status.interfaces[0];
                    // If iface is set and iface.ipAddress is an IPv4 address, return it
                    if (iface && this.isIPv4Address(iface.ipAddress)) {
                        pulumi.log.info(`Found IP address ${iface.ipAddress} for VMI ${namespace}/${vmName} on interface ${iface.name}`);
                        return iface.ipAddress;
                    } else {
                        return undefined;
                    }
                }
            } else {
                return undefined;
            }
        });
    }
}

export class VmIpAddress extends dynamic.Resource {
    public readonly ipAddress!: pulumi.Output<string>;

    constructor(name: string, args: VmIpAddressInputs, opts?: pulumi.ComponentResourceOptions) {
        super(new VmIpAddressProvider(), name, { ...args, ipAddress: undefined }, opts);
    }
}
