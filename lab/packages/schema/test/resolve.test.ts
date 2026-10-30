import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatDiagnostic, loadLab, LoadResult, ObjectTemplate, objectTemplateContext, renderSecretTemplate, renderTemplate } from "../src";
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
    credentials: "{{ secrets['hv-north'] }}"
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
const RANCHER_STACK = "k3s: {}, cert-manager: {}, sprouter: {}, traefik: {}, rancher: { adminPassword: \"{{ secrets.ra }}\" }";

// A valid single-VM lab to derive broken variants from.
const BASE = `
lab: test
domain: lab.geeko.me
tls: { acme: letsencrypt-staging, email: a@b.cd, cloudflare: "{{ secrets.cf }}" }
ssh: { user: lab, publicKey: "ssh-ed25519 AAAA", privateKey: "{{ secrets['ssh-key'] }}" }
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
            cloudflare: { fields: ["token"] },
            "ssh-key": "string",
            "rancher-admin": "string",
            "mlm-admin": "string",
            "scc-regcode-slmicro": "string",
        });
    });

    it("takes Harvester url and credentials from the personal config", () => {
        const { lab } = loadLab({ labFile: path.join(LABS_DIR, "rancher-custom-edge.yaml"), personalConfig });
        expect(lab!.harvesters[0]).toMatchObject({ url: "https://hv-north.lab.geeko.me", credentials: "{{ secrets['hv-north'] }}", insecure: true });
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
  rancher: { on: hv-north, os: leap-16, cpu: 4, memory: 16Gi, disk: 100Gi, profiles: { rancher: { adminPassword: \"{{ secrets.ra }}\" } } }
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
        const builtin = host("k3s: {}, cert-manager: {}, sprouter: {}, rancher: { adminPassword: \"{{ secrets.ra }}\" }");
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
            'hosts.vm2.os: unknown OS profile "windows-11"; known: leap-16, leap-16-k8s, rocky-9, rocky-9-k8s, sl-micro-6.1, sles-16, sles-16-k8s, ubuntu-24.04, ubuntu-24.04-k8s',
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

    it("rejects a metal-cluster node that runs its own Kubernetes", () => {
        const result = load(`${BASE}
hosts:
  rancher: { on: hv-north, os: leap-16, cpu: 4, memory: 16Gi, disk: 100Gi, profiles: { ${RANCHER_STACK} } }
downstream:
  edge:
    type: metal
    rancher: rancher
    nodes: [{ host: rancher, roles: [etcd, controlplane, worker] }]
`);
        expect(errors(result)).toEqual([
            'downstream.edge.nodes[0].host: host "rancher" can\'t join a metal cluster: it runs k3s, which can\'t share a host with Kubernetes',
        ]);
    });

    it("warns about a metal-cluster node without its OS's -k8s variant", () => {
        const result = load(`${BASE}
hosts:
  rancher: { on: hv-north, os: leap-16-k8s, cpu: 4, memory: 16Gi, disk: 100Gi, profiles: { ${RANCHER_STACK} } }
  node: { on: hv-north, os: leap-16, cpu: 2, memory: 4Gi, disk: 40Gi }
downstream:
  edge:
    type: metal
    rancher: rancher
    nodes: [{ host: node, roles: [etcd, controlplane, worker] }]
`);
        expect(errors(result)).toEqual([]);
        expect(result.diagnostics.warnings.map(d => `${resolverPath(d.path)}: ${d.message}`)).toContain(
            'downstream.edge.nodes[0].host: host "node" runs leap-16; a metal-cluster node needs Kubernetes\' prerequisites: use leap-16-k8s');
    });

    it("needs an image source for OSes without a public image", () => {
        const empty = path.join(tmp, "empty-config.yaml");
        writePersonal(empty, "harvesters: { hv-north: { url: https://hv.example.com, credentials: \"{{ secrets.hv }}\" } }\n");
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
        expect(errors(load(host("{ mlm-server: { adminPassword: \"{{ secrets.m }}\" } }", "ubuntu-24.04")))).toEqual([
            'hosts.vm.profiles.mlm-server: needs an OS of the suse family; "ubuntu-24.04" is debian',
        ]);
    });

    it("reports conflicts once", () => {
        expect(errors(load(host("{ k3s: {}, mlm-server: { adminPassword: \"{{ secrets.m }}\" }, mlm-client: { server: other } }", "sl-micro-6.1")))).toEqual([
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

describe("TLS", () => {
    it("needs an ACME server for cert-manager", () => {
        const result = load(`${BASE.replace("acme: letsencrypt-staging", "acme: none")}hosts:\n  r: { on: hv-north, os: leap-16-k8s, profiles: { ${RANCHER_STACK} } }\n`);
        expect(errors(result)).toContain("hosts.r.profiles.cert-manager: issues certificates from the lab's ACME server; set tls.acme (and tls.email, tls.cloudflare), not none");
    });
});

describe("k3k clusters", () => {
    const POOL = "pools: [{ name: a, quantity: 1, roles: [etcd, controlplane, worker], os: leap-16-k8s }]";
    const lab = (extra: string) => `${BASE}hosts:
  r1: { on: hv-north, os: leap-16-k8s, profiles: { ${RANCHER_STACK} } }
  r2: { on: hv-north, os: leap-16-k8s, profiles: { ${RANCHER_STACK} } }
downstream:
  apps: { type: harvester, rancher: r1, harvester: hv-north, ${POOL} }
  other: { type: harvester, rancher: r2, harvester: hv-north, ${POOL} }
