import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatDiagnostic, loadLab, LoadResult } from "../src";

const LABS_DIR = path.resolve(__dirname, "..", "..", "..", "labs");

let tmp: string;
let personalConfig: string;
const originalHome = process.env.HOME;

beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lab-schema-"));
    // Fake home with the ssh key the example labs reference.
    process.env.HOME = tmp;
    fs.mkdirSync(path.join(tmp, ".ssh"));
    fs.writeFileSync(path.join(tmp, ".ssh", "id_ed25519.pub"), "ssh-ed25519 AAAATEST lab@test\n");
    fs.writeFileSync(path.join(tmp, "sles-16.qcow2"), "");

    personalConfig = path.join(tmp, "config.yaml");
    fs.writeFileSync(personalConfig, `
secrets:
  hv-north: { username: admin, password: "env:HV_PASSWORD" }
harvesters:
  hv-north:
    url: https://hv-north.lab.geeko.me
    credentials: { $secret: hv-north }
images:
  sles-16: { file: ~/sles-16.qcow2 }
  sl-micro-6.1: { url: https://mirror.example.com/sl-micro-6.1.qcow2 }
`);
});

afterAll(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmp, { recursive: true, force: true });
});

function load(labYaml: string, personal = personalConfig): LoadResult {
    const file = path.join(tmp, `lab-${Math.random().toString(36).slice(2)}.yaml`);
    fs.writeFileSync(file, labYaml);
    return loadLab({ labFile: file, personalConfig: personal });
}

function errors(result: LoadResult): string[] {
    return result.diagnostics.errors.map(d => `${d.path}: ${d.message}`);
}

// The profiles a Rancher host needs (DESIGN.md §5.4).
const RANCHER_STACK = "k3s: {}, cert-manager: {}, sprouter: {}, traefik: {}, rancher: { adminPassword: { $secret: ra } }";

// A valid single-VM lab to derive broken variants from.
const BASE = `
lab: test
domain: lab.geeko.me
tls: { acme: letsencrypt-staging, email: a@b.cd, cloudflare: { $secret: cf } }
ssh: { user: lab, publicKey: "ssh-ed25519 AAAA", privateKey: { $secret: ssh-key } }
harvesters:
  hv-north: {}
`;

describe("reference labs", () => {
    // The reference labs from DESIGN.md §13; other files in labs/ may depend on a real personal config.
    const files = ["empty.yaml", "rancher-mlm-airgap.yaml", "rancher-harvester-rke2.yaml", "mlm-multi-os.yaml", "rancher-custom-edge.yaml"];

    it.each(files)("%s resolves without errors", file => {
        const result = loadLab({ labFile: path.join(LABS_DIR, file), personalConfig });
        expect(result.diagnostics.errors.map(formatDiagnostic)).toEqual([]);
        expect(result.lab).toBeDefined();
    });

    it("puts exactly the images the hosts need on each Harvester", () => {
        const { lab } = loadLab({ labFile: path.join(LABS_DIR, "mlm-multi-os.yaml"), personalConfig });
        const images = lab!.harvesters[0].images;
        expect(images.map(i => i.os)).toEqual(["leap-16", "rocky-9", "sl-micro-6.1", "sles-16", "ubuntu-24.04"]);
        expect(images.find(i => i.os === "sles-16")!.source).toEqual({ kind: "file", path: path.join(tmp, "sles-16.qcow2") });
        expect(images.find(i => i.os === "sl-micro-6.1")!.source).toEqual({ kind: "url", url: "https://mirror.example.com/sl-micro-6.1.qcow2" });
    });

    it("collects every secret with its shape", () => {
        const { lab } = loadLab({ labFile: path.join(LABS_DIR, "rancher-mlm-airgap.yaml"), personalConfig });
        expect(lab!.secrets).toEqual({
            "hv-north": "credentials",
            routeros: "credentials",
            "cloudflare-token": "string",
            "ssh-key": "string",
            "rancher-admin": "string",
            "mlm-admin": "string",
            "scc-regcode-slmicro": "string",
        });
    });

    it("takes Harvester url and credentials from the personal config", () => {
        const { lab } = loadLab({ labFile: path.join(LABS_DIR, "rancher-custom-edge.yaml"), personalConfig });
        expect(lab!.harvesters[0]).toMatchObject({ url: "https://hv-north.lab.geeko.me", credentials: { $secret: "hv-north" }, insecure: true });
    });

    it("uses an ssh host's address as its name", () => {
        const { lab } = loadLab({ labFile: path.join(LABS_DIR, "rancher-custom-edge.yaml"), personalConfig });
        expect(lab!.hosts.find(h => h.name === "nuc-01")).toMatchObject({ kind: "ssh", fqdn: "nuc-01.lab.geeko.me", user: "root" });
        expect(lab!.hosts.find(h => h.name === "rancher")).toMatchObject({ kind: "harvester", fqdn: "rancher.lab.geeko.me", network: "untagged" });
    });
});

