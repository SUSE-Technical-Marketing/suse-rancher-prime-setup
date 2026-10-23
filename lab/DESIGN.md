# Lab engine — design

Status: **M0 implemented** (CLI, schema, validation, secrets, ownership guard). M1 onwards not built yet.

A config-driven way to build complete demo/lab environments on SUSE Virtualization (Harvester):
describe a lab in one YAML file, run one command, get VMs, Kubernetes, Rancher, Multi-Linux
Manager, an air-gap registry, and downstream clusters — and tear it all down again just as easily.

This lives in `lab/` and is **independent of `pulumi/`**. The existing setup is not modified; useful
code from `pulumi/modules` is ported (copied and adapted), not imported.

---

## 1. Goals and non-goals

**Goals**

- A lab is fully described by a single YAML file. Mixing and matching setups means editing YAML,
  not TypeScript.
- One command to create, preview, inspect and destroy a lab. No `pulumi stack` / `pulumi config`
  for users.
- A lab owns everything on the Harvester machines it uses, including base resources (networks,
  images, add-ons). `destroy` leaves those Harvesters clean.
- One lab may span several Harvester machines.
- Lab files contain no secrets and can be shared.
- Supported building blocks (v1): Harvester VMs and existing SSH hosts; openSUSE/SLES/SL Micro/
  Ubuntu/Rocky guests; k3s/RKE2; Rancher (plugins, Fleet); Rancher-provisioned clusters on
  Harvester and custom clusters on existing machines; Hauler; Multi-Linux Manager server + clients.

**Non-goals**

- Several labs sharing one Harvester at the same time. One Harvester runs one lab.
- Managing application workloads. Apps stay in Fleet (`apps/` + GitRepos); the lab only
  bootstraps Fleet.
- Long-lived production environments, upgrades in place, or day-2 operations beyond re-running
  `up`.
- A general-purpose plugin system. New kinds of profile are added in TypeScript by maintainers.

---

## 2. Principles

1. **One lab per Harvester, lab owns all of it.** Base resources are created by the lab and removed
   by `destroy`. Nothing on a Harvester is `retainOnDelete` unless a field explicitly asks for it.
2. **Config over code.** The YAML is the interface. The TypeScript engine reads it, validates it,
   and builds components. Users never write TypeScript.
3. **Fail before creating anything.** Every reference (host, harvester, OS, secret, profile
   dependency) is checked up front with readable errors (`hosts.sles-01.profiles.mlm-client.server:
   host "mlm" has no mlm-server profile`).
4. **Hosts are machines, profiles are what runs on them.** A host's name is its DNS name. Profiles
   (`k3s`, `rancher`, `hauler`, `mlm-server`, ...) are attached to hosts and may depend on each other.
5. **Unique names by construction.** Every Pulumi resource name is derived from the lab entry it
   belongs to (`<host>/<thing>`, `<harvester>/<thing>`). No fixed names, so two VMs or two
   Harvesters can never collide.
6. **Components talk through small value types**, not through each other's internals (§7.3). Any
   component that produces a `ClusterAccess` can feed any component that needs one.
7. **Versions are centralised** in one engine `versions.ts`, overridable per lab under `versions:`.

---

## 3. User workflow

```bash
cd lab
mise install                      # node, pnpm, pulumi
mise run lab -- validate labs/rancher-airgap.yaml   # schema + reference checks, no Pulumi
mise run lab -- plan     labs/rancher-airgap.yaml   # print the resolved graph (hosts, profiles, order)
mise run lab -- preview  labs/rancher-airgap.yaml   # pulumi preview
mise run lab -- up       labs/rancher-airgap.yaml   # create / update
mise run lab -- outputs  labs/rancher-airgap.yaml   # URLs, addresses, kubeconfig paths
mise run lab -- destroy  labs/rancher-airgap.yaml   # remove everything
```

`outputs --write-kubeconfigs` writes each cluster's kubeconfig to
`~/.kube/lab-<lab>-<cluster>.yaml`.

---

## 4. Directory layout

```
lab/
  DESIGN.md
  mise.toml                 # node, pnpm, pulumi — same approach as pulumi/
  package.json              # workspace root
  pnpm-workspace.yaml       # packages/*, cli, program
  cli/                      # `lab` command: Automation API driver, secret resolution
  program/                  # the Pulumi project (Pulumi.yaml) the CLI runs
  packages/
    schema/                 # lab YAML schema (zod), loader, validation, reference resolution
    core/                   # waitFor, KubeWait, RancherClient, ssh/command helpers, naming, opts
    crds/                   # typed CRD classes, generated with crd2pulumi from crd-sources/
    os/                     # cloud-init builders per OS family (suse, rhel, debian)
    harvester/              # Harvester base, VMs, images, networks, add-ons
    kubernetes/             # k3s/RKE2 install on hosts, kubeconfig retrieval, HelmApp
    rancher/                # Rancher install, plugins, Fleet, Harvester import, downstream clusters
    mlm/                    # Multi-Linux Manager server, products, activation keys, clients
    registry/               # Hauler (host and Kubernetes modes)
  os/                       # built-in OS profiles, one YAML file each (§6)
  labs/                     # example lab files (the four reference labs, §13)
  hauler/                   # Hauler manifests referenced by labs (e.g. rancher-2.15.yaml)
```

Packages are consumed as TypeScript source: no `main: bin/...`, so there is no stale build output
(the problem fixed in `pulumi/` earlier).

---

## 5. Lab file reference

### 5.1 Top level

