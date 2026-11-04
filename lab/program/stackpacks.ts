import { ObservabilityStackPack } from "@lab/apps";
import type { ResolvedLab } from "@lab/schema";
import type { LabClusters } from "./profiles";
import { secretString } from "./secrets";

// StackPacks on the lab's SUSE Observability instances (DESIGN.md §9.6): one resource per instance
// and StackPack the profiles' `observerStackPacks` want (the resolver's `stackPacks`). When the last
// profile wanting one goes, so does its resource, and with it the StackPack's instance.

export function buildStackPacks(lab: ResolvedLab, clusters: LabClusters): void {
    for (const { observer, url, name, stackPack, file, adminToken } of lab.stackPacks) {
        const rancher = lab.downstream.find(d => d.name === observer)!.rancher;
        new ObservabilityStackPack(`downstream/${observer}/stackpack/${name}`, {
            url,
            adminToken: secretString(adminToken),
            name,
            ...(stackPack.version ? { version: stackPack.version } : {}),
            // Built from source: the .sts `lab stackpacks` built (`up` checked it's there).
            ...(file ? { file, sha256: stackPack.sha256 } : {}),
            unlocked: stackPack.unlocked,
            insecure: !!lab.acme?.ca,
            timeoutSeconds: lab.timeouts.observabilityReady,
            // After its cluster, and after its Rancher's Fleet HelmOps: they install the instance.
        }, { dependsOn: [...(clusters.downstream[observer]?.ready ?? []), ...(clusters.fleet[rancher] ?? [])] });
    }
}
