import { describe, expect, it } from "vitest";
import { runProgram } from "./run-program";

// The whole program under Pulumi's mocks, for a Rancher host with SUSE AI Factory: the operator's
// chart gets the registry logins as values, read from the secrets.

const LAB = `apiVersion: lab.geeko.me/v1alpha1
kind: Lab
metadata: { name: aif-test }
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
---
kind: HarvesterVM
metadata: { name: rancher }
spec:
  harvester: hv
  os: leap-16
  profiles:
    k3s: {}
    cert-manager: {}
    sprouter: {}
    traefik: {}
    rancher: { adminPassword: "{{ secrets.admin }}" }
    ai-factory:
      applicationCollection: "{{ secrets.appco }}"
      suseRegistry: "{{ secrets.scc }}"
      nvidia: "{{ secrets.nvidia }}"
      values: { appCatalog: { useStaticCatalog: false } }
`;

describe("ai-factory", () => {
    let registered: Awaited<ReturnType<typeof runProgram>> = [];
    it("installs the operator on Rancher's cluster with the registry logins", async () => {
        registered = await runProgram(LAB, {
            secrets: {
                "ssh-key": "k", hv: { username: "u", password: "p" }, admin: "a", cloudflare: { token: "c" },
                appco: { username: "ac-user", password: "ac-token" }, scc: { username: "scc-user", password: "scc-pass" }, nvidia: "ngc-key",
            },
        });
        const release = registered.find(r => r.type === "kubernetes:helm.sh/v3:Release" && r.name === "rancher/ai-factory/chart");
        expect(release, registered.filter(r => r.type.includes("Release")).map(r => r.name).join(", ")).toBeDefined();
        expect(release!.inputs).toMatchObject({ chart: "oci://ghcr.io/suse/chart/aif-operator", version: "2.3.1", namespace: "aif-operator" });
        // A secret output: the logins stay encrypted in the stack's state.
        const SECRET = "4dabf18193072939515e22adb298388d";
        expect(release!.inputs.values[SECRET]).toBe("1b47061264138c4ac30d75fd1eb44270");
        const values = release!.inputs.values.value;
        expect(values.credentials).toEqual({
            applicationCollection: { username: "ac-user", password: "ac-token" },
            suseRegistry: { username: "scc-user", password: "scc-pass" },
            nvidia: { username: "$oauthtoken", password: "ngc-key" },
        });
        // The lab's own values go in too.
        expect(values.appCatalog).toEqual({ useStaticCatalog: false });
    }, 30000);

    it("creates Fleet's suse-observability HelmOp next to the GitRepos", async () => {
        const op = registered.find(r => r.type === "kubernetes:fleet.cattle.io/v1alpha1:HelmOp");
        expect(op, registered.filter(r => r.type.includes("fleet")).map(r => `${r.type} ${r.name}`).join(", ")).toBeDefined();
        expect(op!.inputs).toMatchObject({
            metadata: { name: "suse-observability", namespace: "fleet-default" },
            spec: {
                helm: { repo: "https://charts.rancher.com/server-charts/prime/suse-observability", chart: "suse-observability", version: "2.12.0" },
                defaultNamespace: "suse-observability",
                targets: [{ clusterSelector: { matchLabels: { "needs-observability": "true" } } }],
            },
        });
    });
});