```yaml
lab: rancher-airgap            # unique name; also the Pulumi stack name
domain: lab.geeko.me           # base DNS domain for every host
tls:
  acme: letsencrypt            # letsencrypt | letsencrypt-staging | none
  email: me@example.com
  cloudflare: { $secret: cloudflare-token }

ssh:                           # default login installed on every VM
  user: jeroen
  publicKey: { file: ~/.ssh/id_ed25519.pub }
  privateKey: { $secret: ssh-key }

versions:                      # optional overrides of engine defaults
  rancher: v2.15.2
  k3s: v1.36.4+k3s1

harvesters: { ... }            # §5.2
hosts: { ... }                 # §5.3
downstream: { ... }            # §5.5
os: { ... }                    # optional extra/overridden OS profiles, §6
images: { ... }                # optional image sources per OS, §6
```

**Secret references.** Anywhere a secret is accepted, the value is `{ $secret: <name> }`. The lab
file only names secrets; values come from the user's environment (§10). Non-secret file contents
can be pulled in with `{ file: <path> }`.

### 5.2 Harvesters

```yaml
harvesters:
  hv-north:
    url: https://hv-north.lab.geeko.me
    credentials: { $secret: hv-north }      # { username, password }
    clusterNetwork: mgmt
    storageClass:                           # created by the lab
      name: longhorn-single
      replicas: 1
    dns:                                    # harvester-dns-controller, always installed
      backend: routeros
      host: 10.29.100.1
      credentials: { $secret: routeros }
    networks:
      default: vlan100                      # network used by hosts that don't name one
      untagged:                             # always present; dhcp optional (existing DHCP server)
        dhcp: { cidr: 10.29.0.0/24, gateway: 10.29.0.1, range: [10.29.0.100, 10.29.0.150] }
      vlans:                                # optional
        - id: 100
          dhcp: { cidr: 10.29.100.0/24, gateway: 10.29.100.1, range: [10.29.100.100, 10.29.100.150] }
          loadBalancer: { range: [10.29.100.200, 10.29.100.220] }   # optional Harvester LB pool

  hv-south: {}                              # url and credentials from the personal config (§10)
```

Everything here used to be hard-coded in `pulumi/setups/sample-setup/harvester-base.ts`
(`10.29.<vlan>` addressing, `lab.geeko.me`, the RouterOS credentials).

- **DHCP and DNS add-ons are always installed.** The vm-dhcp-controller and
  harvester-dns-controller add-ons are installed on every Harvester in a lab. Every VLAN needs a
  `dhcp` pool. On the untagged network `dhcp` is optional: leave it out when the physical network
  already has a DHCP server (for example a home router), so the two don't conflict. VLANs are
  optional.
- **Every Harvester VM gets a DNS record** (`<host>.<domain>`) through the DNS controller.
- **Load-balancer pools** (`loadBalancer:` on a network) become a Harvester load-balancer IPPool,
  limited to the lab's namespace. Guest clusters on that network with the
  `harvester-cloud-provider` profile take their LoadBalancer addresses from it instead of using
  ServiceLB; the DNS controller points `*.<host>.<domain>` at the load balancer. `cidr` and
  `gateway` default to the network's DHCP settings; the range must lie inside the network and
  outside the DHCP range.
- **Supported Harvester versions: 1.8 and newer** (1.9 is current). The engine reads the version
  when it connects and fails on older versions. Add-on versions are chosen per Harvester minor
  version in `versions.ts`.
- **Where a Harvester's `url` and `credentials` come from.** Either directly in the lab file, or
  from the `harvesters:` section of the personal config (§10) under the same name. Fields in the
  lab file win. This lets a team share lab files while each person points `hv-north` at their own
  machine.

**Images are not listed per Harvester.** The engine puts exactly the images needed by the hosts
and downstream pools on each Harvester (§6).

### 5.3 Hosts

```yaml
hosts:
  rancher:
    on: hv-north                 # a harvester name, or `ssh`
    os: leap-16                  # OS profile (§6)
    cpu: 4
    memory: 16Gi
    disk: 100Gi
    network: vlan100             # optional; default = the harvester's default network
    macAddress: 52:54:00:aa:bb:01   # optional, for a fixed DHCP lease
    profiles:
      k3s: {}
      rancher: { plugins: [harvester, kubewarden] }

  nuc-01:                        # an existing machine
    on: ssh
    address: nuc-01.lab.geeko.me # its existing DNS name (or an IP)
    user: root                   # optional; default = ssh.user
    os: sles-16                  # describes what is installed; used for package/registration steps
    profiles: {}                 # used as a custom-cluster node in downstream.edge
```

- `cpu`, `memory`, `disk` are required for Harvester hosts. There are no size presets.
- A Harvester host's FQDN is `<host>.<domain>`, registered by the DNS controller. Rancher is
  served at that FQDN by default (`https://rancher.lab.geeko.me`).
- SSH hosts already have a DNS record. Their `address` is used as-is; the lab creates no records
  for them.

### 5.4 Profiles

Profiles are a map from profile name to its settings. Each profile declares its own rules (§7.6);
validation and build order come from those declarations, never from code that knows a specific
profile. `lab profiles` prints the current list with all rules.