${extra}`;

    it("runs in a downstream cluster of the same Rancher, in namespace k3k-<name> unless it says", () => {
        const result = load(lab("  team: { type: k3k, rancher: r1, parent: apps }\n  tenants: { type: k3k, rancher: r1, parent: apps, namespace: shared-ns, mode: virtual, agents: 2 }\n"));
        expect(errors(result)).toEqual([]);
        const k3k = Object.fromEntries(result.lab!.downstream.filter(d => d.type === "k3k").map(d => [d.name, d]));
        expect(k3k.team).toMatchObject({ parent: "apps", namespace: "k3k-team", mode: "shared", servers: 1, agents: 0 });
        expect(k3k.tenants).toMatchObject({ namespace: "shared-ns", mode: "virtual", agents: 2 });
    });

    it("rejects an unknown parent, a k3k parent, and a parent of another Rancher", () => {
        const result = load(lab("  a: { type: k3k, rancher: r1, parent: nope }\n  b: { type: k3k, rancher: r1, parent: apps }\n  c: { type: k3k, rancher: r1, parent: b }\n  d: { type: k3k, rancher: r1, parent: other }\n"));
        expect(errors(result)).toEqual([
            'downstream.a.parent: unknown downstream cluster "nope"; known: apps, b, c, d, other',
            'downstream.c.parent: "b" is a k3k cluster itself; a k3k cluster runs in a harvester, ec2, eks or metal cluster',
            'downstream.d.parent: "other" is managed by the Rancher on r2, this cluster by the one on r1; they must be the same',
        ]);
    });
});

describe("AWS sites and ec2 clusters", () => {
    // No profile makes a Rancher public yet; a stub one in a copy of the catalog stands in for it.
    let catalogDir: string;
    beforeAll(() => {
        catalogDir = path.join(tmp, "catalog-public");
        fs.cpSync(path.resolve(__dirname, "..", "..", "..", "catalog"), catalogDir, { recursive: true });
        fs.writeFileSync(path.join(catalogDir, "profiles", "public-ingress.yaml"), "apiVersion: lab.geeko.me/v1alpha1\nkind: Profile\nmetadata: { name: public-ingress, description: test stub }\nspec: { requires: [ kubernetes ] }\n");
    });
    const POOL = "{ name: all, quantity: 1, roles: [etcd, controlplane, worker], os: ubuntu-24.04-k8s }";
    const lab = (site: string, cluster: string, publicRancher = true) => `${BASE}awsSites:
  eu: ${site}
hosts:
  vm: { on: hv-north, os: leap-16-k8s, profiles: { ${RANCHER_STACK}${publicRancher ? ", public-ingress: {}" : ""} } }
downstream:
  cloud: ${cluster}
