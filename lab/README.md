# Lab engine

Describe a lab environment on SUSE Virtualization (Harvester) in one YAML file and build it with
one command. See [DESIGN.md](DESIGN.md) for the full design and the lab file reference.

> **Status: M0.** The CLI, the lab file format, validation, secrets and the Harvester ownership
> check work. Nothing is built on Harvester yet: `up` of a lab with hosts only records the lab.
> Next up is M1 (Harvester base and VMs).

## Getting started

```bash
cd lab
mise install                 # node, pnpm, pulumi, crd2pulumi
mise exec -- pnpm install
mise run lab -- validate labs/rancher-harvester-rke2.yaml
mise run lab -- plan     labs/rancher-harvester-rke2.yaml
```

Commands: `validate`, `plan`, `preview`, `up`, `destroy`, `outputs`, `release`, `profiles`
(lists every host profile with its rules) and `catalog [lab.yaml]` (the effective defaults:
components, plugins, secrets, configmaps, Fleet repos and groups, OS profiles and the
Defaults, and where each comes from). Run `mise run lab -- --help` for options.

**OCI charts and your Docker config.** Helm pulls `oci://` charts (Sprouter, Outrider) with the
credential helper your `~/.docker/config.json` names (`credsStore`), even for public charts. If
that helper isn't on your `PATH`, `up` fails with `exec: "docker-credential-<name>": executable
file not found in $PATH`. Put it on the `PATH` of the shell you run `lab` from (Rancher Desktop
installs them in `~/.rd/bin`), or remove `credsStore` if you don't need it.

## Files are documents

Lab files, the personal config and the catalog are Kubernetes-style documents: `apiVersion:
lab.geeko.me/v1alpha1`, a `kind`, `metadata` (`name`, `description`) and a `spec`. A file can hold
several, separated by `---`.

A lab file starts with its `Lab` document (lab-wide settings); the lab's Harvesters, AWS sites,
hosts and downstream clusters are documents of their own, in the same file or in files it includes:

```yaml
apiVersion: lab.geeko.me/v1alpha1
kind: Lab
metadata: { name: my-lab }
spec:
  domain: lab.geeko.me
  tls: { ... }
  ssh: { ... }
  include: [../shared/rancher-host.yaml]   # more documents: lab and catalog ones alike
