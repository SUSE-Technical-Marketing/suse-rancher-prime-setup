import "./stripMargin";
import { CloudInitProcessor, CloudInitUser, CloudInitUserArgs, PackageArgs, CmdArgs } from "./cloud-init";

export const DisableIpv6: CloudInitProcessor = (args) => {
    args.writeFiles = args.writeFiles.concat({
        path: "/etc/sysctl.d/99-disable-ipv6.conf",
        permissions: "0644",
        content: `
        |net.ipv6.conf.all.disable_ipv6 = 1
        |net.ipv6.conf.default.disable_ipv6 = 1
        |net.ipv6.conf.lo.disable_ipv6 = 1`.stripMargin()
    });
    args.runcmd = args.runcmd.concat(
        "sysctl -p /etc/sysctl.d/99-disable-ipv6.conf                 # Disable IPv6"
    );
    args.bootcmd = args.bootcmd.concat(
        "sysctl -w net.ipv6.conf.all.disable_ipv6=1",
        "sysctl -w net.ipv6.conf.default.disable_ipv6=1",
    );
    return args;
};

export const BashRcLocal: CloudInitProcessor = (args) => {
    args.packages = args.packages.concat("fastfetch");
    args.writeFiles = args.writeFiles.concat({
        path: "/etc/bash.bashrc.local",
        permissions: '0644',
        content: `
            |# System-wide Bash aliases and login commands
            |alias ll='ls -la'
            |alias la='ls -A'
            |alias l='ls -CF'
            |alias k='kubectl'
            |
            |if [[ $- == *i* ]]; then
            |   # Clear screen and show fastfetch on every new shell
            |   clear
            |   fastfetch
            |fi
            |
            |# Set KUBECONFIG for all users
            |export KUBECONFIG=/etc/rancher/rke2/rke2.yaml:/etc/rancher/k3s/k3s.yaml`.stripMargin()
    })
    return args;
};

export const DefaultUser: CloudInitProcessor = (cfg) => {
    cfg.users = (["default"] as CloudInitUserArgs[]).concat(cfg.users);
    return cfg;
}

export function NewUser(args: CloudInitUser): CloudInitProcessor {
    return (cfg) => {
        cfg.users = cfg.users.concat(args);
        return cfg;
    }
}

export function Packages(...args: PackageArgs[]): CloudInitProcessor {
    return (cfg) => {
        cfg.packages = cfg.packages.concat(args);
        return cfg;
    }
}

export const GuestAgent: CloudInitProcessor = (cfg) => {
    cfg.packages = cfg.packages.concat("qemu-guest-agent");
    cfg.runcmd = cfg.runcmd.concat(
        "systemctl enable --now qemu-guest-agent.service"
    );
    return cfg;
}

export const IncreaseFileLimit: CloudInitProcessor = (cfg) => {
    cfg.runcmd = cfg.runcmd.concat(
        "echo 'fs.inotify.max_user_instances = 1024' >> /etc/sysctl.conf",
        "echo 'fs.inotify.max_user_watches = 524288' >> /etc/sysctl.conf",
        "sysctl -p"
    );
    return cfg;
}

export const InstallK3s: CloudInitProcessor = (cfg) => {
    cfg.writeFiles = cfg.writeFiles.concat(
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
                |INSTALL_K3S_CHANNEL="v1.31.5+k3s1" INSTALL_K3S_EXEC="--disable=traefik" sh get-k3s.sh
            `.stripMargin(),
            permissions: '0755'
                // |export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
                // |until kubectl get --raw='/readyz?verbose'; do echo "Exit: $?"; sleep 2; done
                // |until kubectl get nodes --no-headers &>/dev/null; do sleep 2; done
                // |kubectl wait node --all --for=condition=Ready --timeout=120s
                // |helm upgrade --install ingress-nginx ingress-nginx --repo https://kubernetes.github.io/ingress-nginx --namespace ingress-nginx --create-namespace
        });
    cfg.templated = true;
    cfg.runcmd = cfg.runcmd.concat(
        "sudo /tmp/install_k3s.sh"
    );
    return cfg;
}

export const LonghornReqs: CloudInitProcessor = (cfg) => {
    cfg.packages = cfg.packages.concat("open-iscsi", "cryptsetup");
    cfg.runcmd = cfg.runcmd.concat(
        "systemctl enable --now --no-block iscsid.service",
        "modprobe iscsi_tcp",
    );
    return cfg;
}

export const PackageUpdate: CloudInitProcessor = (cfg) => {
    cfg.packageUpdate = true;
    return cfg;
}

export const PackageUpgrade: CloudInitProcessor = (cfg) => {
    cfg.packageUpgrade = true;
    return cfg;
}

export const KubeFirewall: CloudInitProcessor = (cfg) => {
    cfg.runcmd = cfg.runcmd.concat(
        "firewall-cmd --permanent --add-port=6443/tcp #apiserver",
        "firewall-cmd --permanent --zone=trusted --add-source=10.42.0.0/16 #pods",
        "firewall-cmd --permanent --zone=trusted --add-source=10.43.0.0/16 #services",
        "firewall-cmd --reload",
    );
    return cfg;
}

export function WriteFile(path: string, content: string, permissions?: string, owner?: string): CloudInitProcessor {
    return (cfg) => {
        cfg.writeFiles = cfg.writeFiles.concat({
            path,
            content,
            permissions: permissions,
            owner: owner
        });
        return cfg;
    };
}