| Profile | Rules it declares | Settings (main ones) | Produces |
|---|---|---|---|
| `k3s` | provides `kubernetes`; one `kubernetes` per host | `version` | `ClusterAccess` |
| `rke2` | provides `kubernetes`; one `kubernetes` per host | `version` | `ClusterAccess` |
| `harvester-cloud-provider` | requires `kubernetes`; provides `load-balancer`; Harvester VMs only; the host's network needs a `loadBalancer` pool | `version` | Harvester cloud provider (+ kube-vip) in the guest cluster; k3s/RKE2 then run without ServiceLB and with an external cloud provider |
| `cert-manager` | requires `kubernetes`; provides `tls` | `version` | ClusterIssuers (Let's Encrypt prod + staging, Cloudflare DNS-01) and a wildcard certificate for `<host>.<domain>` + `*.<host>.<domain>`, labelled for Sprouter |
| `sprouter` | requires `kubernetes`; provides `secret-propagation` | `version` | Copies labelled secrets (the wildcard certificate) into every namespace |
| `traefik` | requires `kubernetes`; uses `load-balancer`; provides `ingress` | `version`, `gatewayApi` | Gateway API CRDs + Traefik with its Gateway provider |
| `outrider` | requires `kubernetes`; provides `downstream-secrets` | `version` | Propagates annotated secrets to downstream clusters |
| `rancher` | requires `kubernetes`, `ingress`, `tls`, `secret-propagation`; requires `downstream-secrets` when `fleet.secrets` is set; secret `adminPassword` | `version`, `hostname`, `adminPassword`, `plugins`, `liz`, `fleet` | `RancherAccess` |
| `hauler` | provides `registry` (uses Kubernetes if the host has it, otherwise systemd) | `manifests`, `port` | `RegistryAccess` |
| `mlm-server` | OS family `suse`; conflicts with `kubernetes` and `mlm-client`; secret `adminPassword` | `version`, `adminPassword`, `products` | `MlmAccess` |
| `mlm-client` | `server` must name a host running `mlm-server` | `server`, `activationKey` | — |

The apps a cluster needs are separate profiles, so they compose: a host can run Traefik without
Rancher, or cert-manager for its own workloads. A Rancher host lists them all:

```yaml
profiles:
  k3s: {}
  cert-manager: {}
  sprouter: {}
  traefik: {}
  outrider: {}
  rancher:
    adminPassword: { $secret: rancher-admin }
    fleet:
      secrets:
        appco: { $secret: appco }
        scc: { $secret: scc }
        suse-observability-license: { $secret: suse-observability-license }
```

Rancher is served at `rancher.<host>.<domain>` (the `hostname` setting changes the first label).
DNS for `*.<host>.<domain>` already points at the host (the DNS controller / RouterOS), and the
wildcard certificate covers it: any app on the host gets a name and TLS without extra records.

`rancher.fleet`:

```yaml
fleet:
  secrets: default               # the appco / SCC / cert-manager / cloudflare secrets used by apps/
  groups:
    edge:  { env: edge }         # ClusterGroup name -> label selector
  repos: default                 # `default` = the current lab-setup-* GitRepos, or a list:
  # repos:
  #   - name: lab-setup-base
  #     url: https://github.com/SUSE-Technical-Marketing/suse-rancher-prime-setup.git
  #     paths: [/apps/base]
  #     group: edge
```

### 5.5 Downstream clusters (created by Rancher)

Both types need a host with the `rancher` profile.

**On Harvester** — Rancher creates the VMs through its Harvester node driver:

```yaml
downstream:
  apps:
    type: harvester
    rancher: rancher             # host with the rancher profile
    harvester: hv-south          # any harvester in this lab
    distro: rke2
    version: v1.36.4+rke2r3
    labels: { env: demo, team: apps }
    pools:
      - name: control
        quantity: 1
        roles: [etcd, controlplane]
        cpu: 4
        memory: 8Gi
        disk: 60Gi
        os: sles-16
        network: vlan100
      - name: workers
        quantity: 2
        roles: [worker]
        cpu: 4
        memory: 16Gi
        disk: 100Gi
        os: sles-16
```

**Custom** — existing machines join a cluster Rancher defines:

```yaml
downstream:
  edge:
    type: custom
    rancher: rancher
    distro: rke2
    labels: { env: edge }
    nodes:
      - host: nuc-01             # an `ssh` host, or a Harvester host with no k8s profile
        roles: [etcd, controlplane, worker]
```

`labels` are set on the `provisioning.cattle.io` Cluster. Rancher copies them to the Fleet
cluster, so `fleet.groups` selectors match them.

---

## 6. OS profiles

OS profiles are **data, not code**. Each is a YAML document; adding an OS never needs TypeScript
as long as it belongs to a known family. Only the families (how packages get installed, how
users and repos are set up) are code, in `packages/os`.

```yaml
# lab/os/sles-16.yaml
name: sles-16
displayName: SUSE Linux Enterprise Server 16.0
family: suse                       # suse (zypper) | rhel (dnf) | debian (apt)
image:
  url: null                        # no public download; needs an images: entry (below)
defaultUser: sles                  # the image's built-in user, disabled by cloud-init
registration:
  suseconnect:
    regcode: { $secret: scc-regcode-sles }
packages: [curl, vim, qemu-guest-agent]
k8s:                               # extra setup when the host runs k3s/RKE2
  packages: [k3s-selinux]
cloudInit: {}                      # optional raw cloud-config, merged last
```

**Where profiles come from**, later sources winning:

1. built-in: `lab/os/*.yaml` (initially `leap-16`, `sles-16`, `sl-micro-6.1`, `ubuntu-24.04`,
   `rocky-9`),
2. the personal config's `os:` section,
3. the lab file's `os:` section.

An entry with `extends: <name>` starts from another profile and overrides only the fields it
sets, for example a variant with extra packages:

```yaml
os:
  sles-16-dev:
    extends: sles-16
    packages: [curl, vim, qemu-guest-agent, git, make]
```

`validate` checks every profile against the schema, that `family` is a known family, that
`extends` chains end at an existing profile, and that each OS used has an image source.

**Image sources.** Each OS used in a lab needs an image, from a URL or from a file on the machine
running the CLI (for images that need a login to download, such as SLES 16 and SL Micro):

```yaml
images:
  sles-16:      { file: ~/images/SLES-16.0-Minimal-VM.x86_64-Cloud.qcow2 }
  sl-micro-6.1: { url: https://mirror.internal/images/SL-Micro.x86_64-6.1-Base-qcow-GM.qcow2 }
  # leap-16, ubuntu-24.04, rocky-9: default public URL from the catalog, nothing needed here
```

- `url` creates a Harvester `VirtualMachineImage` with `sourceType: download`.
- `file` uploads the local file to each Harvester that needs it (`sourceType: upload`, through the
  Harvester upload API, a dynamic provider). The file's checksum is part of the resource, so a
  changed file is uploaded again.
- `images:` can be set in the lab file or in the personal config (§10); the lab file wins. That way
  each person keeps their own local image paths.
- `validate` fails if a host uses an OS with no public default and no `images:` entry.

The cloud-init processors from `pulumi/modules/common/src/cloud-init.ts` are ported and split by
family: package installation, repos, guest agent, firewall, user creation, DHCP interfaces.

The same profile produces both host cloud-init and `HarvesterConfig.userData` for
Rancher-provisioned pool nodes, so a `sles-16` downstream node is set up like a `sles-16` host.

---

## 7. Engine architecture

### 7.1 Pipeline

```
lab.yaml ──► load ──► validate (zod) ──► resolve ──► graph ──► build components (Pulumi)
               │                             │
            secrets (§10)            references, defaults, derived data:
                                     images per harvester, DNS names,
                                     which harvesters Rancher must import
```

- **validate**: shape and types, with field paths in errors.
- **resolve**: cross-references (`on`, `server`, `rancher`, `harvester`, `host`), profile
  requirements, OS/profile compatibility, and derived data. It produces a `ResolvedLab` that the
  Pulumi program uses directly. This step is pure TypeScript and fully unit-testable.
- **build**: one function per entry kind creates Pulumi components, passing outputs between them.

`validate` and `plan` (§3) stop after resolve.

### 7.2 Build order (dependency graph)

```
per harvester:   connection ─► base (storage class, networks, VLAN/DHCP, DNS add-on, images, keypair)
per host:        VM (Harvester) | SSH target ─► cloud-init done ─► TLS cert
                   ─► k3s/rke2 ─► kubeconfig
                   ─► profiles (rancher, hauler, mlm-server, mlm-client)
per rancher:     install ─► local cluster Ready ─► bootstrap ─► plugins, fleet
                   ─► import each harvester used by downstream (once per harvester)
per downstream:  cloud credential + machine configs ─► Cluster ─► (custom: run registration on nodes)
                   ─► Ready ─► kubeconfig
mlm:             server up ─► products synced ─► activation keys ─► clients bootstrap
```

Pulumi's dependency graph does the actual ordering; the resolver only makes sure the edges exist.

### 7.3 Interfaces between components

```ts
interface HostAccess    { name: string; fqdn: string; address: Output<string>; ssh: SshConnection; os: OsProfile }
interface ClusterAccess { name: string; kubeconfig: Output<string>; provider: k8s.Provider }
interface RancherAccess { url: Output<string>; login: RancherLoginInputs; cluster: ClusterAccess }
interface HarvesterAccess { name: string; url: string; login: RancherLoginInputs; cluster: ClusterAccess }
interface MlmAccess     { url: Output<string>; login: MlmLogin; host: HostAccess }
interface RegistryAccess { url: Output<string> }
```

Every component takes some of these and returns one. That is what makes them composable from config.

### 7.4 Pulumi resources

- **Prefer real resources** (Kubernetes objects through CRD bindings, Helm releases,
  `@pulumi/command`) wherever they cover the need.
- **No `@pulumi/rancher2`.** Rancher objects are created as Kubernetes resources on the Rancher
  cluster (generated CRD bindings) or through the Rancher API, as in `pulumi/`.
- **Dynamic providers only for real API gaps** (Harvester cloud-provider kubeconfig, image upload,
  MLM API, readiness polling), following the rules in
  `pulumi/modules/rancher/src/PROVIDER_PATTERNS.md`.
  Every dynamic provider implements `delete` properly: a lab must clean up.
- Secrets inside outputs use `additionalSecretOutputs`, as in `pulumi/`.

### 7.5 Resource naming

`naming.ts` builds every logical name from its owner: `hv-north/network/vlan100`,
`rancher/k3s/kubeconfig`, `apps/pool/workers`. Components never hard-code a name. This fixes the
collisions in today's `provisionVmOnHarvester` (`wait-cloudinit`, `vm-kubeconfig`) and
`HarvesterCloudProvider` (`harvester-cluster`, `harvester-cloud-credential`).

### 7.6 Profile registry

A profile is defined once, in `packages/schema/src/profiles/<name>.ts`, with `defineProfile`:

```ts
export const rancher = defineProfile({
    name: "rancher",
    description: "Rancher Manager on the host's Kubernetes cluster, with UI plugins and Fleet",
    settings: z.strictObject({ adminPassword: secretOrString, plugins: ..., fleet: ... }),
    requires: ["kubernetes"],          // another profile on the host must provide it
    secretFields: ["adminPassword"],   // plain text in a lab file -> warning
});
```

Rules are expressed in **capabilities**. Every profile provides its own name, plus anything in
`provides` (k3s and rke2 both provide `kubernetes`).

| Rule | Meaning | Checked by |
|---|---|---|
| `provides` | Extra capabilities the profile gives its host | — |
| `requires` | Capabilities another profile on the same host must provide; those profiles are built first | resolver, build order |
| `uses` | Capabilities used when present, not required; their providers are built first | build order |
| `conflicts` | Capabilities no other profile on the same host may provide (listing its own capability makes it "one per host") | resolver |
| `hostKinds` | Kinds of host allowed (`harvester`, `ssh`) | resolver |
| `networkFeatures` | What the host's network must have on its Harvester (`dhcp`, `loadBalancer`) | resolver |
| `osFamilies` | Allowed OS families for the host | resolver |
| `hostRefs` | Settings fields naming another host, and the capability that host must provide | resolver |
| `requiresWhen` | Like `requires`, but only when a settings field is set (`{ field: "fleet.secrets", capability: "downstream-secrets" }`) | resolver, build order |
| `secretFields` | Settings fields holding secrets (dot paths), optionally with the shape `credentials` | resolver (shape, warnings) |

All `{ $secret }` values anywhere in a profile's settings are collected automatically.

The rule checker (`profiles/rules.ts`) and the build order (`profileBuildOrder`, a topological sort
over `requires`) only read these declarations. Downstream checks use capabilities too: a custom
cluster needs a host providing `rancher`, and a custom-cluster node may not run anything that
provides or conflicts with `kubernetes`.

The **builders** live in `program/profiles.ts`, typed as `{ [N in ProfileName]: ProfileBuilder<N> }`.
A profile defined without a builder is a compile error. The program builds each host's profiles in
`profileOrder` (from the resolver) and passes the outputs of earlier profiles to later ones, keyed
by capability.

**Adding a profile**: one definition file, one line in `PROFILES`, one builder (plus its
components in a package). No changes to the resolver, the CLI or the program's main loop.

---

### 7.7 How the program reaches Harvester (M1)

- **One namespace per lab** on every Harvester it uses, named after the lab. VMs, disks, cloud-init
  secrets, networks, IP pools, the key pair and images live there. Cluster-wide pieces (the storage
  class, the DHCP add-on, the DNS controller in `harvester-system`) are the only exceptions.
- **No Harvester credentials in state.** For every run the CLI logs in (8-hour token, logged out
  afterwards) and writes a temporary kubeconfig with one context per Harvester, named after it.
  Kubernetes providers only record the context name, so `destroy` works later with a fresh login.
  `KubeValue` (a small dynamic resource that waits for fields Harvester fills in, such as a VM's IP
  address) reads the same file.
- **Isolated registry config.** Pulumi runs get empty `DOCKER_CONFIG`/`HELM_REGISTRY_CONFIG`, so
  public OCI charts don't depend on the user's Docker credential helpers.
- **Networks** are only created when a host or pool uses them or they have DHCP.
- **VM readiness** is the KubeVirt `AgentConnected` condition: the guest agent reports the IP,
  which the DNS controller needs. Every OS profile therefore installs `qemu-guest-agent`.
- **Cloud-init** does registration, repositories and packages in `runcmd`, in that order, because
  cloud-init's `packages:` module runs before `runcmd` and an unregistered SLES can't install.
  No network-data is sent: cloud-init's fallback configures DHCP on the first NIC.
- **Image uploads from local files** are not implemented yet (download URLs only).

## 8. DNS and TLS

- **DNS**: the harvester-dns-controller add-on (RouterOS backend) is installed as part of each
  Harvester base and gives every Harvester VM a record under `domain`. Physical (SSH) machines
  already have DNS records; the lab doesn't manage them.
- **TLS**: ACME with Let's Encrypt and Cloudflare DNS-01. This works for internal-only names
  because only the `_acme-challenge` TXT record is public.
  - Kubernetes hosts: cert-manager with a Cloudflare ClusterIssuer and a certificate for
    `<host>.<domain>`.
  - Hosts without Kubernetes (MLM, Hauler on systemd): `lego` installed through cloud-init gets the
    certificate for `<host>.<domain>`, with a systemd timer for renewal. MLM receives it during
    `mgradm install`.
- `tls.acme: letsencrypt-staging` switches everything to staging and marks clients insecure, like
  `cert-manager:staging` today.

---

## 9. Feature notes

### 9.1 Rancher

The `pulumi/` flow is ported as-is: Rancher Helm install, wait for the `local` Fleet cluster to be
Ready, bootstrap the admin password, UI plugins, Fleet secrets/groups/repos, optional Liz.

### 9.2 Rancher-provisioned clusters on Harvester

1. **Import the Harvester into Rancher**: a management cluster with label
   `provider.cattle.io=harvester`, then Harvester's `cluster-registration-url` setting = the
   registration URL. Once per Harvester, only when a downstream cluster uses it.
2. **Cloud credential** for that Harvester.
3. **Cloud-provider kubeconfig**: `POST /k8s/clusters/<harvester-id>/v1/harvester/kubeconfig`
   (dynamic provider). Needed for LoadBalancer and CSI support in the new cluster.
4. **`HarvesterConfig`** per pool (`rke-machine-config.cattle.io/v1`): CPU, memory, disk JSON
   (image `namespace/name`, size, storage class), network, VM namespace, SSH user, user data from
   the OS profile.
5. **`provisioning.cattle.io/v1` Cluster** with machine pools, cloud credential, labels,
   `cloud-provider-name: harvester` and the kubeconfig from step 3 as `cloud-provider-config`.
6. Wait for `Ready`; export the kubeconfig.

The `HarvesterConfig` and `Cluster` classes for steps 4–5 come from `@lab/crds` (§12).

### 9.3 Custom clusters

Same Cluster object without machine pools. Read the node command from the cluster's
`ClusterRegistrationToken`, add role flags, and run it on each node with
`@pulumi/command` `remote.Command`. On destroy, the node is cleaned up with the RKE2 uninstall
script, because an SSH host is not deleted.

### 9.4 Hauler

- `hauler store sync` from the manifests listed in the profile (files in `lab/hauler/`), then
  `hauler store serve registry` (and `fileserver` if needed).
- Systemd mode: binary, store on the VM disk, systemd unit, lego certificate.
- Kubernetes mode: deployment and PVC, ingress at `<host>.<domain>` with the host's certificate.
- Manifests are hand-written for now; generating them from a Rancher version can come later.
- A `harbor` profile can come later as a separate profile; it is not in v1.
- Syncing a full Rancher image set is large and slow; disk size is the user's responsibility.

### 9.5 Multi-Linux Manager

The subscriptions below are not available yet. They will be added as secrets (`mlm-regcode`,
`scc-org`) in the personal config when needed; this milestone is last for that reason.

1. SL Micro VM registered with SCC using the **MLM server registration code**.
2. `mgradm install podman <fqdn>` with admin password, organisation credentials, and the ACME
   certificate.
3. Add SCC **organisation mirror credentials**; sync products. `products: auto` (the default)
   syncs only what the lab's `mlm-client` hosts need (their OS profiles), to keep rebuilds short.
4. Create activation keys (one per client OS by default) and bootstrap repositories.
5. Clients bootstrap through the MLM API (salt-ssh) after products for their OS are synced.

Because a lab is always rebuilt from scratch, the channel sync is paid on every `up` (tens of
minutes to hours). Accepted for now; an external mirror can be added later.

---

## 10. Secrets, state and stacks

**Stacks are invisible.** The CLI uses Pulumi's Automation API with a `LocalWorkspace` on
`lab/program` (a regular Pulumi project rather than an inline program, which is the safer choice
with dynamic providers). For every command it:

1. loads and resolves the lab file,
2. resolves all `$secret` references,
3. logs in to the state backend,
4. creates or selects the stack named after `lab:`,
5. writes the resolved lab (non-secret) and the secret values (as Pulumi secrets) into stack config,
6. runs the requested operation and streams output.

**Personal config** `~/.config/lab/config.yaml` (path overridable with `LAB_CONFIG`) holds
everything that is per person rather than per lab:

```yaml
secrets:
  hv-north:         { username: admin, password: "cmd:pass show lab/hv-north" }
  cloudflare-token: env:CF_API_TOKEN
  ssh-key:          file:~/.ssh/id_ed25519
harvesters:
  hv-north: { url: https://hv-north.lab.geeko.me, credentials: { $secret: hv-north } }
images:
  sles-16: { file: ~/images/SLES-16.0-Minimal-VM.x86_64-Cloud.qcow2 }
os: {}                    # personal OS profiles (§6)
```

**Secret values** come only from the user's environment:

- `LAB_SECRET_<NAME>` environment variables (`LAB_SECRET_HV_NORTH`), or
- the `secrets:` section of the personal config, whose values may be literal, `env:VAR`,
  `file:path`, or `cmd:<command>` (for password managers).

`cmd:` is only allowed in the personal config, never in a lab file, so a shared lab file cannot
run commands on someone's machine. A lab file may contain literal credentials (for example a
Harvester password written inline); `validate` then warns that the file should not be shared.

