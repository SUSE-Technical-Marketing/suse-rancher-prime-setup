import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as harvester from "@suse-tmm/harvester";
import * as rancher from "@suse-tmm/rancher-kubeconfig";
import "@suse-tmm/utils/src/stripMargin";

export function provisionHarvester() {
    const config = new pulumi.Config("harvester");
    const harvesterUrl = config.require("url");
    const username = config.require("username");
    const password = config.requireSecret("password");

    const kubeconfig = new rancher.RancherKubeconfig("harvesterKubeconfig", {
        url: harvesterUrl,
        username: username,
        password: password,
        clusterName: "local",
        insecure: true, // Harvester normally has a self-signed cert
    });

    const harvesterBase = new harvester.HarvesterBase("harvesterBase", {
        kubeconfig: kubeconfig.kubeconfig,
        extraImages: [
            {
                name: "fedora-cloud-42",
                displayName: "Fedora Cloud 42",
                url: "https://download.fedoraproject.org/pub/fedora/linux/releases/42/Cloud/x86_64/images/Fedora-Cloud-Base-Generic-42-1.1.x86_64.qcow2"
            }
        ]
    });

    const openSuseImage = harvesterBase.images.apply(images => images.get("opensuse-leap-15.6")!);
    const network = harvesterBase.networks.apply(networks => networks.get("backbone-vlan")!);
    const harvesterVm = new harvester.HarvesterVm("control-tower", {
        kubeconfig: kubeconfig.kubeconfig,
        virtualMachine: {
            namespace: "harvester-public",
            resources: {
                cpu: 2,
                memory: "4Gi"
            },
            network: {
                name: network.metadata.name,
                namespace: network.metadata.namespace
            },
            disk: {
                name: "disk0",
                size: "10Gi",
                image: openSuseImage
            },
            cloudInit: {
                users: [
                    {
                        name: "jeroen",
                        password: "$6$FwXqnOc8hOs0Z65p$ZoBsbamvwbew.ryHzIqW3yy0pUgCHCbhq6WqRWuHwclg66imPz4uGwX0SrgLm7kk6d3Ji/Na32pN8ktZrGPhx1",
                        sshAuthorizedKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBSE68VYUiwL5a8xcmv34RZ1OYnrEcRBe4NaeKpE/twU jeroen@hierynomus.com",
                            "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDDmt6+SsXzLoRptifmSKlyjq6grRf4Yb1f2g0Etn7PKUK0LLKO3qZmSEgDwhohALXU7ZhSMVttYgLCjtFd4kG/JEdJVkGSqppLekgpc/T3yG8K3sO78UBdWtnLVY/6MtIHC1GHsAikTuPIJfIqftIk1RZwLKfIIgkT3HQAl9Kzn45QCVj4RrOhekHmqlgePrasTe1HKFRjQ/cuM6cqHSaPNWHrgshlci5BVTS6hqjNxeW/Rb/X4vDcvs/5glRvd0M3ESr1Aii5fhATzHSCGUje2U91ztRDvXdZQNsxQGPP1oTVTRa0oxKutpZee5lMEUjwU6hzoAx3jxPehayFjWJh"
                        ]
                    }
                ],
                packages: ["curl", "qemu-guest-agent", "helm"],
                packageUpdate: true,
                writeFiles: [
                    {
                        path: "/etc/sysctl.d/99-disable-ipv6.conf",
                        permissions: "0644",
                        content: `
                            |net.ipv6.conf.all.disable_ipv6 = 1
                            |net.ipv6.conf.default.disable_ipv6 = 1
                            |net.ipv6.conf.lo.disable_ipv6 = 1`.stripMargin()
                    },
                    {
                        path: "/etc/rancher/k3s/config.yaml",
                        content: `
                            |write-kubeconfig-mode: "0644"
                            |tls-san:
                            |- {{ ds.meta_data.local_hostname }}.lab.geeko.me
                        `.stripMargin(),
                    },
                    {
                        path: "/tmp/install_k3s.sh",
                        content: `
                            |#!/bin/bash
                            |set -e
                            |curl -sfL https://get.k3s.io -o get-k3s.sh
                            |INSTALL_K3S_CHANNEL="v1.31.5+k3s1" INSTALL_K3S_EXEC="--disable=traefik" sh get-k3s.sh`.stripMargin(),
                        permissions: '0755'
                    }
                ],
                runcmd: [
                    "firewall-cmd --permanent --add-port=6443/tcp #apiserver",
                    "firewall-cmd --permanent --zone=trusted --add-source=10.42.0.0/16 #pods",
                    "firewall-cmd --permanent --zone=trusted --add-source=10.43.0.0/16 #services",
                    "firewall-cmd --reload",
                    "echo \"net.ipv6.conf.all.disable_ipv6=1\" >> /etc/sysctl.conf",
                    "echo \"net.ipv6.conf.default.disable_ipv6=1\" >> /etc/sysctl.conf",
                    "echo \"net.ipv6.conf.tun0.disable_ipv6=1\" >> /etc/sysctl.conf",
                    "sysctl -p",
                    "sudo /tmp/install_k3s.sh",
                    ["systemctl", "enable", "--now", "qemu-guest-agent.service"]
                ]
            }
        }
    });

    pulumi.all([kubeconfig.kubeconfig]).apply(([kubeconfig]) => {
        pulumi.log.info(kubeconfig);
    });
}

provisionHarvester();
