import { describe, expect, it } from "vitest";
import { runProgram } from "./run-program";

// The whole program under Pulumi's mocks: VMs with fixed addresses, on a lab VLAN without DHCP and on
// a network already on the Harvester, and one with an address from DHCP for comparison.

const LAB = `apiVersion: lab.geeko.me/v1alpha1
kind: Lab
metadata: { name: fixed-test }
spec:
  domain: lab.example.com
  tls: { acme: none }
  ssh: { publicKey: "ssh-ed25519 AAAA test", privateKey: "{{ secrets['ssh-key'] }}" }
---
kind: Harvester
metadata: { name: hv }
spec:
  url: https://hv.example.com
  credentials: "{{ secrets.hv }}"
  networks:
    default: vlan50
    vlans: [ { id: 50, cidr: 203.0.113.0/24, gateway: 203.0.113.1, dns: [ 9.9.9.9 ] } ]
---
kind: HarvesterVM
metadata: { name: gitlab }
spec: { harvester: hv, os: leap-16, ip: 203.0.113.20, fqdn: gitlab.example.com }
---
kind: HarvesterVM
metadata: { name: other }
spec: { harvester: hv, os: leap-16, network: default/vlan40, ip: 10.29.40.200/24, gateway: 10.29.40.1, macAddress: "52:54:00:aa:bb:01" }
---
kind: HarvesterVM
metadata: { name: plain }
spec: { harvester: hv, os: leap-16, network: untagged }
`;

describe("fixed addresses", () => {
    let registered: Awaited<ReturnType<typeof runProgram>> = [];
    const find = (name: string) => registered.find(r => r.name === name);
    /** A cloud-init Secret's data: all of it a secret, as its user data is. */
    const cloudInit = (vm: string) => find(`${vm}/cloudinit`)!.inputs.stringData.value as { userdata: string; networkdata?: string };

    it("sets them in the VM: its network config, on an interface with a MAC of its own", async () => {
        registered = await runProgram(LAB, { secrets: { "ssh-key": "k", hv: { username: "u", password: "p" } } });
        const vm = find("gitlab/vm")!;
        const nic = vm.inputs.spec.template.spec.domain.devices.interfaces[0];
        expect(nic.macAddress).toMatch(/^52:54:00(:[0-9a-f]{2}){3}$/);
        const volume = vm.inputs.spec.template.spec.volumes.find((v: any) => v.name === "cloudinit");
        expect(volume.cloudInitNoCloud).toEqual({ secretRef: { name: "gitlab-cloudinit" }, networkDataSecretRef: { name: "gitlab-cloudinit" } });
        const network = cloudInit("gitlab").networkdata!;
        for (const line of [`macaddress: ${nic.macAddress}`, "dhcp4: false", "- 203.0.113.20/24", "via: 203.0.113.1", "- 9.9.9.9"]) expect(network).toContain(line);
        // Its external name in its cloud-config; its address known, no wait for the guest agent.
        expect(cloudInit("gitlab").userdata).toContain("fqdn: gitlab.example.com");
        expect(find("gitlab/ip")).toBeUndefined();
    }, 30000);

    it("uses a network already on the Harvester as it is, with the MAC the lab gives", () => {
        const vm = find("other/vm")!;
        expect(vm.inputs.spec.template.spec.networks[0].multus.networkName).toBe("default/vlan40");
        expect(vm.inputs.spec.template.spec.domain.devices.interfaces[0].macAddress).toBe("52:54:00:aa:bb:01");
        const network = cloudInit("other").networkdata!;
        for (const line of ["macaddress: 52:54:00:aa:bb:01", "- 10.29.40.200/24", "via: 10.29.40.1"]) expect(network).toContain(line);
        // The lab creates no network for it.
        expect(registered.some(r => r.name === "hv/network/default/vlan40")).toBe(false);
    });

    it("leaves a VM without one to DHCP: no network config, its address from the guest agent", () => {
        expect(cloudInit("plain").networkdata).toBeUndefined();
        expect(find("plain/ip")).toBeDefined();
    });
});
