import * as pulumi from "@pulumi/pulumi";
import { network } from "@suse-tmm/harvester-crds";

export interface PoolArgs {
    name: string;
    namespace?: string;
    serverIp: string;
    cidr: string;
    rangeStart: string;
    rangeEnd: string;
    gateway: string;
    dnsServers: string[];
    domain: string;
    networkName: string;
    networkNamespace: string;
    leaseTimeSeconds?: number;
}

export function createIpPool(name: string, args: PoolArgs, opts: pulumi.CustomResourceOptions): network.v1alpha1.IPPool {
    return new network.v1alpha1.IPPool(name, {
        metadata: {
            name: name,
            namespace: args.namespace ?? "default",
        },
        spec: {
            ipv4Config: {
                serverIP: args.serverIp,
                cidr: args.cidr,
                pool: {
                    start: args.rangeStart,
                    end: args.rangeEnd,
                    exclude: [
                        args.gateway,
                        ...args.dnsServers,
                    ],
                },
                router: args.gateway,
                dns: args.dnsServers,
                domainName: args.domain,
                domainSearch: [args.domain],
                leaseTime: args.leaseTimeSeconds ?? 300, // 5 minutes
            },
            networkName: `${args.networkNamespace}/${args.networkName}`
        }
    }, opts);
}