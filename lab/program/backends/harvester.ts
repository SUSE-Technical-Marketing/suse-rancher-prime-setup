import * as pulumi from "@pulumi/pulumi";
import { HarvesterVm } from "@lab/harvester";
import { renderCloudConfig, renderNetworkConfig, stableMac } from "@lab/os";
import type { HostBackend } from "@lab/backends";
import { nodeProfiles, profileBootcmd } from "../profiles";
import type { BackendContext } from "./context";

/** A VM on a Harvester: one disk cloned from the OS image in the lab's namespace, cloud-init from the OS profile. */
export const harvesterBackend: HostBackend<"harvester", BackendContext> = {
    kind: "harvester",
    provision(host, { lab, bases, providers, osVars, runcmd }) {
        const base = bases[host.harvester];
        const os = lab.os[host.os];
        const userData = osVars().apply(vars => renderCloudConfig({
            os,
            harvester: true,
            kubernetes: host.kubernetes,
            hostname: host.name,
            fqdn: host.fqdn,
            user: { name: lab.ssh!.user, publicKey: lab.ssh!.publicKey },
            vars,
            runcmd,
            bootcmd: profileBootcmd(lab, nodeProfiles(lab, host), os),
        }));
        const vm = new HarvesterVm(host.name, {
            harvester: host.harvester,
            namespace: base.namespace.metadata.name,
            vmName: host.name,
            cpu: host.cpu,
            memory: host.memory,
            disk: host.disk,
            image: base.images[os.image],
            // `namespace/name`: a network already on the Harvester, not the lab's.
            network: host.network.includes("/") ? host.network : base.networks[host.network],
            // A fixed address is set on the interface with this MAC: one of its own, unless the lab gives it one.
            macAddress: host.macAddress ?? (host.ip ? stableMac(lab.name, host.name) : undefined),
            userData: pulumi.secret(userData),
            ...(host.ip ? {
                networkData: renderNetworkConfig({ macAddress: host.macAddress ?? stableMac(lab.name, host.name), ...host.ip, search: [lab.domain] }),
                fixedAddress: host.ip.address,
            } : {}),
            keyPair: pulumi.interpolate`${base.namespace.metadata.name}/${lab.ssh!.user}`,
            timeouts: { start: lab.timeouts.vmStart, address: lab.timeouts.vmAddress },
        }, { provider: providers[host.harvester], dependsOn: base.ready });
        return {
            address: vm.ipAddress,
            ready: [vm],
            machine: vm.vm,
            site: { name: host.harvester, ready: [base.namespace, ...base.ready] },
        };
    },
};
