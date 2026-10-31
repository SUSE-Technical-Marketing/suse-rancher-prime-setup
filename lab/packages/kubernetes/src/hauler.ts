import * as command from "@pulumi/command";
import * as pulumi from "@pulumi/pulumi";
import { asRoot, HostAccess, runUploaded, sshConnection, stepScript } from "./host";

/** A release tarball to install from: `{version}` and `{arch}` (amd64, arm64) in its URL. */
export interface Download {
    url: string;
    version: string;
}

export interface HaulerRegistryArgs {
    host: HostAccess;
    hauler: Download;
    /** The store's content: `<name>.yaml` → Hauler content documents (`hauler store sync`). */
    manifests: Record<string, string>;
    port: number;
    /** Serve the store's files too, on this port. */
    fileserverPort?: number;
    /**
     * A certificate for the host's name from an ACME server, by DNS-01 with Cloudflare, renewed by
     * a timer. Without it the registry speaks plain HTTP.
     */
    tls?: { lego: Download; server: string; email?: string; cloudflareToken: pulumi.Input<string> };
    /** What has to be done first (the host is up, cloud-init has finished). */
    after: pulumi.Resource[];
    /** How long the setup may take: the sync downloads everything. */
    timeoutSeconds: number;
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const DIR = "/var/lib/hauler";
const STORE = `${DIR}/store`;
const MANIFESTS = `${DIR}/manifests`;
const LEGO = `${DIR}/lego`;
const ENV = "/etc/lab/hauler/lego.env";
const UNITS = "/etc/systemd/system";
const FIREWALL = "/etc/firewalld/services/lab-hauler.xml";
const SERVICES = ["hauler-registry", "hauler-fileserver"];

/** Download a release tarball and install the binary of that name from it into /usr/local/bin. */
const install = (binary: string, d: Download) => {
    const url = d.url.replace(/\{version\}/g, d.version).replace(/\{arch\}/g, "${arch}");
    return [
        `tmp=$(mktemp -d) && curl -sfL "${url}" | tar xz -C "$tmp" ${binary}`,
        `install -m 0755 "$tmp/${binary}" /usr/local/bin/${binary} && rm -rf "$tmp"`,
    ].join(" && \\\n");
};

/** A file written as root, its content as is (a quoted here-document). */
const file = (path: string, content: string, mode = "0644") =>
    `install -d -m 0755 ${quote(path.replace(/\/[^/]*$/, ""))} && cat > ${quote(path)} <<'LAB_EOF'\n${content.replace(/\n?$/, "\n")}LAB_EOF\nchmod ${mode} ${quote(path)}`;

const unit = (description: string, exec: string, extra = "") => `[Unit]
Description=${description} (lab)
Wants=network-online.target
After=network-online.target

[Service]
WorkingDirectory=${DIR}
ExecStart=${exec}
Restart=on-failure
${extra}
[Install]
WantedBy=multi-user.target
`;

/** What the setup script needs: the HaulerRegistry's args, the host's name and the DNS-01 token's value. */
export interface HaulerSetup extends Omit<HaulerRegistryArgs, "host" | "tls" | "after" | "timeoutSeconds"> {
    fqdn: string;
    tls?: Omit<NonNullable<HaulerRegistryArgs["tls"]>, "cloudflareToken"> & { cloudflareToken: string };
}

/** The script that sets Hauler up on a host, or changes it to match (run as root). */
export function haulerSetupScript(s: HaulerSetup): string {
    const tls = s.tls;
    const certFlags = tls ? ` --tls-cert ${LEGO}/certificates/hauler.crt --tls-key ${LEGO}/certificates/hauler.key` : "";
    const serve = (what: "registry" | "fileserver", port: number) =>
        `/usr/local/bin/hauler store --store ${STORE} serve ${what} --directory ${DIR}/${what} --port ${port}${certFlags}`;
    const services = ["hauler-registry", ...(s.fileserverPort !== undefined ? ["hauler-fileserver"] : [])];
    const ports = [s.port, ...(s.fileserverPort !== undefined ? [s.fileserverPort] : [])];
    const lego = tls && [
        "/usr/local/bin/lego run --accept-tos",
        `--server ${quote(tls.server)}`,
        ...(tls.email ? [`--email ${quote(tls.email)}`] : []),
        // Lab names usually resolve internally too: check the challenge records publicly.
        `--dns cloudflare --dns.resolvers 1.1.1.1:53 --env-file ${ENV}`,
        `--path ${LEGO} --cert.name hauler --domains ${quote(s.fqdn)}`,
    ].join(" ");
    const files = Object.keys(s.manifests).sort();

return stepScript([
        `case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64) arch=arm64 ;; *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;; esac`,
        install("hauler", s.hauler),
        ...(tls ? [install("lego", tls.lego)] : []),
        // The manifests as the lab has them now: the store syncs them all.
        `install -d -m 0755 ${MANIFESTS} && rm -f ${MANIFESTS}/*.yaml`,
        ...files.map(f => file(`${MANIFESTS}/${f}`, s.manifests[f])),
        ...(files.length > 0 ? [`cd ${DIR} && /usr/local/bin/hauler store --store ${STORE} sync ${files.map(f => `--filename ${MANIFESTS}/${f}`).join(" ")}`] : []),
        ...(tls && lego ? [
            file(ENV, `CLOUDFLARE_DNS_API_TOKEN=${tls.cloudflareToken}\n`, "0600"),
            // Obtains it, or renews it when it's due.
            lego,
            file(`${UNITS}/hauler-cert.service`, `[Unit]
Description=Renew Hauler's certificate (lab)
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=${lego} --deploy-hook "systemctl try-restart ${services.join(" ")}"
`),
            file(`${UNITS}/hauler-cert.timer`, `[Unit]
Description=Renew Hauler's certificate daily (lab)

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
`),
        ] : []),
        file(`${UNITS}/hauler-registry.service`, unit("Hauler registry", serve("registry", s.port))),
        ...(s.fileserverPort !== undefined
            ? [file(`${UNITS}/hauler-fileserver.service`, unit("Hauler fileserver", serve("fileserver", s.fileserverPort)))]
            : ["systemctl disable --now hauler-fileserver 2>/dev/null; rm -f /etc/systemd/system/hauler-fileserver.service"]),
        "systemctl daemon-reload",
        // Restarted: Hauler serves what was in its store when it started.
        `systemctl enable ${services.join(" ")} && systemctl restart ${services.join(" ")}`,
        ...(tls ? ["systemctl enable --now hauler-cert.timer"] : ["systemctl disable --now hauler-cert.timer 2>/dev/null; true"]),
        // Its ports, as a firewalld service, when firewalld runs.
        [
            "if systemctl is-active --quiet firewalld; then",
            file(FIREWALL, `<?xml version="1.0" encoding="utf-8"?>
<service>
  <short>Hauler (lab)</short>
${ports.map(p => `  <port protocol="tcp" port="${p}"/>`).join("\n")}
</service>`),
            "firewall-cmd --reload && firewall-cmd --permanent --add-service=lab-hauler && firewall-cmd --reload",
            "fi",
        ].join("\n"),
    ]);
}

/** What its delete runs: all of it gone, the store too. */
export const HAULER_UNINSTALL = [
    `systemctl disable --now ${[...SERVICES, "hauler-cert.timer"].join(" ")} 2>/dev/null`,
    `rm -f ${[...SERVICES, "hauler-cert"].map(s => `${UNITS}/${s}.service`).join(" ")} ${UNITS}/hauler-cert.timer`,
    "systemctl daemon-reload",
    `if systemctl is-active --quiet firewalld; then firewall-cmd --permanent --remove-service=lab-hauler; rm -f ${FIREWALL}; firewall-cmd --reload; fi`,
    `rm -rf ${DIR} /etc/lab/hauler /usr/local/bin/hauler /usr/local/bin/lego`,
    "true",
].join("; ");

/**
 * Hauler on a host without Kubernetes (DESIGN.md §9.4): the binary, its store synced from the
 * lab's HaulManifests, `hauler store serve registry` (and `fileserver`) as systemd services, and a
 * lego certificate with a renewal timer. Set up by one uploaded script, run again when anything
 * changes; Hauler copies its store when it starts, so the services restart after each sync. Synced
 * content stays in the store when a manifest is dropped. Its delete removes all of it.
 */
export class HaulerRegistry extends pulumi.ComponentResource {
    readonly setup: command.remote.Command;

    constructor(name: string, args: HaulerRegistryArgs, opts?: pulumi.ComponentResourceOptions) {
        super("lab:kubernetes:HaulerRegistry", name, {}, opts);
        const { host, tls, after, timeoutSeconds, ...rest } = args;
        const setup = { ...rest, fqdn: host.fqdn };
        // It holds the Cloudflare token: uploaded (removed once it ran), and secret.
        const script = tls
            ? pulumi.secret(pulumi.output(tls.cloudflareToken).apply(token => haulerSetupScript({ ...setup, tls: { ...tls, cloudflareToken: token } })))
            : pulumi.output(haulerSetupScript(setup));
        this.setup = new command.remote.Command(`${name}/setup`, {
            connection: sshConnection(host),
            create: runUploaded("hauler"),
            update: runUploaded("hauler"),
            stdin: script,
            delete: asRoot(HAULER_UNINSTALL),
        }, { parent: this, dependsOn: after, customTimeouts: { create: `${timeoutSeconds}s`, update: `${timeoutSeconds}s` } });
        this.registerOutputs({});
    }
}