`;
    const loadPublic = (yaml: string, personal = personalConfig) => {
        const file = path.join(tmp, `lab-${Math.random().toString(36).slice(2)}.yaml`);
        fs.writeFileSync(file, labDocument(yaml));
        return loadLab({ labFile: file, personalConfig: personal, catalogDir });
    };

    it("cuts a subnet per zone from the VPC and fills in the pools", () => {
        const result = loadPublic(lab(
            "{ region: eu-west-1, credentials: \"{{ secrets.aws }}\", zones: [a, c], ttl: 8h }",
            `{ type: ec2, rancher: vm, site: eu, pools: [ ${POOL}, { name: workers, quantity: 2, roles: [worker], os: rocky-9-k8s, instanceType: m6i.xlarge, disk: 100Gi, zone: c } ] }`,
        ));
        expect(errors(result)).toEqual([]);
        expect(result.lab!.awsSites).toEqual([{
            name: "eu", region: "eu-west-1", credentials: "{{ secrets.aws }}", vpcCidr: "10.100.0.0/16", ttl: 8 * 3600,
            zones: [{ letter: "a", az: "eu-west-1a", cidr: "10.100.0.0/20" }, { letter: "c", az: "eu-west-1c", cidr: "10.100.16.0/20" }],
        }]);
        const cloud = result.lab!.downstream.find(d => d.name === "cloud")!;
        expect(cloud).toMatchObject({ type: "ec2", site: "eu", distro: "rke2" });
        expect(cloud.type === "ec2" && cloud.pools).toEqual([
            { name: "all", quantity: 1, roles: ["etcd", "controlplane", "worker"], os: "ubuntu-24.04-k8s", instanceType: "t3.large", disk: "40Gi", zone: "a" },
            { name: "workers", quantity: 2, roles: ["worker"], os: "rocky-9-k8s", instanceType: "m6i.xlarge", disk: "100Gi", zone: "c" },
        ]);
        expect(result.lab!.secrets).toMatchObject({ aws: { fields: ["accessKey", "secretKey"] } });
        expect(result.lab!.os["rocky-9-k8s"].ami).toMatchObject({ owner: "792107900819", user: "rocky" });
    });

    it("takes the region and keys from the personal config", () => {
        const personal = writePersonal(path.join(tmp, "personal-aws.yaml"), `${PERSONAL_YAML}awsSites:\n  eu: { region: eu-central-1, credentials: { accessKey: AKIA, secretKey: "{{ secrets['aws-secret'] }}" } }\n`);
        const result = loadPublic(lab("{}", `{ type: ec2, rancher: vm, site: eu, pools: [ ${POOL} ] }`), personal);
        expect(errors(result)).toEqual([]);
        expect(result.lab!.awsSites[0]).toMatchObject({ region: "eu-central-1", zones: [{ az: "eu-central-1a" }, { az: "eu-central-1b" }] });
        expect(result.lab!.secrets).toMatchObject({ "aws-secret": "string" });
    });

    it("needs a public Rancher, a known site, a zone of the site, an OS with an AMI and every role", () => {
        expect(errors(loadPublic(lab("{ region: eu-west-1, credentials: \"{{ secrets.aws }}\" }", `{ type: ec2, rancher: vm, site: eu, pools: [ ${POOL} ] }`, false)))).toEqual([
            "downstream.cloud.rancher: EC2 machines reach Rancher over the internet, and the Rancher on vm isn't public: its host needs public-ingress",
        ]);
        expect(errors(loadPublic(lab(
            "{ region: eu-west-1, credentials: \"{{ secrets.aws }}\" }",
            "{ type: ec2, rancher: vm, site: eu, pools: [ { name: a, quantity: 1, roles: [etcd, controlplane], os: leap-16-k8s, zone: c } ] }",
        )))).toEqual([
            "downstream.cloud.pools[0].os: OS profile leap-16-k8s has no AMI (ami: owner and name) to boot EC2 machines from",
            "downstream.cloud.pools[0].zone: the site eu has no subnet in zone c; its zones: a, b",
            "downstream.cloud: no node has the worker role; a cluster needs at least one of each",
        ]);
        expect(errors(loadPublic(lab("{ region: eu-west-1, credentials: \"{{ secrets.aws }}\" }", `{ type: ec2, rancher: vm, site: us, pools: [ ${POOL} ] }`)))).toEqual([
            'downstream.cloud.site: unknown AwsSite "us"; known: eu',
        ]);
    });

    it("checks the site's VPC, zones and keys", () => {
        expect(errors(loadPublic(lab("{ vpc: { cidr: 10.100.0.0/25 }, zones: [a, a] }", `{ type: ec2, rancher: vm, site: eu, pools: [ ${POOL} ] }`)))).toEqual([
            "awsSites.eu.region: missing; set it here or in the personal config under awsSites.eu.region",
            "awsSites.eu.credentials: missing; set it here or in the personal config under awsSites.eu.credentials",
            "awsSites.eu.vpc.cidr: must be a /16 to /24: each zone gets a sixteenth of it",
            "awsSites.eu.zones[1]: zone a is listed twice",
        ]);
        expect(errors(loadPublic(lab("{ region: eu-west-1, credentials: AKIA, vpc: { cidr: 10.100.3.0/16 } }", `{ type: ec2, rancher: vm, site: eu, pools: [ ${POOL} ] }`)))).toEqual([
            'awsSites.eu.credentials: AWS credentials are one secret ("{{ secrets.name }}") or { accessKey, secretKey }',
            "awsSites.eu.vpc.cidr: 10.100.3.0/16 isn't the start of its range; use 10.100.0.0/16",
        ]);
    });

    it("fills in an EKS cluster's version and node groups from the defaults and the site", () => {
        const result = loadPublic(lab(
            "{ region: eu-west-1, credentials: \"{{ secrets.aws }}\", zones: [a, b, c] }",
            "{ type: eks, rancher: vm, site: eu, labels: { where: aws }, nodeGroups: [ { name: general, quantity: 2 }, { name: big, quantity: 1, max: 3, instanceType: m7g.xlarge, disk: 80Gi, zones: [c] } ] }",
        ));
        expect(errors(result)).toEqual([]);
        const cloud = result.lab!.downstream.find(d => d.name === "cloud")!;
        expect(cloud).toMatchObject({ type: "eks", site: "eu", version: "1.34", labels: { where: "aws" } });
        expect(cloud.type === "eks" && cloud.nodeGroups).toEqual([
            { name: "general", quantity: 2, min: 2, max: 2, instanceType: "t3.large", disk: "40Gi", zones: ["a", "b", "c"] },
            { name: "big", quantity: 1, min: 1, max: 3, instanceType: "m7g.xlarge", disk: "80Gi", zones: ["c"] },
        ]);
    });

    it("needs a public Rancher, two zones, zones of the site and sizes in range for EKS", () => {
        expect(errors(loadPublic(lab("{ region: eu-west-1, credentials: \"{{ secrets.aws }}\" }", "{ type: eks, rancher: vm, site: eu, nodeGroups: [ { name: g, quantity: 1 } ] }", false)))).toEqual([
            "downstream.cloud.rancher: An EKS cluster's agent reaches Rancher over the internet, and the Rancher on vm isn't public: its host needs public-ingress",
        ]);
        expect(errors(loadPublic(lab(
            "{ region: eu-west-1, credentials: \"{{ secrets.aws }}\", zones: [a] }",
            "{ type: eks, rancher: vm, site: eu, version: \"1.33\", nodeGroups: [ { name: g, quantity: 5, max: 3, zones: [b] }, { name: g, quantity: 1 } ] }",
        )))).toEqual([
            "downstream.cloud.site: EKS needs subnets in two zones at least, and the site eu has 1",
            "downstream.cloud.nodeGroups[0].quantity: 5 isn't between min 5 and max 3",
            "downstream.cloud.nodeGroups[0].zones: the site eu has no subnet in zone b; its zones: a",
            'downstream.cloud.nodeGroups[1].name: node group "g" is defined twice',
        ]);
    });

    it("reports a site's fields at its document", () => {
        const result = loadPublic(lab("{ region: eu-west-1 }", `{ type: ec2, rancher: vm, site: eu, pools: [ ${POOL} ] }`));
        expect(result.diagnostics.errors.map(d => d.path)).toEqual(["AwsSite/eu.spec.credentials"]);
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

    it("checks a DHCP network's addresses against each other", () => {
        const net = (dhcp: string) => BASE.replace("hv-north: {}", `hv-north: { networks: { vlans: [{ id: 20, dhcp: ${dhcp} }] } }`);
        expect(errors(load(net("{ cidr: 10.29.20.5/24, gateway: 10.29.20.255, range: [10.29.20.150, 10.29.20.100] }")))).toEqual([
            "harvesters.hv-north.networks.vlans[0].dhcp.cidr: 10.29.20.5/24 isn't the start of its range; use 10.29.20.0/24",
            "harvesters.hv-north.networks.vlans[0].dhcp.gateway: 10.29.20.255 is the network's broadcast address",
            "harvesters.hv-north.networks.vlans[0].dhcp.range: start is after end",
        ]);
        expect(errors(load(net("{ cidr: 10.29.20.0/24, gateway: 10.29.20.2, range: [10.29.20.0, 10.29.20.150] }")))).toEqual([
            "harvesters.hv-north.networks.vlans[0].dhcp.range[0]: 10.29.20.0 is the network's own address",
            "harvesters.hv-north.networks.vlans[0].dhcp.range: contains the gateway 10.29.20.2",
            "harvesters.hv-north.networks.vlans[0].dhcp.range: contains the DHCP server 10.29.20.2",
            "harvesters.hv-north.networks.vlans[0].dhcp.server: the DHCP server defaults to 10.29.20.2, which is the gateway; set server to a free address",
        ]);
    });

    it("only runs on Harvester VMs", () => {
        const result = load(`${BASE}\nhosts:\n  box: { on: ssh, address: box.example.com, os: leap-16, profiles: { k3s: {}, harvester-cloud-provider: {} } }\n`);
        expect(errors(result)).toEqual(["hosts.box.profiles.harvester-cloud-provider: only runs on Harvester VMs"]);
    });
});

describe("OS profiles", () => {
    it("supports extends: cloud-config lists are joined, the rest of the child wins, the image is shared", () => {
        const { lab, diagnostics } = load(`${BASE}