describe("validation errors", () => {
    it("reports unknown fields with their path", () => {
        const result = load(`${BASE}
hosts:
  vm: { on: hv-north, os: leap-16, cpu: 2, memory: 4Gi, disk: 20Gi, colour: blue }
`);
        expect(errors(result)).toEqual(['hosts.vm.colour: unknown field "colour"']);
    });

    it("reports YAML syntax errors with a line number", () => {
        const result = load("lab: test\n  domain: [oops");
        expect(errors(result)[0]).toMatch(/YAML syntax error at line \d+/);
    });

    it("lists everything Rancher needs on its host", () => {
        const result = load(`${BASE}
hosts:
  rancher: { on: hv-north, os: leap-16, cpu: 4, memory: 16Gi, disk: 100Gi, profiles: { rancher: { adminPassword: { $secret: ra } } } }
`);
        expect(errors(result)).toEqual([
            "hosts.rancher.profiles.rancher: needs kubernetes (k3s or rke2) on the same host",
            "hosts.rancher.profiles.rancher: needs ingress (traefik) on the same host",
            "hosts.rancher.profiles.rancher: needs tls (cert-manager) on the same host",
            "hosts.rancher.profiles.rancher: needs secret-propagation (sprouter) on the same host",
        ]);
    });

    it("rejects unknown references", () => {
        const result = load(`${BASE}
hosts:
  vm: { on: hv-south, os: leap-16, cpu: 2, memory: 4Gi, disk: 20Gi }
  vm2: { on: hv-north, os: windows-11, cpu: 2, memory: 4Gi, disk: 20Gi, network: vlan42 }
  client: { on: hv-north, os: leap-16, cpu: 1, memory: 2Gi, disk: 20Gi, profiles: { mlm-client: { server: vm2 } } }
`);
        expect(errors(result)).toEqual([
            'hosts.vm.on: unknown harvester "hv-south"; use a name from harvesters: or "ssh"',
            'hosts.vm2.os: unknown OS profile "windows-11"; known: leap-16, rocky-9, sl-micro-6.1, sles-16, ubuntu-24.04',
            'hosts.vm2.network: network "vlan42" doesn\'t exist on harvester "hv-north"; known: untagged',
            'hosts.client.profiles.mlm-client.server: host "vm2" doesn\'t run mlm-server',
        ]);
    });

    it("requires every node role in a downstream cluster", () => {
        const result = load(`${BASE}
hosts:
  rancher: { on: hv-north, os: leap-16, cpu: 4, memory: 16Gi, disk: 100Gi, profiles: { ${RANCHER_STACK} } }
downstream:
  apps:
    type: harvester
    rancher: rancher
    harvester: hv-north
    pools:
      - { name: w, quantity: 2, roles: [worker], cpu: 2, memory: 4Gi, disk: 40Gi, os: leap-16 }
`);
        expect(errors(result)).toEqual(["downstream.apps: no node has the etcd, controlplane roles; a cluster needs at least one of each"]);
    });

    it("rejects a custom-cluster node that runs its own Kubernetes", () => {
        const result = load(`${BASE}
hosts:
  rancher: { on: hv-north, os: leap-16, cpu: 4, memory: 16Gi, disk: 100Gi, profiles: { ${RANCHER_STACK} } }
downstream:
  edge:
    type: custom
    rancher: rancher
    nodes: [{ host: rancher, roles: [etcd, controlplane, worker] }]
`);
        expect(errors(result)).toEqual([
            'downstream.edge.nodes[0].host: host "rancher" can\'t join a custom cluster: it runs k3s, which can\'t share a host with Kubernetes',
        ]);
    });

    it("needs an image source for OSes without a public image", () => {
        const empty = path.join(tmp, "empty-config.yaml");
        fs.writeFileSync(empty, "harvesters: { hv-north: { url: https://hv.example.com, credentials: { $secret: hv } } }\n");
        const result = load(`${BASE}
hosts:
  vm: { on: hv-north, os: sles-16, cpu: 2, memory: 4Gi, disk: 20Gi }
`, empty);
        expect(errors(result)).toEqual([
            'images.sles-16: OS "sles-16" has no public image; add images.sles-16 with a url or a local file, here or in the personal config',
        ]);
    });

    it("requires Harvester url and credentials somewhere", () => {
        const result = load(`${BASE}
hosts:
  vm: { on: hv-north, os: leap-16, cpu: 2, memory: 4Gi, disk: 20Gi }
`, path.join(tmp, "does-not-exist.yaml"));
        expect(errors(result)).toEqual([
            "harvesters.hv-north.url: missing; set it here or in the personal config under harvesters.hv-north.url",
            "harvesters.hv-north.credentials: missing; set it here or in the personal config under harvesters.hv-north.credentials",
        ]);
    });
});

