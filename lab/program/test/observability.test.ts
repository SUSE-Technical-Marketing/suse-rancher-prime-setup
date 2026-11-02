import { describe, expect, it } from "vitest";
import { runProgram } from "./run-program";

// The whole program under Pulumi's mocks: SUSE Observability agents on a Rancher host, a downstream
// cluster and the Harvester itself, each registered with the instance Fleet runs on cluster obs.

const AGENT = "suse-observability-agent: { observer: obs }";
const POOL = "pools: [ { name: all, quantity: 1, roles: [ etcd, controlplane, worker ], os: leap-16 } ]";
const LAB = `apiVersion: lab.geeko.me/v1alpha1
kind: Lab
metadata: { name: obs-test }
spec:
  domain: lab.example.com
  tls: { acme: letsencrypt-staging, email: a@example.com, cloudflare: "{{ secrets.cloudflare.token }}" }
  ssh: { publicKey: "ssh-ed25519 AAAA test", privateKey: "{{ secrets['ssh-key'] }}" }
  inputs:
    suse-observability-license: "{{ secrets.observability.license }}"
    suse-observability-token: "{{ secrets.observability.token }}"
    suse-observability-password: "{{ secrets.observability.password }}"
---
kind: Harvester
metadata: { name: hv }
spec:
  url: https://hv.example.com
  credentials: "{{ secrets.hv }}"
  profiles: { ${AGENT} }
---
kind: HarvesterVM
metadata: { name: rancher }
spec:
  harvester: hv
  os: leap-16
  profiles: { k3s: {}, cert-manager: {}, sprouter: {}, traefik: {}, outrider: {}, rancher: { adminPassword: "{{ secrets.admin }}" }, ${AGENT} }
---
kind: DownstreamCluster
metadata: { name: obs }
spec: { type: harvester, rancher: rancher, harvester: hv, ${POOL}, fleetProfiles: { storage: {}, observability: {} } }
---
kind: DownstreamCluster
metadata: { name: apps }
spec: { type: harvester, rancher: rancher, harvester: hv, ${POOL}, profiles: { suse-observability-agent: { observer: obs, clusterName: apps-cluster, values: { logLevel: debug } } } }
`;

describe("SUSE Observability agents", () => {
    let registered: Awaited<ReturnType<typeof runProgram>> = [];
    const find = (name: string) => registered.find(r => r.name === name);

    it("registers each agent with the observer's API, as agent-<cluster name>", async () => {
        registered = await runProgram(LAB, {
            secrets: { "ssh-key": "k", hv: { username: "u", password: "p" }, admin: "a", cloudflare: { token: "c" }, observability: { license: "l", token: "obs-admin-token", password: "pw" } },
        });
        const registrations = registered.filter(r => r.type === "pulumi-nodejs:dynamic/lab:ObservabilityRegistration");
        expect(registrations.map(r => r.name).sort()).toEqual([
            "downstream/apps/suse-observability-agent/registration", "hv/suse-observability-agent/registration", "rancher/suse-observability-agent/registration",
        ]);
        expect(find("downstream/apps/suse-observability-agent/registration")!.inputs).toMatchObject({
            url: "https://observability.obs.lab.example.com", subject: "agent-apps-cluster", insecure: true, timeoutSeconds: 3600,
        });
        expect(find("rancher/suse-observability-agent/registration")!.inputs.subject).toBe("agent-rancher");
        // The admin token is a secret input.
        expect(JSON.stringify(find("hv/suse-observability-agent/registration")!.inputs.adminToken)).toContain("obs-admin-token");
        expect(find("hv/suse-observability-agent/registration")!.inputs.adminToken["4dabf18193072939515e22adb298388d"]).toBeDefined();
    }, 30000);

    it("installs the agent on clusters with its token in a Secret, reporting as the cluster's name", () => {
        const release = find("downstream/apps/suse-observability-agent/chart")!;
        expect(release.inputs).toMatchObject({ chart: "suse-observability-agent", namespace: "suse-observability-agent", version: "1.7.19" });
        expect(release.inputs.values).toMatchObject({
            logLevel: "debug",
            stackstate: { url: "https://observability.obs.lab.example.com/receiver/stsAgent", cluster: { name: "apps-cluster" } },
            global: { apiKey: { fromSecret: "suse-observability-agent-key" } },
        });
        expect(find("downstream/apps/suse-observability-agent/token")!.inputs.metadata.name).toBe("suse-observability-agent-key");
        expect(find("rancher/suse-observability-agent/chart")!.inputs.values.stackstate.cluster.name).toBe("rancher");
    });

    it("installs it on the Harvester as an add-on, the token out of its values", () => {
        const addon = find("hv/suse-observability-agent")!;
        expect(addon.type).toBe("pulumi-nodejs:dynamic/lab:HarvesterAddon");
        expect(addon.inputs).toMatchObject({ name: "suse-observability-agent", namespace: "suse-observability-agent", repo: "https://charts.rancher.com/server-charts/prime/suse-observability" });
        expect(JSON.parse(addon.inputs.valuesContent)).toEqual({
            stackstate: { url: "https://observability.obs.lab.example.com/receiver/stsAgent", cluster: { name: "hv" } },
            global: { apiKey: { fromSecret: "suse-observability-agent-key" } },
        });
        expect(find("hv/suse-observability-agent/token")).toBeDefined();
    });

    it("redeploys SUSE Observability when the values it reads from fleet-secrets change", () => {
        // Fleet doesn't watch valuesFrom: a fingerprint of them, as forceSyncGeneration, changes the HelmOp.
        const op = registered.find(r => r.type === "kubernetes:fleet.cattle.io/v1alpha1:HelmOp" && r.name.endsWith("/suse-observability"))!;
        expect(op.inputs.spec.helm.valuesFrom).toEqual([{ secretKeyRef: { name: "fleet-secrets", namespace: "kube-system", key: "suse-observability-values.yaml" } }]);
        expect(typeof op.inputs.spec.forceSyncGeneration).toBe("number");
        expect(op.inputs.spec.forceSyncGeneration).toBeGreaterThan(0);
    });
});
