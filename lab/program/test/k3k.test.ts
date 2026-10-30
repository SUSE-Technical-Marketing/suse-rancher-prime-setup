import { describe, expect, it } from "vitest";
import { runProgram } from "./run-program";

// The whole program under Pulumi's mocks, for a lab with two k3k clusters in one parent and one
// in another: what it registers, without any cluster.

const LAB = `apiVersion: lab.geeko.me/v1alpha1
kind: Lab
metadata: { name: k3k-test }
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
kind: DownstreamCluster
metadata: { name: apps }
spec: { type: harvester, rancher: rancher, harvester: hv, pools: [ { name: all, quantity: 1, roles: [ etcd, controlplane, worker ], os: leap-16 } ] }
---
kind: DownstreamCluster
metadata: { name: edge }
spec: { type: harvester, rancher: rancher, harvester: hv, distro: k3s, pools: [ { name: all, quantity: 1, roles: [ etcd, controlplane, worker ], os: leap-16 } ] }
---
kind: DownstreamCluster
metadata: { name: team-a }
spec: { type: k3k, rancher: rancher, parent: apps, labels: { team: a } }
---
kind: DownstreamCluster
metadata: { name: team-b }
spec: { type: k3k, rancher: rancher, parent: apps, mode: virtual, servers: 1, agents: 2, persistence: { type: ephemeral } }
---
kind: DownstreamCluster
metadata: { name: team-c }
spec: { type: k3k, rancher: rancher, parent: edge, namespace: tenants }
`;

describe("k3k clusters", () => {
    it("installs the operator once per parent, and imports each k3k cluster into Rancher", async () => {
        const registered = await runProgram(LAB, { secrets: { "ssh-key": "k", hv: { username: "u", password: "p" }, admin: "a", cf: "c" } });
        const named = (type: string) => registered.filter(r => r.type === type).map(r => r.name).sort();

        // One operator per parent: apps has two k3k clusters, edge one.
        expect(registered.filter(r => r.name.endsWith("/k3k-operator")).map(r => r.name).sort()).toEqual(["downstream/apps/k3k-operator", "downstream/edge/k3k-operator"]);
        expect(named("kubernetes:k3k.io/v1beta1:Cluster")).toEqual(["downstream/team-a/k3k", "downstream/team-b/k3k", "downstream/team-c/k3k"]);

        const k3k = Object.fromEntries(registered.filter(r => r.type === "kubernetes:k3k.io/v1beta1:Cluster").map(r => [r.name, r.inputs]));
        expect(k3k["downstream/team-a/k3k"].metadata.namespace).toBe("k3k-team-a");
        expect(k3k["downstream/team-a/k3k"].spec).toMatchObject({ mode: "shared", servers: 1, agents: 0 });
        expect(k3k["downstream/team-b/k3k"].spec).toMatchObject({ mode: "virtual", agents: 2, persistence: { type: "ephemeral" } });
        expect(k3k["downstream/team-c/k3k"].metadata.namespace).toBe("tenants");

        const rancherCluster = registered.find(r => r.type === "kubernetes:provisioning.cattle.io/v1:Cluster" && r.name === "downstream/team-a/cluster")!;
        expect(rancherCluster.inputs.spec).toEqual({});
        expect(rancherCluster.inputs.metadata.labels).toEqual({ team: "a" });
        // No labels: no labels key, rather than an empty map Kubernetes drops (a diff on every preview).
        const parent = registered.find(r => r.type === "kubernetes:provisioning.cattle.io/v1:Cluster" && r.name === "downstream/apps/cluster")!;
        expect(parent.inputs.metadata).not.toHaveProperty("labels");
        expect(rancherCluster.inputs.metadata.annotations).toMatchObject({
            "ui.rancher/provider": "k3k",
            "ui.rancher/parent-cluster": "c-m-apps",
            "ui.rancher/parent-cluster-display": "apps",
            "ui.rancher/k3k-namespace": "k3k-team-a",
        });

        const job = registered.find(r => r.name === "downstream/team-c/import")!;
        expect(job.inputs.metadata.namespace).toBe("tenants");
        expect(job.inputs.spec.template.spec.volumes[0].secret.secretName).toBe("k3k-team-c-kubeconfig");
        expect(job.inputs.spec.template.spec.containers[0].image).toBe("rancher/shell:v0.8.3");

        // Ready is the imported cluster's management cluster's Ready condition.
        const ready = registered.find(r => r.name === "downstream/team-a/ready")!;
        expect(ready.inputs).toMatchObject({ path: "/apis/management.cattle.io/v3/clusters/c-m-x", condition: "Ready" });
    }, 30000);
});