**State** uses the local file backend in `~/.local/share/lab/state` by default
(`LAB_STATE_URL` to override). The passphrase comes from `PULUMI_CONFIG_PASSPHRASE` or
`PULUMI_CONFIG_PASSPHRASE_FILE` if set; otherwise the CLI creates a random one in
`~/.config/lab/passphrase` on first use and tells the user to keep it.

**Ownership guard.** Since several team members use the same Harvesters, `up` first writes a
`lab-owner` ConfigMap on each Harvester (`default` namespace) with the lab name, the user
(`git config user.email`, else `$USER`) and a timestamp. If one already exists for a different lab
or user, `up` stops and says who owns it. `destroy` removes it last. `lab release <harvester>`
removes a stale guard by hand.

---

## 11. Teardown guarantees

`destroy` must leave every Harvester as clean as before `up`. That means:

- No `retainOnDelete` on anything that lives on a Harvester (add-ons, networks, IP pools, images,
  storage classes, key pairs, settings, the DNS controller). Defaults are reversed compared with
  `pulumi/`'s `HelmApp`.
- **Downstream VMs first.** Each downstream cluster deletion waits until Rancher reports its
  machines gone *and* no VMs with its labels remain on the Harvester. Only then may Rancher itself
  go.
- **Harvester import is undone**: reset `cluster-registration-url` and remove the Rancher agent
  (`cattle-system` on the Harvester). To be verified in M3: whether resetting the setting is enough.
