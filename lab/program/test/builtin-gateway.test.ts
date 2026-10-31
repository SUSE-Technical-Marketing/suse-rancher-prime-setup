import { describe, expect, it } from "vitest";
import { runProgram } from "./run-program";

// The whole program under Pulumi's mocks, for Rancher on RKE2's own Traefik: its Gateway provider is
// turned on with a HelmChartConfig, and Rancher goes on the Gateway API. And a k3s host, whose
// Traefik gets the Gateway API CRDs first: k3s doesn't ship them, RKE2 does.

const LAB = `apiVersion: lab.geeko.me/v1alpha1
kind: Lab
metadata: { name: gw-test }
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
---
kind: HarvesterVM
metadata: { name: rancher }
spec:
  harvester: hv
  os: leap-16
  profiles: { rke2: {}, cert-manager: {}, sprouter: {}, rancher: { adminPassword: "{{ secrets.admin }}" } }
---
kind: HarvesterVM
metadata: { name: apps }
spec: { harvester: hv, os: leap-16, profiles: { k3s: {}, metallb: { addresses: [ 10.0.20.200-10.0.20.210 ] } } }
`;

describe("the distribution's own Traefik", () => {
    let registered: Awaited<ReturnType<typeof runProgram>> = [];
    it("gets its Gateway provider, and Rancher a Gateway on it", async () => {
        registered = await runProgram(LAB, { secrets: { "ssh-key": "k", hv: { username: "u", password: "p" }, admin: "a", cf: "c" } });
        const config = registered.find(r => r.type === "kubernetes:helm.cattle.io/v1:HelmChartConfig" && r.name === "rancher/rke2/ingress-config");
        expect(config?.inputs).toMatchObject({ metadata: { name: "rke2-traefik", namespace: "kube-system" } });
        expect(JSON.parse(config!.inputs.spec.valuesContent)).toEqual({ providers: { kubernetesGateway: { enabled: true } } });
        expect(registered.some(r => r.name === "rancher/rke2/gateway-class")).toBe(true);
        const chart = registered.find(r => r.type === "kubernetes:helm.sh/v3:Release" && r.name === "rancher/rancher/chart");
        expect(chart, registered.map(r => r.name).join(", ")).toBeDefined();
        expect(registered.some(r => r.name === "rancher/rke2/gateway-api")).toBe(false);

        // k3s: the CRDs from the catalog's gateway-api Manifest, then its Traefik's config.
        const crds = registered.find(r => r.name === "apps/k3s/gateway-api");
        expect(crds?.inputs.file).toMatch(/gateway-api\/releases\/download\/v[\d.]+\/standard-install\.yaml$/);
        expect(registered.find(r => r.name === "apps/k3s/ingress-config")?.inputs).toMatchObject({ metadata: { name: "traefik", namespace: "kube-system" } });
    }, 30000);

    it("creates MetalLB's pool from its ChartProfile, once the webhook admits it", async () => {
        const one = (type: string, name: string) => registered.find(r => r.type === type && r.name === name);
        expect(one("kubernetes:helm.sh/v3:Release", "apps/metallb/chart")?.inputs).toMatchObject({ name: "metallb", namespace: "metallb-system" });
        expect(one("pulumi-nodejs:dynamic/lab:KubeAdmitted", "apps/metallb/pool/admitted")?.inputs).toMatchObject({ path: "/apis/metallb.io/v1beta1/namespaces/metallb-system/ipaddresspools" });
        expect(one("kubernetes:metallb.io/v1beta1:IPAddressPool", "apps/metallb/pool")?.inputs).toMatchObject({ metadata: { name: "lab", namespace: "metallb-system" }, spec: { addresses: ["10.0.20.200-10.0.20.210"] } });
        expect(one("kubernetes:metallb.io/v1beta1:L2Advertisement", "apps/metallb/l2")?.inputs.spec).toEqual({ ipAddressPools: ["lab"] });
    });

    it("creates cert-manager's objects from its Profile, under the names they always had", async () => {
        const one = (type: string, name: string) => registered.find(r => r.type === type && r.name === name);
        const token = one("kubernetes:core/v1:Secret", "rancher/cert-manager/cloudflare-token");
        expect(token?.inputs.metadata).toMatchObject({ name: "cloudflare-api-token", namespace: "cert-manager" });
        // The token is the secret's value, and stays a secret.
        expect(token?.inputs.stringData).toEqual({ "4dabf18193072939515e22adb298388d": "1b47061264138c4ac30d75fd1eb44270", value: { "api-token": "c" } });
        expect(one("kubernetes:cert-manager.io/v1:ClusterIssuer", "rancher/cert-manager/letsencrypt-staging")?.inputs.spec.acme).toMatchObject({
            server: "https://acme-staging-v02.api.letsencrypt.org/directory", email: "a@example.com", privateKeySecretRef: { name: "letsencrypt-staging" },
        });
        const cert = one("kubernetes:cert-manager.io/v1:Certificate", "rancher/cert-manager/wildcard");
        expect(cert?.inputs.spec).toMatchObject({ secretName: "wildcard-cert", dnsNames: ["*.rancher.lab.example.com", "rancher.lab.example.com"], issuerRef: { name: "letsencrypt-staging" } });
        expect(cert?.inputs.metadata.annotations).toMatchObject({ "pulumi.com/waitFor": "condition=Ready" });
    });
});
