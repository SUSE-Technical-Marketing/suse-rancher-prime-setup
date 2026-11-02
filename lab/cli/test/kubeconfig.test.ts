import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { kubeconfigPath, mergeKubeconfigs, writeKubeconfig } from "../src/kubeconfig";

// A host's kubeconfig as the program has it (JSON, from the host) and a downstream cluster's (through Rancher).
const HOST = JSON.stringify({
    apiVersion: "v1", kind: "Config", "current-context": "odin",
    clusters: [{ name: "odin", cluster: { server: "https://10.0.0.1:6443", "certificate-authority-data": "Q0E=" } }],
    users: [{ name: "odin", user: { "client-certificate-data": "Q0VSVA==", "client-key-data": "S0VZ" } }],
    contexts: [{ name: "odin", context: { cluster: "odin", user: "odin" } }],
});
const DOWNSTREAM = `apiVersion: v1
kind: Config
clusters: [ { name: c, cluster: { server: "https://rancher.example.com/k8s/clusters/c-m-1", insecure-skip-tls-verify: true } } ]
users: [ { name: u, user: { token: "kubeconfig-t" } } ]
contexts: [ { name: x, context: { cluster: c, user: u, namespace: apps } } ]
current-context: x
`;

describe("the lab's kubeconfig", () => {
    it("has a context per cluster, named after it, the Rancher host's current", () => {
        const kc = parse(mergeKubeconfigs({ odin: HOST, freya: DOWNSTREAM }, "odin"));
        expect(kc.contexts).toEqual([
            { name: "freya", context: { cluster: "freya", user: "freya", namespace: "apps" } },
            { name: "odin", context: { cluster: "odin", user: "odin" } },
        ]);
        expect(kc.clusters.find((c: any) => c.name === "freya").cluster).toEqual({ server: "https://rancher.example.com/k8s/clusters/c-m-1", "insecure-skip-tls-verify": true });
        expect(kc.users.find((u: any) => u.name === "odin").user).toEqual({ "client-certificate-data": "Q0VSVA==", "client-key-data": "S0VZ" });
        expect(kc["current-context"]).toBe("odin");
        expect(parse(mergeKubeconfigs({ odin: HOST, freya: DOWNSTREAM }))["current-context"]).toBe("freya");
    });

    it("goes next to the lab file, readable by its owner only", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lab-kubeconfig-"));
        const file = kubeconfigPath(path.join(dir, "my.yaml"), "asgard-odin");
        expect(file).toBe(path.join(dir, "asgard-odin.kubeconfig"));
        writeKubeconfig(file, "x");
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
