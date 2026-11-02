import { EksCluster } from "@lab/rancher";
import type { ClusterBuilder, ClusterOf } from "./types";

// An EKS cluster Rancher creates and manages, in the site's VPC, with the Rancher's AWS credential.

export const eks: ClusterBuilder<ClusterOf<"eks">> = {
    build({ lab, rancher, awsCredential, network: networkOf, siteTags }, d) {
        const site = lab.awsSites.find(s => s.name === d.site)!;
        const network = networkOf(d.site);
        const credential = awsCredential(d.site);
        return new EksCluster(`downstream/${d.name}`, {
            rancher,
            region: site.region,
            kubernetesVersion: d.version,
            labels: d.labels,
            annotations: d.annotations,
            cloudCredential: credential.secretName,
            subnetIds: site.zones.map(z => network.subnets[z.letter].id),
            tags: siteTags(d.site),
            publicAccessSources: d.publicAccessSources,
            logging: d.logging,
            nodeGroups: d.nodeGroups.map(g => ({ ...g, subnetIds: g.zones.map(z => network.subnets[z].id) })),
            timeouts: lab.timeouts,
            // The cluster goes before its network does.
            after: [credential, network, ...network.ready],
        });
    },
};
