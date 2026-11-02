import { HarvesterCloudProvider } from "@lab/apps";
import { HarvesterCloudConfig } from "@lab/harvester";
import { profileChart } from "../catalog";
import type { ProfileBuilder } from "../profiles";
import { chartValuesWithSecrets } from "../secrets";
import { need } from "./util";

// The harvester-cloud-provider profile: the Harvester cloud provider in a VM's cluster, with a
// kubeconfig for a service account of its own on the Harvester; it gives the cluster load balancers
// from the network's Harvester pool.

export const harvesterCloudProvider: ProfileBuilder<"harvester-cloud-provider"> = {
    host(ctx, settings) {
        const { lab, host } = ctx;
        if (!ctx.harvester) throw new Error(`host ${host.name}: harvester-cloud-provider only runs on Harvester VMs`);
        const name = `${host.name}/harvester-cloud-provider`;
        const cloudConfig = new HarvesterCloudConfig(`${name}/cloud-config`, {
            harvester: ctx.harvester.name,
            namespace: lab.name,
            serviceAccountName: `${host.name}-cloud-provider`,
        }, { dependsOn: ctx.harvester.ready });
        const ccm = new HarvesterCloudProvider(name, {
            cluster: need(ctx, "kubernetes"),
            chart: profileChart("harvester-cloud-provider", host, lab, settings.version),
            values: chartValuesWithSecrets(settings.values),
            cloudConfig: cloudConfig.kubeconfig,
        });
        return { "load-balancer": { ready: [ccm.release] }, "cloud-provider": { ready: [ccm.release] } };
    },
};
