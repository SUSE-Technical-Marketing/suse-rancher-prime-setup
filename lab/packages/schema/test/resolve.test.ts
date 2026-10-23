import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatDiagnostic, loadLab, LoadResult } from "../src";
import { labDocument, personalDocument, resolverPath } from "./as-documents";

const LABS_DIR = path.resolve(__dirname, "..", "..", "..", "labs");

let tmp: string;
let personalConfig: string;
let PERSONAL_YAML: string;
const originalHome = process.env.HOME;

beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lab-schema-"));
    // Fake home with the ssh key the example labs reference.
    process.env.HOME = tmp;
    fs.mkdirSync(path.join(tmp, ".ssh"));
    fs.writeFileSync(path.join(tmp, ".ssh", "id_ed25519.pub"), "ssh-ed25519 AAAATEST lab@test\n");
    fs.writeFileSync(path.join(tmp, "sles-16.qcow2"), "");

    personalConfig = path.join(tmp, "config.yaml");
    PERSONAL_YAML = `
secrets:
  hv-north: { username: admin, password: "env:HV_PASSWORD" }
harvesters:
  hv-north:
    url: https://hv-north.lab.geeko.me
    credentials: { $secret: hv-north }
images:
  sles-16: { file: ~/sles-16.qcow2 }
  sl-micro-6.1: { url: https://mirror.example.com/sl-micro-6.1.qcow2 }
`;
    writePersonal(personalConfig, PERSONAL_YAML);
});

afterAll(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmp, { recursive: true, force: true });
});

function load(labYaml: string, personal = personalConfig): LoadResult {
    const file = path.join(tmp, `lab-${Math.random().toString(36).slice(2)}.yaml`);
    fs.writeFileSync(file, labDocument(labYaml));
    return loadLab({ labFile: file, personalConfig: personal });
}

/** Load a lab file written as documents, as is. */
function loadDocs(text: string, personal = personalConfig): LoadResult {
    const file = path.join(tmp, `lab-${Math.random().toString(36).slice(2)}.yaml`);
    fs.writeFileSync(file, text);
    return loadLab({ labFile: file, personalConfig: personal });
}

/** Write a compact personal config as a PersonalConfig document. */
function writePersonal(file: string, yaml: string): string {
    fs.writeFileSync(file, personalDocument(yaml));
    return file;
}

