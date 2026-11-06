import { describe, expect, it } from "vitest";
import { resourceDependencies, runProgram } from "./run-program";

// The whole program under Pulumi's mocks: a Harvester cluster with a one-machine pool at a fixed
// address on a VLAN without DHCP, and a pool of several machines from DHCP next to it.

const LAB = `apiVersion: lab.geeko.me/v1alpha1
kind: Lab
metadata: { name: pool-test }
spec:
  domain: lab.example.com
  tls: { acme: letsencrypt-staging, email: a@example.com, cloudflare: "{{ secrets.cloudflare.token }}" }
  ssh: { publicKey: "ssh-ed25519 AAAA test", privateKey: "{{ secrets['ssh-key'] }}" }
---
kind: Harvester
metadata: { name: hv }
spec:
  url: https://hv.example.com
  credentials: "{{ secrets.hv }}"
  networks:
    default: vlan20
    vlans:
      - { id: 20, dhcp: { cidr: 10.0.20.0/24, gateway: 10.0.20.1, range: [ 10.0.20.100, 10.0.20.150 ] } }
      - { id: 50, cidr: 203.0.113.0/24, gateway: 203.0.113.1, dns: [ 9.9.9.9 ] }
---
kind: HarvesterVM
metadata: { name: rancher }
spec: { harvester: hv, os: leap-16, profiles: { k3s: {}, cert-manager: {}, sprouter: {}, traefik: {}, rancher: { adminPassword: "{{ secrets.admin }}" } } }
---
kind: DownstreamCluster
metadata: { name: edge }
spec:
  type: harvester
  rancher: rancher
  harvester: hv
  pools:
    - { name: cp, quantity: 1, roles: [ etcd, controlplane, worker ], os: leap-16, network: vlan50, ip: 203.0.113.21 }
    - { name: workers, quantity: 2, roles: [ worker ], os: leap-16 }
`;

describe("fixed addresses on a Harvester cluster's pool", () => {
    let registered: Awaited<ReturnType<typeof runProgram>> = [];
    const find = (name: string) => registered.find(r => r.name === name);

    it("give the one-machine pool its network config, on an interface with a MAC of its own", async () => {
        registered = await runProgram(LAB, { secrets: { "ssh-key": "k", hv: { username: "u", password: "p" }, admin: "a", cloudflare: { token: "c" } } });
        const cp = find("downstream/edge/cp")!.inputs;
        const nic = JSON.parse(cp.networkInfo).interfaces[0];
        expect(nic.macAddress).toMatch(/^52:54:00(:[0-9a-f]{2}){3}$/);
        for (const line of [`macaddress: ${nic.macAddress}`, "dhcp4: false", "- 203.0.113.21/24", "via: 203.0.113.1", "- 9.9.9.9", "- lab.example.com"]) expect(cp.networkData).toContain(line);
        // The pool from DHCP: no MAC, no network config.
        const workers = find("downstream/edge/workers")!.inputs;
        expect(JSON.parse(workers.networkInfo).interfaces[0].macAddress).toBeUndefined();
        expect(workers.networkData).toBe("");
    }, 30000);

    it("replace that machine before creating its successor, so its address is never held twice", () => {
        const cluster = registered.find(r => r.type.endsWith(":Cluster") && r.inputs?.spec?.rkeConfig?.machinePools)!;
        expect(cluster, registered.filter(r => r.name.startsWith("downstream/edge")).map(r => `${r.type} ${r.name}`).join(", ")).toBeDefined();
        const pools = cluster.inputs.spec.rkeConfig.machinePools as { name: string; rollingUpdate?: unknown }[];
        expect(pools.find(p => p.name === "cp")!.rollingUpdate).toEqual({ maxSurge: 0, maxUnavailable: 1 });
        expect(pools.find(p => p.name === "workers")!.rollingUpdate).toBeUndefined();
    });

    it("uses the same single-replica image for the host VM and Rancher's pool disks", () => {
        const image = find("hv/image/leap-16")!.inputs;
        expect(image.metadata.annotations["harvesterhci.io/storageClassName"]).toBe("longhorn-single");
        expect(image.spec.targetStorageClassName).toBe("longhorn-single");
        expect(find("hv/storageclass")!.inputs.parameters.numberOfReplicas).toBe("1");
        const imageId = `${image.metadata.namespace}/${image.metadata.name}`;
        const disk = find("rancher/disk")!.inputs;
        expect(disk.metadata.annotations["harvesterhci.io/imageId"]).toBe(imageId);
        expect(disk.spec.storageClassName).toBe(`longhorn-${image.metadata.namespace}-${image.metadata.name}`);
        for (const pool of ["cp", "workers"]) {
            const disks = JSON.parse(find(`downstream/edge/${pool}`)!.inputs.diskInfo).disks;
            expect(disks[0].imageName).toBe(imageId);
        }
    });

    it("waits for CAPI's rollout before importing Harvester or provisioning pool machines", () => {
        const capiName = "rancher/rancher/capi-ready";
        expect(find(capiName)!.inputs).toMatchObject({
            path: "/apis/apps/v1/namespaces/cattle-capi-system/deployments/capi-controller-manager",
            rollout: true,
        });
        expect(find(capiName)!.inputs.timeoutSeconds).toBe(find("rancher/rancher/local-ready")!.inputs.timeoutSeconds);
        expect(resourceDependencies.get(capiName)).toEqual(expect.arrayContaining([
            expect.stringContaining("::rancher/rancher/webhook-admits"),
        ]));
        for (const name of ["rancher/import/hv", "downstream/edge/cp", "downstream/edge/workers", "downstream/edge/cluster"]) {
            expect(resourceDependencies.get(name), name).toEqual(expect.arrayContaining([
                expect.stringContaining(`::${capiName}`),
            ]));
        }
    });

    it("waits for the Harvester's default-class promotion before creating VMs and clusters", () => {
        expect(find("hv/storageclass")!.inputs.metadata.annotations?.["storageclass.kubernetes.io/is-default-class"]).toBeUndefined();
        const waitsForDefault = (name: string, seen = new Set<string>()): boolean => {
            if (seen.has(name)) return false;
            seen.add(name);
            return (resourceDependencies.get(name) ?? []).some(urn => {
                const dependency = urn.split("::").pop()!;
                return dependency === "hv/default-class" || waitsForDefault(dependency, seen);
            });
        };
        for (const name of ["rancher/disk", "rancher/vm", "downstream/edge/cp", "downstream/edge/cluster"]) {
            expect(waitsForDefault(name), name).toBe(true);
        }
    });
});
