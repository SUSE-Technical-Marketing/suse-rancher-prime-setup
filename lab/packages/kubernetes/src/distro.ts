export type Distro = "k3s" | "rke2";

export interface DistroInstall {
    /** cloud-init `runcmd` lines that install and start the distribution. */
    runcmd: string[];
    kubeconfigPath: string;
    /** Command on the host that succeeds once the API server answers. */
    readyCheck: string;
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export interface DistroOptions {
    /**
     * Another profile runs the cloud provider (the Harvester cloud provider): no ServiceLB, no
     * built-in cloud controller, and the kubelet waits for the external one.
     */
    externalCloudProvider?: boolean;
}

/**
 * Install a single-node k3s or RKE2 server. The built-in ingress controller is disabled: ingress
 * is the `traefik` profile's job. The host's FQDN is added to the API certificate so the
 * kubeconfig works by name as well as by address.
 */
export function distroInstall(distro: Distro, version: string, fqdn: string, opts: DistroOptions = {}): DistroInstall {
    const external = opts.externalCloudProvider ?? false;
    if (distro === "k3s") {
        const args = ["server", "--disable=traefik", `--tls-san=${fqdn}`];
        if (external) args.push("--disable=servicelb", "--disable-cloud-controller", "--kubelet-arg=cloud-provider=external");
        return {
            runcmd: [
                `curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION=${quote(version)} INSTALL_K3S_EXEC=${quote(args.join(" "))} sh -`,
            ],
            kubeconfigPath: "/etc/rancher/k3s/k3s.yaml",
            // Full path: sudo's secure_path on SUSE doesn't include /usr/local/bin.
            readyCheck: "sudo /usr/local/bin/k3s kubectl get --raw /readyz",
        };
    }
    // Without an external cloud provider, ServiceLB (k3s' built-in load balancer) gives
    // LoadBalancer services such as Traefik's the node's address, as on k3s.
    const config = [
        "tls-san:", `  - ${fqdn}`,
        "disable:", "  - rke2-ingress-nginx",
        ...(external ? ["cloud-provider-name: external", "disable-cloud-controller: true"] : ["enable-servicelb: true"]),
    ];
    return {
        runcmd: [
            "mkdir -p /etc/rancher/rke2",
            `printf '%s\\n' ${config.map(quote).join(" ")} > /etc/rancher/rke2/config.yaml`,
            // The tarball install doesn't depend on an RPM repository for the host's distribution.
            `curl -sfL https://get.rke2.io | INSTALL_RKE2_VERSION=${quote(version)} INSTALL_RKE2_METHOD=tar sh -`,
            "systemctl enable --now rke2-server.service",
        ],
        kubeconfigPath: "/etc/rancher/rke2/rke2.yaml",
        readyCheck: "sudo /var/lib/rancher/rke2/bin/kubectl --kubeconfig /etc/rancher/rke2/rke2.yaml get --raw /readyz",
    };
}
