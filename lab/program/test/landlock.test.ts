import { describe, expect, it } from "vitest";
import { LANDLOCK_CHECK } from "@lab/os";
import { runProgram } from "./run-program";

// The whole program under Pulumi's mocks: the landlock profile on a VM, on an existing machine and
// on a downstream cluster, next to a VM and a cluster without it.

const LAB = `apiVersion: lab.geeko.me/v1alpha1
kind: Lab
metadata: { name: landlock-test }
spec:
  domain: lab.example.com
  tls: { acme: letsencrypt-staging, email: a@example.com, cloudflare: "{{ secrets.cf }}" }
  ssh: { publicKey: "ssh-ed25519 AAAA test", privateKey: "{{ secrets['ssh-key'] }}" }
---
kind: Harvester
metadata: { name: hv }
spec:
  url: https://hv.example.com
  credentials: "{{ secrets.hv }}"
  networks:
    vlans: [ { id: 20, dhcp: { cidr: 10.0.20.0/24, gateway: 10.0.20.1, range: [ 10.0.20.100, 10.0.20.150 ] } } ]
    default: vlan20
---
kind: HarvesterVM
metadata: { name: rancher }
spec:
  harvester: hv
  os: leap-16
  profiles: { k3s: {}, cert-manager: {}, sprouter: {}, traefik: {}, rancher: { adminPassword: "{{ secrets.admin }}" } }
---
kind: HarvesterVM
metadata: { name: sandbox }
spec: { harvester: hv, os: leap-16, profiles: { rke2: {}, landlock: {} } }
---
kind: Machine
metadata: { name: box }
spec: { address: 10.0.30.5, os: sles-16, profiles: { k3s: {}, landlock: {} } }
---
kind: DownstreamCluster
metadata: { name: agents }
spec: { type: harvester, rancher: rancher, harvester: hv, profiles: { landlock: {} }, pools: [ { name: all, quantity: 1, roles: [ etcd, controlplane, worker ], os: leap-16 } ] }
---
kind: DownstreamCluster
metadata: { name: infer }
spec: { type: harvester, rancher: rancher, harvester: hv, pools: [ { name: all, quantity: 1, roles: [ etcd, controlplane, worker ], os: leap-16 } ] }
`;

describe("landlock", () => {
    let registered: Awaited<ReturnType<typeof runProgram>> = [];
    const find = (name: string) => registered.find(r => r.name === name);
    const userData = (vm: string) => (find(`${vm}/cloudinit`)!.inputs.stringData.value as { userdata: string }).userdata;

    it("turns it on at a VM's first boot, and checks it once cloud-init is done", async () => {
        registered = await runProgram(LAB, { secrets: { "ssh-key": "k", hv: { username: "u", password: "p" }, admin: "a", cf: "c", "scc-regcode-sles": "r" } });
        expect(userData("sandbox")).toContain("lab: turning landlock on");
        expect(userData("rancher")).not.toContain("landlock");
        expect(find("sandbox/landlock")!.inputs.create).toBe(LANDLOCK_CHECK);
        expect(find("rancher/landlock")).toBeUndefined();
    }, 30000);

    it("turns it on on an existing machine over SSH, waits out its reboot and checks it", () => {
        const turnOn = find("box/landlock")!;
        expect(turnOn.inputs.stdin).toContain("lab: rebooting");
        expect(find("box/landlock/reboot")!.type).toBe("command:local:Command");
        expect(find("box/landlock/check")!.inputs.create).toBe(LANDLOCK_CHECK);
        expect(find("box/setup")).toBeDefined();
    });

    it("turns it on in a cluster's machines' user data, and checks every node with a DaemonSet", () => {
        // The user data is a secret: its value inside.
        const pool = (cluster: string) => String(find(`downstream/${cluster}/all`)!.inputs.userData.value);
        expect(pool("agents")).toContain("lab: turning landlock on");
        expect(pool("infer")).not.toContain("landlock");
        const ds = find("downstream/agents/landlock")!;
        expect(ds.type).toBe("kubernetes:apps/v1:DaemonSet");
        const container = ds.inputs.spec.template.spec.containers[0];
        expect(container.command[2]).toContain("/host/lsm");
        expect(ds.inputs.spec.template.spec.volumes[0].hostPath.path).toBe("/sys/kernel/security");
        expect(find("downstream/infer/landlock")).toBeUndefined();
    });
});
