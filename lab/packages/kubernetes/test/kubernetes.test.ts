import { describe, expect, it } from "vitest";
import { distroInstall, rewriteKubeconfig } from "../src";

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

describe("distroInstall", () => {
    it("hands load balancing to an external cloud provider when asked", () => {
        const k3s = distroInstall("k3s", "v1", "vm.example.com", { externalCloudProvider: true }).runcmd[0];
        expect(k3s).toContain("--disable=servicelb --disable-cloud-controller --kubelet-arg=cloud-provider=external");
        const rke2 = distroInstall("rke2", "v1", "vm.example.com", { externalCloudProvider: true }).runcmd.join("\n");
        expect(rke2).toContain("'cloud-provider-name: external'");
        expect(rke2).not.toContain("enable-servicelb");
    });

    it("installs k3s without its Traefik and with the FQDN in the certificate", () => {
        const k3s = distroInstall("k3s", "v1.36.4+k3s1", "rancher.lab.example.com");
        expect(k3s.runcmd[0]).toContain("INSTALL_K3S_VERSION='v1.36.4+k3s1'");
        expect(k3s.runcmd[0]).toContain("--disable=traefik --tls-san=rancher.lab.example.com");
        expect(k3s.kubeconfigPath).toBe("/etc/rancher/k3s/k3s.yaml");
        expect(k3s.readyCheck).toContain("/usr/local/bin/k3s");
    });

    it("installs RKE2 from the tarball without ingress-nginx", () => {
        const rke2 = distroInstall("rke2", "v1.36.4+rke2r3", "vm.lab.example.com");
        expect(rke2.runcmd.join("\n")).toContain("rke2-ingress-nginx");
        expect(rke2.runcmd.join("\n")).toContain("enable-servicelb: true");
        expect(rke2.runcmd.join("\n")).toContain("INSTALL_RKE2_METHOD=tar");
        expect(rke2.runcmd.at(-1)).toBe("systemctl enable --now rke2-server.service");
    });
});
