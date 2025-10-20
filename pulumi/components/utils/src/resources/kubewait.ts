import * as pulumi from "@pulumi/pulumi";
import * as dynamic from "@pulumi/pulumi/dynamic";
import got from "got";
import { kubeConfigToHttp } from "../functions/kubehttp";
import { waitFor } from "../functions/waitfor";

export interface KubeWaitInputs {
    kubeconfig: pulumi.Input<string>;
    apiVersion: pulumi.Input<string>;
    kind: pulumi.Input<string>;
    namespace?: pulumi.Input<string>;
    name: pulumi.Input<string>;
    condition?: pulumi.Input<string>;
    expectedValue?: pulumi.Input<string>; // e.g. "True"
    timeoutSeconds?: pulumi.Input<number>; // default 300
    pollSeconds?: pulumi.Input<number>; // default 5
}

interface KubeWaitProviderInputs {
    kubeconfig: string;
    apiVersion: string;
    kind: string;
    namespace?: string;
    name: string;
    condition: string;
    expectedValue?: string;       // e.g. "True"
    timeoutSeconds?: number;     // default 300
    pollSeconds?: number;        // default 5
}

interface KubeWaitProviderOutputs extends KubeWaitProviderInputs { reached: boolean }

class KubeWaitProvider implements dynamic.ResourceProvider<KubeWaitProviderInputs, KubeWaitProviderOutputs> {
    async create(i: KubeWaitProviderInputs): Promise<dynamic.CreateResult<KubeWaitProviderOutputs>> {

        const httpConfig = kubeConfigToHttp(i.kubeconfig);
        const expected = i.expectedValue ?? "True"; // Default to "True" if not specified
        const path = (i.namespace)
            ? `/apis/${i.apiVersion}/namespaces/${i.namespace}/${i.kind.toLowerCase()}s/${i.name}`
            : `/apis/${i.apiVersion}/${i.kind.toLowerCase()}s/${i.name}`;

        const url = `${httpConfig.server}${path}`;        // tiny JSONPath helper
        const reached = waitFor(() => got.get(url, {
            agent: { https: httpConfig.agent },
            headers: httpConfig.headers,
            responseType: "json",
            timeout: { request: 10000 },
            retry: { limit: 2 },
        }).then(res => {
            if (res.statusCode === 404) {
                return undefined; // Resource not found, will retry
            } else if (res.statusCode < 200 || res.statusCode >= 300) {
                throw new Error(`Failed to fetch ${i.kind}/${i.name}: ${res.statusMessage}`);
            } else {
                if (!i.condition) {
                    return true; // Resource exists
                }
                const val = this.conditionStatus(res.body, i.condition);
                if (val === expected) {
                    return true; // Condition met
                } else {
                    return undefined; // Will retry
                }
            }
        }), {
            intervalMs: (i.pollSeconds ?? 5) * 1000,
            timeoutMs: (i.timeoutSeconds ?? 300) * 1000,
        }).catch(err => {
            pulumi.log.error(`Failed to fetch ${i.kind}/${i.name}: ${err.message}`);
            throw new Error(`Failed to fetch ${i.kind}/${i.name}: ${err.message}`);
        }
        );

        return {
            id: `${i.namespace ?? "_cluster"}/${i.name}/${i.condition}`,
            outs: { ...i, reached: true },
        };
    }

    /**
     * Grab the value of  .status.conditions[?(@.type == wanted)].status
     * Returns undefined if the path or the condition is absent.
     */
    private conditionStatus(
        obj: any,
        wanted: string,
    ): string | undefined {
        return obj?.status?.conditions
            ?.find((c: any) => c?.type === wanted)
            ?.status;
    }
}

export class KubeWait extends dynamic.Resource {
    public readonly reached!: pulumi.Output<boolean>;
    constructor(name: string, args: KubeWaitInputs, opts?: pulumi.ResourceOptions) {
        super(new KubeWaitProvider(), name, { ...args, reached: undefined }, opts);
    }
}
