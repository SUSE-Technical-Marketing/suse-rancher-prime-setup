import { describe, expect, it } from "vitest";
import type { ResolvedDistribution } from "@lab/schema";
import { parse } from "yaml";
import { distroInstall, mergeConfig, rewriteKubeconfig } from "../src";

const K3S_YAML = `apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: Q0E=
    server: https://127.0.0.1:6443
  name: default
contexts:
- context: { cluster: default, user: default }
  name: default
current-context: default
kind: Config
users:
- name: default
  user: { client-certificate-data: Q0VSVA==, client-key-data: S0VZ }
`;

describe("rewriteKubeconfig", () => {
    it("points at the host, names everything after it, and emits JSON", () => {
        const kc = JSON.parse(rewriteKubeconfig(K3S_YAML, "rancher", "10.29.20.150"));
        expect(kc.clusters).toEqual([{ name: "rancher", cluster: { "certificate-authority-data": "Q0E=", server: "https://10.29.20.150:6443" } }]);
        expect(kc.users[0]).toEqual({ name: "rancher", user: { "client-certificate-data": "Q0VSVA==", "client-key-data": "S0VZ" } });
        expect(kc["current-context"]).toBe("rancher");
    });
});

const DISTRO: ResolvedDistribution = {
    kind: "KubernetesDistribution",
    version: "v1",
    install: "curl -sfL https://get.example.com | VERSION=v1 sh -",
    configFile: "/etc/rancher/x/config.yaml",
    config: { disable: ["traefik"], "enable-servicelb": true },
    withCapability: {
        "load-balancer": { disable: ["servicelb"], "enable-servicelb": false },
        "cloud-provider": { "disable-cloud-controller": true },
    },
    kubeconfig: "/etc/rancher/x/x.yaml",
    kubectl: "/usr/local/bin/x kubectl",
    dataDir: "/var/lib/rancher/x",
    uninstall: [],
    cni: "flannel",
};

/** The config.yaml the runcmd writes. */
const written = (runcmd: string[]) => parse(/^printf '%s' '([\s\S]*)' > /.exec(runcmd[1])![1].replace(/'\\''/g, "'"));

describe("distroInstall", () => {
    it("writes the config file, with the FQDN as a tls-san, then runs the install command", () => {
        const { runcmd } = distroInstall(DISTRO, DISTRO.install, "vm.example.com");
        expect(runcmd[0]).toBe("mkdir -p '/etc/rancher/x'");
        expect(runcmd[1]).toMatch(/> '\/etc\/rancher\/x\/config.yaml'$/);
        expect(written(runcmd)).toEqual({ disable: ["traefik"], "enable-servicelb": true, "tls-san": ["vm.example.com"] });
        expect(runcmd[2]).toBe(DISTRO.install);
    });

    it("merges the config for each capability other profiles provide, joining lists", () => {
        const lb = distroInstall(DISTRO, DISTRO.install, "vm.example.com", { capabilities: ["kubernetes", "load-balancer"] });
        expect(written(lb.runcmd)).toEqual({ disable: ["traefik", "servicelb"], "enable-servicelb": false, "tls-san": ["vm.example.com"] });
        const both = distroInstall(DISTRO, DISTRO.install, "vm.example.com", { capabilities: ["load-balancer", "cloud-provider"] });
        expect(written(both.runcmd)).toMatchObject({ "enable-servicelb": false, "disable-cloud-controller": true });
    });
});

describe("mergeConfig", () => {
    it("merges maps key by key, joins lists without duplicates, and replaces scalars", () => {
        expect(mergeConfig({ a: [1, 2], m: { x: 1 }, s: "a" }, { a: [2, 3], m: { y: 2 }, s: "b" })).toEqual({ a: [1, 2, 3], m: { x: 1, y: 2 }, s: "b" });
    });
});
