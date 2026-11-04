import { describe, expect, it } from "vitest";
import { runProgram } from "./run-program";

// The whole program under Pulumi's mocks: the ai-demos ResourceProfile next to ai-factory on Rancher's
// host. Its objects only, no chart: the demos' ClusterRepos, and the GitRepo Fleet applies the blueprints from.

const LAB = `apiVersion: lab.geeko.me/v1alpha1
kind: Lab
metadata: { name: demos-test }
spec:
  domain: lab.example.com
  tls: { acme: letsencrypt, email: a@example.com, cloudflare: "{{ secrets.cloudflare.token }}" }
  ssh: { publicKey: "ssh-ed25519 AAAA test", privateKey: "{{ secrets['ssh-key'] }}" }
---
kind: Harvester
metadata: { name: hv }
spec: { url: https://hv.example.com, credentials: "{{ secrets.hv }}" }
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
    ai-factory: { applicationCollection: "{{ secrets.appco }}", suseRegistry: "{{ secrets.scc }}" }
    ai-demos: { blueprintsBranch: try-this }
`;

describe("AI demos on SUSE AI Factory", () => {
    it("registers the demos' chart repositories and their blueprints' GitRepo, objects of their own", async () => {
        const registered = await runProgram(LAB, {
            secrets: { "ssh-key": "k", hv: { username: "u", password: "p" }, admin: "a", cloudflare: { token: "c" }, appco: { username: "me", password: "pw" }, scc: { username: "me", password: "pw" } },
        });
        const find = (name: string) => registered.find(r => r.name === name);
        expect(find("rancher/ai-demos")?.type).toBe("lab:apps:ResourceProfile");
        expect(find("rancher/ai-demos/chart-repo")!.inputs).toMatchObject({
            apiVersion: "catalog.cattle.io/v1", kind: "ClusterRepo", metadata: { name: "wiredquill-ai-demos" },
            spec: { gitRepo: "https://github.com/wiredquill/ai-demos", gitBranch: "aif/hr-assistant-vllm" },
        });
        expect(find("rancher/ai-demos/upstream-chart-repo")!.inputs).toMatchObject({ metadata: { name: "wiredquill-upstream" }, spec: { gitBranch: "aif/upstream-charts" } });
        expect(find("rancher/ai-demos/blueprints")!.inputs).toMatchObject({
            apiVersion: "fleet.cattle.io/v1alpha1", kind: "GitRepo", metadata: { name: "ai-demos-blueprints", namespace: "fleet-local" },
            spec: { repo: "https://github.com/wiredquill/ai-demos", branch: "try-this", paths: ["catalog/blueprints"] },
        });
        // No chart of its own.
        expect(registered.filter(r => r.name.startsWith("rancher/ai-demos") && r.type.includes("helm"))).toEqual([]);
    }, 30000);
});