describe("profile rules", () => {
    const host = (profiles: string, os = "leap-16") =>
        `${BASE}\nhosts:\n  vm: { on: hv-north, os: ${os}, cpu: 4, memory: 16Gi, disk: 100Gi, profiles: ${profiles} }\n`;

    it("allows only one Kubernetes distribution per host", () => {
        expect(errors(load(host("{ k3s: {}, rke2: {} }")))).toEqual(["hosts.vm.profiles: k3s and rke2 can't run on the same host"]);
    });

    it("checks the OS family", () => {
        expect(errors(load(host("{ mlm-server: { adminPassword: { $secret: m } } }", "ubuntu-24.04")))).toEqual([
            'hosts.vm.profiles.mlm-server: needs an OS of the suse family; "ubuntu-24.04" is debian',
        ]);
    });

    it("reports conflicts once", () => {
        expect(errors(load(host("{ k3s: {}, mlm-server: { adminPassword: { $secret: m } }, mlm-client: { server: other } }", "sl-micro-6.1")))).toEqual([
            'hosts.vm.profiles.mlm-client.server: unknown host "other"',
            "hosts.vm.profiles: k3s and mlm-server can't run on the same host",
            "hosts.vm.profiles: mlm-client and mlm-server can't run on the same host",
        ]);
    });

    it("rejects a host reference to itself", () => {
        expect(errors(load(host("{ mlm-client: { server: vm } }")))).toEqual(["hosts.vm.profiles.mlm-client.server: can't point at its own host"]);
    });

    it("requires secret fields declared by the profile", () => {
        expect(errors(load(host("{ k3s: {}, cert-manager: {}, sprouter: {}, traefik: {}, rancher: {} }")))).toEqual(["hosts.vm.profiles.rancher.adminPassword: required"]);
    });

    it("orders profiles so requirements come first", () => {
        const { lab, diagnostics } = load(host(`{ ${RANCHER_STACK}, hauler: {} }`));
        expect(diagnostics.errors).toEqual([]);
        expect(lab!.hosts[0].profileOrder).toEqual(["hauler", "k3s", "cert-manager", "sprouter", "traefik", "rancher"]);
    });

    it("applies requiresWhen only when the field is set", () => {
        const fleetSecrets = "fleet: { secrets: { appco: { $secret: appco }, suse-observability-license: { $secret: obs } } }";
        const withSecrets = RANCHER_STACK.replace("adminPassword: { $secret: ra }", `adminPassword: { $secret: ra }, ${fleetSecrets}`);
        expect(errors(load(host(`{ ${withSecrets} }`)))).toEqual([
            "hosts.vm.profiles.rancher: needs downstream-secrets (outrider) on the same host",
        ]);
        const { lab } = load(host(`{ ${withSecrets}, outrider: {} }`));
        expect(lab!.hosts[0].profileOrder.indexOf("outrider")).toBeLessThan(lab!.hosts[0].profileOrder.indexOf("rancher"));
        expect(lab!.secrets).toMatchObject({ appco: "credentials", obs: "string", ra: "string" });
    });

    it("needs a host running rancher for downstream clusters", () => {
        const result = load(`${host("{ k3s: {}, cert-manager: {}, sprouter: {}, traefik: {} }")}
downstream:
  apps: { type: harvester, rancher: vm, harvester: hv-north, pools: [{ name: a, quantity: 1, roles: [etcd, controlplane, worker], cpu: 2, memory: 4Gi, disk: 40Gi, os: leap-16 }] }
`);
        expect(errors(result)).toEqual(['downstream.apps.rancher: host "vm" doesn\'t run rancher']);
    });
});