/** Errors as `path: message`; a lab's own fields without their `spec.` prefix. */
function errors(result: LoadResult): string[] {
    return result.diagnostics.errors.map(d => `${resolverPath(d.path)}: ${d.message}`);
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
        const file = path.join(tmp, "broken.yaml");
        fs.writeFileSync(file, "apiVersion: lab.geeko.me/v1alpha1\nkind: Lab\nmetadata: { name: test }\nspec:\n  domain: [oops\n");
        expect(errors(loadLab({ labFile: file, personalConfig }))[0]).toMatch(/YAML syntax error at line \d+/);
    });

    it("lists everything Rancher needs on its host", () => {
        const result = load(`${BASE}
hosts:
  rancher: { on: hv-north, os: leap-16, cpu: 4, memory: 16Gi, disk: 100Gi, profiles: { rancher: { adminPassword: { $secret: ra } } } }
`);
        expect(errors(result)).toEqual([
            "hosts.rancher.profiles.rancher: needs kubernetes (k3s or rke2) on the same host",
            "hosts.rancher.profiles.rancher: needs ingress (k3s or rke2 or traefik) on the same host",
            "hosts.rancher.profiles.rancher: needs tls (cert-manager) on the same host",
            "hosts.rancher.profiles.rancher: needs secret-propagation (sprouter) on the same host",
        ]);
    });

    it("uses k3s's own ingress and load balancer unless another profile provides them", () => {
        const host = (profiles: string) => load(`${BASE}
hosts:
  vm: { on: hv-north, os: leap-16, cpu: 4, memory: 16Gi, disk: 100Gi, profiles: { ${profiles} } }
`);
        const builtin = host("k3s: {}, cert-manager: {}, sprouter: {}, rancher: { adminPassword: { $secret: ra } }");
        expect(errors(builtin)).toEqual([]);
        const vm = builtin.lab!.hosts[0];
        expect(vm.providers).toMatchObject({ ingress: ["k3s"], "load-balancer": ["k3s"], kubernetes: ["k3s"] });
        expect(vm.outputs.ingress).toEqual({ ingressClassName: "traefik" });

        const own = host("k3s: {}, traefik: {}, metallb: { addresses: [10.0.0.10-10.0.0.20] }").lab!.hosts[0];
        expect(own.providers).toMatchObject({ ingress: ["traefik"], "load-balancer": ["metallb"] });
        expect(errors(host("k3s: {}, metallb: { addresses: [10.0.0.10-10.0.0.20] }, harvester-cloud-provider: {}"))).toContain(
            "hosts.vm.profiles: harvester-cloud-provider and metallb can't run on the same host");
    });

    it("rejects unknown references", () => {
        const result = load(`${BASE}
hosts:
  vm: { on: hv-south, os: leap-16, cpu: 2, memory: 4Gi, disk: 20Gi }
  vm2: { on: hv-north, os: windows-11, cpu: 2, memory: 4Gi, disk: 20Gi, network: vlan42 }
  client: { on: hv-north, os: leap-16, cpu: 1, memory: 2Gi, disk: 20Gi, profiles: { mlm-client: { server: vm2 } } }
`);
        expect(errors(result)).toEqual([
            'hosts.vm.on: unknown Harvester "hv-south"; known: hv-north',
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
        writePersonal(empty, "harvesters: { hv-north: { url: https://hv.example.com, credentials: { $secret: hv } } }\n");
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
catalog:
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
catalog:
  os:
    a: { extends: b }
    b: { extends: a }
`);
        expect(errors(result)).toContain("b.extends: circular extends: a -> b -> a");
    });

    it("requires a family", () => {
        const result = load(`${BASE}
catalog:
  os:
    plan9: { image: { url: https://example.com/plan9.qcow2 } }
`);
        expect(errors(result)).toEqual(["plan9.family: missing; must be one of suse, rhel, debian"]);
    });
});

describe("catalog components and chart values", () => {
    const rancherHost = (rancher: string) => `${BASE}
hosts:
  vm: { on: hv-north, os: leap-16, cpu: 4, memory: 16Gi, disk: 100Gi, profiles: { k3s: {}, cert-manager: {}, sprouter: {}, traefik: {}, rancher: { adminPassword: { $secret: ra }${rancher} } } }
`;

    it("starts from the built-in components, each with its version", () => {
        const { lab } = load(BASE);
        expect(lab!.components.rancher).toMatchObject({ chart: "rancher", version: expect.stringMatching(/^v2\./) });
        expect(lab!.components.k3s).toMatchObject({ kind: "KubernetesDistribution", version: expect.stringMatching(/\+k3s/) });
        expect(lab!.components["gateway-api"]).toMatchObject({ manifest: expect.stringContaining("{version}") });
        expect(lab!.components["harvester-vm-dhcp-controller"].version).toEqual(expect.objectContaining({ "1.9": expect.any(String) }));
    });

    it("lets the personal config and then the lab override single fields", () => {
        const personal = path.join(tmp, "config-components.yaml");
        writePersonal(personal, `${PERSONAL_YAML}catalog:\n  components: { rancher: { version: v2.14.0 }, k3s: { version: v1.35.0+k3s1 }, traefik: { version: 40 } }\n`);
        const { lab, diagnostics } = load(`${BASE}
catalog:
  components:
    k3s: { version: v1.35.1+k3s1 }
    rancher: { repo: https://releases.rancher.com/server-charts/latest }
    harvester-vm-dhcp-controller: { version: 1.9.1 }
`, personal);
        expect(diagnostics.errors).toEqual([]);
        expect(lab!.components.rancher).toMatchObject({ kind: "HelmChart", chart: "rancher", repo: "https://releases.rancher.com/server-charts/latest", version: "v2.14.0", namespace: "cattle-system" });
        expect(lab!.components.k3s).toMatchObject({ kind: "KubernetesDistribution", version: "v1.35.1+k3s1" });
        expect(lab!.components.traefik.version).toBe("40");
        expect(lab!.components["harvester-vm-dhcp-controller"].version).toBe("1.9.1");
    });

    it("rejects a per-Harvester map keyed by something other than a minor", () => {
        const result = load(`${BASE}\ncatalog:\n  components: { harvester-vm-dhcp-controller: { version: { latest: 1.9.0 } } }\n`);
        expect(errors(result).join("\n")).toMatch(/must be a Harvester minor/);
    });

    it("rejects components without a version, a chart or a url, and charts without a repo", () => {
        const result = loadDocs(`${labDocument(BASE)}---
kind: HelmChart
metadata: { name: noversion }
spec: { chart: oci://example.com/x }
---
kind: HelmChart
metadata: { name: nochart }
spec: { repo: https://example.com, version: 1 }
---
kind: Manifest
metadata: { name: nourl }
spec: { version: 1 }
---
kind: HelmChart
metadata: { name: norepo }
spec: { chart: x, version: 1 }
---
kind: Manifest
metadata: { name: k3s }
spec: { url: https://example.com/x.yaml }
`);
        expect(errors(result)).toEqual([
            "Manifest/k3s: overrides KubernetesDistribution/k3s; an override must have the same kind",
            "HelmChart/noversion.spec.version: required",
            "HelmChart/nochart.spec.chart: required",
            "Manifest/nourl.spec.url: required",
            'HelmChart/norepo.spec.repo: chart "x" needs a repo, or must be an oci:// reference',
        ]);
    });

    it("describes how each distribution is installed, and checks new ones", () => {
        const { lab } = load(BASE);
        expect(lab!.components.rke2).toMatchObject({
            kind: "KubernetesDistribution",
            install: expect.stringContaining("{{ version }}"),
            configFile: "/etc/rancher/rke2/config.yaml",
            config: { disable: ["rke2-ingress-nginx"], "enable-servicelb": true },
            withCapability: { "load-balancer": { "enable-servicelb": false }, "cloud-provider": { "cloud-provider-name": "external" } },
            cni: "calico",
        });
        const result = loadDocs(`${labDocument(BASE)}---
kind: KubernetesDistribution
metadata: { name: k0s }
spec: { version: v1, install: "curl {{ version | nope }}", configFile: /etc/k0s.yaml }
`);
        expect(errors(result)).toEqual([
            "KubernetesDistribution/k0s.spec.kubeconfig: required",
            "KubernetesDistribution/k0s.spec.kubectl: required",
            "KubernetesDistribution/k0s.spec.dataDir: required",
            "KubernetesDistribution/k0s.spec.cni: required",
            expect.stringMatching(/^KubernetesDistribution\/k0s.spec.install: template: .*nope/),
        ]);
    });

    it("takes the ACME server from the catalog, with the roots of an untrusted CA", () => {
        expect(load(BASE).lab!.acme).toMatchObject({ name: "letsencrypt-staging", url: expect.stringContaining("acme-staging-v02"), ca: expect.stringContaining("BEGIN CERTIFICATE") });
        expect(load(BASE.replace("acme: letsencrypt-staging", "acme: letsencrypt")).lab!.acme).toEqual({ name: "letsencrypt", url: "https://acme-v02.api.letsencrypt.org/directory", description: "Let's Encrypt" });
        expect(load(BASE.replace("acme: letsencrypt-staging", "acme: none")).lab!.acme).toBeUndefined();
        expect(errors(load(BASE.replace("acme: letsencrypt-staging", "acme: zerossl")))).toEqual([
            'tls.acme: no AcmeServer "zerossl"; known: letsencrypt, letsencrypt-staging, none',
        ]);
        const own = loadDocs(`${labDocument(BASE.replace("acme: letsencrypt-staging", "acme: zerossl"))}---
kind: AcmeServer
metadata: { name: zerossl }
spec: { url: https://acme.zerossl.com/v2/DV90 }
`);
        expect(errors(own)).toEqual([]);
        expect(own.lab!.acme).toEqual({ name: "zerossl", url: "https://acme.zerossl.com/v2/DV90" });
    });

    it("checks plugin names against the catalog", () => {
        expect(errors(load(rancherHost(", plugins: [harvester, nope]")))).toEqual([
            'hosts.vm.profiles.rancher.plugins: no UiPlugin "nope" in the catalog; known: harvester, kubewarden, rancher-ai-ui, virtual-clusters, vulnerability-scanner',
        ]);
    });

    it("accepts chart values outside the protected paths", () => {
        const result = load(rancherHost(", values: { auditLog: { enabled: true }, ingress: { extraAnnotations: { a: b } } }"));
        expect(errors(result)).toEqual([]);
    });

    it("rejects values the engine owns, at or under a protected path", () => {
        const result = load(rancherHost(", values: { hostname: other.example.com, ingress: { tls: { source: letsEncrypt } }, replicas: 3 }"));
        expect(errors(result)).toEqual([
            "hosts.vm.profiles.rancher.values.hostname: is set by the lab engine (hostname); it can't be overridden",
            "hosts.vm.profiles.rancher.values.ingress.tls.source: is set by the lab engine (ingress.tls.source); it can't be overridden",
            "hosts.vm.profiles.rancher.values.replicas: is set by the lab engine (replicas); it can't be overridden",
        ]);
    });

    it("renders the profiles' templates for each host", () => {
        const { lab, diagnostics } = load(rancherHost(", hostname: manager"));
        expect(diagnostics.errors).toEqual([]);
        const host = lab!.hosts[0];
        expect(host.chartValues.rancher.entries[0].lockedValues).toEqual({
            replicas: 1,
            hostname: "manager.vm.lab.geeko.me",
            ingress: { ingressClassName: "traefik", tls: { source: "secret", secretName: "wildcard-cert" } },
            privateCA: true,                      // BASE uses Let's Encrypt staging: a real boolean
            agentTLSMode: "strict",
        });
        // Liz is off unless the rancher profile says liz: true.
        expect(host.chartValues.rancher.entries[1].install).toBe(false);
        // No load-balancer profile on the host: Traefik's Service gets no annotations.
        expect(host.chartValues.traefik.entries[1].lockedValues.service).toEqual({ annotations: {} });
        // The Gateway API manifest: its channel, and the catalog's version (no gatewayApi.version setting).
        expect(host.chartValues.traefik.entries[0]).toMatchObject({ install: true, vars: { channel: "standard" } });
        expect(host.chartValues.traefik.entries[0].version).toBeUndefined();
        expect(host.outputs).toMatchObject({ tls: { secretName: "wildcard-cert" }, ingress: { ingressClassName: "traefik" } });
    });

    it("rejects a scalar where the engine needs a map", () => {
        const result = load(rancherHost(", values: { ingress: disabled }"));
        expect(errors(result)).toEqual(["hosts.vm.profiles.rancher.values.ingress: is set by the lab engine (ingress.ingressClassName); it can't be overridden"]);
    });
});

describe("downstream passthroughs", () => {
    const lab = (extra: string) => `${BASE}
hosts:
  rancher: { on: hv-north, os: leap-16, cpu: 4, memory: 16Gi, disk: 100Gi, profiles: { ${RANCHER_STACK} } }
downstream:
  apps:
    type: harvester
    rancher: rancher
    harvester: hv-north
    pools: [{ name: a, quantity: 1, roles: [etcd, controlplane, worker], cpu: 2, memory: 4Gi, disk: 40Gi, os: leap-16 }]
${extra}`;

    it("passes cni, machineGlobalConfig and chartValues through", () => {
        const result = load(lab("    cni: cilium\n    machineGlobalConfig: { disable: [rke2-ingress-nginx] }\n    chartValues: { rke2-cilium: { hubble: { enabled: true } } }\n"));
        expect(errors(result)).toEqual([]);
        expect(result.lab!.downstream[0]).toMatchObject({ cni: "cilium", machineGlobalConfig: { disable: ["rke2-ingress-nginx"] } });
    });

    it("keeps the CNI key and the Harvester cloud provider's values engine-owned", () => {
        expect(errors(load(lab("    machineGlobalConfig: { cni: canal }\n    chartValues: { harvester-cloud-provider: { clusterName: x } }\n")))).toEqual([
            "downstream.apps.machineGlobalConfig.cni: set it with downstream cni instead",
            "downstream.apps.chartValues.harvester-cloud-provider: is set by the lab engine; it can't be overridden",
        ]);
    });
});

describe("host profiles", () => {
    it("rejects unknown profiles and checks settings against the catalog", () => {
        const result = load(`${BASE}
hosts:
  vm: { on: hv-north, os: leap-16, cpu: 2, memory: 4Gi, disk: 20Gi, profiles: { nope: {}, k3s: { versoin: x }, hauler: { port: 70000 } } }
`);
        expect(errors(result)).toEqual([
            'hosts.vm.profiles: unknown profile "nope"; known: cert-manager, harvester-cloud-provider, hauler, k3s, metallb, mlm-client, mlm-server, outrider, rancher, rke2, sprouter, traefik',
            'hosts.vm.profiles.k3s.versoin: unknown field "versoin"',
            "hosts.vm.profiles.hauler.port: Too big: expected number to be <=65535",
        ]);
    });

    it("applies the catalog's defaults", () => {
        const { lab } = load(`${BASE}\nhosts:\n  vm: { on: hv-north, os: leap-16, cpu: 2, memory: 4Gi, disk: 20Gi, profiles: { hauler: {} } }\n`);
        expect(lab!.hosts[0].profiles.hauler).toEqual({ manifests: [] });
        expect(lab!.hosts[0].capabilities).toEqual(["hauler", "registry"]);
    });

    it("can't have its rules changed, or new ones added, from a lab", () => {
        const result = loadDocs(`${labDocument(BASE)}---
kind: Profile
metadata: { name: rancher }
spec: { requires: [] }
`);
        expect(errors(result)).toEqual(["Profile/rancher: Profiles can only be defined in the engine's catalog (lab/catalog/): their builders are written against them"]);
    });
});

describe("catalog plugins", () => {
    it("merges a partial repo override, and plugins in and out of the default set", () => {
        const { lab, diagnostics } = loadDocs(`${labDocument(BASE)}---
kind: UiPluginRepository
metadata: { name: rancher-ui-plugins }
spec: { branch: dev }
---
kind: UiPlugin
metadata: { name: kubewarden }
spec: { default: false }
---
kind: UiPlugin
metadata: { name: elemental }
spec: { repository: rancher-ui-plugins, version: 3.0.0, default: true }
`);
        expect(diagnostics.errors).toEqual([]);
        expect(lab!.plugins.repo).toEqual({ name: "rancher-ui-plugins", gitRepo: "https://github.com/rancher/ui-plugin-charts", branch: "dev" });
        expect(lab!.plugins.default).toEqual(["elemental", "harvester", "rancher-ai-ui", "virtual-clusters", "vulnerability-scanner"]);
        expect(lab!.plugins.versions).toMatchObject({ elemental: "3.0.0", kubewarden: expect.any(String) });
    });
});

describe("Fleet repos", () => {
    const rancher = (fleet: string, extra = "", tail = "") => `${BASE}
hosts:
  vm: { on: hv-north, os: leap-16, cpu: 4, memory: 16Gi, disk: 100Gi, profiles: { ${RANCHER_STACK.replace("adminPassword: { $secret: ra }", `adminPassword: { $secret: ra }${fleet ? `, fleet: ${fleet}` : ""}`)}${extra} } }
${tail}`;
    const repoNames = (r: LoadResult) => r.lab!.fleet.vm.repos.map(x => x.name);
    const objectsOn = (r: LoadResult) => r.lab!.objects.map(o => `${o.kind} ${o.namespace}/${o.name}`);

    it("creates the default repos that need no inputs, and says what the others wait for", () => {
        const result = load(rancher(""));
        expect(errors(result)).toEqual([]);
        expect(repoNames(result)).toEqual(["lab-setup-base", "lab-setup-demos", "lab-setup-local", "lab-setup-platform", "lab-setup-thirdparty"]);
        expect(result.lab!.fleet.vm.groups).toHaveProperty("all-downstream-clusters");
        expect(result.lab!.fleet.vm.skipped).toContainEqual({ what: "repo lab-setup-appco", missing: ["appco"] });
        // A secret with no keys left is reported once, not per key.
        expect(result.lab!.skippedObjects).toContainEqual({ what: "secret fleet-default/application-collection-basicauth on vm", missing: ["appco"] });
        // fleet-secrets needs Outrider, which the host doesn't run: left out, and said so.
        expect(result.lab!.skippedObjects).toContainEqual({ what: "secret fleet-default/fleet-secrets on vm", missing: ["downstream-secrets (outrider) on vm"] });
        expect(result.lab!.objects).toEqual([]);
    });

    it("builds the repos' secrets from the lab's inputs, on the Rancher host", () => {
        const result = load(rancher("", ", outrider: {}", "inputs: { appco: { $secret: appco }, suse-observability-license: { $secret: obs } }\n"));
        expect(errors(result)).toEqual([]);
        expect(repoNames(result)).toContain("lab-setup-appco");
        expect(repoNames(result)).not.toContain("lab-setup-suse");
        const basicauth = result.lab!.objects.find(x => x.name === "application-collection-basicauth")!;
        expect(basicauth).toMatchObject({ kind: "Secret", namespace: "fleet-default", target: { host: "vm" }, type: "kubernetes.io/basic-auth" });
        expect(basicauth.data).toEqual({ username: { $secret: "appco", key: "username" }, password: { $secret: "appco", key: "password" } });
        const files = result.lab!.objects.find(x => x.name === "fleet-secrets")!.data;
        expect(Object.keys(files).sort()).toEqual(["appco-values.yaml", "cert-manager-values.yaml", "harbor-values.yaml", "suse-observability-values.yaml"]);
        expect(files["cert-manager-values.yaml"]).toEqual({ letsencrypt: { prod: { email: "a@b.cd" } }, cloudflare: { token: { $secret: "cf" } } });
        expect(result.lab!.secrets).toMatchObject({ appco: "credentials", obs: "string" });
        expect(result.lab!.hosts[0].profileOrder.indexOf("outrider")).toBeLessThan(result.lab!.hosts[0].profileOrder.indexOf("rancher"));
    });

    it("leaves out a used secret whose requirements the host lacks; listed by name, it's an error", () => {
        const result = load(rancher("", "", "inputs: { appco: { $secret: appco } }\n"));
        expect(errors(result)).toEqual([]);
        expect(result.lab!.skippedObjects).toContainEqual({ what: "secret fleet-default/fleet-secrets on vm", missing: ["downstream-secrets (outrider) on vm"] });
        expect(repoNames(result)).toContain("lab-setup-appco");
        expect(errors(load(`${BASE}
hosts:
  vm: { on: hv-north, os: leap-16, cpu: 4, memory: 16Gi, disk: 100Gi, profiles: { k3s: {} }, secrets: [fleet-secrets] }
`))).toEqual([
            "hosts.vm.secrets[0]: secret fleet-secrets needs downstream-secrets (outrider) on vm",
        ]);
    });

    it("creates only the listed repos; a listed repo whose Helm secret can't be built is an error", () => {
        expect(repoNames(load(rancher("{ repos: [lab-setup-demos, lab-setup-base] }")))).toEqual(["lab-setup-demos", "lab-setup-base"]);
        expect(repoNames(load(rancher("{ repos: [] }")))).toEqual([]);
        expect(errors(load(rancher("{ repos: [lab-setup-suse, nope] }")))).toEqual([
            "hosts.vm.profiles.rancher.fleet.repos[0]: secret scc-suse-basicauth needs input scc; set them under inputs",
            'hosts.vm.profiles.rancher.fleet.repos[1]: unknown Fleet repo "nope"; known: ai-apps, lab-setup-appco, lab-setup-base, lab-setup-demos, lab-setup-local, lab-setup-platform, lab-setup-suse, lab-setup-thirdparty',
        ]);
    });

    it("lets the lab change a repo's fields and add its own repos and groups", () => {
        const result = load(rancher("{ repos: [lab-setup-base, team-apps] }", "", `catalog:
  fleet:
    groups: { demo: { matchLabels: { env: demo } } }
    repos:
      lab-setup-base: { branch: my-feature, url: https://example.com/fork.git }
      team-apps: { url: https://example.com/team.git, paths: [/], target: demo }
`));
        expect(errors(result)).toEqual([]);
        expect(result.lab!.fleet.vm.repos.map(r => `${r.name}@${r.branch} ${r.url} ${r.paths.join(",")}`)).toEqual([
            "lab-setup-base@my-feature https://example.com/fork.git /apps/base",
            "team-apps@main https://example.com/team.git /",
        ]);
        expect(result.lab!.fleet.vm.groups).toMatchObject({ demo: { matchLabels: { env: "demo" } }, "all-downstream-clusters": expect.anything() });
        expect(objectsOn(result)).toEqual([]);
    });

    it("checks secret and group references", () => {
        expect(errors(load(rancher("{ repos: [r] }", "", "catalog:\n  fleet:\n    repos:\n      r: { url: https://example.com/r.git, target: nope, uses: [missing] }\n")))).toEqual([
            'catalog.fleet.repos.r.target: no ClusterGroup "nope" in catalog.fleet.groups',
        ]);
        expect(errors(load(rancher("{ repos: [r] }", "", "catalog:\n  fleet:\n    repos:\n      r: { url: https://example.com/r.git, uses: [missing] }\n")))).toEqual([
            'catalog.fleet.repos.r.uses[0]: no catalog secret "missing"',
        ]);
    });
});

describe("secrets and configmaps", () => {
    const lab = (host: string, tail = "") => `${BASE}
hosts:
  vm: { on: hv-north, os: leap-16, cpu: 4, memory: 16Gi, disk: 100Gi, ${host} }
${tail}`;

    it("places catalog objects on a host's cluster, by name or with a namespace", () => {
        const result = load(lab("profiles: { k3s: {} }, secrets: [scc-suse-basicauth], configmaps: [{ name: proxy, namespace: kube-system }]", `inputs: { scc: { username: me, password: { $secret: scc-pw } } }
catalog:
  configmaps:
    proxy: { data: { HTTPS_PROXY: http://proxy.example.com:3128, settings: { noProxy: [{ $lab: domain }] } } }
`));
        expect(errors(result)).toEqual([]);
        expect(result.lab!.objects).toEqual([
            expect.objectContaining({ kind: "Secret", name: "scc-suse-basicauth", namespace: "default", target: { host: "vm" }, data: { username: "me", password: { $secret: "scc-pw" } } }),
            expect.objectContaining({ kind: "ConfigMap", name: "proxy", namespace: "kube-system", data: { HTTPS_PROXY: "http://proxy.example.com:3128", settings: { noProxy: ["lab.geeko.me"] } } }),
        ]);
        expect(result.lab!.secrets).toMatchObject({ "scc-pw": "string" });
    });

    it("takes inputs from the personal config, overridden by the lab", () => {
        const personal = path.join(tmp, "config-inputs.yaml");
        writePersonal(personal, `${PERSONAL_YAML}inputs:\n  scc: { $secret: my-scc }\n  appco: { $secret: my-appco }\n`);
        const result = load(lab("profiles: { k3s: {} }, secrets: [scc-suse-basicauth, application-collection-basicauth]", "inputs: { appco: { $secret: lab-appco } }\n"), personal);
        expect(errors(result)).toEqual([]);
        expect(result.lab!.objects.map(o => (o.data.username as { $secret: string }).$secret)).toEqual(["my-scc", "lab-appco"]);
    });

    it("places objects on downstream clusters", () => {
        const result = load(`${BASE}
hosts:
  rancher: { on: hv-north, os: leap-16, cpu: 4, memory: 16Gi, disk: 100Gi, profiles: { ${RANCHER_STACK} } }
inputs: { appco: { $secret: appco } }
downstream:
  apps:
    type: harvester
    rancher: rancher
    harvester: hv-north
    secrets: [{ name: application-collection-basicauth, namespace: apps }]
    pools: [{ name: a, quantity: 1, roles: [etcd, controlplane, worker], cpu: 2, memory: 4Gi, disk: 40Gi, os: leap-16 }]
`);
        expect(errors(result)).toEqual([]);
        expect(result.lab!.objects).toContainEqual(expect.objectContaining({ name: "application-collection-basicauth", namespace: "apps", target: { downstream: "apps" } }));
    });

    it("rejects listed objects that can't be built, unknown names and inputs, and hosts without Kubernetes", () => {
        expect(errors(load(lab("profiles: { k3s: {} }, secrets: [scc-suse-basicauth, nope]")))).toEqual([
            "hosts.vm.secrets[0]: secret scc-suse-basicauth needs input scc; set them under inputs",
            'hosts.vm.secrets[1]: unknown secret "nope"; known: application-collection-basicauth, fleet-secrets, scc-suse-basicauth',
        ]);
        expect(errors(load(lab("secrets: [fleet-secrets]")))).toEqual([
            "hosts.vm: has secrets or configmaps to create, but no kubernetes (k3s or rke2) to put them on",
        ]);
        expect(errors(load(lab("profiles: { k3s: {} }", "inputs: { appco: plain, other: x }\n")))).toEqual([
            "inputs.appco: must be credentials: { $secret: name } or { username, password }",
            'inputs.other: no catalog secret or configmap takes input "other"; known: appco, scc, suse-observability-license',
        ]);
    });

    it("checks refs in a secret's templates", () => {
        const result = load(lab("profiles: { k3s: {} }, secrets: [s]", `inputs: { key: { $secret: k } }
catalog:
  secrets:
    s: { inputs: { key: string }, data: { a: { $input: key.username }, b: { $input: nope }, c: { $lab: nope } } }
`));
        expect(errors(result)).toEqual([
            'catalog.secrets.s.data.a: input "key" is a single value: use key',
            "catalog.secrets.s.data.b: refers to input \"nope\", which secret s doesn't list under inputs",
            'catalog.secrets.s.data.c: unknown $lab ref "nope"; one of tls.email, tls.cloudflare, domain',
        ]);
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
        expect(result.diagnostics.warnings.map(d => d.path)).toContain("Harvester/hv-north.spec.credentials.password");
    });
});
