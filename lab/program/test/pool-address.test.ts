import { describe, expect, it } from "vitest";
import { runProgram } from "./run-program";

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
});
