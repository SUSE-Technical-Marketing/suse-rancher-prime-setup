import { describe, expect, it } from "vitest";
import { runProgram } from "./run-program";

// The whole program under Pulumi's mocks, for Hauler both ways: as systemd services on a plain VM,
// and with its chart on a Rancher host's cluster.

const LAB = `apiVersion: lab.geeko.me/v1alpha1
kind: Lab
metadata: { name: hauler-test }
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
metadata: { name: registry }
spec:
  harvester: hv
  os: leap-16
  profiles:
    hauler: { manifests: [ rancher-2.15 ], fileserverPort: 8080 }
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
    hauler-chart: { manifests: [ rancher-2.15 ], storage: 20Gi }
`;

describe("hauler", () => {
    let registered: Awaited<ReturnType<typeof runProgram>> = [];
    it("sets the registry up on a plain VM with one uploaded script, after cloud-init", async () => {
        registered = await runProgram(LAB, {
            secrets: { "ssh-key": "k", hv: { username: "u", password: "p" }, admin: "a", cloudflare: { token: "cf-token" } },
        });
        const setup = registered.find(r => r.type === "command:remote:Command" && r.name === "registry/hauler/setup");
        expect(setup, registered.filter(r => r.type.startsWith("command:")).map(r => r.name).join(", ")).toBeDefined();
        expect(setup!.inputs.create).toContain("/var/lib/lab/hauler.sh");
        expect(setup!.inputs.delete).toContain("rm -rf /var/lib/hauler");
        // The script holds the Cloudflare token: a secret.
        const SECRET = "4dabf18193072939515e22adb298388d";
        const script: string = setup!.inputs.stdin.value;
        expect(setup!.inputs.stdin[SECRET]).toBeDefined();
        expect(script).toContain("CLOUDFLARE_DNS_API_TOKEN=cf-token");
        expect(script).toContain("hauler_2.1.2_linux_${arch}.tar.gz");
        expect(script).toContain("--server 'https://acme-staging-v02.api.letsencrypt.org/directory'");
        expect(script).toContain("--domains 'registry.lab.example.com'");
        expect(script).toContain("kind: Charts");
        expect(script).toContain("serve fileserver --directory /var/lib/hauler/fileserver --port 8080");
    }, 30000);

    it("installs the chart on Rancher's cluster, then syncs its store with a Job", async () => {
        const release = registered.find(r => r.type === "kubernetes:helm.sh/v3:Release" && r.name === "rancher/hauler-chart/chart");
        expect(release, registered.filter(r => r.type.includes("Release")).map(r => r.name).join(", ")).toBeDefined();
        expect(release!.inputs).toMatchObject({ chart: "hauler-helm", version: "2.4.2", namespace: "hauler" });
        expect(release!.inputs.values).toMatchObject({
            hauler: { data: { pvc: { accessModes: "ReadWriteOnce", storageRequest: "20Gi" } } },
            haulerRegistry: { ingress: { hostname: "registry.rancher.lab.example.com", tls: { enabled: true, secretName: "wildcard-cert" } } },
        });
        const configMap = registered.find(r => r.type === "kubernetes:core/v1:ConfigMap" && r.name === "rancher/hauler-chart/manifests");
        expect(Object.keys(configMap!.inputs.data)).toEqual(["rancher-2.15.yaml"]);
        const job = registered.find(r => r.type === "kubernetes:batch/v1:Job" && r.name === "rancher/hauler-chart/sync");
        expect(job!.inputs.metadata.annotations).toMatchObject({ "pulumi.com/waitFor": "condition=Complete", "pulumi.com/timeoutSeconds": "7200" });
    });
});
