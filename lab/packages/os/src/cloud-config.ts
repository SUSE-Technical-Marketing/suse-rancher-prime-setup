import type { OsFamily, ResolvedOs } from "@lab/schema";
import { stringify } from "yaml";

export interface CloudConfigInput {
    os: ResolvedOs;
    /** Left out for machines Rancher provisions: it names them. */
    hostname?: string;
    fqdn?: string;
    /** The login created on the VM; the image's own default user is not created. */
    user: { name: string; publicKey: string };
    /**
     * Make the login cloud-init's default user. Rancher's node driver adds its SSH key at the
     * top level of the user data, which is where the default user's keys go.
     */
    defaultUser?: boolean;
    /** Registration code for OSes with `registration.suseconnect`, already resolved. */
    regcode?: string;
    /** Add the OS profile's `k8s.packages` (the host runs k3s or RKE2). */
    kubernetes?: boolean;
    /** Extra commands, run after packages are installed (profiles add these). */
    runcmd?: string[];
}

/** How one OS family adds repositories, registers and installs packages. */
interface Family {
    addRepos(repos: ResolvedOs["repos"]): string[];
    register(os: ResolvedOs, regcode: string | undefined): string[];
    install(packages: string[]): string[];
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const FAMILIES: Record<OsFamily, Family> = {
    suse: {
        addRepos: repos => repos.flatMap(r => [
            ...(r.gpgkey ? [`rpm --import ${quote(r.gpgkey)}`] : []),
            `zypper --non-interactive addrepo --refresh ${r.gpgkey ? "" : "--no-gpgcheck "}${quote(r.url)} ${quote(r.name)}`,
        ]),
        register: (os, regcode) => {
            if (!os.registration?.suseconnect) return [];
            if (!regcode) throw new Error(`OS ${os.name} needs a registration code`);
            return [`suseconnect --regcode ${quote(regcode)}`];
        },
        install: packages => packages.length === 0 ? [] : [
            "zypper --non-interactive --gpg-auto-import-keys refresh",
            `zypper --non-interactive install --no-recommends ${packages.map(quote).join(" ")}`,
        ],
    },
    rhel: {
        addRepos: repos => repos.flatMap(r => [
            ...(r.gpgkey ? [`rpm --import ${quote(r.gpgkey)}`] : []),
            `dnf config-manager --add-repo ${quote(r.url)}`,
        ]),
        register: () => [],
        install: packages => packages.length === 0 ? [] : [`dnf -y install ${packages.map(quote).join(" ")}`],
    },
    debian: {
        addRepos: repos => {
            if (repos.length > 0) throw new Error("repos: are not supported for the debian family yet");
            return [];
        },
        register: () => [],
        install: packages => packages.length === 0 ? [] : [
            "apt-get update",
            `DEBIAN_FRONTEND=noninteractive apt-get install -y ${packages.map(quote).join(" ")}`,
        ],
    },
};

/**
 * Render `#cloud-config` user data for a host from its OS profile. Everything order-sensitive
 * (registration, repositories, packages) runs in `runcmd`, because cloud-init's `packages:`
 * module runs before `runcmd` and an unregistered SLES can't install anything.
 */
export function renderCloudConfig(input: CloudConfigInput): string {
    const { os } = input;
    const family = FAMILIES[os.family];
    const packages = [...new Set([...os.packages, ...(input.kubernetes ? os.k8s.packages : [])])];

    const login = {
        name: input.user.name,
        sudo: "ALL=(ALL) NOPASSWD:ALL",
        shell: "/bin/bash",
        lock_passwd: true,
    };
    const config: Record<string, unknown> = {
        ...(input.hostname ? { hostname: input.hostname, fqdn: input.fqdn, prefer_fqdn_over_hostname: false, manage_etc_hosts: true } : {}),
        ...(input.defaultUser
            ? { system_info: { default_user: login }, users: ["default"], ssh_authorized_keys: [input.user.publicKey] }
            : { users: [{ ...login, ssh_authorized_keys: [input.user.publicKey] }] }),
        ssh_pwauth: false,
        runcmd: [
            ...family.register(os, input.regcode),
            ...family.addRepos(os.repos),
            ...family.install(packages),
            ...(packages.includes("qemu-guest-agent") ? ["systemctl enable --now qemu-guest-agent"] : []),
            ...(input.runcmd ?? []),
        ],
        // Profile-specific raw cloud-config wins, key by key.
        ...os.cloudInit,
    };
    return `#cloud-config\n${stringify(config, { lineWidth: 0 })}`;
}