---
kind: Harvester                            # url and credentials can stay in your personal config
metadata: { name: asgard }
spec: { networks: { ... } }
---
kind: HarvesterVM                          # a VM the lab creates on a Harvester
metadata: { name: rancher }
spec: { harvester: asgard, os: leap-16, cpu: 4, memory: 16Gi, disk: 100Gi, profiles: { ... } }
---
kind: Machine                              # an existing machine, reached over SSH
metadata: { name: nuc-01 }
spec: { address: nuc-01.lab.geeko.me, user: root, os: sles-16 }
---
kind: DownstreamCluster                    # a cluster Rancher creates
metadata: { name: apps }
spec: { type: harvester, rancher: rancher, harvester: asgard, pools: [ ... ] }
---
kind: AwsSite                              # an AWS account and region; the lab gets its own VPC there
metadata: { name: aws-eu }
spec: { region: eu-west-1, credentials: "{{ secrets.aws }}", ttl: 8h }
---
kind: DownstreamCluster                    # machines Rancher creates on EC2 (its Rancher must be public)
metadata: { name: cloud }
spec: { type: ec2, rancher: rancher, site: aws-eu, pools: [ { name: all, quantity: 1, roles: [ etcd, controlplane, worker ], os: ubuntu-24.04 } ] }
---
kind: DownstreamCluster                    # an EKS cluster Rancher creates and manages (its Rancher must be public)
metadata: { name: eks }
spec: { type: eks, rancher: rancher, site: aws-eu, nodeGroups: [ { name: general, quantity: 2 } ] }
---
kind: DownstreamCluster                    # a k3k virtual cluster inside apps, imported into Rancher
metadata: { name: team-blue }
spec: { type: k3k, rancher: rancher, parent: apps }
---
kind: HelmChart                            # a catalog override for this lab
metadata: { name: rancher }
spec: { version: v2.14.3 }
```

Each lab document name may be used once (HarvesterVMs and Machines share names, as hosts).
Errors point at the document: `HarvesterVM/rancher.spec.cpu`, `HelmChart/rancher.spec.version`, or
`spec.tls.email` for the Lab's own fields.

## Personal config

Everything that belongs to you rather than to a lab goes in `~/.config/lab/config.yaml`
(or `$LAB_CONFIG`): secret values, your Harvesters' addresses and logins, local image files, and
default `inputs`.

```yaml
apiVersion: lab.geeko.me/v1alpha1
kind: PersonalConfig
metadata: { name: me }
spec:
  secrets:
    hv-north:         { username: admin, password: "cmd:pass show lab/hv-north" }
    cloudflare:       { token: env:CF_API_TOKEN }
    ssh-key:          file:~/.ssh/id_ed25519
    rancher-admin:    "cmd:pass show lab/rancher-admin"
    aws:              { accessKey: AKIA..., secretKey: "cmd:pass show lab/aws" }
  harvesters:
    hv-north: { url: https://hv-north.lab.geeko.me, credentials: "{{ secrets['hv-north'] }}" }
  awsSites:
    aws-eu: { region: eu-west-1, credentials: "{{ secrets.aws }}" }
  images:
    sles-16: { file: ~/images/SLES-16.0-Minimal-VM.x86_64-Cloud.qcow2 }
```

Secret values may be literal, `env:VAR`, `file:path` or `cmd:<command>`. Any secret can also be set
as an environment variable `LAB_SECRET_<NAME>` (for example `LAB_SECRET_HV_NORTH`, as JSON
`{"username":"...","password":"..."}` for a map, like credentials).

Lab files only name secrets, as Jinja2 templates: `"{{ secrets.appco }}"`, with brackets for a name
with a dash (`"{{ secrets['ssh-key'] }}"`), a field of a map secret by name (`"{{ secrets.scc.password }}"`,
`"{{ secrets.aws.accessKey }}"`) or by path into nested maps (`"{{ secrets.cloudflare.tunnel.token }}"`),
or with text around it (`"Bearer {{ secrets.token }}"`). Quote
them: YAML reads a bare `{` as a map.

Any value in the lab's own documents can also refer to the Lab document, as `lab` (its spec and
`name`): `"{{ lab.domain }}"`, `"{{ lab.name }}"`, `"{{ lab.tls.email }}"`, e.g.
`hosted-domain: "{{ lab.domain }}"` on a cluster. `validate` rejects a reference to anything the Lab
document doesn't have (`lab.spec.domain`, a typo), so none is left in the lab as text. Values of
your own go under `vars` in the Lab document, any keys: `vars: { team: tmm }`, then
`"{{ lab.vars.team }}"`; profiles and cloud-init can use them too. Your personal config can have
`vars:` as well: defaults for every lab, merged under the lab's own key by key, so a lab can
override any of them (`vars: { owner: "me@{{ lab.domain }}", dns: { zone: geeko.me } }`). Lab values can build on each
other at any depth (`b: "{{ lab.vars.a }}-y"`, `c: "{{ lab.vars.b }}-z"`); a circle is reported with
its links. A value can mix both kinds (`"{{ secrets.k }}@{{ lab.domain }}"`): the lab part is filled
in, the secret when the lab is built. Secrets only get their values in secret fields and chart
values; `validate` reports one anywhere else (an annotation), where it would end up as text.

In the lab composer, typing `{{` in any text box (form fields and the YAML) offers what can follow:
`lab.…` from the Lab document, with its values, and `secrets.…` from the personal config, by name
and shape only. ↑/↓ choose, Enter or Tab take one (a map goes one level down, a value closes the
`}}`), Esc closes the list.

## Catalog: the defaults

What a lab installs by default is data in [`catalog/`](catalog), one document per thing, in
directories by kind (the directories don't matter to the loader; the `kind` does):

| Kind | What | Where |
|---|---|---|
| `KubernetesDistribution` | k3s, RKE2: version, install command, config, paths, default CNI | `kubernetes/` |
| `AcmeServer` | where certificates come from (`tls.acme`): Let's Encrypt and its staging | `acme/` |
| `Defaults` | what the engine uses where a lab doesn't say: the SSH user, a VM's size, Harvester's cluster network and storage class, and how long each step may take | `defaults.yaml` |
| `HelmChart` | a chart: repo, chart, version, default namespace | `charts/` |
| `Manifest` | a manifest URL template and its version (Gateway API) | `charts/` |
| `Binary` | a release tarball a host downloads (Hauler, lego): URL template and version | `binaries/` |
| `HaulManifest` | what a Hauler store holds: images, charts, files | `hauler/` |
| `HostRecipe` | a standard host for the composer's palette (Rancher VM, Registry VM): its kind, size, OS and profiles; add your own in the personal config or an included catalog | `recipes/` |
| `Profile` | what you can put on a host under `profiles:`, with its rules and settings | `profiles/` |
| `SecretTemplate`, `ConfigMapTemplate` | Secrets/ConfigMaps built from `inputs` | `secrets/`, `configmaps/` |
| `FleetRepo`, `ClusterGroup` | Fleet GitRepos and the groups they target | `fleet/` |
| `UiPluginRepository`, `UiPlugin` | Rancher UI plugins, their versions and the default set | `plugins.yaml` |
| `OperatingSystem` | OS profiles | `os/` |

**Overriding or adding** works from the personal config and from a lab file: put documents after
the first one, or list files and directories (a team's shared catalog) under
`spec.include`. A document of the same kind and name merges its `spec` into the built-in
one, field by field, so you only write what differs (a distribution's `config` and
`withCapability`, and `Defaults`, merge key by key; lists are replaced); a new name adds an entry. Profiles can't be
changed this way: the engine's builders are written against them.

```yaml
---
kind: KubernetesDistribution
metadata: { name: k3s }
spec: { version: v1.35.4+k3s1 }
---
kind: HelmChart
metadata: { name: rancher }
spec: { repo: https://releases.rancher.com/server-charts/latest, version: v2.14.3 }   # community Rancher
---
kind: OperatingSystem
metadata: { name: sles-16-dev, description: SLES 16 with build tools }
spec: { extends: sles-16, cloudInit: { packages: [git, make] } }   # joined with sles-16's
---
kind: Defaults
metadata: { name: default }
spec: { timeouts: { downstreamReady: 2h, image: 2h } }   # a slow Harvester; the other timeouts stay
```

`mise run lab -- catalog [lab.yaml]` shows the result and where each entry comes from.

Chart profiles (`rancher`, `cert-manager`, `traefik`, `sprouter`, `outrider`,
`harvester-cloud-provider`, `metallb`) take extra Helm `values:`. Their Profile documents list what they
install under `charts:` (charts and manifests, in order, each with its namespace, default `values`,
`lockedValues` and an optional `when`); your `values` go to the first chart. Values that depend on the host or on other
profiles are Jinja2 templates in those (`hostname: "{{ settings.hostname }}.{{ host.fqdn }}"`,
`"{{ outputs.tls.secretName }}"`), rendered by `validate`. Your `values` merge over the defaults;
setting a locked path is rejected.
Secret templates (`"{{ secrets.name }}"`) work inside `values` too; the program renders those.

A profile that only installs charts (Sprouter, Outrider, or a chart set like Kubewarden's) needs
no TypeScript at all: HelmChart documents and a Profile document with its `charts` are enough. The engine
installs it after the profiles it `requires`, and other profiles can require what it `provides`.

### Charts on a host

Any catalog `HelmChart` can go on a host that runs Kubernetes; it's installed after the host's
profiles, in the chart's namespace unless you name another:

```yaml
hosts:
  apps:
    profiles: { rke2: {} }
    charts:
      - name: longhorn
        values: { persistence: { defaultClassReplicaCount: 1 } }
```

Charts take no part in the profiles' rules: something other profiles `require` (storage, say) has
to be a Profile.

### Secrets and configmaps

Credentials, licenses and settings for clusters are `SecretTemplate`/`ConfigMapTemplate`
documents in [`catalog/secrets/`](catalog/secrets) and `catalog/configmaps/`. Each lists the
**inputs** it is built from; the lab gives their values once, in `spec.inputs` (your personal
config can hold defaults):

```yaml
spec:
  inputs:
    appco: "{{ secrets.appco }}"                     # SUSE Application Collection login
    scc: "{{ secrets.scc }}"                         # SCC registry login
```

Put them on any cluster by name, optionally in another namespace:

```yaml
  hosts:
    rancher:
      secrets: [scc-suse-basicauth]
      configmaps: [{ name: proxy-config, namespace: kube-system }]
  downstream:
    apps:
      secrets: [{ name: application-collection-basicauth, namespace: apps }]
```

A template's `spec.template.data` value is a single value or a map (stored as a YAML document,
e.g. a values file). Strings in it are Jinja2 templates over `inputs` and `lab`:
`"{{ inputs.appco.username }}"`, `"Bearer {{ inputs.token }}"`, `"{{ lab.tls.email }}"` (an input
whose name has a `-` is `inputs['suse-observability-license']`). Keys whose inputs you didn't give
are left out; something you list by name that can't be built is a validation error. Secret values
never reach the resolver: a template that uses one is rendered by the Pulumi program.

### Fleet

Fleet GitRepos are `FleetRepo` documents in [`catalog/fleet/repos/`](catalog/fleet/repos) (this
repository's `apps/` tree), with the `ClusterGroup`s they target in
[`catalog/fleet/groups.yaml`](catalog/fleet/groups.yaml). A repo requires its Helm login
(`helm.secret`) and `uses` other catalog secrets when they're there (values files), the same two
words profiles use; they're created on the Rancher cluster from the lab's `inputs`. A `rancher`
profile picks the repos:

```yaml
rancher:
  adminPassword: "{{ secrets['rancher-admin'] }}"
  fleet:
    repos: [lab-setup-base, lab-setup-appco, team-apps]   # default: the repos marked default: true
```

Change or add repos and groups with documents:

```yaml
---
kind: FleetRepo
metadata: { name: lab-setup-base }
spec: { branch: my-feature }                              # test a branch (or url: a fork)
---
kind: FleetRepo
metadata: { name: team-apps, description: Our team's apps }
spec: { url: https://github.com/example/team-apps.git, paths: [/], target: demo }
---
kind: ClusterGroup
metadata: { name: demo }
spec: { selector: { matchLabels: { env: demo } } }
```

Without `fleet.repos` you get the default repos whose Helm secrets can be built from your
`inputs`; `repos: []` means none. `lab plan` lists what's created and what's skipped, with the
input it waits for. To share a repo or secret with the team, add a file to `catalog/`.

## State

Lab state lives in `~/.local/share/lab/state` (`$LAB_STATE_URL` to override). Secrets in it are
encrypted with a passphrase from `$PULUMI_CONFIG_PASSPHRASE(_FILE)`, or otherwise from
`~/.config/lab/passphrase`, which the CLI creates on first use. **Keep that file**: without it you
can't update or destroy your labs.

## One lab per Harvester

`up` claims every Harvester the lab uses by writing a `lab-owner` ConfigMap on it, and refuses to
touch a Harvester claimed by another lab or person. `destroy` releases the claim.
`release` (with `--force` for someone else's claim) clears a stale one.

AWS sites aren't claimed: each lab gets its own VPC, and everything it makes there is tagged with
the lab, the site and who ran `up` (`lab.geeko.me/*`). `destroy --check` finds leftovers by those
tags.

## Development

```bash
mise run test            # unit tests
mise run typecheck       # tsc in every package
mise run profile-types   # after changing a Profile in catalog/profiles/: regenerate its settings types
mise run crds            # after changing packages/crds/crd-sources/: regenerate the CRD classes
```

| Path | What |
|---|---|
| `cli/` | The `lab` command (Pulumi Automation API, secrets, Harvester claims) |
| `program/` | The Pulumi program the CLI runs; `profiles.ts` has one builder per profile |
| `packages/schema/` | Lab file schema, loading, validation and resolution |
| `packages/schema/src/profiles/` | Profile rule checks; the profiles themselves are `Profile` documents in `catalog/profiles/` |
| `packages/core/` | Harvester API client, ownership claims |
| `catalog/` | Built-in defaults as documents (see Catalog above): `plugins.yaml`, `secrets/`, `configmaps/`, Fleet repos and groups in `fleet/`, OS profiles in `os/` (`lab catalog` shows the effective set) |
| `labs/` | Example labs |
