import { ResolvedLab } from "@lab/schema";
import { HarvesterSession } from "./harvesters";

/**
 * Everything a lab may create on a Harvester, as API paths. `destroy --check` lists whatever of
 * it still exists, to catch teardown leaks. Keep in sync with packages/harvester.
 */
function candidates(lab: ResolvedLab, session: HarvesterSession): { what: string; path: string; list?: boolean; prefix?: string; leaks?: (item: any) => boolean }[] {
    const ns = lab.name;
    const h = session.harvester;
    // A Rancher of the lab imported this Harvester: removing it from Rancher should remove its agent.
    const imported = lab.downstream.some(d => d.type === "harvester" && d.harvester === h.name);
    return [
        { what: `namespace ${ns}`, path: `/api/v1/namespaces/${ns}` },
        ...["virtualmachines", "virtualmachineinstances"].map(r => ({ what: `kubevirt ${r}`, path: `/apis/kubevirt.io/v1/namespaces/${ns}/${r}`, list: true })),
        { what: "volumes (PVCs)", path: `/api/v1/namespaces/${ns}/persistentvolumeclaims`, list: true },
        { what: "images", path: `/apis/harvesterhci.io/v1beta1/namespaces/${ns}/virtualmachineimages`, list: true },
        { what: "networks", path: `/apis/k8s.cni.cncf.io/v1/namespaces/${ns}/network-attachment-definitions`, list: true },
        { what: "IP pools", path: `/apis/network.harvesterhci.io/v1alpha1/namespaces/${ns}/ippools`, list: true },
        { what: "key pairs", path: `/apis/harvesterhci.io/v1beta1/namespaces/${ns}/keypairs`, list: true },
        { what: "load balancers", path: `/apis/loadbalancer.harvesterhci.io/v1beta1/namespaces/${ns}/loadbalancers`, list: true },
        { what: "load-balancer IP pools", path: "/apis/loadbalancer.harvesterhci.io/v1beta1/ippools", list: true, prefix: `${ns}-` },
        { what: `storage class ${h.storageClass.name}`, path: `/apis/storage.k8s.io/v1/storageclasses/${h.storageClass.name}` },
        { what: "DHCP controller add-on", path: "/apis/harvesterhci.io/v1beta1/namespaces/harvester-system/addons/harvester-vm-dhcp-controller" },
        { what: "DHCP controller chart (uninstall not finished)", path: "/apis/helm.cattle.io/v1/namespaces/harvester-system/helmcharts/harvester-vm-dhcp-controller" },
        { what: "DHCP controller pods", path: "/api/v1/namespaces/harvester-system/pods?labelSelector=app.kubernetes.io%2Fname%3Dharvester-vm-dhcp-controller", list: true },
        { what: "DNS controller pods", path: "/api/v1/namespaces/harvester-system/pods?labelSelector=app.kubernetes.io%2Fname%3Dharvester-dns-controller", list: true },
        { what: "DNS controller secret", path: "/api/v1/namespaces/harvester-system/secrets/lab-dns-controller" },
        { what: "DNS controller release", path: "/api/v1/namespaces/harvester-system/secrets?labelSelector=owner%3Dhelm%2Cname%3Dharvester-dns-controller", list: true },
        { what: "ownership claim", path: "/api/v1/namespaces/default/configmaps/lab-owner" },
        // Harvester binds the service accounts it makes kubeconfigs for (the cloud provider's) cluster-wide.
        { what: "cluster role bindings of the lab's service accounts", path: "/apis/rbac.authorization.k8s.io/v1/clusterrolebindings", list: true,
            leaks: (b: any) => (b.subjects ?? []).length > 0 && b.subjects.every((s: any) => s.kind === "ServiceAccount" && s.namespace === ns) },
        ...(imported ? [
            { what: "Rancher registration (setting cluster-registration-url)", path: "/apis/harvesterhci.io/v1beta1/settings/cluster-registration-url", leaks: (s: any) => !!s?.value },
            { what: "Rancher cluster agent", path: "/apis/apps/v1/namespaces/cattle-system/deployments/cattle-cluster-agent" },
            { what: "namespace cattle-impersonation-system", path: "/api/v1/namespaces/cattle-impersonation-system" },
            { what: "Rancher's service account cattle", path: "/api/v1/namespaces/cattle-system/serviceaccounts/cattle" },
            { what: "Rancher cluster agent service", path: "/api/v1/namespaces/cattle-system/services/cattle-cluster-agent" },
            { what: "Rancher agent credentials", path: "/api/v1/namespaces/cattle-system/secrets", list: true, prefix: "cattle-credentials-" },
            { what: "cluster role binding cattle-admin-binding", path: "/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/cattle-admin-binding" },
            { what: "cluster role proxy-clusterrole-kubeapiserver", path: "/apis/rbac.authorization.k8s.io/v1/clusterroles/proxy-clusterrole-kubeapiserver" },
            { what: "Rancher impersonation roles", path: "/apis/rbac.authorization.k8s.io/v1/clusterroles?labelSelector=authz.cluster.cattle.io%2Fimpersonator%3Dtrue", list: true },
            { what: "Rancher cleanup roles", path: "/apis/rbac.authorization.k8s.io/v1/clusterroles", list: true, prefix: "cattle-cleanup-" },
            { what: "Rancher cleanup role bindings", path: "/apis/rbac.authorization.k8s.io/v1/clusterrolebindings", list: true, prefix: "cattle-cleanup-" },
            { what: "Fleet agent (registered with the lab's Rancher)", path: "/apis/apps/v1/namespaces/cattle-fleet-system/deployments/fleet-agent" },
        ] : []),
    ];
}

export interface Leftovers {
    /** Still present and not being deleted: a teardown leak. */
    found: string[];
    /** Already being deleted (pods shutting down, finalizers running): give it a moment. */
    terminating: string[];
}

export async function findLeftovers(lab: ResolvedLab, sessions: HarvesterSession[]): Promise<Leftovers> {
    const found: string[] = [];
    const terminating: string[] = [];
    for (const session of sessions) {
        for (const c of candidates(lab, session)) {
            const res = await session.api.k8s("GET", c.path);
            if (res.status === 404) continue;
            if (res.status !== 200) {
                found.push(`${session.harvester.name}: couldn't check ${c.what} (HTTP ${res.status})`);
                continue;
            }
            // Cluster-scoped lists (IP pools) are narrowed to this lab's objects by name prefix.
            const items: any[] = (c.list ? res.body?.items ?? [] : [res.body])
                .filter((i: any) => !c.prefix || i?.metadata?.name?.startsWith(c.prefix))
                .filter((i: any) => !c.leaks || c.leaks(i));
            const live = items.filter(i => !i?.metadata?.deletionTimestamp);
            const dying = items.filter(i => i?.metadata?.deletionTimestamp);
            const describe = (list: any[]) => `${session.harvester.name}: ${c.what}${c.list ? `: ${list.map(i => i.metadata.name).join(", ")}` : ""}`;
            if (live.length > 0) found.push(describe(live));
            if (dying.length > 0) terminating.push(describe(dying));
        }
    }
    return { found, terminating };
}
