import { Ec2Cluster } from "@lab/rancher";
import { distribution, version } from "../catalog";
import type { ClusterBuilder, ClusterOf } from "./types";

// Machines Rancher creates on EC2 with its node driver, in the site's VPC.

export const ec2: ClusterBuilder<ClusterOf<"ec2">> = {
    build({ lab, rancher, awsCredential, network: networkOf, siteTags, amiOf, poolUserData }, d) {
        const site = lab.awsSites.find(s => s.name === d.site)!;
        const network = networkOf(d.site);
        const credential = awsCredential(d.site);
        return new Ec2Cluster(`downstream/${d.name}`, {
            rancher,
            distribution: distribution(d.distro, lab),
            kubernetesVersion: d.version ?? version(d.distro, lab),
            labels: d.labels,
            annotations: d.annotations,
            cloudCredential: credential.secretName,
            cni: d.cni,
            machineGlobalConfig: d.machineGlobalConfig,
            chartValues: d.chartValues,
            timeouts: lab.timeouts,
            region: site.region,
            vpcId: network.vpc.id,
            securityGroup: network.securityGroup.name,
            tags: siteTags(d.site),
            pools: d.pools.map(pool => {
                const os = lab.os[pool.os];
                return {
                    ...pool,
                    ami: amiOf(d.site, pool.os),
                    sshUser: os.ami!.user ?? os.defaultUser ?? "ec2-user",
                    subnetId: network.subnets[pool.zone].id,
                    userData: poolUserData(pool.os, pool.roles, false),
                };
            }),
            // The machines go before their network does.
            after: [credential, network, ...network.ready],
        });
    },
};
