import * as pulumi from "@pulumi/pulumi";
import * as dynamic from "@pulumi/pulumi/dynamic";
import { waitFor } from "@suse-tmm/utils";
import { RancherClient } from "@suse-tmm/utils";

export interface BridgeNameProviderInputs {
    kubeconfig: string; // Kubeconfig to access the Kubernetes cluster
    name: string;
    timeout?: number; // Optional timeout in seconds
}

export interface BridgeNameProviderOutputs extends BridgeNameProviderInputs {
    bridgeName: string; // The name of the bridge interface
}

export interface BridgeNameInputs {
    kubeconfig: pulumi.Input<string>; // Kubeconfig to access the Kubernetes cluster
    namespace: pulumi.Input<string>;
    name: pulumi.Input<string>;
    timeout?: pulumi.Input<number>; // Optional timeout in seconds
}

class BridgeNameProvider implements dynamic.ResourceProvider<BridgeNameProviderInputs, BridgeNameProviderOutputs> {
    async create(inputs: BridgeNameProviderInputs): Promise<pulumi.dynamic.CreateResult<BridgeNameProviderOutputs>> {
        const { kubeconfig, name, timeout = 30 } = inputs;

        return waitFor(() => this.getBridgeName(kubeconfig, name), {
            intervalMs: 5_000,
            timeoutMs: timeout * 1000,
        }).catch(err => {
            pulumi.log.error(`Failed to get bridge name for linkmonitor ${name}: ${err.message}`);
            throw new Error(`Failed to get bridge name for linkmonitor ${name}: ${err.message}`);
        }).then(bridgeName => {
            return {
                id: `${name}`,
                outs: { ...inputs, bridgeName },
            };
        });
    }

    async read(id: pulumi.ID, props?: BridgeNameProviderOutputs): Promise<pulumi.dynamic.ReadResult<BridgeNameProviderOutputs>> {
        if (!props) return { id, props: {} as BridgeNameProviderOutputs };
        const bridgeName = await this.getBridgeName(props.kubeconfig, props.name)
            .catch(() => props.bridgeName);
        return {
            id,
            props: { ...props, bridgeName: bridgeName ?? props.bridgeName },
        };
    }

    async update(id: string, olds: BridgeNameProviderOutputs, news: BridgeNameProviderInputs): Promise<pulumi.dynamic.UpdateResult<BridgeNameProviderOutputs>> {
        return this.create(news);
    }

    async getBridgeName(kubeconfig: string, name: string): Promise<string> {
        return RancherClient.fromKubeconfig(kubeconfig).then(async client => {
            return client.get(`apis/network.harvesterhci.io/v1beta1/linkmonitors/${name}`);
        }).then((linkmonitor: any) => {
            if (linkmonitor?.status?.linkStatus) {
                const linkStatus = linkmonitor.status.linkStatus;
                const bridge = linkStatus.find((link: any) => link.type === "bridge");
                if (bridge) {
                    return bridge.name;
                }

                throw new Error(`No 'bridge' type link found for linkmonitor ${name}`);
            }
        });
    }
}

export class BridgeName extends pulumi.dynamic.Resource {
    public readonly bridgeName!: pulumi.Output<string>;

    constructor(name: string, args: BridgeNameInputs, opts?: pulumi.CustomResourceOptions) {
        super(new BridgeNameProvider(), name, { ...args, bridgeName: undefined }, opts);
    }
}