import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUILTIN_CATALOG_DIR, loadCatalog, loadLab, LoadResult } from "../src";

let tmp: string;
const noPersonal = () => path.join(tmp, "no-config.yaml");
const LAB = "apiVersion: lab.geeko.me/v1alpha1\nkind: Lab\nmetadata: { name: test }\nspec:\n  domain: lab.example.com\n";

beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lab-docs-")); });
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(name: string, text: string): string {
    const file = path.join(tmp, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
}
const errors = (r: { diagnostics: LoadResult["diagnostics"] }) => r.diagnostics.errors.map(d => `${d.path}: ${d.message}`);

describe("documents", () => {
    it("needs a Lab document first in a lab file", () => {
        expect(errors(loadLab({ labFile: write("old.yaml", "lab: test\ndomain: lab.example.com\n"), personalConfig: noPersonal() }))).toEqual([
            "document 1: must be a document with apiVersion: lab.geeko.me/v1alpha1, kind: Lab, metadata and spec",
        ]);
        expect(errors(loadLab({ labFile: write("wrong.yaml", "kind: PersonalConfig\nmetadata: {}\nspec: {}\n"), personalConfig: noPersonal() }))).toEqual([
            "document 1.kind: the first document must be kind: Lab",
        ]);
        expect(errors(loadLab({ labFile: write("noname.yaml", "kind: Lab\nmetadata: {}\nspec: { domain: lab.example.com }\n"), personalConfig: noPersonal() }))).toEqual([
            "metadata.name: required: the lab's name",
        ]);
    });

    it("checks apiVersion, top-level fields and kinds", () => {
        const result = loadLab({
            labFile: write("bad.yaml", `${LAB}---
apiVersion: lab.geeko.me/v2
kind: HelmChart
metadata: { name: x }
spec: { chart: oci://example.com/x, version: 1 }
extra: true
---
kind: Deployment
metadata: { name: y }
spec: {}
---
kind: Lab
metadata: { name: again }
spec: {}
`),
            personalConfig: noPersonal(),
        });
        expect(errors(result)).toEqual([
            "document 2.apiVersion: must be lab.geeko.me/v1alpha1",
            'document 2.extra: unknown field "extra"; a document has apiVersion, kind, metadata and spec',
            'document 3.kind: unknown kind "Deployment"; one of HelmChart, Manifest, Binary, KubernetesDistribution, AcmeServer, Defaults, Profile, ChartProfile, SecretTemplate, ConfigMapTemplate, FleetRepo, FleetHelmOp, FleetProfile, HostRecipe, HaulManifest, ClusterGroup, UiPluginRepository, UiPlugin, OperatingSystem, Harvester, AwsSite, HarvesterVM, Machine, DownstreamCluster',
            "document 4.kind: Lab can only be the first document of its own file",
        ]);
    });

    it("takes secrets of any shape in the personal config, and can leave a broken one out", () => {
        const PERSONAL = "apiVersion: lab.geeko.me/v1alpha1\nkind: PersonalConfig\nmetadata: { name: me }\nspec:\n";
        const nested = write("personal-nested.yaml", `${PERSONAL}  secrets:\n    cloudflare: { token: t, tunnel: { account: a, id: 1 } }\n    list: [a, b]\n`);
        expect(errors(loadCatalog({ personalConfig: nested }))).toEqual([]);
        const broken = write("personal-broken.yaml", `${PERSONAL}  harvesters: { hv: { url: 42 } }\n`);
        expect(loadCatalog({ personalConfig: broken }).catalog).toBeUndefined();
        expect(loadCatalog({ personalConfig: broken, withoutPersonal: true }).catalog).toBeDefined();
    });

    it("reads catalog documents from spec.include, files and directories", () => {
        write("team/charts.yaml", "kind: HelmChart\nmetadata: { name: podinfo }\nspec: { chart: oci://ghcr.io/stefanprodan/charts/podinfo, version: 6.11.0, namespace: podinfo }\n---\nkind: HelmChart\nmetadata: { name: rancher }\nspec: { version: v2.14.3 }\n");
        const lab = write("with-include.yaml", `apiVersion: lab.geeko.me/v1alpha1\nkind: Lab\nmetadata: { name: test }\nspec:\n  domain: lab.example.com\n  include: [team, missing]\n`);
        expect(errors(loadCatalog({ labFile: lab, personalConfig: noPersonal() }))).toEqual([`spec.include[1]: no such file or directory: ${path.join(tmp, "missing")}`]);
        const ok = write("with-include-ok.yaml", `apiVersion: lab.geeko.me/v1alpha1\nkind: Lab\nmetadata: { name: test }\nspec:\n  domain: lab.example.com\n  include: [team]\n`);
        const loaded = loadCatalog({ labFile: ok, personalConfig: noPersonal() });
        expect(loaded.diagnostics.errors).toEqual([]);
        expect(loaded.catalog!.components.podinfo.value).toMatchObject({ kind: "HelmChart", namespace: "podinfo" });
        expect(loaded.catalog!.components.rancher.value).toMatchObject({ chart: "rancher", version: "v2.14.3" });
    });

    it("rejects a name defined twice in the engine's catalog", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lab-catalog-"));
        fs.cpSync(BUILTIN_CATALOG_DIR, dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "charts", "copy.yaml"), "kind: HelmChart\nmetadata: { name: traefik }\nspec: { repo: https://example.com, chart: traefik, version: 1 }\n");
        const { diagnostics } = loadCatalog({ personalConfig: noPersonal(), catalogDir: dir });
        expect(diagnostics.errors.map(d => `${d.path}: ${d.message}`)).toEqual(["HelmChart/traefik: is defined twice"]);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("reads the personal config as a PersonalConfig document", () => {
        const personal = write("config.yaml", "apiVersion: lab.geeko.me/v1alpha1\nkind: PersonalConfig\nmetadata: { name: me }\nspec:\n  inputs: { scc: \"{{ secrets.scc }}\" }\n  colour: blue\n");
        expect(errors(loadLab({ labFile: write("plain.yaml", LAB), personalConfig: personal }))).toEqual(['spec.colour: unknown field "colour"']);
    });

    it("renders references to the Lab document in the lab's documents, and those it includes", () => {
        write("refs/hosts.yaml", "kind: Machine\nmetadata: { name: shared }\nspec: { address: \"shared.{{ lab.domain }}\", os: leap-16 }\n");
        const lab = write("refs.yaml", `apiVersion: lab.geeko.me/v1alpha1
kind: Lab
metadata: { name: refs }
spec:
  domain: lab.example.com
  tls: { acme: letsencrypt, email: "admin@{{ lab.domain }}", cloudflare: "{{ secrets.cf }}" }
  ssh: { user: lab, publicKey: "ssh-ed25519 AAAA", privateKey: "{{ secrets.k }}" }
  include: [refs]
---
kind: Machine
metadata: { name: box }
spec:
  address: "box.{{ lab.domain }}"
  os: leap-16
  profiles: { k3s: {}, cert-manager: {}, sprouter: {}, traefik: {}, rancher: { adminPassword: "{{ secrets.ra }}" } }
---
kind: Machine
metadata: { name: loops }
spec: { address: "{% for p in ['loops'] %}{{ p }}{% endfor %}.{{ lab.domain | lower }}", os: leap-16 }
---
kind: DownstreamCluster
metadata: { name: edge }
spec:
  type: metal
  rancher: box
  annotations: { hosted-domain: "{{ lab.domain }}", owner: "{{ lab.name }}", contact: "{{ lab.tls.email }}", acme: "{{ lab.tls.acme }}", user: "{{ lab.ssh.user }}" }
  nodes: [ { host: shared, roles: [ etcd, controlplane, worker ] } ]
`);
        const result = loadLab({ labFile: lab, personalConfig: noPersonal() });
        expect(errors(result)).toEqual([]);
        expect(Object.fromEntries(result.lab!.hosts.map(h => [h.name, h.fqdn]))).toEqual({ box: "box.lab.example.com", loops: "loops.lab.example.com", shared: "shared.lab.example.com" });
        // Lab values that are references themselves arrive rendered.
        expect(result.lab!.downstream[0].annotations).toEqual({ "hosted-domain": "lab.example.com", owner: "refs", contact: "admin@lab.example.com", acme: "letsencrypt", user: "lab" });
        expect(result.lab!.tls.email).toBe("admin@lab.example.com");
        // Secrets stay templates, rendered with their values later.
        expect(result.lab!.tls.cloudflare).toBe("{{ secrets.cf }}");
    });

    it("has vars: any keys, for references, themselves referring to the Lab document", () => {
        const lab = write("vars.yaml", `apiVersion: lab.geeko.me/v1alpha1
kind: Lab
metadata: { name: vars }
spec:
  domain: lab.example.com
  tls: { acme: none }
  ssh: { publicKey: "ssh-ed25519 AAAA", privateKey: "{{ secrets.k }}" }
  vars:
    team: tmm
    contact: "admin@{{ lab.domain }}"
    dns: { zone: geeko.me, servers: [ 10.0.0.1, 10.0.0.2 ] }
---
kind: Machine
metadata: { name: box }
spec: { address: "box.{{ lab.vars.dns.zone }}", os: leap-16, user: "{{ lab.vars.team }}" }
---
kind: Machine
metadata: { name: dns }
spec: { address: "{{ lab.vars.dns.servers[1] }}", os: leap-16 }
---
kind: Machine
metadata: { name: typo }
spec: { address: "{{ lab.vars.taem }}", os: leap-16 }
`);
        expect(errors(loadLab({ labFile: lab, personalConfig: noPersonal() }))).toEqual([
            'Machine/typo.spec.address: unknown reference "lab.vars.taem"; lab.vars has lab.vars.contact, lab.vars.dns, lab.vars.team',
        ]);
        fs.writeFileSync(lab, fs.readFileSync(lab, "utf8").replace("lab.vars.taem", "lab.vars.team"));
        const result = loadLab({ labFile: lab, personalConfig: noPersonal() });
        expect(errors(result)).toEqual([]);
        expect(result.lab!.hosts.map(h => `${h.name} ${h.fqdn} ${(h as { user?: string }).user}`)).toEqual(["box box.geeko.me tmm", "dns 10.0.0.2 lab", "typo tmm lab"]);
        // vars reach the resolved lab rendered, for profiles and cloud-init.
        expect(result.lab!.vars).toEqual({ team: "tmm", contact: "admin@lab.example.com", dns: { zone: "geeko.me", servers: ["10.0.0.1", "10.0.0.2"] } });
    });

    it("rejects references to anything the Lab document doesn't have, wherever they are", () => {
        write("dangling/hosts.yaml", "kind: Machine\nmetadata: { name: inc }\nspec: { address: \"{{ lab.spec.domain }}\", os: leap-16 }\n");
        const lab = write("dangling.yaml", `apiVersion: lab.geeko.me/v1alpha1
kind: Lab
metadata: { name: dangling }
spec:
  domain: lab.example.com
  include: [dangling]
---
kind: Machine
metadata: { name: a }
spec: { address: "{{ lab.domian }}", os: leap-16 }
---
kind: Machine
metadata: { name: e }
spec: { address: "e.{{ domain }}", os: leap-16 }
---
kind: Machine
metadata: { name: b }
spec: { address: "{{ lab.missing | default('x') }}", os: leap-16 }
---
kind: Machine
metadata: { name: c }
spec: { address: "{{ lab }}", os: leap-16 }
---
kind: Machine
metadata: { name: d }
spec: { address: "{{ lab.domain", os: leap-16 }
---
kind: Machine
metadata: { name: f }
spec: { address: "{{ lab.tls.mail }}", os: leap-16 }
`);
        const result = loadLab({ labFile: lab, personalConfig: noPersonal() });
        expect(result.diagnostics.errors.map(d => `${path.relative(tmp, d.source)}: ${d.path}: ${d.message}`)).toEqual([
            'dangling.yaml: Machine/a.spec.address: unknown reference "lab.domian"; lab has lab.domain, lab.images, lab.include, lab.inputs, lab.name, lab.tls, lab.vars',
            'dangling.yaml: Machine/e.spec.address: unknown reference "domain"; a lab file\'s templates can use lab (the Lab document: lab.domain, lab.images, lab.include, lab.inputs, lab.name, lab.tls, lab.vars) and secrets',
            'dangling.yaml: Machine/b.spec.address: unknown reference "lab.missing"; lab has lab.domain, lab.images, lab.include, lab.inputs, lab.name, lab.tls, lab.vars',
            // The whole Lab document is a map, not an address.
            "dangling.yaml: Machine/c.spec.address: Invalid input: expected string, received object",
            expect.stringMatching(/^dangling\.yaml: Machine\/d\.spec\.address: template: /),
            'dangling.yaml: Machine/f.spec.address: unknown reference "lab.tls.mail"; lab.tls has lab.tls.acme',
            'dangling/hosts.yaml: Machine/inc.spec.address: unknown reference "lab.spec.domain"; lab has lab.domain, lab.images, lab.include, lab.inputs, lab.name, lab.tls, lab.vars',
        ]);
    });

    it("fills in Lab values that refer to each other, at any depth, in any order", () => {
        const lab = write("chain.yaml", `apiVersion: lab.geeko.me/v1alpha1
kind: Lab
metadata: { name: chain }
spec:
  domain: "{{ lab.vars.sub }}.example.com"
  tls: { acme: none, email: "admin@{{ lab.domain }}" }
  vars:
    c: "{{ lab.vars.b }}-z"
    b: "{{ lab.vars.a }}-y"
    a: x
    sub: "{{ lab.vars.c }}"
    all: "{{ lab.vars.a }}/{{ lab.vars.b }}"
`);
        const { lab: resolved, diagnostics } = loadLab({ labFile: lab, personalConfig: noPersonal() });
        expect(diagnostics.errors).toEqual([]);
        expect(resolved!.vars).toEqual({ c: "x-y-z", b: "x-y", a: "x", sub: "x-y-z", all: "x/x-y" });
        expect(resolved!.domain).toBe("x-y-z.example.com");
        expect(resolved!.tls.email).toBe("admin@x-y-z.example.com");
    });

    it("takes the personal config's vars as defaults for the lab's, merged key by key, the lab's winning", () => {
        const personal = write("vars-config.yaml", `apiVersion: lab.geeko.me/v1alpha1
kind: PersonalConfig
metadata: { name: me }
spec:
  vars:
    team: tmm
    owner: "me@{{ lab.domain }}"
    dns: { zone: geeko.me, ttl: 300 }
    token: "{{ secrets.tok }}"
`);
        const lab = write("vars-lab.yaml", `apiVersion: lab.geeko.me/v1alpha1
kind: Lab
metadata: { name: mine }
spec:
  domain: lab.example.com
  tls: { acme: none }
  vars:
    team: edge
    dns: { ttl: 60 }
    label: "{{ lab.vars.team }}-{{ lab.vars.dns.zone }}"
`);
        const { lab: resolved, diagnostics } = loadLab({ labFile: lab, personalConfig: personal });
        expect(diagnostics.errors).toEqual([]);
        expect(resolved!.vars).toEqual({
            team: "edge", owner: "me@lab.example.com", dns: { zone: "geeko.me", ttl: 60 },
            token: "{{ secrets.tok }}", label: "edge-geeko.me",
        });
    });

    it("reports a problem in a var only the personal config has against the personal config", () => {
        const personal = write("bad-vars-config.yaml", `apiVersion: lab.geeko.me/v1alpha1
kind: PersonalConfig
metadata: { name: me }
spec:
  vars: { owner: "{{ lab.vars.nope }}" }
`);
        const lab = write("bad-vars-lab.yaml", `apiVersion: lab.geeko.me/v1alpha1
kind: Lab
metadata: { name: mine }
spec: { domain: lab.example.com, tls: { acme: none } }
`);
        const { diagnostics } = loadLab({ labFile: lab, personalConfig: personal });
        expect(diagnostics.errors.map(d => `${path.basename(d.source)}: ${d.path}: ${d.message}`)).toEqual([
            'bad-vars-config.yaml: spec.vars.owner: unknown reference "lab.vars.nope"; lab.vars has lab.vars.owner (rendering lab mine)',
        ]);
    });

    it("reports a circle of references by its links, and what waits on one", () => {
        const lab = write("circle.yaml", `apiVersion: lab.geeko.me/v1alpha1
kind: Lab
metadata: { name: circle }
spec:
  domain: "{{ lab.domain }}"
  tls: { acme: none }
  vars:
    a: "{{ lab.vars.b }}"
    b: "{{ lab.vars.a }}"
    c: "{{ lab.vars.nope }}"
    d: "{{ lab.vars.c }}!"
`);
        expect(errors(loadLab({ labFile: lab, personalConfig: noPersonal() }))).toEqual([
            "spec.domain: refers to lab.domain, which can't be filled in: lab.domain → lab.domain go round in a circle",
            "spec.vars.a: refers to lab.vars.b, which can't be filled in: lab.vars.b → lab.vars.a → lab.vars.b go round in a circle",
            "spec.vars.b: refers to lab.vars.a, which can't be filled in: lab.vars.a → lab.vars.b → lab.vars.a go round in a circle",
            'spec.vars.c: unknown reference "lab.vars.nope"; lab.vars has lab.vars.a, lab.vars.b, lab.vars.c, lab.vars.d',
            "spec.vars.d: refers to lab.vars.c, which can't be filled in (see its own problem)",
            "spec.domain: must be a lowercase DNS name",
        ]);
    });

    it("fills in the lab in a value that uses secrets too, leaving the secrets for later", () => {
        const lab = write("mixed.yaml", `apiVersion: lab.geeko.me/v1alpha1
kind: Lab
metadata: { name: mixed }
spec:
  domain: lab.example.com
  tls: { acme: none }
  vars:
    token: "{{ secrets.cf.token }}"
    bearer: "Bearer {{ secrets.cf.token }} for {{ lab.domain }}"
    again: "{{ lab.vars.token }}"
`);
        const { lab: resolved, diagnostics } = loadLab({ labFile: lab, personalConfig: noPersonal() });
        expect(diagnostics.errors).toEqual([]);
        expect(resolved!.vars).toEqual({
            token: "{{ secrets.cf.token }}",
            bearer: "Bearer {{ secrets.cf.token }} for lab.example.com",
            again: "{{ secrets.cf.token }}",
        });
        const tags = write("tags.yaml", `apiVersion: lab.geeko.me/v1alpha1
kind: Lab
metadata: { name: tags }
spec:
  domain: lab.example.com
  tls: { acme: none }
  vars: { tags: "{% if lab.domain %}{{ secrets.cf.token }}{% endif %}" }
`);
        expect(errors(loadLab({ labFile: tags, personalConfig: noPersonal() }))).toEqual([
            "spec.vars.tags: a template with {% %} tags can use secrets or lab, not both; give the lab part a value of its own (a var)",
        ]);
    });

    it("takes a lab's own ChartProfiles, but not its own Profiles, and checks what a ChartProfile may have", () => {
        const lab = write("own-profiles.yaml", `apiVersion: lab.geeko.me/v1alpha1
kind: Lab
metadata: { name: own }
spec:
  domain: lab.example.com
  tls: { acme: none }
  ssh: { user: lab, publicKey: "ssh-ed25519 AAAA", privateKey: "{{ secrets.k }}" }
---
kind: ChartProfile
metadata: { name: mine, description: "Sprouter, again" }
spec:
  charts: [ { chart: sprouter, namespace: mine } ]
  requires: [ kubernetes ]
---
kind: ChartProfile
metadata: { name: hosty }
spec:
  charts: [ { chart: sprouter, namespace: hosty } ]
  hostKinds: [ ssh ]
---
kind: ChartProfile
metadata: { name: chartless }
spec:
  objects: [ { name: x, object: { apiVersion: v1, kind: ConfigMap, metadata: { name: x } } } ]
---
kind: Machine
metadata: { name: box }
spec: { address: box.example.com, os: leap-16, profiles: { k3s: {}, mine: {} } }
`);
        expect(errors(loadLab({ labFile: lab, personalConfig: noPersonal() }))).toEqual([
            "ChartProfile/hosty.spec.hostKinds: is for a Profile (lab hosts only); a ChartProfile has charts and objects only",
            "ChartProfile/chartless.spec.charts: needs a chart of its own (its objects go with it)",
        ]);
        // Without those two, the lab's own ChartProfile is used like a built-in one.
        fs.writeFileSync(lab, fs.readFileSync(lab, "utf8").replace(/---\nkind: ChartProfile\nmetadata: \{ name: hosty \}[\s\S]*?(?=---\nkind: Machine)/, ""));
        const ok = loadLab({ labFile: lab, personalConfig: noPersonal() });
        expect(errors(ok)).toEqual([]);
        expect(ok.lab!.hosts[0].profileOrder).toEqual(["k3s", "mine"]);
        // A Profile, with a builder in the engine, only in the engine's own catalog.
        fs.writeFileSync(lab, `${fs.readFileSync(lab, "utf8")}---\nkind: Profile\nmetadata: { name: coded }\nspec: {}\n`);
        expect(errors(loadLab({ labFile: lab, personalConfig: noPersonal() }))).toEqual([
            "Profile/coded: Profiles can only be defined in the engine's catalog (lab/catalog/): their builders are written against them",
        ]);
    });

    it("assembles a lab from its Harvester, HarvesterVM, Machine and DownstreamCluster documents", () => {
        write("shared/hosts.yaml", "kind: HarvesterVM\nmetadata: { name: vm }\nspec: { harvester: hv, os: leap-16, cpu: 2, memory: 4Gi, disk: 20Gi, colour: blue }\n");
        const lab = write("composed.yaml", `apiVersion: lab.geeko.me/v1alpha1
kind: Lab
metadata: { name: test }
spec:
  domain: lab.example.com
  tls: { acme: none }
  ssh: { user: lab, publicKey: "ssh-ed25519 AAAA", privateKey: "{{ secrets.k }}" }
  include: [shared]
---
kind: Harvester
metadata: { name: hv }
spec: { url: https://hv.example.com, credentials: { username: a, password: "{{ secrets.hv }}" } }
---
kind: Machine
metadata: { name: box }
spec: { address: box.example.com, os: leap-16 }
---
kind: HarvesterVM
metadata: { name: other }
spec: { harvester: nope, os: leap-16, cpu: 2, memory: 4Gi, disk: 20Gi }
`);
        const result = loadLab({ labFile: lab, personalConfig: noPersonal() });
        // An error in an included document points at that file and document.
        expect(result.diagnostics.errors.map(d => `${path.relative(tmp, d.source)}: ${d.path}: ${d.message}`)).toEqual([
            'shared/hosts.yaml: HarvesterVM/vm.spec.colour: unknown field "colour"',
        ]);
        fs.writeFileSync(path.join(tmp, "shared/hosts.yaml"), "kind: HarvesterVM\nmetadata: { name: vm }\nspec: { harvester: hv, os: leap-16, cpu: 2, memory: 4Gi, disk: 20Gi }\n");
        const fixed = loadLab({ labFile: lab, personalConfig: noPersonal() });
        expect(fixed.diagnostics.errors.map(d => `${d.path}: ${d.message}`)).toEqual([
            'HarvesterVM/other.spec.harvester: unknown Harvester "nope"; known: hv',
        ]);
    });

    it("rejects duplicate lab documents, and hosts of both kinds with one name", () => {
        const lab = write("dup.yaml", `${LAB}---
kind: Harvester
metadata: { name: hv }
spec: {}
---
kind: Harvester
metadata: { name: hv }
spec: {}
---
kind: HarvesterVM
metadata: { name: box }
spec: { harvester: hv, os: leap-16, cpu: 2, memory: 4Gi, disk: 20Gi }
---
kind: Machine
metadata: { name: box }
spec: { address: box.example.com, os: leap-16 }
`);
        expect(errors(loadLab({ labFile: lab, personalConfig: noPersonal() }))).toEqual([
            `Harvester/hv: is defined twice (also in ${lab})`,
            `Machine/box: has the same name as HarvesterVM/box (in ${lab})`,
        ]);
    });

    it("keeps lab documents out of the personal config, and the old inline sections out of the Lab", () => {
        const personal = write("config-lab.yaml", "kind: PersonalConfig\nmetadata: { name: me }\nspec: {}\n---\nkind: Harvester\nmetadata: { name: hv }\nspec: {}\n");
        expect(errors(loadLab({ labFile: write("plain2.yaml", LAB), personalConfig: personal }))).toEqual([
            "Harvester/hv: Harvester documents belong in a lab file (or a file it includes), not in the personal config",
        ]);
        expect(errors(loadLab({ labFile: write("inline.yaml", `${LAB}  hosts: {}\n`), personalConfig: noPersonal() }))).toEqual([
            'spec.hosts: unknown field "hosts"',
        ]);
    });
});
