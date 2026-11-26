import { describe, expect, it } from "vitest";
import { HOST_TRAITS } from "@lab/schema";
import { hostBackends } from "../backends";
import { runProgram } from "./run-program";

// The host backends under Pulumi's mocks: what a VM on a Harvester registers, what an existing
// machine registers, and that every kind of host has a backend that says it is for that kind.

const LAB = `apiVersion: lab.geeko.me/v1alpha1
kind: Lab
metadata: { name: backends-test }
spec:
  domain: lab.example.com
  tls: { acme: letsencrypt-staging, email: a@example.com, cloudflare: "{{ secrets.cf }}" }
  ssh: { user: lab, publicKey: "ssh-ed25519 AAAA test", privateKey: "{{ secrets['ssh-key'] }}" }
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
metadata: { name: vm }
spec: { harvester: hv, os: leap-16, cpu: 2, memory: 4Gi, disk: 30Gi, profiles: { k3s: {} } }
---
kind: Machine
metadata: { name: box }
spec: { address: 10.0.30.5, user: root, os: sles-16, profiles: { k3s: {} } }
`;

describe("the program's host backends", () => {
    it("has one for every host kind, registered under its own kind", () => {
        expect(Object.keys(hostBackends).sort()).toEqual(Object.keys(HOST_TRAITS).sort());
        for (const [kind, backend] of Object.entries(hostBackends)) expect(backend.kind).toBe(kind);
    });

    let registered: Awaited<ReturnType<typeof runProgram>> = [];
    /** A secret input as the mocks record it: its value, under `value`. */
    const plain = (input: any) => input?.value ?? input;
    const find = (name: string) => registered.find(r => r.name === name);
    const names = (prefix: string) => registered.map(r => r.name).filter(n => n === prefix || n.startsWith(`${prefix}/`));

    it("runs the program", async () => {
        registered = await runProgram(LAB, { secrets: { "ssh-key": "k", hv: { username: "u", password: "p" }, cf: "c", "scc-regcode-sles": "r" } });
        expect(registered.length).toBeGreaterThan(0);
    }, 30000);

    it("a VM on a Harvester becomes a KubeVirt VM with its disk and cloud-init, and its setup waits for cloud-init", () => {
        expect(find("vm")?.type).toBe("lab:harvester:Vm");
        expect(find("vm/cloudinit")).toBeDefined();
        expect(find("vm/cloud-init")?.type).toBe("command:remote:Command");
        expect(plain(find("vm/cloud-init")!.inputs.connection)).toMatchObject({ user: "lab" });
    });

    it("an existing machine creates no VM, no disk and no cloud-init, and is set up over SSH as its own user", () => {
        expect(names("box").filter(n => n !== "box/setup" && !n.startsWith("box/k3s"))).toEqual([]);
        expect(find("box")).toBeUndefined();
        expect(find("box/cloudinit")).toBeUndefined();
        const setup = find("box/setup");
        expect(setup?.type).toBe("command:remote:Command");
        expect(plain(setup!.inputs.connection)).toMatchObject({ host: "10.0.30.5", user: "root" });
    });

    it("an existing machine is uninstalled when the lab goes: its setup has a delete step, a VM's does not need one", () => {
        expect(find("box/setup")!.inputs.delete).toBeTruthy();
        expect(find("vm/cloud-init")!.inputs.delete).toBeUndefined();
    });
});