catalog:
  os:
    leap-16-dev:
      extends: leap-16-k8s
      cloudInit: { packages: [make], runcmd: [make install], timezone: UTC }
hosts:
  vm: { on: hv-north, os: leap-16-dev, cpu: 2, memory: 4Gi, disk: 20Gi }
  plain: { on: hv-north, os: leap-16, cpu: 2, memory: 4Gi, disk: 20Gi }
`);
        expect(diagnostics.errors).toEqual([]);
        const dev = lab!.os["leap-16-dev"];
        expect(dev.family).toBe("suse");
        expect(dev.cloudInit.packages).toEqual(["curl", "git-core", "bash-completion", "vim", "wget", "tree", "qemu-guest-agent", "firewalld", "k3s-selinux", "open-iscsi", "nfs-client", "cryptsetup", "make"]);
        expect((dev.cloudInit.runcmd as string[]).at(0)).toBe("systemctl enable --now qemu-guest-agent");
        expect((dev.cloudInit.runcmd as string[]).at(-1)).toBe("make install");
        expect(dev.cloudInit).toMatchObject({ package_update: true, timezone: "UTC" });
        // Both variants boot leap-16's image: one download.
        expect(lab!.harvesters[0].images).toEqual([{ os: "leap-16", source: { kind: "url", url: expect.stringContaining("Leap-16.0") } }]);
    });

    it("checks the cloudInit templates and registers the secrets they use", () => {
        const result = load(`${BASE}\ncatalog:\n  os:\n    mine: { extends: leap-16, cloudInit: { runcmd: [\"echo {{ secrets.tok }} {{ lab.domain }}\", \"echo {{ secrets.tok.user }}\", \"echo {{ nope }}\"] } }\nhosts:\n  vm: { on: hv-north, os: mine, cpu: 2, memory: 4Gi, disk: 20Gi }\n`);
        // After leap-16's own runcmd.
        expect(errors(result).filter(e => e.startsWith("cloudInit"))).toEqual([
            "cloudInit.runcmd[3]: secret \"tok\" is used both as string and as a map with user",
            "cloudInit.runcmd[4]: template: attempted to output null or undefined value",
        ]);
        const ok = load(`${BASE}\ncatalog:\n  os:\n    mine: { extends: leap-16, cloudInit: { runcmd: [\"echo {{ secrets['reg-code'] }} {{ secrets.scc.password }}\"] } }\nhosts:\n  vm: { on: hv-north, os: mine, cpu: 2, memory: 4Gi, disk: 20Gi }\n`);
        expect(errors(ok)).toEqual([]);
        expect(ok.lab!.secrets).toMatchObject({ "reg-code": "string", scc: "credentials" });
    });

    it("leaves the login and the hostname to the engine", () => {
        expect(errors(load(`${BASE}\ncatalog:\n  os:\n    mine: { extends: leap-16, cloudInit: { users: [], hostname: x } }\n`))).toEqual([
            "mine.cloudInit.users: set by the engine (the lab's ssh user and the host's name)",
            "mine.cloudInit.hostname: set by the engine (the lab's ssh user and the host's name)",
        ]);
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
  vm: { on: hv-north, os: leap-16, cpu: 4, memory: 16Gi, disk: 100Gi, profiles: { k3s: {}, cert-manager: {}, sprouter: {}, traefik: {}, rancher: { adminPassword: "{{ secrets.ra }}"${rancher} } } }
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

    it("merges a distribution override's config and withCapability key by key", () => {
        const result = loadDocs(`${labDocument(BASE)}---
kind: KubernetesDistribution
metadata: { name: rke2 }
spec:
  config: { disable: [], profile: cis }
  withCapability: { ingress: { disable: [rke2-traefik] } }
`);
        expect(errors(result)).toEqual([]);
        const rke2 = result.lab!.components.rke2 as { config: unknown; withCapability: Record<string, unknown> };
        // Lists are replaced; the other keys stay.
        expect(rke2.config).toEqual({ disable: [], "enable-servicelb": true, profile: "cis" });
        expect(rke2.withCapability.ingress).toEqual({ disable: ["rke2-traefik"] });
        expect(rke2.withCapability["load-balancer"]).toEqual({ "enable-servicelb": false });
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

    it("takes timeouts and Harvester defaults from the catalog's Defaults, overridden field by field", () => {
        const base = load(BASE).lab!;
        expect(base.timeouts).toMatchObject({ downstreamReady: 3600, uiPlugin: 600, loadBalancerCleanup: 300 });
        expect(base.harvesters[0]).toMatchObject({
            clusterNetwork: "mgmt",
            storageClass: { name: "longhorn-single", replicas: 1, parameters: { staleReplicaTimeout: "30", migratable: "true" } },
        });

        const own = loadDocs(`${labDocument(BASE.replace("hv-north: {}", "hv-north: { storageClass: { replicas: 3, parameters: { dataLocality: best-effort } } }"))}---
kind: Defaults
metadata: { name: default }
spec:
  harvester: { clusterNetwork: storage }
  timeouts: { downstreamReady: 2h }
`);
        expect(errors(own)).toEqual([]);
        expect(own.lab!.timeouts).toMatchObject({ downstreamReady: 7200, uiPlugin: 600 });
        expect(own.lab!.harvesters[0]).toMatchObject({
            clusterNetwork: "storage",
            storageClass: { name: "longhorn-single", replicas: 3, parameters: { staleReplicaTimeout: "30", migratable: "true", dataLocality: "best-effort" } },
        });

        const sized = loadDocs(`${labDocument(`${BASE.replace("user: lab, ", "")}
hosts:
  vm: { on: hv-north, os: leap-16 }
  big: { on: hv-north, os: leap-16, memory: 32Gi }
`)}---
kind: Defaults
metadata: { name: default }
spec: { ssh: { user: geeko }, vm: { disk: 80Gi } }
`);
        expect(errors(sized)).toEqual([]);
        expect(sized.lab!.ssh!.user).toBe("geeko");
        expect(sized.lab!.hosts.map(h => h.kind === "harvester" && [h.cpu, h.memory, h.disk])).toEqual([[4, "8Gi", "80Gi"], [4, "32Gi", "80Gi"]]);

        const named = loadDocs(`${labDocument(BASE)}---
kind: Defaults
metadata: { name: mine }
spec: {}
`);
        expect(errors(named)).toEqual(['Defaults/mine.metadata.name: must be "default": there is one Defaults document, which later layers override']);
        const bad = loadDocs(`${labDocument(BASE)}---
kind: Defaults
metadata: { name: default }
spec: { timeouts: { downstreamReady: soon, nope: 1m } }
`);
        expect(errors(bad)).toEqual([
            "Defaults/default.spec.timeouts.downstreamReady: must be a duration like 90s, 15m or 2h",
            'Defaults/default.spec.timeouts.nope: unknown field "nope"',
        ]);
    });

    it("merges a lab's Rancher feature flags over the profile's default", () => {
        const rancher = (extra: string) => load(rancherHost(extra)).lab!.hosts[0].profiles.rancher as Record<string, unknown>;
        expect(rancher("").features).toEqual({ "harvester-baremetal-container-workload": true });
        expect(rancher(", features: { harvester-baremetal-container-workload: false, fleet-workspaces: true }, settings: { ui-brand: suse }")).toMatchObject({
            features: { "harvester-baremetal-container-workload": false, "fleet-workspaces": true },
            settings: { "ui-brand": "suse" },
        });
        expect(errors(load(rancherHost(", features: { x: yes }")))[0]).toMatch(/^hosts\.vm\.profiles\.rancher\.features\.x: /);
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

describe("ai-factory", () => {
    const lab = (settings: string) => `${BASE}
hosts:
  rancher: { on: hv-north, os: leap-16, cpu: 4, memory: 16Gi, disk: 100Gi, profiles: { ${RANCHER_STACK}, ai-factory: { ${settings} } } }
`;
    const credentials = (result: LoadResult) => result.lab!.hosts[0].chartValues["ai-factory"].entries[0].lockedValues.credentials as Record<string, unknown>;

    it("hands the chart secret templates for each login's fields, and the NGC user", () => {
        const result = load(lab(`applicationCollection: "{{ secrets.appco }}", suseRegistry: "{{ secrets.scc }}", nvidia: "{{ secrets.nvidia }}"`));
        expect(errors(result)).toEqual([]);
        expect(credentials(result)).toEqual({
            applicationCollection: { username: "{{ secrets.appco.username }}", password: "{{ secrets.appco.password }}" },
            suseRegistry: { username: "{{ secrets.scc.username }}", password: "{{ secrets.scc.password }}" },
            nvidia: { username: "$oauthtoken", password: "{{ secrets.nvidia }}" },
        });
        expect(result.lab!.secrets).toMatchObject({ appco: "credentials", scc: "credentials", nvidia: "string" });
    });

    it("takes a login as a username with a password secret, and leaves NVIDIA out when not given", () => {
        const result = load(lab(`applicationCollection: { username: me, password: "{{ secrets['appco-token'] }}" }, suseRegistry: "{{ secrets.scc }}"`));
        expect(errors(result)).toEqual([]);
        expect(credentials(result).applicationCollection).toEqual({ username: "me", password: "{{ secrets['appco-token'] }}" });
        expect(credentials(result).nvidia).toEqual({ username: "", password: "" });
    });

    it("needs both registry logins, and Rancher on the host", () => {
        const host = (settings: string) => load(`${BASE}
hosts:
  vm: { on: hv-north, os: leap-16, cpu: 4, memory: 16Gi, disk: 100Gi, profiles: { k3s: {}, ai-factory: { ${settings} } } }
`);
        expect(errors(host(""))).toEqual([
            "hosts.vm.profiles.ai-factory.applicationCollection: required",
            "hosts.vm.profiles.ai-factory.suseRegistry: required",
        ]);
        expect(errors(host(`applicationCollection: "{{ secrets.appco }}", suseRegistry: "{{ secrets.scc }}"`)).join("\n")).toMatch(/ai-factory.*rancher/);
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
            'hosts.vm.profiles: unknown profile "nope"; known: ai-factory, cert-manager, harvester-cloud-provider, hauler, k3s, metallb, mlm-client, mlm-server, outrider, rancher, rke2, sprouter, traefik',
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
  vm: { on: hv-north, os: leap-16, cpu: 4, memory: 16Gi, disk: 100Gi, profiles: { ${RANCHER_STACK.replace("adminPassword: \"{{ secrets.ra }}\"", `adminPassword: \"{{ secrets.ra }}\"${fleet ? `, fleet: ${fleet}` : ""}`)}${extra} } }
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
        const result = load(rancher("", ", outrider: {}", "inputs: { appco: \"{{ secrets.appco }}\", suse-observability-license: \"{{ secrets.obs }}\" }\n"));
        expect(errors(result)).toEqual([]);
        expect(repoNames(result)).toContain("lab-setup-appco");
        expect(repoNames(result)).not.toContain("lab-setup-suse");
        const basicauth = result.lab!.objects.find(x => x.name === "application-collection-basicauth")!;
        expect(basicauth).toMatchObject({ kind: "Secret", namespace: "fleet-default", target: { host: "vm" }, type: "kubernetes.io/basic-auth" });
        expect(basicauth.data).toEqual({
            username: { $template: "{{ inputs.appco.username }}", inputs: { appco: "{{ secrets.appco }}" }, lab: {} },
            password: { $template: "{{ inputs.appco.password }}", inputs: { appco: "{{ secrets.appco }}" }, lab: {} },
        });
        const files = result.lab!.objects.find(x => x.name === "fleet-secrets")!.data;
        expect(Object.keys(files).sort()).toEqual(["appco-values.yaml", "cert-manager-values.yaml", "harbor-values.yaml", "suse-observability-values.yaml"]);
        expect(files["cert-manager-values.yaml"]).toEqual({
            letsencrypt: { prod: { email: "a@b.cd" } },
            cloudflare: { token: { $template: "{{ lab.tls.cloudflare }}", inputs: {}, lab: { "tls.cloudflare": "{{ secrets.cf }}" } } },
        });
        expect(result.lab!.secrets).toMatchObject({ appco: "credentials", obs: "string" });
        expect(result.lab!.hosts[0].profileOrder.indexOf("outrider")).toBeLessThan(result.lab!.hosts[0].profileOrder.indexOf("rancher"));
    });

    it("leaves out a used secret whose requirements the host lacks; listed by name, it's an error", () => {
        const result = load(rancher("", "", "inputs: { appco: \"{{ secrets.appco }}\" }\n"));
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

describe("fleet HelmOps", () => {
    const rancher = (fleet: string, catalog = "") => `${BASE}
hosts:
  vm: { on: hv-north, os: leap-16, cpu: 4, memory: 16Gi, disk: 100Gi, profiles: { ${RANCHER_STACK.replace("rancher: {", `rancher: { fleet: ${fleet}, `)} } }
${catalog}`;
    const ops = (result: LoadResult) => result.lab!.fleet.vm.helmOps;

    it("creates the default ones: suse-observability, pulled by Fleet's agents from its repo", () => {
        const result = load(rancher("{}"));
        expect(errors(result)).toEqual([]);
        expect(ops(result)).toEqual([expect.objectContaining({
            name: "suse-observability", namespace: "fleet-default",
            repo: "https://charts.rancher.com/server-charts/prime/suse-observability", chart: "suse-observability", version: "2.12.0",
            defaultNamespace: "suse-observability", selector: { matchLabels: { "needs-observability": "true" } },
            labels: { provides: "suse-observability" },
        })]);
        expect(ops(result)[0].values).toHaveProperty("global.suseObservability.sizing.profile", "trial");
        expect(ops(result)[0].valuesFrom).toEqual([{ secretKeyRef: { name: "fleet-secrets", namespace: "kube-system", key: "suse-observability-values.yaml" } }]);
    });

    it("creates only the listed ones, and lets a lab add its own", () => {
        expect(ops(load(rancher("{ helmOps: [] }")))).toEqual([]);
        const result = load(rancher("{ helmOps: [mine] }", `catalog:
  fleet:
    helmOps:
      mine: { repo: oci://registry.example.com/charts, chart: thing, target: all-downstream-clusters }
`));
        expect(errors(result)).toEqual([]);
        expect(ops(result).map(o => `${o.name} ${o.repo} ${o.chart} → ${o.target}`)).toEqual(["mine oci://registry.example.com/charts thing → all-downstream-clusters"]);
    });

    it("checks names, charts and targets", () => {
        expect(errors(load(rancher("{ helmOps: [nope] }")))).toEqual([
            'hosts.vm.profiles.rancher.fleet.helmOps[0]: unknown Fleet HelmOp "nope"; known: suse-observability',
        ]);
        expect(errors(load(rancher("{ helmOps: [a, b, c] }", `catalog:
  fleet:
    helmOps:
      a: { repo: https://example.com/charts }
      b: { repo: https://example.com/charts, chart: x, target: nope }
      c: { repo: https://example.com/charts, chart: x, target: all-downstream-clusters, selector: { matchLabels: { a: b } } }
`)))).toEqual([
            "catalog.fleet.helmOps.a: needs a repo and a chart",
            'catalog.fleet.helmOps.b.target: no ClusterGroup "nope" in catalog.fleet.groups',
            "catalog.fleet.helmOps.c: has both a target and a selector; give one",
        ]);
    });
});

describe("secrets and configmaps", () => {
    const lab = (host: string, tail = "") => `${BASE}
hosts:
  vm: { on: hv-north, os: leap-16, cpu: 4, memory: 16Gi, disk: 100Gi, ${host} }
${tail}`;

    it("places catalog objects on a host's cluster, by name or with a namespace", () => {
        const result = load(lab("profiles: { k3s: {} }, secrets: [scc-suse-basicauth], configmaps: [{ name: proxy, namespace: kube-system }]", `inputs: { scc: { username: me, password: "{{ secrets['scc-pw'] }}" } }
catalog:
  configmaps:
    proxy: { data: { HTTPS_PROXY: http://proxy.example.com:3128, settings: { noProxy: ["{{ lab.domain }}", "*.{{ lab.domain }}"] } } }
`));
        expect(errors(result)).toEqual([]);
        expect(result.lab!.objects).toEqual([
            expect.objectContaining({ kind: "Secret", name: "scc-suse-basicauth", namespace: "default", target: { host: "vm" }, data: {
                // The username is plain, so it's rendered here; the password is a secret, rendered by the program.
                username: "me",
                password: { $template: "{{ inputs.scc.password }}", inputs: { scc: { password: "{{ secrets['scc-pw'] }}" } }, lab: {} },
            } }),
            expect.objectContaining({ kind: "ConfigMap", name: "proxy", namespace: "kube-system", data: { HTTPS_PROXY: "http://proxy.example.com:3128", settings: { noProxy: ["lab.geeko.me", "*.lab.geeko.me"] } } }),
        ]);
        expect(result.lab!.secrets).toMatchObject({ "scc-pw": "string" });
    });

    it("takes inputs from the personal config, overridden by the lab", () => {
        const personal = path.join(tmp, "config-inputs.yaml");
        writePersonal(personal, `${PERSONAL_YAML}inputs:\n  scc: "{{ secrets['my-scc'] }}"\n  appco: "{{ secrets['my-appco'] }}"\n`);
        const result = load(lab("profiles: { k3s: {} }, secrets: [scc-suse-basicauth, application-collection-basicauth]", "inputs: { appco: \"{{ secrets['lab-appco'] }}\" }\n"), personal);
        expect(errors(result)).toEqual([]);
        expect(result.lab!.objects.map(o => (o.data.username as { inputs: Record<string, string> }).inputs)).toEqual([{ scc: "{{ secrets['my-scc'] }}" }, { appco: "{{ secrets['lab-appco'] }}" }]);
    });

    it("places objects on downstream clusters", () => {
        const result = load(`${BASE}
hosts:
  rancher: { on: hv-north, os: leap-16, cpu: 4, memory: 16Gi, disk: 100Gi, profiles: { ${RANCHER_STACK} } }
inputs: { appco: "{{ secrets.appco }}" }
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
            "inputs.appco: must be credentials: \"{{ secrets.name }}\" or { username, password }",
            'inputs.other: no catalog secret or configmap takes input "other"; known: appco, scc, suse-observability-license',
        ]);
    });

    it("checks a secret's templates", () => {
        const result = load(lab("profiles: { k3s: {} }, secrets: [s]", `inputs: { key: "{{ secrets.k }}", login: "{{ secrets.l }}" }
catalog:
  secrets:
    s:
      inputs: { key: string, login: credentials }
      data: { a: "{{ inputs.key.username }}", b: "{{ inputs.nope }}", c: "{{ lab.nope }}", d: "{{ inputs.login }}", e: "x {{ inputs.login }}", f: "{{ inputs.key", g: "Bearer {{ inputs.key | upper }}" }
`));
        expect(errors(result)).toEqual([
            expect.stringMatching(/^catalog\.secrets\.s\.data\.a: template: /),
            "catalog.secrets.s.data.b: refers to input \"nope\", which secret s doesn't list under inputs",
            expect.stringMatching(/^catalog\.secrets\.s\.data\.c: template: /),
            "catalog.secrets.s.data.d: renders to a map or list; a template must give a single value",
            expect.stringMatching(/^catalog\.secrets\.s\.data\.e: template: .*input "login" is credentials: use inputs\.login\.username or inputs\.login\.password/),
            expect.stringMatching(/^catalog\.secrets\.s\.data\.f: template: /),
        ]);
    });

    it("hands templates with secrets to the program, which renders them with the values", () => {
        const result = load(lab("profiles: { k3s: {} }, secrets: [s]", `inputs: { login: { username: me, password: "{{ secrets.pw }}" }, token: "{{ secrets.tk }}" }
catalog:
  secrets:
    s:
      inputs: { login: credentials, token: string }
      data: { auth: "{{ inputs.login.username }}:{{ inputs.login.password }}", header: "Bearer {{ inputs.token }} for {{ lab.domain }}" }
`));
        expect(errors(result)).toEqual([]);
        const secrets: Record<string, string> = { pw: "s3cret", tk: "t0ken" };
        const render = (leaf: unknown) => renderTemplate((leaf as ObjectTemplate).$template, objectTemplateContext(leaf as ObjectTemplate, t => renderSecretTemplate(t, secrets)));
        const data = result.lab!.objects[0].data;
        expect(render(data.auth)).toBe("me:s3cret");
        expect(render(data.header)).toBe("Bearer t0ken for lab.geeko.me");
        // Only what a template uses goes with it, and no secret value.
        expect(data.header).toEqual({ $template: "Bearer {{ inputs.token }} for {{ lab.domain }}", inputs: { token: "{{ secrets.tk }}" }, lab: { domain: "lab.geeko.me" } });
    });

    it("leaves out a key whose inputs aren't given, and renders the rest", () => {
        const result = load(lab("profiles: { k3s: {} }, secrets: [s]", `inputs: { key: plain }
catalog:
  secrets:
    s:
      inputs: { key: string, other: string }
      data: { a: "Bearer {{ inputs.key | upper }}", b: "{{ inputs.key }}-{{ inputs.other }}", c: literal }
`));
        expect(errors(result)).toEqual([]);
        expect(result.lab!.objects[0].data).toEqual({ a: "Bearer PLAIN", c: "literal" });
        expect(result.lab!.skippedObjects).toContainEqual({ what: "secret s/b", missing: ["other"] });
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

describe("secret templates", () => {
    const vm = (profiles: string) => `${BASE.replace("hv-north: {}", "hv-north: { url: https://hv.example.com, credentials: \"{{ secrets.hv }}\" }")}hosts:\n  vm: { on: hv-north, os: leap-16-k8s, profiles: { ${profiles} } }\n`;

    it("registers each secret with the shape it's used in: whole, or by username and password", () => {
        const result = load(vm(`${RANCHER_STACK.replace("rancher: {", "rancher: { values: { auth: \"Basic {{ secrets.reg.username }}:{{ secrets.reg.password }}\" }, ")}`));
        expect(errors(result)).toEqual([]);
        expect(result.lab!.secrets).toEqual({ cf: "string", "ssh-key": "string", hv: "credentials", ra: "string", reg: "credentials" });
    });

    it("rejects a secret used in two shapes, an unknown field, and credentials that aren't one secret", () => {
        const result = load(`${BASE.replace("hv-north: {}", "hv-north: { url: https://hv.example.com, credentials: \"admin:{{ secrets.hv }}\" }")}hosts:\n  vm: { on: hv-north, os: leap-16-k8s, profiles: { k3s: {}, cert-manager: {}, sprouter: {}, traefik: {}, rancher: { adminPassword: \"{{ secrets.cf.password }}\", values: { x: \"{{ secrets['ssh-key'].token }}\", y: \"{{ secrets.ra['a b'] }}\" } } } }\n`);
        expect(errors(result)).toEqual([
            "harvesters.hv-north.credentials: credentials are one secret ({{ secrets.name }}) or { username, password }",
            "hosts.vm.profiles.rancher.values.y: secrets.ra: \"a b\" can't be a field of a secret",
            // Reported where it's used the second time.
            "tls.cloudflare: secret \"cf\" is used both as credentials and as string",
            "ssh.privateKey: secret \"ssh-key\" is used both as a map with token and as string",
        ]);
    });

    it("collects the fields of map secrets across their uses", () => {
        const result = load(`${BASE}hosts:\n  vm: { on: hv-north, os: leap-16-k8s, profiles: { k3s: {}, cert-manager: {}, sprouter: {}, traefik: {}, rancher: { adminPassword: \"{{ secrets.ra }}\", values: { a: \"{{ secrets.aws.accessKey }}\", b: \"{{ secrets.aws.secretKey | trim }}\", c: \"{{ secrets.reg.username }}\" } } } }\n`);
        expect(errors(result)).toEqual([]);
        expect(result.lab!.secrets).toMatchObject({ aws: { fields: ["accessKey", "secretKey"] }, reg: "credentials" });
    });

    it("follows paths into map secrets, for a field or a map inside one", () => {
        const result = load(`${BASE.replace("\"{{ secrets.cf }}\"", "\"{{ secrets.cf.tunnel.token }}\"").replace("hv-north: {}", "hv-north: { url: https://hv.example.com, credentials: \"{{ secrets.infra['hv-north'] }}\" }")}hosts:\n  vm: { on: hv-north, os: leap-16-k8s, profiles: { k3s: {}, cert-manager: {}, sprouter: {}, traefik: {}, rancher: { adminPassword: \"{{ secrets.ra }}\", values: { a: \"{{ secrets.cf.token }}\", b: \"x-{{ secrets.cf.tunnel.id | trim }}\" } } } }\n`);
        expect(errors(result)).toEqual([]);
        expect(result.lab!.secrets).toMatchObject({ cf: { fields: ["token", "tunnel.id", "tunnel.token"] }, infra: { fields: ["hv-north.password", "hv-north.username"] } });
        const secrets = { cf: { token: "t", tunnel: { token: "tt", id: "i" } }, infra: { "hv-north": { username: "u", password: "p" } } };
        expect(renderSecretTemplate("{{ secrets.cf.tunnel.token }}", secrets)).toBe("tt");
        expect(renderSecretTemplate("{{ secrets.infra['hv-north'] }}", secrets)).toEqual({ username: "u", password: "p" });
        expect(renderSecretTemplate("x-{{ secrets.cf.tunnel.id }}", secrets)).toBe("x-i");
    });

    it("warns about plain values in secret fields, and errors on credentials written as one plain string", () => {
        const result = load(BASE.replace("\"{{ secrets.cf }}\"", "my-token").replace("hv-north: {}", "hv-north: { url: https://hv.example.com, credentials: admin }"));
        expect(errors(result)).toEqual(["harvesters.hv-north.credentials: credentials are one secret (\"{{ secrets.name }}\") or { username, password }"]);
        expect(result.diagnostics.warnings.map(d => `${resolverPath(d.path)}: ${d.message}`)).toContain("tls.cloudflare: secret value is written in the lab file; use a secret (\"{{ secrets.name }}\") before sharing it");
    });
});

describe("warnings", () => {
    it("warns about passwords written into the lab file", () => {
        const result = load(BASE.replace("hv-north: {}", "hv-north: { url: https://hv.example.com, credentials: { username: admin, password: hunter2 } }"));
        expect(result.diagnostics.warnings.map(d => d.path)).toContain("Harvester/hv-north.spec.credentials.password");
    });
});
