import { describe, expect, it } from "vitest";
import { runProgram } from "./run-program";

// The whole program under Pulumi's mocks, for a Harvester with DNS: the controller as a Harvester
// add-on, its values from the Harvester's harvester-dns-controller profile, the router's password in
// a Secret of its own.

const LAB = `apiVersion: lab.geeko.me/v1alpha1
kind: Lab
metadata: { name: dns-test }
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
  profiles:
    harvester-dns-controller:
      backend: routeros
      host: 10.0.0.1
      credentials: "{{ secrets.router }}"
      ttl: 1h
      values: { logLevel: debug, dns: { useGuestClusterLabel: false } }
---
kind: HarvesterVM
metadata: { name: vm }
spec: { harvester: hv, os: leap-16 }
`;

describe("Harvester DNS", () => {
    it("installs the controller as a Harvester add-on, configured from the Harvester's profile", async () => {
        const registered = await runProgram(LAB, {
            secrets: { "ssh-key": "k", hv: { username: "u", password: "p" }, router: { username: "admin", password: "router-pw" } },
        });
        const addon = registered.find(r => r.name === "hv/dns-controller");
        expect(addon, registered.filter(r => r.name.startsWith("hv/")).map(r => `${r.type} ${r.name}`).join(", ")).toBeDefined();
        expect(addon!.type).toBe("pulumi-nodejs:dynamic/lab:HarvesterAddon");
        expect(addon!.inputs).toMatchObject({
            harvester: "hv", name: "harvester-dns-controller", namespace: "harvester-system", repo: "",
            chart: "oci://ghcr.io/hierynomus/harvester-dns-controller/charts/harvester-dns-controller", version: "0.3.0",
            labels: { "addon.harvesterhci.io/experimental": "true" },
        });
        expect(addon!.inputs.valuesContent).toBe([
            "logLevel: debug",
            "dns:",
            "  useGuestClusterLabel: false",
            "  backend: routeros",
            "  host: 10.0.0.1",
            "  username: admin",
            "  existingSecret: lab-dns-controller",
            "  useTls: false",
            "  domain: lab.example.com",
            "  ttl: 1h",
            "  commentTag: managed-by=harvester-dns-controller/hv",
            "watchNamespaces: dns-test",
            "",
        ].join("\n"));
        // The password only in the Secret.
        expect(addon!.inputs.valuesContent).not.toContain("router-pw");
        expect(registered.find(r => r.name === "hv/dns-controller-secret")?.inputs.stringData).toBeDefined();
    }, 30000);
});
