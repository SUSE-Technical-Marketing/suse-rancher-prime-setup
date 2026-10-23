import { ResolvedLab } from "@lab/schema";
import { HarvesterSession } from "./harvesters";

/**
 * Everything a lab may create on a Harvester, as API paths. `destroy --check` lists whatever of
 * it still exists, to catch teardown leaks. Keep in sync with packages/harvester.
 */
function candidates(lab: ResolvedLab, session: HarvesterSession): { what: string; path: string; list?: boolean; prefix?: string }[] {
    const ns = lab.name;
    const h = session.harvester;
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
            const items: any[] = (c.list ? res.body?.items ?? [] : [res.body]).filter((i: any) => !c.prefix || i?.metadata?.name?.startsWith(c.prefix));
            const live = items.filter(i => !i?.metadata?.deletionTimestamp);
            const dying = items.filter(i => i?.metadata?.deletionTimestamp);
            const describe = (list: any[]) => `${session.harvester.name}: ${c.what}${c.list ? `: ${list.map(i => i.metadata.name).join(", ")}` : ""}`;
            if (live.length > 0) found.push(describe(live));
            if (dying.length > 0) terminating.push(describe(dying));
        }
    }
    return { found, terminating };
}