- Images are deleted only after all VMs using them.
- **Nothing on a lab VM's cluster is deleted one by one.** Everything installed on a VM's
  Kubernetes (charts, Rancher, its settings and plugins) is `deletedWith` the VM: deleting the VM
  removes it all. Uninstalling Rancher piece by piece is slow, and its `rancher-post-delete` job
  can fail and block the whole teardown. Clusters on existing (ssh) machines don't get this; their
  resources are removed normally.
- SSH hosts are restored as far as possible (k3s/RKE2 uninstall scripts, MLM client removal).
  Packages installed on them are not removed.
- A `lab destroy --check` command lists anything still left on each Harvester (VMs, volumes,
  networks, images not present before), to catch leaks during development.

---

## 12. Toolchain and quality

- `lab/mise.toml`: node, pnpm, pulumi (as in `pulumi/mise.toml`), plus the tasks `lab` (the CLI,
  run from the caller's directory so relative lab paths work), `test` and `typecheck`.
- TypeScript is pinned to 5.9: Pulumi's TypeScript runtime (ts-node) doesn't support TypeScript 7.
- TypeScript, strict mode, pnpm workspace. Packages are consumed as source; `pnpm -r typecheck`
  runs `tsc --noEmit` everywhere.
- **Tests**
  - `schema`: unit tests for validation and resolution, using the four example labs plus broken
    variants (missing references, profile requirements, unknown OS).
  - Components: Pulumi unit tests with mocks to check generated resources and names.
  - CI-friendly: `lab validate labs/*.yaml` must pass for every example.
- CRD bindings are generated with crd2pulumi, as in `pulumi/`, but into one package
  (`packages/crds`, `mise run crds`) rather than per package: Harvester, Rancher and cert-manager
  kinds are used across packages. Every Kubernetes object of a CRD kind uses a generated class,
  never a bare `CustomResource`. The sources are taken from the clusters the lab runs against.

---

## 13. Reference labs

These four go into `lab/labs/` and act as acceptance tests for the design. Harvester and TLS
sections are left out for brevity.

**1. Rancher + MLM + air-gap registry**

```yaml
lab: rancher-mlm-airgap
hosts:
  rancher:  { on: hv-north, os: leap-16,      cpu: 4, memory: 16Gi, disk: 100Gi, profiles: { k3s: {}, rancher: {} } }
  mlm:      { on: hv-north, os: sl-micro-6.1, cpu: 4, memory: 16Gi, disk: 300Gi, profiles: { mlm-server: {} } }
  registry: { on: hv-north, os: leap-16,      cpu: 2, memory: 4Gi,  disk: 200Gi, profiles: { hauler: { manifests: [rancher-2.15] } } }
```

**2. Rancher provisioning RKE2 on Harvester, labelled for Fleet**

```yaml
lab: rancher-harvester-rke2
hosts:
  rancher: { on: hv-north, os: leap-16, cpu: 4, memory: 16Gi, disk: 100Gi,
             profiles: { k3s: {}, rancher: { fleet: { groups: { demo: { env: demo } } } } } }
downstream:
  apps:
    type: harvester
    rancher: rancher
    harvester: hv-north
    distro: rke2
    labels: { env: demo }
    pools:
      - { name: all, quantity: 3, roles: [etcd, controlplane, worker], cpu: 4, memory: 8Gi, disk: 60Gi, os: sles-16 }
```

**3. MLM managing four Linux distributions**

```yaml
lab: mlm-multi-os
hosts:
  mlm:      { on: hv-north, os: sl-micro-6.1, cpu: 4, memory: 16Gi, disk: 400Gi, profiles: { mlm-server: {} } }
  sles-01:  { on: hv-north, os: sles-16,      cpu: 2, memory: 4Gi,  disk: 40Gi,  profiles: { mlm-client: { server: mlm } } }
  ubuntu-01:{ on: hv-north, os: ubuntu-24.04, cpu: 2, memory: 4Gi,  disk: 40Gi,  profiles: { mlm-client: { server: mlm } } }
  rocky-01: { on: hv-north, os: rocky-9,      cpu: 2, memory: 4Gi,  disk: 40Gi,  profiles: { mlm-client: { server: mlm } } }
  leap-01:  { on: hv-north, os: leap-16,      cpu: 2, memory: 4Gi,  disk: 40Gi,  profiles: { mlm-client: { server: mlm } } }
```

**4. Rancher + custom cluster on a physical machine**

```yaml
lab: rancher-custom-edge
hosts:
  rancher: { on: hv-north, os: leap-16, cpu: 4, memory: 16Gi, disk: 100Gi, profiles: { k3s: {}, rancher: {} } }
  nuc-01:  { on: ssh, address: nuc-01.lab.geeko.me, user: root, os: sles-16 }
downstream:
  edge:
    type: custom
    rancher: rancher
    distro: rke2
    labels: { env: edge }
    nodes: [{ host: nuc-01, roles: [etcd, controlplane, worker] }]
```

---

## 14. Milestones

| # | Scope | Done when |
|---|---|---|
| M0 | `lab/` skeleton: mise, workspace, CLI (`validate`, `plan`, `preview`, `up`, `destroy`, `outputs`), schema + resolver with tests, secrets, ownership guard | `validate` passes on the four example labs; `up` of an empty lab works |
| M1 ✅ | Harvester base (per-lab, derived images), Harvester hosts, OS profiles, DNS, unique naming | Plain VMs on one Harvester; `destroy --check` is clean. Deferred: a lab across two Harvesters (advanced), uploading local image files, host TLS with lego (moves to the first profile that needs it, M5/M6) |
| M2 🟡 | SSH access, `k3s`/`rke2`, cluster TLS (cert-manager + Let's Encrypt), `rancher` (plugins, Fleet, Liz) | See §14.1. Done on asgard with k3s and RKE2, including clean teardown; open: a run with `letsencrypt` (production) and with the Fleet secrets |
| M3 | Harvester import per harvester, `downstream.type: harvester`, cloud-provider config, labels → Fleet groups, teardown ordering | Reference lab 2 builds and destroys cleanly |
| M4 | SSH hosts, `downstream.type: custom`, node cleanup | Reference lab 4 |
| M5 | `hauler` (systemd and Kubernetes modes), manifests | Registry part of reference lab 1 |
| M6 | `sl-micro-6.1`, `ubuntu-24.04`, `rocky-9`; `mlm-server`, `mlm-client` | Reference labs 1 and 3 |
| M7 | Docs for lab authors (`lab/README.md`), more examples, `AGENTS.md` | Someone new can write a lab without reading TypeScript |

---

### 14.1 M2 — Rancher on a lab VM

**Goal**: a lab file with one Harvester VM carrying `k3s` + the app profiles + `rancher` gives a
working Rancher at `https://rancher.<host>.<domain>` with a trusted wildcard certificate, UI
plugins and Fleet, and destroys cleanly. That is `pulumi/setups/sample-setup` minus the Harvester
import, which belongs with Rancher-provisioned clusters in M3.

**Separation.** Every app is its own profile and its own component; Rancher only consumes what
they provide (§5.4):

```
packages/kubernetes   k3s/RKE2 cloud-init, kubeconfig over SSH -> ClusterAccess, HelmApp
packages/apps         CertManager, Sprouter, Traefik, Outrider (each: ClusterAccess in, outputs out)
packages/rancher      RancherServer, bootstrap, UI plugins, Fleet (consumes ClusterAccess + app outputs)
```

Profile builders get two phases: `cloudInit` (contributions to the VM's cloud-init, e.g. the k3s
install, before the VM exists) and `build` (resources after it is up).

**Work items**

1. **SSH access to hosts.** A `HostAccess` per host (address, user, private key from
   `ssh.privateKey`). `@pulumi/command` waits for `cloud-init status --wait` over SSH and fails
   with the tail of `cloud-init-output.log` when cloud-init failed. Works for Harvester VMs and
   `ssh` hosts alike.
2. **`k3s` / `rke2`.** Installed from cloud-init with the pinned version, the built-in ingress
   disabled (Traefik is its own profile), firewall ports opened for the `suse` and `rhel`
   families, and the OS profile's `k8s.packages`. The kubeconfig is read over SSH, its server
   rewritten to the host's address, and kept as a Pulumi secret: the one credential in state,
   encrypted, gone with the lab.
3. **`cert-manager`.** Chart, Cloudflare token secret, ClusterIssuers `letsencrypt-prod` and
   `letsencrypt-staging`, and the wildcard certificate (`tls.acme` picks the issuer) labelled
   `sprouter.geeko.me/enabled`.
4. **`sprouter`**, **`traefik`** (Gateway API CRDs first), **`outrider`**: as in `pulumi/` today.
5. **`rancher`.** Rancher Prime chart with the Traefik ingress and the propagated wildcard secret,
   `server-url`, the `harvester-baremetal-container-workload` feature, wait for the `local` Fleet
   cluster to be Ready, bootstrap the admin password. Produces `RancherAccess`.
6. **Plugins and Liz** inside the `rancher` profile (they are Rancher extensions).
7. **Fleet** inside the `rancher` profile: the Fleet secrets named explicitly under
   `fleet.secrets` (appco and scc as credentials, the observability license as a string),
   ClusterGroups from `fleet.groups`, GitRepos (`default` = today's `lab-setup-*` repos).
8. **Versions** of everything in `program/versions.ts`, overridable per lab.
9. **Profile rules**: `requiresWhen` and shaped `secretFields` (credentials), with tests.

**Done when**

- `labs/asgard-m2.yaml` comes up with `tls.acme: letsencrypt-staging` during development and
  `letsencrypt` for the final run (Let's Encrypt allows 5 certificates per week for the same
  names); Rancher answers at `rancher.<host>.<domain>`; the admin password logs in; plugins are
  installed; the Fleet GitRepos exist and the `local` cluster is Ready.
- The same lab with `rke2` instead of `k3s` comes up.
- `lab destroy` followed by `lab destroy --check` is clean.

**Not in M2**: importing Harvester into Rancher, downstream clusters (M3, M4), HA Rancher,
profile bundles (a shorthand for "the Rancher stack"; possible later, as data).

## 15. Decisions and open questions

Decided:

- **Users write YAML only.** TypeScript and Pulumi are the engine; lab authors never touch them.
- **Team use.** Other team members run labs too: shared lab files, personal config for endpoints,
  credentials and image paths, an ownership guard on each Harvester, and clear validation errors
  and author docs are first-class requirements, not polish.
- **Secrets** from env vars or the personal config (§10).
- **Rancher is single-node**: the `rancher` profile attaches to one host.
- **MLM subscriptions** are added to the personal config as secrets when MLM work starts.
- **No `@pulumi/rancher2`** (§7.4).
- **Images** from a download URL or a local file (§6).
- **Harvester `url`/`credentials`** in the lab file or the personal config (§5.2).
- **DNS**: every Harvester VM gets a record; physical machines already have one.
- **DHCP and DNS add-ons always**; VLANs optional. Harvester 1.8 and newer.
- **Hauler manifests** are hand-written.

- **OS profiles are YAML**, extensible from the personal config and the lab file (§6).
- **DHCP on the untagged network is optional** (§5.2).

Still open (doesn't block M0–M2):

1. **Extra hostnames on a host** (for example several ingress names on one k3s VM). Today every
   host gets exactly one name; if a profile needs more, we need to know whether the DNS controller
   can create extra or wildcard records.
