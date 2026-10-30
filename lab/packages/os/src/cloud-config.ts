import { renderTemplates, type CloudInitVars, type OsFamily, type ResolvedOs } from "@lab/schema";
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
    /** For the profile's `cloudInit` templates: its secrets' values, the lab's name and domain. */
    vars: CloudInitVars;
    /** The host's own commands (k3s / RKE2, profiles), run after the OS profile's `runcmd`. */
    runcmd?: string[];
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** How one OS family installs packages: for existing machines, which get no user data. */
const INSTALL: Record<OsFamily, (packages: string[]) => string[]> = {
    suse: packages => [
        "zypper --non-interactive --gpg-auto-import-keys refresh",
        `zypper --non-interactive install --no-recommends ${packages.map(quote).join(" ")}`,
    ],
    rhel: packages => [`dnf -y install ${packages.map(quote).join(" ")}`],
    debian: packages => [
        "apt-get update",
        `DEBIAN_FRONTEND=noninteractive apt-get install -y ${packages.map(quote).join(" ")}`,
    ],
};

/** The OS profile's cloud-config with its templates rendered. */
function cloudInit(os: ResolvedOs, vars: CloudInitVars): Record<string, unknown> {
    return renderTemplates(os.cloudInit, vars, "cloudInit", (at, message) => {
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
    const os = cloudInit(input.os, input.vars);
    const login = {
        name: input.user.name,
        sudo: "ALL=(ALL) NOPASSWD:ALL",
        shell: "/bin/bash",
        lock_passwd: true,
    };
    const runcmd = [...list(os.runcmd), ...(input.runcmd ?? [])];
    const config: Record<string, unknown> = {
        ssh_pwauth: false,
        ...os,
        ...(input.hostname ? { hostname: input.hostname, fqdn: input.fqdn, prefer_fqdn_over_hostname: false, manage_etc_hosts: true } : {}),
        ...(input.defaultUser
            ? { system_info: { default_user: login }, users: ["default"], ssh_authorized_keys: [input.user.publicKey] }
            : { users: [{ ...login, ssh_authorized_keys: [input.user.publicKey] }] }),
        ...(runcmd.length > 0 ? { runcmd } : {}),
    };
    return `#cloud-config\n${stringify(config, { lineWidth: 0 })}`;
}

/**
 * Commands (run as root over SSH) that do for an existing machine what a VM's user data would:
 * install the OS profile's `packages` with the family's package manager, then run its `runcmd`.
 * Other cloud-config keys need cloud-init and are skipped (the resolver warns).
 */
export function machineSetup(os: ResolvedOs, vars: CloudInitVars): string[] {
    const config = cloudInit(os, vars);
    const packages = list(config.packages).filter((p): p is string => typeof p === "string");
    const runcmd = list(config.runcmd).map(c => (Array.isArray(c) ? c.map(a => quote(String(a))).join(" ") : String(c)));
    return [...(packages.length > 0 ? INSTALL[os.family](packages) : []), ...runcmd];
}
