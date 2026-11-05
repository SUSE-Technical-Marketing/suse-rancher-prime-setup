import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
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
    return loadLab({ labFile: path.join(tmp, "lab.yaml"), labText: labDocument(labYaml), personalConfig: personal });
}

/** Load a lab file written as documents, as is. */
function loadDocs(text: string, personal = personalConfig): LoadResult {
    return loadLab({ labFile: path.join(tmp, "lab.yaml"), labText: text, personalConfig: personal });
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

/** Warnings, the same way. */
function warnings(result: LoadResult): string[] {
    return result.diagnostics.warnings.map(d => `${resolverPath(d.path)}: ${d.message}`);
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
        // k3s's own Traefik, with its Gateway provider turned on: an IngressClass and a GatewayClass.
        expect(vm.providers).toMatchObject({ "gateway-api": ["k3s"] });
        expect(vm.outputs).toMatchObject({ ingress: { ingressClassName: "traefik" }, "gateway-api": { gatewayClassName: "traefik" } });

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

    it("knows which hosts run Kubernetes: their OS profile's kubernetes part applies", () => {
        const result = load(`${BASE}
hosts:
  rancher: { on: hv-north, os: leap-16, cpu: 4, memory: 16Gi, disk: 100Gi, profiles: { ${RANCHER_STACK} } }
  node: { on: hv-north, os: leap-16, cpu: 2, memory: 4Gi, disk: 40Gi }
  plain: { on: hv-north, os: leap-16, cpu: 2, memory: 4Gi, disk: 40Gi }
downstream:
  edge:
    type: metal
    rancher: rancher
    nodes: [{ host: node, roles: [etcd, controlplane, worker] }]
`);
        expect(errors(result)).toEqual([]);
        expect(Object.fromEntries(result.lab!.hosts.map(h => [h.name, h.kubernetes]))).toEqual({ rancher: true, node: true, plain: false });
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

    it("reports a secret in a field that isn't filled in with secrets, through a var or mixed with the lab", () => {
        const lab = (annotations: string, password = "{{ lab.vars.pw }}") => load(`${BASE.replace("harvesters:", "vars: { pw: \"{{ secrets.ra }}\" }\nharvesters:")}
hosts:
  vm: { on: hv-north, os: leap-16, cpu: 2, memory: 4Gi, disk: 20Gi, profiles: { k3s: {}, cert-manager: {}, sprouter: {}, traefik: {}, rancher: { adminPassword: "${password}" } } }
downstream:
  apps: { type: harvester, rancher: vm, harvester: hv-north, annotations: ${annotations}, pools: [{ name: a, quantity: 1, roles: [etcd, controlplane, worker], cpu: 2, memory: 4Gi, disk: 40Gi, os: leap-16 }] }
`);
        // A var holding a secret, in a secret field: filled in when the lab is built.
        expect(errors(lab("{ team: tmm, domain: \"{{ lab.domain }}\" }"))).toEqual([]);
        expect(errors(lab("{ a: \"{{ secrets.ra }}\", b: \"{{ lab.vars.pw }}\", c: \"{{ secrets.ra }}@{{ lab.domain }}\" }"))).toEqual([
            "downstream.apps.annotations.a: uses a secret, but this field isn't filled in with secrets: the template would be used as text. Secrets go in secret fields (passwords, credentials, tokens) and in chart values",
            "downstream.apps.annotations.b: uses a secret, but this field isn't filled in with secrets: the template would be used as text. Secrets go in secret fields (passwords, credentials, tokens) and in chart values",
            "downstream.apps.annotations.c: uses a secret, but this field isn't filled in with secrets: the template would be used as text. Secrets go in secret fields (passwords, credentials, tokens) and in chart values",
        ]);
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
        const result = load(`${BASE.replace("acme: letsencrypt-staging", "acme: none")}hosts:\n  r: { on: hv-north, os: leap-16, profiles: { ${RANCHER_STACK} } }\n`);
        expect(errors(result)).toContain("hosts.r.profiles.cert-manager: needs the lab's ACME server; set tls.acme (and tls.email, tls.cloudflare), not none");
    });

    it("needs it for cert-manager on a downstream cluster too", () => {
        const result = load(`${BASE.replace("acme: letsencrypt-staging", "acme: none")}hosts:
  r: { on: hv-north, os: leap-16, profiles: { ${RANCHER_STACK} } }
downstream:
  apps: { type: harvester, rancher: r, harvester: hv-north, pools: [{ name: a, quantity: 1, roles: [etcd, controlplane, worker], os: leap-16 }], profiles: { cert-manager: {} } }
`);
        expect(errors(result)).toContain("downstream.apps.profiles.cert-manager: needs the lab's ACME server; set tls.acme (and tls.email, tls.cloudflare), not none");
    });
});

describe("k3k clusters", () => {
    const POOL = "pools: [{ name: a, quantity: 1, roles: [etcd, controlplane, worker], os: leap-16 }]";
    const lab = (extra: string) => `${BASE}hosts:
  r1: { on: hv-north, os: leap-16, profiles: { ${RANCHER_STACK} } }
  r2: { on: hv-north, os: leap-16, profiles: { ${RANCHER_STACK} } }
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
    const POOL = "{ name: all, quantity: 1, roles: [etcd, controlplane, worker], os: ubuntu-24.04 }";
    const lab = (site: string, cluster: string, publicRancher = true) => `${BASE}awsSites:
  eu: ${site}
hosts:
  vm: { on: hv-north, os: leap-16, profiles: { ${RANCHER_STACK}${publicRancher ? ", public-ingress: {}" : ""} } }
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
            `{ type: ec2, rancher: vm, site: eu, pools: [ ${POOL}, { name: workers, quantity: 2, roles: [worker], os: rocky-9, instanceType: m6i.xlarge, disk: 100Gi, zone: c } ] }`,
        ));
        expect(errors(result)).toEqual([]);
        expect(result.lab!.awsSites).toEqual([{
            name: "eu", region: "eu-west-1", credentials: "{{ secrets.aws }}", vpcCidr: "10.100.0.0/16", ttl: 8 * 3600,
            zones: [{ letter: "a", az: "eu-west-1a", cidr: "10.100.0.0/20" }, { letter: "c", az: "eu-west-1c", cidr: "10.100.16.0/20" }],
        }]);
        const cloud = result.lab!.downstream.find(d => d.name === "cloud")!;
        expect(cloud).toMatchObject({ type: "ec2", site: "eu", distro: "rke2" });
        expect(cloud.type === "ec2" && cloud.pools).toEqual([
            { name: "all", quantity: 1, roles: ["etcd", "controlplane", "worker"], os: "ubuntu-24.04", instanceType: "t3.large", disk: "40Gi", zone: "a" },
            { name: "workers", quantity: 2, roles: ["worker"], os: "rocky-9", instanceType: "m6i.xlarge", disk: "100Gi", zone: "c" },
        ]);
        expect(result.lab!.secrets).toMatchObject({ aws: { fields: ["accessKey", "secretKey"] } });
        expect(result.lab!.os["rocky-9"].ami).toMatchObject({ owner: "792107900819", user: "rocky" });
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
            "downstream.cloud.rancher: EC2 machines reach Rancher over the internet, so the Rancher on vm needs public-ingress on its host",
        ]);
        expect(errors(loadPublic(lab(
            "{ region: eu-west-1, credentials: \"{{ secrets.aws }}\" }",
            "{ type: ec2, rancher: vm, site: eu, pools: [ { name: a, quantity: 1, roles: [etcd, controlplane], os: leap-16, zone: c } ] }",
        )))).toEqual([
            "downstream.cloud.pools[0].os: OS profile leap-16 has no AMI (ami: owner and name) to boot EC2 machines from",
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
            "downstream.cloud.rancher: An EKS cluster's agent reaches Rancher over the internet, so the Rancher on vm needs public-ingress on its host",
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
            // On the network too, where the pool goes: any feature a profile's networkFeatures names.
            "harvesters.hv-north.networks.vlans[0].loadBalancer: required: vm's harvester-cloud-provider profile needs it on this network",
        ]);
        const untagged = BASE.replace("hv-north: {}", "hv-north: { networks: { untagged: { dhcp: { cidr: 10.29.20.0/24, gateway: 10.29.20.1, range: [10.29.20.100, 10.29.20.150] } } } }");
        expect(errors(load(untagged + vm("{ k3s: {}, harvester-cloud-provider: {} }")))).toContain(
            "harvesters.hv-north.networks.untagged.loadBalancer: required: vm's harvester-cloud-provider profile needs it on this network");
    });

    it("takes a pool's cidr and gateway from a network without lab DHCP, its own", () => {
        const fixed = (pool: string) => BASE.replace("hv-north: {}", `hv-north: { networks: { default: vlan20, vlans: [{ id: 20, cidr: 10.29.20.0/24, gateway: 10.29.20.1, loadBalancer: { range: [${pool}] } }] } }`);
        const { lab, diagnostics } = load(fixed("10.29.20.200, 10.29.20.220") + vm("{ k3s: {}, harvester-cloud-provider: {} }"));
        expect(diagnostics.errors).toEqual([]);
        expect(lab!.harvesters[0].networks[1].loadBalancer).toEqual({ cidr: "10.29.20.0/24", gateway: "10.29.20.1", range: ["10.29.20.200", "10.29.20.220"] });
        expect(errors(load(fixed("10.29.30.200, 10.29.30.220")))).toContain("harvesters.hv-north.networks.vlans[0].loadBalancer.range[0]: 10.29.30.200 is outside 10.29.20.0/24");
        // Neither lab DHCP nor a subnet of its own: the pool has to say.
        const bare = BASE.replace("hv-north: {}", "hv-north: { networks: { vlans: [{ id: 20, loadBalancer: { range: [10.29.20.200, 10.29.20.220] } }] } }");
        expect(errors(load(bare))).toEqual(["harvesters.hv-north.networks.vlans[0].loadBalancer: needs cidr and gateway: the network has neither lab DHCP nor a cidr and gateway of its own"]);
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
      extends: leap-16
      cloudInit: { packages: [make], runcmd: [make install], timezone: UTC }
      kubernetes: { cloudInit: { packages: [helm] } }
hosts:
  vm: { on: hv-north, os: leap-16-dev, cpu: 2, memory: 4Gi, disk: 20Gi }
  plain: { on: hv-north, os: leap-16, cpu: 2, memory: 4Gi, disk: 20Gi }
`);
        expect(diagnostics.errors).toEqual([]);
        const dev = lab!.os["leap-16-dev"];
        expect(dev.family).toBe("suse");
        expect(dev.cloudInit.packages).toEqual(["curl", "git-core", "bash-completion", "vim", "wget", "tree", "firewalld", "k9s", "sofka", "make"]);
        expect((dev.cloudInit.runcmd as string[]).at(0)).toBe("systemctl enable --now firewalld");
        // The Harvester and Kubernetes parts are inherited, and extended the same way.
        expect(dev.harvester.packages).toEqual(["qemu-guest-agent"]);
        expect(dev.kubernetes.packages).toEqual(["k3s-selinux", "open-iscsi", "nfs-client", "cryptsetup", "iptables-backend-nft", "helm"]);
        expect((dev.cloudInit.runcmd as string[]).at(-1)).toBe("make install");
        expect(dev.cloudInit).toMatchObject({ package_update: true, timezone: "UTC" });
        // Both boot leap-16's image: one download.
        expect(lab!.harvesters[0].images).toEqual([{ os: "leap-16", source: { kind: "url", url: expect.stringContaining("Leap-16.0") } }]);
    });

    it("checks the cloudInit templates and registers the secrets they use", () => {
        const result = load(`${BASE}\ncatalog:\n  os:\n    mine: { extends: leap-16, cloudInit: { runcmd: [\"echo {{ secrets.tok }} {{ lab.domain }}\", \"echo {{ secrets.tok.user }}\", \"echo {{ nope }}\"] } }\nhosts:\n  vm: { on: hv-north, os: mine, cpu: 2, memory: 4Gi, disk: 20Gi }\n`);
        // After leap-16's own runcmd.
        expect(errors(result).filter(e => e.startsWith("cloudInit"))).toEqual([
            "cloudInit.runcmd[2]: secret \"tok\" is used both as string and as a map with user",
            "cloudInit.runcmd[3]: template: attempted to output null or undefined value",
        ]);
        const ok = load(`${BASE}\ncatalog:\n  os:\n    mine: { extends: leap-16, cloudInit: { runcmd: [\"echo {{ secrets['reg-code'] }} {{ secrets.scc.password }}\"] } }\nhosts:\n  vm: { on: hv-north, os: mine, cpu: 2, memory: 4Gi, disk: 20Gi }\n`);
        expect(errors(ok)).toEqual([]);
        // Only its password is read: a map with that field, not full credentials.
        expect(ok.lab!.secrets).toMatchObject({ "reg-code": "string", scc: { fields: ["password"] } });
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
            storageClass: { name: "longhorn-single", replicas: 1, parameters: { staleReplicaTimeout: "30", migratable: "true" }, imageClass: "longhorn-single" },
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
            storageClass: { name: "longhorn-single", replicas: 3, parameters: { staleReplicaTimeout: "30", migratable: "true", dataLocality: "best-effort" }, imageClass: "longhorn-single" },
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
            // The traefik profile's GatewayClass: Rancher on the Gateway API, with the host's certificate.
            networkExposure: { type: "gateway" },
            gateway: { gatewayClass: { name: "traefik", tls: { source: "secret", secretName: "wildcard-cert" } } },
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

    it("puts Rancher on the Gateway API with the distribution's own Traefik too", () => {
        const result = load(`${BASE}
hosts:
  vm: { on: hv-north, os: leap-16, cpu: 4, memory: 16Gi, disk: 100Gi, profiles: { rke2: {}, cert-manager: {}, sprouter: {}, rancher: { adminPassword: "{{ secrets.ra }}" } } }
`);
        expect(errors(result)).toEqual([]);
        expect(result.lab!.hosts[0].chartValues.rancher.entries[0].lockedValues).toMatchObject({
            networkExposure: { type: "gateway" },
            gateway: { gatewayClass: { name: "traefik", tls: { source: "secret", secretName: "wildcard-cert" } } },
        });
    });

    it("exposes Rancher as its exposure setting says; gateway needs the Gateway API on the host", () => {
        const exposed = (exposure: string, extra = "") => load(rancherHost(`, exposure: ${exposure}`).replace("traefik: {}, ", extra));
        const type = (r: LoadResult) => r.lab!.hosts[0].chartValues.rancher.entries[0].lockedValues.networkExposure;
        expect(type(load(rancherHost("")))).toEqual({ type: "gateway" });
        expect(type(exposed("ingress", "traefik: {}, "))).toEqual({ type: "ingress" });
        expect(type(exposed("gateway", "traefik: {}, "))).toEqual({ type: "gateway" });
        // Without the traefik profile, k3s's own Traefik has the Gateway API too.
        expect(type(exposed("gateway"))).toEqual({ type: "gateway" });
        expect(errors(exposed("sideways", "traefik: {}, "))).toEqual([expect.stringMatching(/^hosts\.vm\.profiles\.rancher\.exposure: /)]);
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

    it("hands the chart secret templates for each login's fields", () => {
        const result = load(lab(`applicationCollection: "{{ secrets.appco }}", suseRegistry: "{{ secrets.scc }}", nvidia: "{{ secrets.nvidia }}"`));
        expect(errors(result)).toEqual([]);
        expect(credentials(result)).toEqual({
            applicationCollection: { username: "{{ secrets.appco.username }}", password: "{{ secrets.appco.password }}" },
            suseRegistry: { username: "{{ secrets.scc.username }}", password: "{{ secrets.scc.password }}" },
            nvidia: { username: "{{ secrets.nvidia.username }}", password: "{{ secrets.nvidia.password }}" },
        });
        expect(result.lab!.secrets).toMatchObject({ appco: "credentials", scc: "credentials", nvidia: "credentials" });
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

describe("fleet profiles", () => {
    const lab = (cluster: string, catalog = "") => `${BASE}
hosts:
  rancher: { on: hv-north, os: leap-16, cpu: 4, memory: 16Gi, disk: 100Gi, profiles: { ${RANCHER_STACK} } }
downstream:
  apps:
    type: harvester
    rancher: rancher
    harvester: hv-north
    pools: [{ name: a, quantity: 1, roles: [etcd, controlplane, worker], cpu: 2, memory: 4Gi, disk: 40Gi, os: leap-16 }]
${cluster}
${catalog}`;
    const cluster = (r: LoadResult) => r.lab!.downstream[0] as unknown as { labels: Record<string, string>; annotations: Record<string, string> };

    it("puts their labels and annotations on the cluster, with its own", () => {
        const result = load(lab("    labels: { team: a }\n    annotations: { hosted-domain: lab.geeko.me }\n    fleetProfiles: { storage: {}, security: {} }"));
        expect(errors(result)).toEqual([]);
        expect(cluster(result).labels).toEqual({ team: "a", "needs-storage": "true", "needs-security": "true" });
        // The same value from the cluster and a profile is fine; rancher-host is the cluster's Rancher host.
        expect(cluster(result).annotations).toEqual({ "hosted-domain": "lab.geeko.me", "rancher-host": "rancher" });
    });

    it("checks names, requirements and conflicts among a cluster's Fleet profiles", () => {
        expect(errors(load(lab("    fleetProfiles: { nope: {}, security: {}, storage: {}, longhorn: {} }")))).toEqual([
            expect.stringMatching(/^downstream\.apps\.fleetProfiles\.nope: unknown Fleet profile "nope"; known: .*security/),
            "downstream.apps.fleetProfiles.storage: conflicts with longhorn (both block-storage)",
            "downstream.apps.fleetProfiles.longhorn: conflicts with storage (both block-storage)",
        ]);
        expect(errors(load(lab("    fleetProfiles: { security: {} }")))).toEqual([
            "downstream.apps.fleetProfiles.security: needs block-storage, which none of this cluster's Fleet profiles provides",
        ]);
    });

    it("doesn't let a Fleet profile change a value the cluster or another profile set", () => {
        expect(errors(load(lab("    annotations: { hosted-domain: other.example.com }\n    fleetProfiles: { traefik: {} }")))).toEqual([
            'downstream.apps.fleetProfiles.traefik: sets annotation hosted-domain to "lab.geeko.me", but the cluster\'s annotations has "other.example.com"',
        ]);
    });

    describe("value overlays", () => {
        // A probe chart profile: overlays by the target's kind and capabilities, on a host and on a GPU cluster.
        const PROBE = `catalog:
  chartProfiles:
    probe:
      charts:
        - chart: sprouter
          namespace: probe
          values: { base: 1, where: anywhere }
          valueOverlays:
            - when: "{{ 'gpu' in target.capabilities }}"
              values: { gpu: { enabled: true } }
            - when: "{{ target.kind == 'cluster' and 'gpu' in target.capabilities }}"
              lockedValues: { where: gpu-cluster }
            - when: "{{ target.kind == 'host' }}"
              values: { where: host, caps: "{{ target.capabilities | join(',') }}" }
      objects:
        - name: config
          object: { apiVersion: v1, kind: ConfigMap, metadata: { name: probe, namespace: probe }, data: { base: "1", where: anywhere } }
          objectOverlays:
            - when: "{{ 'gpu' in target.capabilities }}"
              object: { data: { gpu: "yes", where: gpu } }
      settings: { type: object, properties: { values: { type: chartValues } } }
`;
        const probeLab = (cluster: string, extra = "") => load(lab(`${cluster}\n    profiles: { probe: { ${extra} } }`, PROBE).replace(
            `profiles: { ${RANCHER_STACK} }`, `profiles: { ${RANCHER_STACK}, probe: {} }`));

        it("apply in order where their when is true: by the target's kind and capabilities (its Fleet profiles' too)", () => {
            const result = probeLab("    fleetProfiles: { gpu-operator: {} }");
            expect(errors(result)).toEqual([]);
            const onCluster = result.lab!.downstream[0].chartProfiles!.chartValues.probe.entries[0];
            expect(onCluster.values).toEqual({ base: 1, where: "anywhere", gpu: { enabled: true } });
            expect(onCluster.lockedValues).toEqual({ where: "gpu-cluster" });
            const onHost = result.lab!.hosts[0].chartValues.probe.entries[0];
            expect(onHost.values).toMatchObject({ base: 1, where: "host" });
            expect(onHost.values.gpu).toBeUndefined();
            expect(String(onHost.values.caps).split(",")).toEqual(expect.arrayContaining(["kubernetes", "rancher", "tls"]));
            // Objects too: maps merged key by key.
            const config = (r: typeof result) => r.lab!.downstream[0].chartProfiles!.chartValues.probe.objects[0].object;
            expect(config(result)).toMatchObject({ metadata: { name: "probe" }, data: { base: "1", where: "gpu", gpu: "yes" } });
            // Without the GPU Fleet profile, no GPU overlays.
            const plainLab = probeLab("    fleetProfiles: { storage: {} }");
            const plain = plainLab.lab!.downstream[0].chartProfiles!.chartValues.probe.entries[0];
            expect(plain).toMatchObject({ values: { base: 1, where: "anywhere" }, lockedValues: {} });
            expect(config(plainLab).data).toEqual({ base: "1", where: "anywhere" });
        });

        it("protect their locked paths, and need a when that's true or false", () => {
            expect(errors(probeLab("    fleetProfiles: { gpu-operator: {} }", "values: { where: mine }"))).toEqual([
                "downstream.apps.profiles.probe.values.where: is set by the lab engine (where); it can't be overridden",
            ]);
            const broken = load(lab("    profiles: { probe: {} }", PROBE.replace(`"{{ target.kind == 'host' }}"`, `"{{ target.kind }}"`)));
            expect(errors(broken)).toContain("ChartProfile/probe.spec.charts[0].valueOverlays[2].when: must render to true or false, not \"cluster\" (on cluster apps)");
        });
    });

    it("installs ChartProfiles on the cluster, rendered for it", () => {
        const result = load(lab("    profiles: { cert-manager: {}, sprouter: {} }"));
        expect(errors(result)).toEqual([]);
        const cp = result.lab!.downstream[0].chartProfiles!;
        expect(cp.order).toEqual(["cert-manager", "sprouter"]);
        // target is the cluster: its wildcard is *.<cluster>.<domain>, as the Fleet apps name things.
        const cert = cp.chartValues["cert-manager"].objects.find(o => o.name === "wildcard")!;
        expect((cert.object.spec as { dnsNames: string[] }).dnsNames).toEqual(["*.apps.lab.geeko.me", "apps.lab.geeko.me"]);
    });

    it("takes only ChartProfiles, with their rules, on a cluster", () => {
        expect(errors(load(lab("    profiles: { k3s: {}, storage: {}, nope: {}, ai-factory: { applicationCollection: \"{{ secrets.a }}\", suseRegistry: \"{{ secrets.s }}\" } }")))).toEqual([
            expect.stringMatching(/^downstream\.apps\.profiles\.k3s: is a Profile for lab hosts .*a downstream cluster takes: ai-demos, ai-factory, cert-manager, hauler-chart, landlock, metallb, open-webui, opentelemetry, outrider, sprouter, suse-observability-agent, traefik, vllm$/),
            "downstream.apps.profiles.storage: is a Fleet profile: list it under fleetProfiles",
            expect.stringMatching(/^downstream\.apps\.profiles\.nope: unknown profile "nope"/),
            expect.stringMatching(/^downstream\.apps\.profiles\.ai-factory: needs rancher .*on the same cluster$/),
        ]);
    });

    it("reports a template that refers to something that isn't there", () => {
        const result = load(lab("    fleetProfiles: { mine: {} }", "catalog:\n  fleet:\n    profiles:\n      mine: { labels: { x: \"{{ cluster.nope }}\" } }\n"));
        expect(result.diagnostics.errors.map(d => d.path)).toContain("FleetProfile/mine.spec.labels.x");
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
    it("takes a distribution from the catalog, rke2 by default", () => {
        expect(load(lab("")).lab!.downstream[0]).toMatchObject({ distro: "rke2" });
        expect(errors(load(lab("    distro: k3s\n")))).toEqual([]);
        expect(errors(load(lab("    distro: k0s\n")))).toEqual(['downstream.apps.distro: no KubernetesDistribution "k0s"; known: k3s, rke2']);
    });
});

describe("Harvester DNS (the harvester-dns-controller profile)", () => {
    const lab = (dns: string) => load(BASE.replace("  hv-north: {}", `  hv-north:\n    profiles: { harvester-dns-controller: ${dns} }`));

    it("renders its add-on's values and Secret, and keeps a running lab's add-on", () => {
        const h = lab(`{ backend: routeros, host: 10.0.0.1, credentials: "{{ secrets.router }}", ttl: 1h }`).lab!.harvesters[0];
        const rendered = h.chartValues["harvester-dns-controller"];
        expect(rendered.entries[0].lockedValues).toEqual({
            dns: { backend: "routeros", host: "10.0.0.1", username: "{{ secrets.router.username }}", existingSecret: "lab-dns-controller", useTls: false, domain: "lab.geeko.me", ttl: "1h", commentTag: "managed-by=harvester-dns-controller/hv-north" },
            watchNamespaces: expect.any(String),
        });
        expect(rendered.objects).toEqual([expect.objectContaining({ name: "secret", aliases: ["hv-north/dns-controller-secret"], object: expect.objectContaining({ stringData: { password: "{{ secrets.router.password }}" } }) })]);
        expect(rendered.aliases).toEqual([{ name: "hv-north/dns-controller" }, { type: "kubernetes:helm.sh/v3:Release", name: "hv-north/dns-controller" }]);
    });

    it("takes either backend, a TTL, TLS settings and other chart values", () => {
        const { lab: resolved, diagnostics } = lab(`{ backend: glinet, host: router.lab.geeko.me, credentials: "{{ secrets.router }}", ttl: 1h, useTls: true, tlsVerify: false, values: { logLevel: debug, dns: { useGuestClusterLabel: false } } }`);
        expect(diagnostics.errors).toEqual([]);
        expect(resolved!.harvesters[0].profiles["harvester-dns-controller"]).toMatchObject({ backend: "glinet", host: "router.lab.geeko.me", ttl: "1h", useTls: true, values: { logLevel: "debug" } });
    });

    it("needs the router's login, and won't let values override what the engine sets", () => {
        expect(errors(lab("{ backend: routeros, host: 10.0.0.1 }"))).toEqual([
            expect.stringMatching(/^harvesters\.hv-north\.profiles\.harvester-dns-controller\.credentials: /),
        ]);
        expect(errors(lab(`{ backend: routeros, host: 10.0.0.1, credentials: "{{ secrets.router }}", ttl: 15 minutes, values: { watchNamespaces: x, dns: { host: y, domain: z, commentTag: ok } } }`))).toEqual([
            expect.stringMatching(/^harvesters\.hv-north\.profiles\.harvester-dns-controller\.ttl: /),
        ]);
        expect(errors(lab(`{ backend: routeros, host: 10.0.0.1, credentials: "{{ secrets.router }}", values: { watchNamespaces: x, dns: { host: y, domain: z, commentTag: mine, useGuestClusterLabel: false } } }`))).toEqual([
            "harvesters.hv-north.profiles.harvester-dns-controller.values.watchNamespaces: is set by the lab engine (watchNamespaces); it can't be overridden",
            "harvesters.hv-north.profiles.harvester-dns-controller.values.dns.host: is set by the lab engine (dns.host); it can't be overridden",
            "harvesters.hv-north.profiles.harvester-dns-controller.values.dns.domain: is set by the lab engine (dns.domain); it can't be overridden",
            "harvesters.hv-north.profiles.harvester-dns-controller.values.dns.commentTag: is set by the lab engine (dns.commentTag); it can't be overridden",
        ]);
    });
});

describe("SUSE Observability agents", () => {
    const POOL = "harvester: hv-north, pools: [{ name: a, quantity: 1, roles: [etcd, controlplane, worker], cpu: 2, memory: 4Gi, disk: 40Gi, os: leap-16 }]";
    const lab = (opts: { host?: string; harvester?: string; obs?: string; apps?: string }) => load(`${BASE.replace("  hv-north: {}", `  hv-north: { profiles: { ${opts.harvester ?? ""} } }`)}
hosts:
  vm: { on: hv-north, os: leap-16, cpu: 2, memory: 4Gi, disk: 20Gi, profiles: { ${RANCHER_STACK}${opts.host ?? ""} } }
downstream:
  obs: { type: harvester, rancher: vm, ${POOL}, fleetProfiles: { ${opts.obs ?? "storage: {}, observability: {}"} } }
  apps: { type: harvester, rancher: vm, ${POOL}${opts.apps ? `, profiles: { ${opts.apps} }` : ""} }
`);

    it("go on a host, a downstream cluster and a Harvester, reporting to a cluster with SUSE Observability", () => {
        const agent = "suse-observability-agent: { observer: obs }";
        const { lab: resolved, diagnostics } = lab({ host: `, ${agent}`, harvester: agent, apps: agent });
        expect(diagnostics.errors).toEqual([]);
        expect(resolved!.downstream.find(d => d.name === "obs")!.fleetOutputs).toEqual({
            "suse-observability": { url: "https://observability.obs.lab.geeko.me", otlp: "otlp-observability.obs.lab.geeko.me:443" },
        });
        expect(resolved!.hosts[0].profiles["suse-observability-agent"]).toEqual({ observer: "obs", adminToken: "{{ secrets.observability.token }}" });
        expect(resolved!.harvesters[0].profiles["suse-observability-agent"]).toMatchObject({ observer: "obs" });
        expect(resolved!.downstream.find(d => d.name === "apps")!.chartProfiles!.profiles["suse-observability-agent"]).toMatchObject({ observer: "obs" });
        expect(resolved!.secrets.observability).toEqual({ fields: ["token"] });
    });

    describe("OpenTelemetry (the opentelemetry ChartProfile)", () => {
        const otel = (settings: string, inputs = 'inputs: { appco: "{{ secrets.appco }}" }\n') =>
            load(`${inputs}${BASE.replace("  hv-north: {}", "  hv-north: {}")}
hosts:
  vm: { on: hv-north, os: leap-16, cpu: 2, memory: 4Gi, disk: 20Gi, profiles: { ${RANCHER_STACK} } }
downstream:
  obs: { type: harvester, rancher: vm, ${POOL}, fleetProfiles: { storage: {}, observability: {} } }
  apps: { type: harvester, rancher: vm, ${POOL}, profiles: { opentelemetry: { ${settings} } } }
`);

        it("sends to its observer's OTLP endpoint as the cluster, after what Fleet puts there, logged in to Application Collection", () => {
            const result = otel("observer: obs");
            expect(errors(result)).toEqual([]);
            const rendered = result.lab!.downstream.find(d => d.name === "apps")!.chartProfiles!.chartValues.opentelemetry;
            const chart = rendered.entries[0];
            expect(chart.credentials).toBe("{{ secrets.appco }}");
            expect(chart.waitFor).toEqual([
                { path: "/apis/apps/v1/namespaces/cert-manager/deployments/cert-manager-webhook", condition: "Available" },
                { path: "/api/v1/namespaces/cattle-system/secrets/application-collection" },
                { path: "/api/v1/namespaces/cattle-system/secrets/suse-registry" },
            ]);
            expect(chart.values).toMatchObject({ global: { imagePullSecrets: ["application-collection"] } });
            const collector = rendered.objects.find(o => o.name === "collector")!.object as any;
            expect(collector.spec.config.exporters.otlp).toEqual({
                endpoint: "otlp-observability.obs.lab.geeko.me:443",
                headers: { Authorization: "SUSEObservability ${env:API_KEY}" },
                // Let's Encrypt staging in the test lab: a CA nothing trusts.
                tls: { insecure_skip_verify: true },
            });
            expect(collector.spec.env).toContainEqual({ name: "K8S_CLUSTER_NAME", value: "apps" });
            expect(rendered.objects.find(o => o.name === "api-key")!.object).toMatchObject({ stringData: { API_KEY: "{{ secrets.observability.token }}" } });
            expect(result.lab!.secrets).toMatchObject({ appco: "credentials", observability: { fields: ["token"] } });
        });

        // Its observer, with StackPacks of its own: installed with the instance's bootstrap token (an input).
        const observed = (stackPacks: string, inputs = 'inputs: { appco: "{{ secrets.appco }}", suse-observability-token: "{{ secrets.observability.token }}" }\n') => load(`${inputs}${BASE}
hosts:
  vm: { on: hv-north, os: leap-16, cpu: 2, memory: 4Gi, disk: 20Gi, profiles: { ${RANCHER_STACK} } }
downstream:
  obs: { type: harvester, rancher: vm, ${POOL}, fleetProfiles: { storage: {}, observability: {} }${stackPacks} }
  apps: { type: harvester, rancher: vm, ${POOL}, profiles: { opentelemetry: { observer: obs } } }
`);

        it("go on the cluster running SUSE Observability, explicitly, with its bootstrap token", () => {
            const result = observed(", stackPacks: [ open-telemetry, suse-ai ]");
            expect(errors(result)).toEqual([]);
            expect(warnings(result)).toEqual([]);
            expect(result.lab!.stackPacks.map(p => ({ ...p, stackPack: p.stackPack.archive ?? "catalog" }))).toEqual([
                { observer: "obs", url: "https://observability.obs.lab.geeko.me", name: "open-telemetry", stackPack: "catalog", adminToken: "{{ secrets.observability.token }}" },
                // Built from source: its .sts, which `lab stackpacks` builds before `up`.
                { observer: "obs", url: "https://observability.obs.lab.geeko.me", name: "suse-ai", stackPack: expect.stringMatching(/^https:\/\/github\.com\/SUSE\/suse-ai-observability-extension\/archive\/refs\/tags\/v\{version\}\.zip$/), file: expect.stringMatching(/\/lab\/\.cache\/stackpacks\/suse-ai-3\.0\.0\.sts$/), adminToken: "{{ secrets.observability.token }}" },
            ]);
            expect(result.lab!.stackPacks[1].stackPack).toMatchObject({ kind: "StackPack", version: "3.0.0", path: "stackpack/suse-ai", sha256: expect.stringMatching(/^[0-9a-f]{64}$/), unlocked: "overwrite" });
            expect(result.lab!.stackPacks[0].stackPack).toEqual({ kind: "StackPack", unlocked: "fail", icon: "activity", description: expect.any(String) });
        });

        it("warn when the instance a profile sends to lacks the StackPacks it expects", () => {
            const result = observed(", stackPacks: [ open-telemetry ]");
            expect(errors(result)).toEqual([]);
            expect(warnings(result)).toEqual([
                "downstream.apps.profiles.opentelemetry: obs's SUSE Observability has no StackPack suse-ai, so it won't show all this sends: add it to obs's stackPacks",
            ]);
            expect(warnings(observed(""))).toEqual([
                "downstream.apps.profiles.opentelemetry: obs's SUSE Observability has no StackPack open-telemetry, suse-ai, so it won't show all this sends: add them to obs's stackPacks",
            ]);
            // None of them installed for it: only what obs lists.
            expect(observed("").lab!.stackPacks).toEqual([]);
        });

        it("need SUSE Observability on the cluster, StackPacks of the catalog, and the bootstrap token", () => {
            expect(errors(observed(", stackPacks: [ open-telemetry, nope, open-telemetry ]"))).toEqual([
                'downstream.obs.stackPacks[1]: no StackPack "nope"; the catalog has: open-telemetry, suse-ai',
                "downstream.obs.stackPacks[2]: open-telemetry is listed twice",
            ]);
            expect(errors(observed(", stackPacks: [ open-telemetry ]", 'inputs: { appco: "{{ secrets.appco }}" }\n'))).toEqual([
                "inputs.suse-observability-token: required: the StackPacks on obs are installed with its SUSE Observability's bootstrap token (a secret, as its values file has it)",
            ]);
            expect(errors(load(`inputs: { appco: "{{ secrets.appco }}", suse-observability-token: "{{ secrets.observability.token }}" }\n${BASE}
hosts:
  vm: { on: hv-north, os: leap-16, cpu: 2, memory: 4Gi, disk: 20Gi, profiles: { ${RANCHER_STACK} } }
downstream:
  apps: { type: harvester, rancher: vm, ${POOL}, stackPacks: [ open-telemetry ] }
`))).toEqual([
                "downstream.apps.stackPacks: cluster apps doesn't run suse-observability: give it the Fleet profile observability",
            ]);
        });

        it("names StackPacks of the catalog, on a clusterRefs field providing suse-observability", () => {
            const bad = `catalog:
  chartProfiles:
    probe:
      charts: [ { chart: sprouter, namespace: probe } ]
      clusterRefs: [ { field: observer, provides: suse-observability } ]
      observerStackPacks: { on: target, expects: [ suse-ai, nope, opentelemetry-operator ] }
      settings: { type: object, properties: { observer: { type: dnsLabel } } }
`;
            expect(errors(load(`${bad}${BASE}`))).toEqual([
                "ChartProfile/probe.spec.observerStackPacks.on: isn't one of its clusterRefs fields providing suse-observability",
                'ChartProfile/probe.spec.observerStackPacks.expects[1]: no StackPack "nope"',
                'ChartProfile/probe.spec.observerStackPacks.expects[2]: no StackPack "opentelemetry-operator"',
            ]);
        });

        it("needs the lab's Application Collection login, and an observer with SUSE Observability", () => {
            expect(errors(otel("observer: obs", ""))).toEqual([
                "inputs.appco: required: HelmChart opentelemetry-operator (the opentelemetry profile on cluster apps) logs in to its registry with it",
            ]);
            expect(errors(otel("observer: apps"))).toEqual([
                expect.stringMatching(/^downstream\.apps\.profiles\.opentelemetry\.observer: /),
            ]);
        });
    });

    it("need an observer that runs SUSE Observability, in the lab", () => {
        expect(errors(lab({ apps: "suse-observability-agent: { observer: nope }" }))).toEqual([
            'downstream.apps.profiles.suse-observability-agent.observer: no downstream cluster "nope" in the lab; clusters: obs, apps',
        ]);
        expect(errors(lab({ obs: "storage: {}", apps: "suse-observability-agent: { observer: obs }" }))).toEqual([
            "downstream.apps.profiles.suse-observability-agent.observer: cluster obs doesn't run suse-observability: give it the Fleet profile observability",
        ]);
        expect(errors(lab({ apps: "suse-observability-agent: {}" }))).toEqual([
            'downstream.apps.profiles.suse-observability-agent.observer: required',
        ]);
    });

    it("take only profiles that target Harvesters on a Harvester", () => {
        expect(errors(lab({ harvester: "k3s: {}" }))).toEqual([
            "harvesters.hv-north.profiles.k3s: doesn't go on a Harvester; a Harvester takes: harvester-dns-controller, suse-observability-agent",
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
            'hosts.vm.profiles: unknown profile "nope"; known: ai-demos, ai-factory, cert-manager, harvester-cloud-provider, harvester-dns-controller, hauler, hauler-chart, k3s, landlock, metallb, mlm-client, mlm-server, open-webui, opentelemetry, outrider, rancher, rke2, sprouter, suse-observability-agent, traefik, vllm',
            'hosts.vm.profiles.k3s.versoin: unknown field "versoin"',
            "hosts.vm.profiles.hauler.port: Too big: expected number to be <=65535",
        ]);
    });

    it("applies the catalog's defaults", () => {
        const { lab } = load(`${BASE}\nhosts:\n  vm: { on: hv-north, os: leap-16, cpu: 2, memory: 4Gi, disk: 20Gi, profiles: { hauler: {} } }\n`);
        expect(lab!.hosts[0].profiles.hauler).toEqual({ manifests: [], port: 5000 });
        expect(lab!.hosts[0].capabilities).toEqual(["hauler", "registry"]);
    });

    it("checks HaulManifest names against the catalog, and hands the lab the ones it uses, rendered", () => {
        const vm = (manifests: string) => load(`${BASE}\nhosts:\n  vm: { on: hv-north, os: leap-16, cpu: 2, memory: 4Gi, disk: 20Gi, profiles: { hauler: { manifests: ${manifests} } } }\n`);
        expect(errors(vm("[ rancher-2.15, nope ]"))).toEqual([
            'hosts.vm.profiles.hauler.manifests[1]: no HaulManifest "nope"; known: rancher-2.15',
        ]);
        const { lab } = vm("[ rancher-2.15 ]");
        expect(Object.keys(lab!.haulManifests)).toEqual(["rancher-2.15"]);
        const docs = parseAllDocuments(lab!.haulManifests["rancher-2.15"]).map(d => d.toJS());
        expect(docs.map(d => [d.apiVersion, d.kind, d.metadata.name])).toEqual([
            ["content.hauler.cattle.io/v1", "Images", "rancher-2.15-images"],
            ["content.hauler.cattle.io/v1", "Charts", "rancher-2.15-charts"],
        ]);
        expect(docs[1].spec.charts[0]).toEqual({ name: "rancher", repoURL: "https://charts.rancher.com/server-charts/prime", version: "2.15.2", "add-images": true });
    });

    it("takes a lab's own HaulManifest, and renders hauler-chart's ConfigMap and sync Job from them", () => {
        const result = loadDocs(`${labDocument(`${BASE}\nhosts:\n  vm: { on: hv-north, os: leap-16, cpu: 2, memory: 4Gi, disk: 20Gi, profiles: { ${RANCHER_STACK}, hauler-chart: { manifests: [ tools ] } } }\n`)}---
kind: HaulManifest
metadata: { name: tools }
spec:
  images: [ { name: busybox:1.37, platform: linux/amd64 } ]
  files: [ { path: https://example.com/a.txt } ]
`);
        expect(errors(result)).toEqual([]);
        const values = result.lab!.hosts[0].chartValues["hauler-chart"];
        const configMap = values.objects.find(o => o.name === "manifests")!.object as { data: Record<string, string> };
        expect(Object.keys(configMap.data)).toEqual(["tools.yaml"]);
        expect(parseAllDocuments(configMap.data["tools.yaml"]).map(d => d.toJS().kind)).toEqual(["Images", "Files"]);
        const job = values.objects.find(o => o.name === "sync")!;
        expect(job.wait).toEqual({ condition: "Complete", timeout: "haulerSync" });
        expect((job.object as any).spec.template.metadata.annotations["lab.geeko.me/manifests"]).toMatch(/^[0-9a-f]{12}$/);
        expect(values.entries[0].lockedValues).toMatchObject({
            haulerRegistry: { ingress: { hostname: "registry.vm.lab.geeko.me", ingressClassName: "traefik", tls: { secretName: "wildcard-cert" } } },
            haulerFileserver: { enabled: false },
        });
    });

    it("lets only one registry on a host", () => {
        const result = load(`${BASE}\nhosts:\n  vm: { on: hv-north, os: leap-16, cpu: 2, memory: 4Gi, disk: 20Gi, profiles: { ${RANCHER_STACK}, hauler: {}, hauler-chart: {} } }\n`);
        expect(errors(result)).toEqual(["hosts.vm.profiles: hauler and hauler-chart can't run on the same host"]);
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
        const result = load(rancher("", ", outrider: {}", "inputs: { appco: \"{{ secrets.appco }}\", suse-observability-license: \"{{ secrets.obs }}\", suse-observability-token: \"{{ secrets['obs-token'] }}\", suse-observability-password: \"{{ secrets['obs-password'] }}\" }\n"));
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
            'inputs.other: no catalog secret or configmap takes input "other"; known: appco, scc, suse-observability-license, suse-observability-password, suse-observability-token',
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
    it("allows networks without lab DHCP, untagged and VLAN (the LAN's DHCP, or fixed addresses)", () => {
        const ok = load(`${BASE.replace("hv-north: {}", "hv-north: { networks: { untagged: {}, vlans: [{ id: 100 }] } }")}
hosts:
  vm: { on: hv-north, os: leap-16, cpu: 2, memory: 4Gi, disk: 20Gi }
  vm2: { on: hv-north, os: leap-16, cpu: 2, memory: 4Gi, disk: 20Gi, network: vlan100 }
`);
        expect(errors(ok)).toEqual([]);
    });
});

describe("fixed addresses", () => {
    const NETWORKS = `networks:
      untagged: { cidr: 10.29.10.0/24, gateway: 10.29.10.1 }
      vlans:
        - { id: 50, cidr: 203.0.113.0/24, gateway: 203.0.113.1, dns: [ 9.9.9.9 ] }
        - { id: 20, dhcp: { cidr: 10.29.20.0/24, gateway: 10.29.20.1, range: [ 10.29.20.100, 10.29.20.150 ] }, loadBalancer: { range: [ 10.29.20.200, 10.29.20.210 ] } }`;
    const lab = (vms: string) => load(`${BASE.replace("  hv-north: {}", `  hv-north:\n    ${NETWORKS}`)}
hosts:
${vms}
`);
    const vm = (name: string, spec: string) => `  ${name}: { on: hv-north, os: leap-16, cpu: 2, memory: 4Gi, disk: 20Gi, ${spec} }`;

    it("sets them from the network: its own subnet, or its DHCP's, outside the DHCP range", () => {
        const { lab: resolved, diagnostics } = lab([
            vm("a", "network: vlan50, ip: 203.0.113.20, fqdn: gitlab.example.com"),
            vm("b", "network: untagged, ip: 10.29.10.5"),
            vm("c", "network: vlan20, ip: 10.29.20.50"),
            vm("d", "network: default/vlan40, ip: 10.29.40.200/24, gateway: 10.29.40.1"),
        ].join("\n"));
        expect(diagnostics.errors).toEqual([]);
        const host = (n: string) => resolved!.hosts.find(h => h.name === n) as any;
        expect(host("a")).toMatchObject({ fqdn: "gitlab.example.com", network: "vlan50", ip: { address: "203.0.113.20", prefix: 24, gateway: "203.0.113.1", dns: ["9.9.9.9"] } });
        expect(host("b").ip).toEqual({ address: "10.29.10.5", prefix: 24, gateway: "10.29.10.1", dns: ["10.29.10.1"] });
        expect(host("c").ip).toEqual({ address: "10.29.20.50", prefix: 24, gateway: "10.29.20.1", dns: ["10.29.20.1"] });
        expect(host("d")).toMatchObject({ network: "default/vlan40", ip: { address: "10.29.40.200", prefix: 24, gateway: "10.29.40.1", dns: ["10.29.40.1"] } });
        expect(host("b").fqdn).toBe("b.lab.geeko.me");
    });

    it("gives a one-machine pool of a Harvester cluster its own, checked as a VM's; other pools any size", () => {
        const pools = (p: string) => lab(`  r: { on: hv-north, os: leap-16, network: vlan20, profiles: { ${RANCHER_STACK} } }
${vm("a", "network: vlan50, ip: 203.0.113.20")}
downstream:
  apps: { type: harvester, rancher: r, harvester: hv-north, pools: [ ${p} ] }`);
        const cp = (extra: string) => `{ name: cp, quantity: 1, roles: [etcd, controlplane, worker], os: leap-16, network: vlan50, ${extra} }`;
        const { lab: resolved, diagnostics } = pools(`${cp("ip: 203.0.113.21, macAddress: '52:54:00:aa:bb:02'")}, { name: workers, quantity: 3, roles: [worker], os: leap-16, network: vlan20 }`);
        expect(diagnostics.errors).toEqual([]);
        const apps = resolved!.downstream[0] as any;
        expect(apps.pools[0]).toMatchObject({ network: "vlan50", macAddress: "52:54:00:aa:bb:02", ip: { address: "203.0.113.21", prefix: 24, gateway: "203.0.113.1", dns: ["9.9.9.9"] } });
        expect(apps.pools[1].ip).toBeUndefined();
        expect(errors(pools([
            "{ name: two, quantity: 2, roles: [etcd, controlplane, worker], os: leap-16, network: vlan50, ip: 203.0.113.22 }",
            "{ name: macs, quantity: 2, roles: [worker], os: leap-16, macAddress: '52:54:00:aa:bb:03' }",
            cp("ip: 203.0.113.20"),
        ].join(", ")))).toEqual([
            "downstream.apps.pools[0].quantity: must be 1 with a fixed ip or macAddress: every machine in a pool gets the same network settings",
            "downstream.apps.pools[1].quantity: must be 1 with a fixed ip or macAddress: every machine in a pool gets the same network settings",
        ]);
        expect(errors(pools(cp("ip: 203.0.113.20")))).toEqual(["downstream.apps.pools[0].ip: 203.0.113.20 is a's fixed address too"]);
    });

    it("keeps them in the subnet, out of the DHCP range and load-balancer pool, off the network's own addresses, and unique", () => {
        expect(errors(lab([
            vm("a", "network: vlan20, ip: 10.29.20.120"),
            vm("b", "network: vlan20, ip: 10.29.20.205"),
            vm("c", "network: vlan20, ip: 10.29.20.1"),
            vm("d", "network: vlan20, ip: 10.29.20.2"),
            vm("e", "network: vlan50, ip: 198.51.100.4"),
            vm("f", "network: vlan50, ip: 203.0.113.255"),
            vm("g", "network: vlan50, ip: 203.0.113.30"),
            vm("h", "network: vlan50, ip: 203.0.113.30"),
            vm("i", "network: vlan50, ip: 203.0.113.31/16"),
        ].join("\n")))).toEqual([
            "hosts.a.ip: 10.29.20.120 is in the DHCP range 10.29.20.100-10.29.20.150; a fixed address goes outside it",
            "hosts.b.ip: 10.29.20.205 is in the load-balancer pool 10.29.20.200-10.29.20.210",
            "hosts.c.ip: 10.29.20.1 is the gateway",
            "hosts.d.ip: 10.29.20.2 is the DHCP server",
            "hosts.e.ip: 198.51.100.4 is outside vlan50's 203.0.113.0/24",
            "hosts.f.ip: 203.0.113.255 is the network's broadcast address",
            "hosts.h.ip: 203.0.113.30 is g's fixed address too",
            "hosts.i.ip: /16 doesn't match vlan50's 203.0.113.0/24; leave the prefix out",
        ]);
    });

    it("needs the prefix and gateway on a network the lab doesn't declare, and a subnet on one it does", () => {
        expect(errors(lab([
            vm("a", "network: default/vlan40, ip: 10.29.40.200"),
            vm("b", "network: vlan50, ip: 203.0.113.20, gateway: 203.0.113.254"),
            vm("c", "network: untagged, gateway: 10.29.10.1"),
        ].join("\n")))).toEqual([
            "hosts.a.ip: needs its prefix (10.29.40.200/24) on default/vlan40, a network the lab doesn't declare",
            "hosts.a.gateway: required with ip on default/vlan40, a network the lab doesn't declare",
            "hosts.b.gateway: comes from the network vlan50; set it there",
            "hosts.c.gateway: only goes with ip",
        ]);
        const plain = load(`${BASE.replace("hv-north: {}", "hv-north: { networks: { vlans: [{ id: 60 }, { id: 70, cidr: 10.0.70.0/24 }] } }")}
hosts:
${vm("a", "network: vlan60, ip: 10.0.60.5")}
`);
        expect(errors(plain)).toEqual([
            "harvesters.hv-north.networks.vlans[1]: needs both cidr and gateway, for its VMs' fixed addresses",
            "hosts.a.ip: vlan60 has neither lab DHCP nor a cidr: give the network cidr and gateway",
        ]);
    });
});

describe("secret templates", () => {
    const vm = (profiles: string) => `${BASE.replace("hv-north: {}", "hv-north: { url: https://hv.example.com, credentials: \"{{ secrets.hv }}\" }")}hosts:\n  vm: { on: hv-north, os: leap-16, profiles: { ${profiles} } }\n`;

    it("registers each secret with the shape it's used in: whole, or by username and password", () => {
        const result = load(vm(`${RANCHER_STACK.replace("rancher: {", "rancher: { values: { auth: \"Basic {{ secrets.reg.username }}:{{ secrets.reg.password }}\" }, ")}`));
        expect(errors(result)).toEqual([]);
        expect(result.lab!.secrets).toEqual({ cf: "string", "ssh-key": "string", hv: "credentials", ra: "string", reg: "credentials" });
    });

    it("rejects a secret used in two shapes, an unknown field, and credentials that aren't one secret", () => {
        const result = load(`${BASE.replace("hv-north: {}", "hv-north: { url: https://hv.example.com, credentials: \"admin:{{ secrets.hv }}\" }")}hosts:\n  vm: { on: hv-north, os: leap-16, profiles: { k3s: {}, cert-manager: {}, sprouter: {}, traefik: {}, rancher: { adminPassword: \"{{ secrets.cf.password }}\", values: { x: \"{{ secrets['ssh-key'].token }}\", y: \"{{ secrets.ra['a b'] }}\" } } } }\n`);
        expect(errors(result)).toEqual([
            "harvesters.hv-north.credentials: credentials are one secret ({{ secrets.name }}) or { username, password }",
            "hosts.vm.profiles.rancher.values.y: secrets.ra: \"a b\" can't be a field of a secret",
            // Reported where it's used the second time.
            "tls.cloudflare: secret \"cf\" is used both as a map with password and as string",
            "ssh.privateKey: secret \"ssh-key\" is used both as a map with token and as string",
        ]);
    });

    it("collects the fields of map secrets across their uses", () => {
        const result = load(`${BASE}hosts:\n  vm: { on: hv-north, os: leap-16, profiles: { k3s: {}, cert-manager: {}, sprouter: {}, traefik: {}, rancher: { adminPassword: \"{{ secrets.ra }}\", values: { a: \"{{ secrets.aws.accessKey }}\", b: \"{{ secrets.aws.secretKey | trim }}\", c: \"{{ secrets.reg.username }}\" } } } }\n`);
        expect(errors(result)).toEqual([]);
        expect(result.lab!.secrets).toMatchObject({ aws: { fields: ["accessKey", "secretKey"] }, reg: { fields: ["username"] } });
    });

    it("follows paths into map secrets, for a field or a map inside one", () => {
        const result = load(`${BASE.replace("\"{{ secrets.cf }}\"", "\"{{ secrets.cf.tunnel.token }}\"").replace("hv-north: {}", "hv-north: { url: https://hv.example.com, credentials: \"{{ secrets.infra['hv-north'] }}\" }")}hosts:\n  vm: { on: hv-north, os: leap-16, profiles: { k3s: {}, cert-manager: {}, sprouter: {}, traefik: {}, rancher: { adminPassword: \"{{ secrets.ra }}\", values: { a: \"{{ secrets.cf.token }}\", b: \"x-{{ secrets.cf.tunnel.id | trim }}\" } } } }\n`);
        expect(errors(result)).toEqual([]);
        expect(result.lab!.secrets).toMatchObject({ cf: { fields: ["token", "tunnel.id", "tunnel.token"] }, infra: { fields: ["hv-north.password", "hv-north.username"] } });
        const secrets = { cf: { token: "t", tunnel: { token: "tt", id: "i" } }, infra: { "hv-north": { username: "u", password: "p" } } };
        expect(renderSecretTemplate("{{ secrets.cf.tunnel.token }}", secrets)).toBe("tt");
        expect(renderSecretTemplate("{{ secrets.infra['hv-north'] }}", secrets)).toEqual({ username: "u", password: "p" });
        expect(renderSecretTemplate("x-{{ secrets.cf.tunnel.id }}", secrets)).toBe("x-i");
    });

    it("fetches the secrets the lab's vars use", () => {
        const result = load(`${BASE}vars: { token: "{{ secrets.tok }}", header: "Bearer {{ secrets['api-key'] }}", plain: 1 }\n`);
        expect(errors(result)).toEqual([]);
        expect(result.lab!.secrets).toMatchObject({ tok: "string", "api-key": "string" });
        expect(result.lab!.vars).toEqual({ token: "{{ secrets.tok }}", header: "Bearer {{ secrets['api-key'] }}", plain: 1 });
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

describe("landlock", () => {
    const POOL = "pools: [{ name: a, quantity: 1, roles: [etcd, controlplane, worker], os: leap-16 }]";
    const lab = (hosts: string, downstream = "", catalog = "") => load(`${BASE}${catalog}hosts:
  r: { on: hv-north, os: leap-16, profiles: { ${RANCHER_STACK} } }
${hosts}
${downstream ? `downstream:\n${downstream}` : ""}`);

    it("goes on hosts, metal clusters (for their nodes) and clusters Rancher creates machines for", () => {
        const result = lab([
            "  sandbox: { on: hv-north, os: leap-16, profiles: { k3s: {}, landlock: {} } }",
            "  plain: { on: hv-north, os: leap-16, profiles: { k3s: {} } }",
            "  node: { on: hv-north, os: leap-16 }",
        ].join("\n"), [
            "  edge: { type: metal, rancher: r, nodes: [{ host: node, roles: [etcd, controlplane, worker] }], profiles: { landlock: {} } }",
            `  apps: { type: harvester, rancher: r, harvester: hv-north, ${POOL}, profiles: { landlock: {} } }`,
            `  infer: { type: harvester, rancher: r, harvester: hv-north, ${POOL} }`,
        ].join("\n"));
        expect(errors(result)).toEqual([]);
        expect(result.lab!.downstream.find(d => d.name === "edge")!.chartProfiles!.profiles).toHaveProperty("landlock");
    });

    it("needs a metal cluster's nodes' OS to say how", () => {
        const result = lab("  bare-node: { on: hv-north, os: bare }",
            "  edge: { type: metal, rancher: r, nodes: [{ host: bare-node, roles: [etcd, controlplane, worker] }], profiles: { landlock: {} } }",
            "catalog:\n  os:\n    bare: { family: suse, image: { url: https://example.com/bare.qcow2 } }\n");
        expect(errors(result)).toEqual(["downstream.edge.profiles.landlock (node bare-node): OS profile bare has no landlock section, which the landlock profile needs"]);
    });

    it("isn't for k3k clusters (their parent's nodes), and needs the OS to say how", () => {
        const result = lab(
            "  bare-vm: { on: hv-north, os: bare, profiles: { landlock: {} } }",
            [
                `  apps: { type: harvester, rancher: r, harvester: hv-north, pools: [{ name: a, quantity: 1, roles: [etcd, controlplane, worker], os: bare }], profiles: { landlock: {} } }`,
                "  team: { type: k3k, rancher: r, parent: apps, profiles: { landlock: {} } }",
            ].join("\n"),
            "catalog:\n  os:\n    bare: { family: suse, image: { url: https://example.com/bare.qcow2 } }\n",
        );
        expect(errors(result)).toEqual([
            "hosts.bare-vm.profiles.landlock: OS profile bare has no landlock section, which the landlock profile needs",
            "downstream.apps.pools[0].os: OS profile bare has no landlock section, which the landlock profile needs",
            "downstream.team.profiles.landlock: can't go on a k3k cluster: it runs on its parent's nodes; put landlock on the parent",
        ]);
    });
});

describe("planned profiles", () => {
    it("validate with a warning, and are listed for `lab up` to refuse", () => {
        const result = load(`${BASE}hosts:
  mlm: { on: hv-north, os: sl-micro-6.1, cpu: 4, memory: 16Gi, disk: 100Gi, profiles: { mlm-server: { adminPassword: "{{ secrets.m }}" } } }
images:
  sl-micro-6.1: { url: https://example.com/sl-micro.qcow2 }
`);
        expect(errors(result)).toEqual([]);
        expect(result.diagnostics.warnings.map(d => `${resolverPath(d.path)}: ${d.message}`)).toContain(
            "hosts.mlm.profiles.mlm-server: isn't built yet (status: planned): the lab validates with it, but `lab up` refuses it");
        expect(result.lab!.planned).toEqual(["mlm-server"]);
    });
});