describe("Harvester load balancer", () => {
    const VLAN = (pool: string) => BASE.replace("hv-north: {}", `hv-north: { networks: { default: vlan20, vlans: [{ id: 20, dhcp: { cidr: 10.29.20.0/24, gateway: 10.29.20.1, range: [10.29.20.100, 10.29.20.150] }${pool} }] } }`);
    const vm = (profiles: string) => `\nhosts:\n  vm: { on: hv-north, os: leap-16, cpu: 4, memory: 16Gi, disk: 100Gi, profiles: ${profiles} }\n`;

    it("needs a load-balancer pool on the host's network", () => {
        expect(errors(load(VLAN("") + vm("{ k3s: {}, harvester-cloud-provider: {} }")))).toEqual([
            "hosts.vm.profiles.harvester-cloud-provider: needs the host's network to have a loadBalancer section on its Harvester",
        ]);
    });

    it("resolves the pool from the network's DHCP settings and builds the provider before Traefik", () => {
        const { lab, diagnostics } = load(VLAN(", loadBalancer: { range: [10.29.20.200, 10.29.20.220] }") + vm("{ k3s: {}, traefik: {}, harvester-cloud-provider: {} }"));
        expect(diagnostics.errors).toEqual([]);
        expect(lab!.harvesters[0].networks.find(n => n.name === "vlan20")!.loadBalancer).toEqual({ cidr: "10.29.20.0/24", gateway: "10.29.20.1", range: ["10.29.20.200", "10.29.20.220"] });
        expect(lab!.hosts[0].profileOrder).toEqual(["k3s", "harvester-cloud-provider", "traefik"]);
    });

    it("rejects pools outside the network or overlapping DHCP", () => {
        expect(errors(load(VLAN(", loadBalancer: { range: [10.29.20.140, 10.29.21.10] }")))).toEqual([
            "harvesters.hv-north.networks.vlans[0].loadBalancer.range[1]: 10.29.21.10 is outside 10.29.20.0/24",
            "harvesters.hv-north.networks.vlans[0].loadBalancer.range: overlaps the DHCP range 10.29.20.100-10.29.20.150",
        ]);
    });

    it("only runs on Harvester VMs", () => {
        const result = load(`${BASE}\nhosts:\n  box: { on: ssh, address: box.example.com, os: leap-16, profiles: { k3s: {}, harvester-cloud-provider: {} } }\n`);
        expect(errors(result)).toEqual(["hosts.box.profiles.harvester-cloud-provider: only runs on Harvester VMs"]);
    });
});

describe("OS profiles", () => {
    it("supports extends, with the child's fields winning", () => {
        const { lab, diagnostics } = load(`${BASE}
os:
  leap-16-dev:
    extends: leap-16
    packages: [git, make]
hosts:
  vm: { on: hv-north, os: leap-16-dev, cpu: 2, memory: 4Gi, disk: 20Gi }
`);
        expect(diagnostics.errors).toEqual([]);
        expect(lab!.os["leap-16-dev"]).toMatchObject({ family: "suse", packages: ["git", "make"], k8s: { packages: ["k3s-selinux"] } });
        expect(lab!.harvesters[0].images[0].source).toMatchObject({ kind: "url", url: expect.stringContaining("Leap-16.0") });
    });

    it("detects circular extends", () => {
        const result = load(`${BASE}
os:
  a: { extends: b }
  b: { extends: a }
`);
        expect(errors(result)).toContain("b.extends: circular extends: a -> b -> a");
    });

    it("requires a family", () => {
        const result = load(`${BASE}
os:
  plan9: { image: { url: https://example.com/plan9.qcow2 } }
`);
        expect(errors(result)).toEqual(["plan9.family: missing; must be one of suse, rhel, debian"]);
    });
});

describe("networks", () => {
    it("allows the untagged network without DHCP but requires it on VLANs", () => {
        const ok = load(`${BASE.replace("hv-north: {}", "hv-north: { networks: { untagged: {} } }")}
hosts:
  vm: { on: hv-north, os: leap-16, cpu: 2, memory: 4Gi, disk: 20Gi }
`);
        expect(errors(ok)).toEqual([]);

        const bad = load(BASE.replace("hv-north: {}", "hv-north: { networks: { vlans: [{ id: 100 }] } }"));
        expect(errors(bad)).toEqual(["harvesters.hv-north.networks.vlans[0].dhcp: required"]);
    });
});

describe("warnings", () => {
    it("warns about passwords written into the lab file", () => {
        const result = load(BASE.replace("hv-north: {}", "hv-north: { url: https://hv.example.com, credentials: { username: admin, password: hunter2 } }"));
        expect(result.diagnostics.warnings.map(d => d.path)).toContain("harvesters.hv-north.credentials.password");
    });
});
