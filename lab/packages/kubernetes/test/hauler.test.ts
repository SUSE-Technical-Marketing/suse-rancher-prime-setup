import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { HAULER_UNINSTALL, haulerSetupScript, type HaulerSetup } from "../src";

const SETUP: HaulerSetup = {
    fqdn: "registry.lab.example.com",
    hauler: { url: "https://example.com/hauler_{version}_linux_{arch}.tar.gz", version: "2.1.2" },
    manifests: { "b.yaml": "kind: Images\n", "a.yaml": "kind: Charts\n" },
    port: 5000,
    tls: { lego: { url: "https://example.com/lego_{version}_{arch}.tar.gz", version: "v5.6.0" }, server: "https://acme.example.com/directory", email: "a@b.cd", cloudflareToken: "cf-s3cret" },
};

/** `sh -n`: it parses. */
const parses = (script: string) => execFileSync("sh", ["-n"], { input: script });

describe("haulerSetupScript", () => {
    it("is a script sh can parse, with or without TLS and the fileserver", () => {
        parses(haulerSetupScript(SETUP));
        parses(haulerSetupScript({ ...SETUP, tls: undefined, fileserverPort: 8080, manifests: {} }));
        parses(HAULER_UNINSTALL);
    });

    it("installs the binaries for the host's architecture, and syncs every manifest", () => {
        const script = haulerSetupScript(SETUP);
        expect(script).toContain('curl -sfL "https://example.com/hauler_2.1.2_linux_${arch}.tar.gz"');
        expect(script).toContain('curl -sfL "https://example.com/lego_v5.6.0_${arch}.tar.gz"');
        expect(script).toContain("sync --filename /var/lib/hauler/manifests/a.yaml --filename /var/lib/hauler/manifests/b.yaml");
        expect(script).toContain("cat > '/var/lib/hauler/manifests/a.yaml' <<'LAB_EOF'\nkind: Charts\nLAB_EOF");
    });

    it("gets a certificate for the host with lego, serves with it, and renews it daily", () => {
        const script = haulerSetupScript(SETUP);
        expect(script).toContain("/usr/local/bin/lego run --accept-tos --server 'https://acme.example.com/directory' --email 'a@b.cd' --dns cloudflare");
        expect(script).toContain("--cert.name hauler --domains 'registry.lab.example.com'");
        expect(script).toContain("serve registry --directory /var/lib/hauler/registry --port 5000 --tls-cert /var/lib/hauler/lego/certificates/hauler.crt");
        expect(script).toContain('--deploy-hook "systemctl try-restart hauler-registry"');
        expect(script).toContain("systemctl enable --now hauler-cert.timer");
        // The token only in the root-only env file lego reads.
        expect(script.split("cf-s3cret").length - 1).toBe(1);
        expect(script).toContain("CLOUDFLARE_DNS_API_TOKEN=cf-s3cret\nLAB_EOF\nchmod 0600 '/etc/lab/hauler/lego.env'");
    });

    it("serves plain HTTP without TLS, and opens its ports in firewalld", () => {
        const script = haulerSetupScript({ ...SETUP, tls: undefined, fileserverPort: 8080 });
        expect(script).not.toContain("lego run");
        expect(script).toContain("serve fileserver --directory /var/lib/hauler/fileserver --port 8080\n");
        expect(script).toContain('<port protocol="tcp" port="5000"/>\n  <port protocol="tcp" port="8080"/>');
        expect(script).toContain("systemctl enable hauler-registry hauler-fileserver && systemctl restart hauler-registry hauler-fileserver");
    });
});
