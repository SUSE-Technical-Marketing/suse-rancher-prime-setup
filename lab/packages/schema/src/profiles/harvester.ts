import { z } from "zod";
import { defineProfile } from "./define";

export const harvesterCloudProvider = defineProfile({
    name: "harvester-cloud-provider",
    description: "Harvester cloud provider: LoadBalancer services get an address from the network's Harvester load-balancer pool (instead of ServiceLB)",
    settings: z.strictObject({ version: z.string().optional() }),
    requires: ["kubernetes"],
    provides: ["load-balancer"],
    hostKinds: ["harvester"],
    networkFeatures: ["loadBalancer"],
});
