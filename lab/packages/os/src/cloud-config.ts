import { createHash } from "node:crypto";
import { osCloudInit, renderTemplates, type CloudInitVars, type OsFamily, type ResolvedOs } from "@lab/schema";
import { stringify } from "yaml";

export interface CloudConfigInput {
    os: ResolvedOs;
    /** A Harvester VM: the OS profile's `harvester` part too (the guest agent). */
    harvester: boolean;
    /** It runs Kubernetes: the OS profile's `kubernetes` part too. */
    kubernetes: boolean;
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
    /** For the profile's `cloudInit` templates: its secrets' values, the lab's name and domain. */
    vars: CloudInitVars;
    /** The host's own commands (k3s / RKE2, profiles), run after the OS profile's `runcmd`. */
    runcmd?: string[];
    /** The host's own `bootcmd` lines (its profiles': Landlock), run after the OS profile's. */
    bootcmd?: string[];
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * How one OS family installs packages: for existing machines, which get no user data. A repository
 * that fails to refresh (a third-party one mid-update: NVIDIA's CUDA repo) only warns: the install
 * still fails if a package it needs isn't there. zypper's 106 is such a skipped repository, the
 * packages installed.
 */
const INSTALL: Record<OsFamily, (packages: string[]) => string[]> = {
    suse: packages => [
        `zypper --non-interactive --gpg-auto-import-keys refresh || echo "lab: zypper refresh failed (exit $?): some repositories keep their old metadata" >&2`,
        `zypper --non-interactive install --no-recommends ${packages.map(quote).join(" ")} || { rc=$?; [ "$rc" -eq 106 ] && echo "lab: zypper skipped a repository that failed to refresh" >&2 || (exit "$rc"); }`,
    ],
    rhel: packages => [`dnf -y install ${packages.map(quote).join(" ")}`],
    debian: packages => [
        `apt-get update || echo "lab: apt-get update failed (exit $?): some repositories keep their old lists" >&2`,
        `DEBIAN_FRONTEND=noninteractive apt-get install -y ${packages.map(quote).join(" ")}`,
    ],
};

/** The OS profile's cloud-config for a host, its templates rendered. */
function cloudInit(os: ResolvedOs, config: Record<string, unknown>, vars: CloudInitVars): Record<string, unknown> {
    return renderTemplates(config, vars, "cloudInit", (at, message) => {
        throw new Error(`OS profile ${os.name}: ${at}: ${message}`);
    }) as Record<string, unknown>;
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * Render `#cloud-config` user data for a host: its OS profile's `cloudInit` (templates rendered),
 * plus what the engine owns. The login and hostname are set here (profiles can't); the host's own
 * commands are appended to the profile's `runcmd`.
 */
export function renderCloudConfig(input: CloudConfigInput): string {
    const os = cloudInit(input.os, osCloudInit(input.os, { created: true, harvester: input.harvester, kubernetes: input.kubernetes }), input.vars);
    const login = {
        name: input.user.name,
        sudo: "ALL=(ALL) NOPASSWD:ALL",
        shell: "/bin/bash",
        lock_passwd: true,
    };
    const runcmd = [...list(os.runcmd), ...(input.runcmd ?? [])];
    const bootcmd = [...list(os.bootcmd), ...(input.bootcmd ?? [])];
    const config: Record<string, unknown> = {
        ssh_pwauth: false,
        ...os,
        ...(bootcmd.length > 0 ? { bootcmd } : {}),
        ...(input.hostname ? { hostname: input.hostname, fqdn: input.fqdn, prefer_fqdn_over_hostname: false, manage_etc_hosts: true } : {}),
        ...(input.defaultUser
            ? { system_info: { default_user: login }, users: ["default"], ssh_authorized_keys: [input.user.publicKey] }
            : { users: [{ ...login, ssh_authorized_keys: [input.user.publicKey] }] }),
        ...(runcmd.length > 0 ? { runcmd } : {}),
    };
    return `#cloud-config\n${stringify(config, { lineWidth: 0 })}`;
}

/**
 * Commands (run as root over SSH) that ready an existing machine for Kubernetes: the OS profile's
 * `kubernetes` part, its `packages` installed with the family's package manager, then its `runcmd`.
 * Nothing for a machine that doesn't run Kubernetes: it's someone's box, set up as it is. Other
 * cloud-config keys need cloud-init and are skipped (the resolver warns).
 */
export function machineSetup(os: ResolvedOs, vars: CloudInitVars, kubernetes: boolean): string[] {
    const config = cloudInit(os, osCloudInit(os, { created: false, harvester: false, kubernetes }), vars);
    const packages = list(config.packages).filter((p): p is string => typeof p === "string");
    const runcmd = list(config.runcmd).map(c => (Array.isArray(c) ? c.map(a => quote(String(a))).join(" ") : String(c)));
    return [...(packages.length > 0 ? INSTALL[os.family](packages) : []), ...runcmd];
}

/** A VM's fixed address, for cloud-init's network config. */
export interface FixedAddress {
    /** The interface to configure, by its MAC (the VM's fixed MAC). */
    macAddress: string;
    address: string;
    prefix: number;
    gateway: string;
    dns: string[];
    /** DNS search domains (the lab's domain). */
    search?: string[];
}

/**
 * cloud-init's network config (version 2) for a fixed address: the interface with that MAC gets the
 * address, a default route through the gateway and the DNS servers, and no DHCP. cloud-init writes
 * it in the OS's own form (NetworkManager, netplan, wicked).
 */
/** A MAC of a machine's own, the same on every run: locally administered (52:54:00, as QEMU's), from the lab's and the machine's names. */
export function stableMac(labName: string, machine: string): string {
    const h = createHash("sha256").update(`${labName}/${machine}`).digest();
    return ["52", "54", "00", ...[h[0], h[1], h[2]].map(b => b.toString(16).padStart(2, "0"))].join(":");
}

export function renderNetworkConfig(f: FixedAddress): string {
    return stringify({
        version: 2,
        ethernets: {
            lab0: {
                match: { macaddress: f.macAddress.toLowerCase() },
                dhcp4: false,
                dhcp6: false,
                addresses: [`${f.address}/${f.prefix}`],
                routes: [{ to: "0.0.0.0/0", via: f.gateway }],
                nameservers: { addresses: f.dns, ...(f.search?.length ? { search: f.search } : {}) },
            },
        },
    }, { lineWidth: 0 });
}
