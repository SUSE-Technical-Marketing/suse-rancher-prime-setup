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
  Harvester clusters and metal clusters on existing machines; Hauler; Multi-Linux Manager server + clients.

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
  catalog/                  # built-in defaults as data (§16): components/, plugins.yaml, secrets/, fleet/, os/ (§6)
  labs/                     # example lab files (the four reference labs, §13)
  hauler/                   # Hauler manifests referenced by labs (e.g. rancher-2.15.yaml)
```

Packages are consumed as TypeScript source: no `main: bin/...`, so there is no stale build output
(the problem fixed in `pulumi/` earlier).

---

## 5. Lab file reference

> **File format (§17).** The examples here show a lab in the compact, single-map form. In a lab
> file the lab-wide fields are the `Lab` document's `spec`, and each entry under `harvesters`,
> `hosts` and `downstream` is a `Harvester`, `HarvesterVM` (`harvester:` instead of `on:`),
> `Machine` (`on: ssh`) or `DownstreamCluster` document. See `lab/labs/` for real files.

### 5.1 Top level

```yaml
lab: rancher-airgap            # unique name; also the Pulumi stack name
domain: lab.geeko.me           # base DNS domain for every host
tls:
  acme: letsencrypt            # an AcmeServer (letsencrypt, letsencrypt-staging) or none
  email: me@example.com
  cloudflare: "{{ secrets.cloudflare.token }}"

ssh:                           # default login installed on every VM
  user: jeroen
  publicKey: { file: ~/.ssh/id_ed25519.pub }
  privateKey: "{{ secrets['ssh-key'] }}"

catalog:                       # optional overrides of the engine's defaults (§16)
  components:
    rancher: { version: v2.15.2 }
    k3s: { version: v1.36.4+k3s1 }

harvesters: { ... }            # §5.2
hosts: { ... }                 # §5.3
downstream: { ... }            # §5.5
os: { ... }                    # optional extra/overridden OS profiles, §6
images: { ... }                # optional image sources per OS, §6
```

**Secrets are templates.** Anywhere a secret is accepted, the value is a Jinja2 template over the
personal config's `secrets` (§10): `"{{ secrets.appco }}"`, or with brackets for a name with a dash,
`"{{ secrets['ssh-key'] }}"`. A secret can be a map: one holding a username and password is used
whole where a field takes credentials (`credentials: "{{ secrets.harbor }}"`), or by field
(`"{{ secrets.scc.password }}"`); AWS keys are a map with `accessKey` and `secretKey`
(`credentials: "{{ secrets.aws }}"` on an AwsSite, or `"{{ secrets.aws.accessKey }}"`). A path goes
deeper into nested maps: `"{{ secrets.cloudflare.tunnel.token }}"` for a field, or
`credentials: "{{ secrets.infra.harvester }}"` for a map inside one. Text around it is fine (`"Bearer {{ secrets.token }}"`). The lab file only names secrets; values come from the
user's environment (§10).

`validate` renders each template against placeholders: that checks it and finds which secrets it
uses, and how, so `lab plan` can list them with their shape (a secret used whole is a string; one
used by field is a map with at least those fields, credentials when they're `username` and
`password`; both at once is an error). The CLI checks a map secret has every field the lab uses,
and only those fields travel on to the program. The CLI resolves those
values, and the program renders the templates with them; whatever comes out stays a Pulumi
secret. A plain value in a secret field works, with a warning in a lab file. Templates using
`secrets` are allowed in secret fields, in profile settings (chart values), in catalog inputs and
in OS profiles' `cloudInit`; other strings that aren't templates are left alone. Non-secret file
contents can be pulled in with `{ file: <path> }`.

### 5.2 Harvesters

```yaml
harvesters:
  hv-north:
    url: https://hv-north.lab.geeko.me
    credentials: "{{ secrets['hv-north'] }}"      # { username, password }
    clusterNetwork: mgmt                    # default: the catalog's Defaults (§17)
    storageClass:                           # created by the lab; merged over the Defaults
      name: longhorn-single
      replicas: 1
      parameters: { staleReplicaTimeout: "30", migratable: "true" }   # Longhorn parameters
    dns:                                    # harvester-dns-controller, always installed
      backend: routeros
      host: 10.29.100.1
      credentials: "{{ secrets.routeros }}"
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
    os: leap-16-k8s              # OS profile (§6); the -k8s variant for k3s / RKE2 hosts
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
    os: sles-16-k8s              # what's installed; its packages and runcmd run over SSH
    profiles: {}                 # used as a metal-cluster node in downstream.edge
```

- `cpu`, `memory`, `disk` of a Harvester host (and of a downstream pool) default to the catalog's `Defaults` (`vm`: 4 CPUs, 8Gi, 40Gi). There are no size presets.
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
| `k3s` | provides `kubernetes`; one `kubernetes` per host; fallback `load-balancer` and `ingress` (its own ServiceLB and Traefik) | `version` | `ClusterAccess`; its Traefik is the ingress unless the `traefik` profile is on the host |
| `rke2` | provides `kubernetes`; one `kubernetes` per host; fallback `load-balancer` and `ingress` (its own ServiceLB and Traefik, which runs on the node's host ports) | `version` | `ClusterAccess`; as k3s |
| `harvester-cloud-provider` | requires `kubernetes`; provides `load-balancer` and `cloud-provider`; Harvester VMs only; the host's network needs a `loadBalancer` pool | `version` | Harvester cloud provider (+ kube-vip) in the guest cluster; k3s/RKE2 then run without ServiceLB and with an external cloud provider |
| `metallb` | requires `kubernetes`; provides `load-balancer` | `addresses` (required), `version`, `values` | MetalLB in L2 mode with one address pool; k3s/RKE2 then run without ServiceLB. For machines and VMs without a cloud provider |
| `cert-manager` | requires `kubernetes`; provides `tls` | `version` | ClusterIssuers (Let's Encrypt prod + staging, Cloudflare DNS-01) and a wildcard certificate for `<host>.<domain>` + `*.<host>.<domain>`, labelled for Sprouter |
| `sprouter` | requires `kubernetes`; provides `secret-propagation` | `version` | Copies labelled secrets (the wildcard certificate) into every namespace |
| `traefik` | requires `kubernetes`; uses `load-balancer`; provides `ingress` (replacing the distribution's own Traefik) | `version`, `gatewayApi` | Gateway API CRDs + Traefik with its Gateway provider |
| `outrider` | requires `kubernetes`; provides `downstream-secrets` | `version` | Propagates annotated secrets to downstream clusters |
| `rancher` | requires `kubernetes`, `ingress`, `tls`, `secret-propagation`; uses `downstream-secrets` (a Fleet secret can need it, §16.3); secret `adminPassword` | `version`, `hostname`, `adminPassword`, `plugins`, `liz`, `fleet`, `values`, `settings` (Rancher settings by name; `server-url` is the engine's), `features` (feature flags, merged over the default `harvester-baremetal-container-workload: true`) | `RancherAccess` |
| `hauler` | provides `registry` (uses Kubernetes if the host has it, otherwise systemd) | `manifests`, `port` | `RegistryAccess` |
| `mlm-server` | OS family `suse`; conflicts with `kubernetes` and `mlm-client`; secret `adminPassword` | `version`, `adminPassword`, `products` | `MlmAccess` |
| `mlm-client` | `server` must name a host running `mlm-server` | `server`, `activationKey` | — |
| `ai-factory` | requires `rancher`; secrets `applicationCollection`, `suseRegistry` (credentials), `nvidia` | `version`, `applicationCollection` (required), `suseRegistry` (required; SCC), `nvidia` (the NGC API key), `values` | SUSE AI Factory on Rancher's cluster: the `aif-operator` chart, which installs the `aif-ui` extension and gets the registry logins as values, so its Settings need no Test and Apply |

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
    adminPassword: "{{ secrets['rancher-admin'] }}"
    fleet:
      secrets:
        appco: "{{ secrets.appco }}"
        scc: "{{ secrets.scc }}"
        suse-observability-license: "{{ secrets['suse-observability-license'] }}"
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

Every type needs a host with the `rancher` profile. Rancher creates them all; the engine never
imports a cluster it didn't make (k3k clusters are imported, but the engine makes those too).

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
        os: sles-16-k8s
        network: vlan100
      - name: workers
        quantity: 2
        roles: [worker]
        cpu: 4
        memory: 16Gi
        disk: 100Gi
        os: sles-16-k8s
```

**On EC2** — Rancher creates the machines through its Amazon EC2 node driver, in the lab's VPC on
an AWS site (§5.6), with the site's keys as its cloud credential:

```yaml
downstream:
  cloud:
    type: ec2
    rancher: rancher             # must be public: the machines register over the internet
    site: aws-eu                 # an AwsSite of this lab
    distro: rke2
    pools:
      - name: control
        quantity: 1
        roles: [etcd, controlplane]
        instanceType: t3.large   # default: Defaults aws.instanceType
        disk: 60Gi               # root volume (gp3); default: Defaults vm.disk
        os: ubuntu-24.04-k8s     # an OS profile with an ami
        zone: a                  # default: the site's first zone
      - name: workers
        quantity: 2
        roles: [worker]
        instanceType: m6i.xlarge
        os: ubuntu-24.04-k8s
        zone: b
```

The machines get the same user data as Harvester pools (the OS profile's cloud-config, the lab's
login, the helm Job watch on servers); the node driver logs in as the AMI's user with a key pair it
makes per machine. They run in the site's security group with public addresses, IMDSv2 only, and
carry the lab's tags. An OS profile's AMI is looked up in the site's region on first use (the newest
matching one) and kept: a new AMI release doesn't replace the pool's machines. No AWS cloud
provider yet, so LoadBalancer Services get no load balancer.

**On EKS** — Rancher creates and manages the EKS cluster itself (a hosted cluster), in the lab's
VPC on an AWS site, with the same cloud credential:

```yaml
downstream:
  eks:
    type: eks
    rancher: rancher             # must be public: the cluster agent registers over the internet
    site: aws-eu                 # an AwsSite of this lab, with two zones at least
    version: "1.34"              # an EKS minor; default: Defaults aws.eksVersion
    publicAccessSources: [ 203.0.113.0/24 ]   # who may reach the EKS API directly; default anyone
    logging: [ audit ]           # control plane logs to CloudWatch; default none
    nodeGroups:
      - name: general
        quantity: 2              # nodes it starts with
        max: 4                   # it scales between min and max; both default to quantity
        instanceType: t3.large   # default: Defaults aws.instanceType; Graviton types get arm64
        disk: 60Gi               # default: Defaults vm.disk
        zones: [ a, b ]          # by letter; default all of the site's
        labels: { tier: general }
```

The engine creates the cluster the way Rancher's UI does: a management cluster (`/v3/clusters`)
with an `eksConfig`, which Rancher's eks-operator turns into the EKS cluster (public and private
API endpoint, the EBS CSI add-on, the lab's tags) and managed node groups (the lab's tags on their
instances and volumes) in the site's subnets. Rancher makes the IAM roles both need, as
CloudFormation stacks named after the cluster (`<name>-eks-service-role`, `-node-instance-role`,
`-ebs-csi-driver-role`), and a launch template `rancher-managed-lt-<name>`; it deletes all of them
when the cluster goes. EKS makes the cluster's security group. The nodes run EKS's own image: no
OS profile, no lab login, no SSH key. The engine waits until Rancher reports the cluster active
(`timeouts.downstreamReady`), then talks to it through Rancher's proxy with a token from Rancher's
`generateKubeconfig`. Node group sizes, the version and the tags change in place; the site, its
subnets and the name make another cluster. EKS names clusters per account and region, so two labs
sharing a site can't both have an EKS cluster with the same name: the eks-operator refuses the
second.

The account's keys need what Rancher's EKS docs list beyond EC2: EKS, CloudFormation, IAM roles
and instance profiles (create, pass, delete), launch templates, and KMS only for secrets
encryption (off).

**Not tried against AWS yet.** The schema, the program and the UI are done and tested under
mocks; the first real `up` waits for a public Rancher. To check then: that the management
cluster's labels reach its Fleet cluster (`fleet.groups` selectors), how long the
`generateKubeconfig` token lives (Rancher's `kubeconfig-default-token-ttl-minutes`), whether k3k
needs a default StorageClass set on EKS (EKS marks none default), and the update path.

**Reachability.** EC2 machines and EKS clusters reach Rancher over the internet, so `validate`
rejects an `ec2` or `eks` cluster whose Rancher host doesn't provide `public-ingress`. No profile
does yet: that's the Cloudflare tunnel operator's `public-ingress` profile, still to come. Until
then they can be validated and previewed only with a stub profile (the tests do this).

**Metal** — Rancher installs Kubernetes on the lab's own hosts (what Rancher calls a custom
cluster: it doesn't create the machines, the lab supplies them):

```yaml
downstream:
  edge:
    type: metal
    rancher: rancher
    distro: rke2
    labels: { env: edge }
    nodes:
      - host: nuc-01             # an `ssh` host, or a Harvester host with no k8s profile
        roles: [etcd, controlplane, worker]
```

**k3k** — a virtual cluster inside another downstream cluster of the same Rancher, imported into
Rancher the way its UI does it:

```yaml
downstream:
  team-blue:
    type: k3k
    rancher: rancher
    parent: apps                 # a harvester or metal cluster of this lab
    mode: shared                 # shared (its workloads are pods of the parent) | virtual (own nodes, as pods) | hcp
    servers: 1
    agents: 0
    version: v1.33.1-k3s1        # default: the parent's Kubernetes version
    namespace: k3k-team-blue     # on the parent; the default
    persistence: { type: dynamic, size: 5Gi }   # etcd on a PVC of the parent's default StorageClass, or type: ephemeral
    labels: { team: blue }
```

The engine installs the k3k operator (the `k3k` HelmChart in the catalog) on every parent, once
however many k3k clusters run in it. Per cluster it creates the `k3k.io` Cluster on the parent
and waits for it, a `provisioning.cattle.io` Cluster without a spec (an imported cluster) whose
`ui.rancher/*` annotations make Rancher's UI show it as k3k under its parent, and a Job on the
parent that applies Rancher's import manifest with the virtual cluster's kubeconfig (its server is
a Service only reachable from inside the parent; the Job's image is the Defaults `images.kubectl`).
Then it waits for Ready, like the other clusters. On destroy the Rancher cluster goes first, then
the k3k Cluster and its namespace; when the parent goes too, what's on it goes with it.

`labels` and `annotations` are set on the `provisioning.cattle.io` Cluster. Rancher copies them to
the Fleet cluster, so `fleet.groups` selectors match the labels and a `fleet.yaml` reads both
(`.ClusterLabels`, `.ClusterAnnotations`; the apps use `hosted-domain`).

### 5.6 AWS sites

An `AwsSite` is an AWS account and region Rancher creates machines in. The lab gets a VPC of its
own there; nothing is claimed, so several labs (and people) can share an account.

```yaml
apiVersion: lab.geeko.me/v1alpha1
kind: AwsSite
metadata: { name: aws-eu }
spec:
  region: eu-west-1                         # or from the personal config (awsSites.aws-eu.region)
  credentials: "{{ secrets.aws }}"          # a map secret with accessKey and secretKey, or { accessKey, secretKey }
  vpc: { cidr: 10.100.0.0/16 }              # default: Defaults aws.vpcCidr
  zones: [ a, b ]                           # default: Defaults aws.zones
  ttl: 8h                                   # tagged as lab.geeko.me/expires; nothing enforces it
```

The engine creates the VPC, an internet gateway, a route table with the default route, a public
subnet per zone (a sixteenth of the VPC each: `10.100.0.0/20` in `a`, `10.100.16.0/20` in `b`,
tagged for Kubernetes load balancers) and the security group the machines run in, `<lab>-nodes`:
everything between the lab's machines, SSH (Rancher's node driver sets machines up over SSH, from
wherever Rancher runs), HTTP and HTTPS in; everything out. Pick `zones` for a region where the
account lacks `a` or `b`.

Everything is tagged `lab.geeko.me/lab`, `lab.geeko.me/site` and `lab.geeko.me/owner` (who ran
`up`), and with a `ttl`, `lab.geeko.me/expires` (from when the lab was first created). Rancher's
machines carry the same tags, through the node driver, and EKS clusters and their node groups
through the eks-operator. A site no `ec2` or `eks` cluster uses is a warning: its VPC is still
created.

---

## 6. OS profiles

OS profiles are **data, not code**. Each is a YAML document holding the VM's whole cloud-config;
adding an OS, or a variant of one, never needs TypeScript. Only the families (how an existing
machine installs packages over SSH) are code, in `packages/os`.

```yaml
# lab/catalog/os/sles-16.yaml
kind: OperatingSystem
metadata: { name: sles-16, description: SUSE Linux Enterprise Server 16.0 }
spec:
  family: suse                     # suse (zypper) | rhel (dnf) | debian (apt): for Machines
  image:
    url: null                      # no public download; needs an images: entry (below)
  defaultUser: sles                # the image's built-in user, disabled by cloud-init
  cloudInit:                       # the VM's cloud-config
    bootcmd:                       # before cloud-init installs packages; once, on the first boot
      - cloud-init-per once register suseconnect --regcode '{{ secrets["scc-regcode-sles"] }}'
    package_update: true
    packages: [curl, vim, qemu-guest-agent]
    runcmd:
      - systemctl enable --now qemu-guest-agent
```

The engine only adds what depends on the host: the login (the lab's ssh user and key) and the
hostname. The host's own commands (the distribution install, the profiles' commands) are appended
to the profile's `runcmd`. A profile can't set the login or hostname keys (`users`,
`system_info`, `ssh_authorized_keys`, `hostname`, `fqdn`, ...): `validate` rejects them.

Strings in `cloudInit` can be Jinja2 templates (as in §17), with `secrets` (as everywhere, §5.1)
and `lab` (`name`, `domain`). Registration is such a template: a `bootcmd`, because bootcmd runs
before cloud-init installs `packages` and an unregistered SLES can't install anything, with
`cloud-init-per once` so it runs on the first boot only. `validate` renders the templates with
placeholders, so an unknown name is an error and the secrets they use are needed by the lab; the
program renders them with the values, and the user data is a Pulumi secret. Shell such as `${x%.*}` or `%{VERSION}` is left alone: only `{{` and `{%`
start a template (`{% raw %}` keeps one literal).

**Variants are profiles.** Kubernetes nodes need more than a plain VM, so each OS has a `-k8s`
variant (`leap-16-k8s`, `sles-16-k8s`, `rocky-9-k8s`, `ubuntu-24.04-k8s`) with the SELinux policy
and Longhorn's needs (iSCSI, NFS, cryptsetup, `iscsid` started), and turns firewalld off, as the
k3s and RKE2 docs advise (it conflicts with their CNIs and blocks the API and ingress); the plain
profiles start it on the first boot, so a VM behaves the same before and after a reboot. Use it for every host that runs
k3s or RKE2, every downstream pool, and every node of a metal cluster; nothing picks it for you.
The SUSE variants also swap a minimal image's `kernel-default-base` (Leap 16 Minimal-VM) for the
`kernel-default` of the same version: only that has `iscsi_tcp`, and the same version means the
running kernel finds it without a reboot. If the repositories no longer have that version,
cloud-init says so and Longhorn can't attach volumes until the VM runs a full kernel.

**Existing machines** get no user data. A `Machine` gets its profile's `packages` (with the
family's package manager) and `runcmd` over SSH; any other cloud-config key only applies to VMs,
and `validate` warns about it.

**Where profiles come from**, later sources winning:

1. built-in: `lab/catalog/os/*.yaml` (initially `leap-16`, `sles-16`, `sl-micro-6.1`,
   `ubuntu-24.04`, `rocky-9`),
2. the personal config's `catalog.os:` section,
3. the lab file's `catalog.os:` section.

OS profiles are one section of the catalog (§16).

An entry with `extends: <name>` starts from another profile. Its own fields win, and its
`cloudInit` is merged into the parent's: lists (`packages`, `runcmd`, ...) are joined, parent
first; maps are merged; other values are replaced. A variant with extra packages:

```yaml
catalog:
  os:
    sles-16-dev:
      extends: sles-16
      cloudInit: { packages: [git, make] }   # added to sles-16's
```

A variant without an `image` of its own boots its parent's: Harvester images and `images:`
entries go by the name of the profile that sets the image, so `leap-16` and `leap-16-k8s` share
one download and `images.sles-16` serves `sles-16-k8s` too.

Layers are different from `extends`: a profile of the same name in the personal config or lab
file replaces the built-in one's fields whole (its `cloudInit` too).

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
per downstream:  cloud credential + machine configs ─► Cluster ─► (metal: run registration on nodes)
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

A profile is data: a `Profile` document in `lab/catalog/profiles/` (§16.10, §17). It names the
HelmChart or KubernetesDistribution it installs:

```yaml
# lab/catalog/profiles/rancher.yaml (excerpt)
apiVersion: lab.geeko.me/v1alpha1
kind: Profile
metadata:
  name: rancher
  description: Rancher Manager on the host's Kubernetes cluster, with UI plugins and Fleet
spec:
  charts:                                                   # what it installs, in order
    - chart: rancher                                        # the first chart is its own
      namespace: cattle-system
      values: { global: { cattle: { psp: { enabled: false } } } }   # defaults; the lab's `values` merge over them
      lockedValues:                                         # merged last; a lab can't set them
        replicas: 1
        hostname: "{{ settings.hostname }}.{{ host.fqdn }}" # Jinja2, rendered per host by the resolver
        ingress: { tls: { source: secret, secretName: "{{ outputs.tls.secretName }}" } }
    - chart: rancher-ai-agent                               # Liz, only when the liz setting is on
      namespace: cattle-ai-agent-system
      when: "{{ settings.liz | default(false) }}"
  requires: [kubernetes, ingress, tls, secret-propagation]   # another profile on the host provides each
  uses: [downstream-secrets]
  secretFields: [adminPassword]                             # plain text in a lab file -> warning
  settings:                                                 # JSON Schema; $ref names a lab type
    type: object
    required: [adminPassword]
    properties:
      hostname: { $ref: dnsLabel, default: rancher }
      adminPassword: { $ref: secretOrString }
```

Rules are expressed in **capabilities**. Every profile provides its own name, plus anything in
`provides` (k3s and rke2 both provide `kubernetes`).

| Rule | Meaning | Checked by |
|---|---|---|
| `provides` | Extra capabilities the profile gives its host | — |
| `fallback` | Capabilities it provides itself only when no other profile on the host does: k3s's and RKE2's own ServiceLB (`load-balancer`) and Traefik (`ingress`). Each host's `providers` says who provides what; a replaced fallback's `outputs` don't apply, and its KubernetesDistribution's `withCapability` turns it off | resolver, program |
| `requires` | Capabilities another profile on the same host must provide; those profiles are built first | resolver, build order |
| `uses` | Capabilities used when present, not required; their providers are built first | build order |
| `conflicts` | Capabilities no other profile on the same host may provide (listing its own capability makes it "one per host") | resolver |
| `hostKinds` | Kinds of host allowed (`harvester`, `ssh`) | resolver |
| `networkFeatures` | What the host's network must have on its Harvester (`dhcp`, `loadBalancer`) | resolver |
| `osFamilies` | Allowed OS families for the host | resolver |
| `hostRefs` | Settings fields naming another host, and the capability that host must provide | resolver |
| `requiresWhen` | Like `requires`, but only when a settings field is set | resolver, build order |
| `secretFields` | Settings fields holding secrets (dot paths), optionally with the shape `credentials` | resolver (shape, warnings) |
| `charts` | What the profile installs, in order, each after the one before: entries with a `chart` (and `namespace`, `values`, `lockedValues`) or a `manifest` (and `vars` for its URL placeholders), each with an optional `when` and `version`. The first chart is the profile's own: the lab's `values` and the `version` setting go to it, and the leaves of its `lockedValues` are protected. Entries before it are installed before its builder runs, entries after it once the builder's work is ready | resolver (renders), program |
| `outputs` | Data other profiles on the host can use in their templates, by capability this profile provides (`tls: { secretName: wildcard-cert }`); only from the profile actually providing it on the host | resolver |
| `settings` | The settings under `profiles.<name>`: a JSON Schema object (subset; `required` inside it) | resolver |

Strings using `secrets` anywhere else in a profile's settings (chart values) are collected too, as string secrets.

The rule checker (`profiles/rules.ts`) and the build order (`profileBuildOrder`, a topological sort
over `requires`) only read these declarations, from the registry the catalog builds. Downstream
checks use capabilities too: a metal cluster needs a host providing `rancher`, and a
metal-cluster node may not run anything that provides or conflicts with `kubernetes`. Resolved
hosts carry their capabilities, so the program never needs the registry.

The **builders** live in `program/profiles.ts`, typed against `ProfileSettings`, which is generated
from the catalog (`program/generated/profile-settings.ts`, `mise run profile-types`): a builder
reading a setting its profile doesn't declare is a compile error, and a test fails when the
generated file is out of date. Only profiles that need code have a builder, for real wiring: k3s,
RKE2, Rancher (bootstrap, plugins, Fleet, staging CA), cert-manager (issuers, certificate), Traefik
(Gateway API CRDs), the cloud provider (its kubeconfig secret). No builder sets chart values. A profile that only installs
its chart (Sprouter, Outrider) has none: the generic chart builder installs it once the profiles it
requires or uses are ready, with its Profile document's namespace and values, and reports the
release as the `ready` of each of its capabilities. A test checks that every profile has a builder
or a chart. The program builds each host's profiles in
`profileOrder` (from the resolver) and passes the outputs of earlier profiles to later ones, keyed
by capability.

**Adding a profile**: a `Profile` document in `lab/catalog/profiles/` and `mise run profile-types`.
A profile that only installs charts or manifests needs nothing else (its HelmChart documents and
its Profile's `charts` say it all, Kubewarden's three charts included); one with real wiring also gets
a builder (plus its components in a package). No changes to the resolver, the CLI or the
program's main loop.

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
- **Cloud-init** is the OS profile's cloud-config (§6). SLES registration is the profile's once-only `bootcmd`,
  because cloud-init's `packages:` module runs before `runcmd` and an unregistered SLES can't install.
  No network-data is sent: cloud-init's fallback configures DHCP on the first NIC.
- **Image uploads from local files** are not implemented yet (download URLs only).

### 7.8 How the program reaches AWS

- **No AWS keys in state either.** For every run the CLI writes a shared credentials file with a
  profile per site (`lab-<site>`) and an empty AWS config, next to the run's kubeconfig, and points
  `AWS_SHARED_CREDENTIALS_FILE` / `AWS_CONFIG_FILE` at them. Each site's AWS provider records only
  its region and profile name, so `destroy` works with the keys of the day; the user's own
  `~/.aws/config` (SSO, a default region) doesn't mix in.
- **Rancher does hold the keys**: its Amazon EC2 cloud credential (EC2 machines and EKS clusters both use it) is the site's keys (the dynamic
  resource creating it keeps them, encrypted, in state, as the Harvester credential does Rancher's
  password). A key change updates the credential in place.
- **Default tags** on each site's provider tag everything the engine creates there.

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
- `tls.acme` names an `AcmeServer` document (§17): `letsencrypt`, `letsencrypt-staging`, or one a
  team adds. An AcmeServer with a `ca` (staging) is a CA nothing trusts: Rancher serves those
  roots as its private CA, its agents verify against them strictly, and the engine's own clients
  skip verification.

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

### 9.3 Metal clusters

Same Cluster object without machine pools (`MetalCluster` in `@lab/rancher`; Rancher calls it a custom
cluster, and the component was `CustomCluster` until it was renamed: an alias keeps existing stacks'
clusters). The node command
comes from the cluster's `ClusterRegistrationToken` (the insecure one with Let's Encrypt staging;
the token itself from the Secret it names), gets the node's role flags and `--node-name`, and runs
as root on each node with `@pulumi/command` `remote.Command`. Then the Cluster is waited on until
Ready.

A node is any host without a Kubernetes profile: a `Machine`, or a `HarvesterVM` with no
profiles, with a `-k8s` OS profile (§6). A lab VM gets that profile's setup from its user data and
is waited on until cloud-init is done; a `Machine` gets its packages and `runcmd` over SSH before it
registers (it has to be registered with its vendor already, and is never waited on for cloud-init).

On destroy the Cluster is deleted first, while the nodes' agents still run; then every `Machine`
node is cleaned up with the RKE2/k3s and `rancher-system-agent` uninstall scripts, because it is
not deleted. A lab VM is just deleted.

**Profiles on existing machines.** A `Machine` with profiles gets no user data (it may not even
have cloud-init). What a VM's user data would run (the OS profile's `packages` and `runcmd`, then
the profiles' install commands, e.g. the distribution's config file and
`install`) runs over SSH as root instead, as one `remote.Command`. Its delete runs the profiles'
uninstall scripts (a distribution's `uninstall`), last built first, because the machine stays;
everything the profiles created on the machine's cluster is `deletedWith` that command, as it is
with a VM. The machine needs SSH with the lab's key as root or a passwordless sudoer, and its OS
already registered.

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
2. resolves the secrets the lab's templates use,
3. logs in to the state backend,
4. creates or selects the stack named after `lab:`,
5. writes the resolved lab (non-secret) and the secret values (as Pulumi secrets) into stack config,
6. runs the requested operation and streams output.

**Personal config** `~/.config/lab/config.yaml` (path overridable with `LAB_CONFIG`) holds
everything that is per person rather than per lab:

```yaml
secrets:
  hv-north:         { username: admin, password: "cmd:pass show lab/hv-north" }
  cloudflare:       { token: env:CF_API_TOKEN }
  ssh-key:          file:~/.ssh/id_ed25519
harvesters:
  hv-north: { url: https://hv-north.lab.geeko.me, credentials: "{{ secrets['hv-north'] }}" }
awsSites:
  aws-eu: { region: eu-west-1, credentials: "{{ secrets.aws }}" }   # secrets.aws: { accessKey, secretKey }
images:
  sles-16: { file: ~/images/SLES-16.0-Minimal-VM.x86_64-Cloud.qcow2 }
os: {}                    # personal OS profiles (§6)
```

**Secret values** come only from the user's environment:

- `LAB_SECRET_<NAME>` environment variables (`LAB_SECRET_HV_NORTH`; a map secret as JSON), or
- the `secrets:` section of the personal config, whose values may be literal, `env:VAR`,
  `file:path`, or `cmd:<command>` (for password managers).

A secret the lab uses is a string, or a map whose fields the lab uses (by path, `tunnel.token`) are
strings. Anything else in
`secrets:` (a nested map another tool reads, a list) is let through when the file loads, and only
a lab that uses it gets an error naming the secret and what it holds, never its value. Only the
used fields are resolved, so a `cmd:` in a field no lab uses never runs. A personal config that
doesn't load at all doesn't stop the UI: it falls back to the built-in catalog alone and shows the
config's problems.

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
  networks, images not present before), to catch leaks during development, and on each AWS site
  (by the lab's tags: instances, volumes, the VPC and what's in it, network interfaces left in the
  VPC, and key pairs named like the lab's machines; for EKS clusters, the EKS cluster, the
CloudFormation stacks and the launch template Rancher names after it).
- **AWS: machines before the network.** An `ec2` or `eks` cluster depends on its site's network,
  so destroy deletes the cluster (Rancher terminates its machines, or deletes the EKS cluster, its
  node groups and IAM stacks, waiting up to `timeouts.downstreamDelete`) before the security group,
  subnets and VPC. Network interfaces that something else left in the VPC (a load balancer) would block
  deleting it; with no AWS cloud provider yet, the engine's clusters make none.

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

> **File format (§17).** The examples here show a lab in the compact, single-map form. In a lab
> file the lab-wide fields are the `Lab` document's `spec`, and each entry under `harvesters`,
> `hosts` and `downstream` is a `Harvester`, `HarvesterVM` (`harvester:` instead of `on:`),
> `Machine` (`on: ssh`) or `DownstreamCluster` document. See `lab/labs/` for real files.

These four go into `lab/labs/` and act as acceptance tests for the design. Harvester and TLS
sections are left out for brevity.

**1. Rancher + MLM + air-gap registry**

```yaml
lab: rancher-mlm-airgap
hosts:
  rancher:  { on: hv-north, os: leap-16-k8s,  cpu: 4, memory: 16Gi, disk: 100Gi, profiles: { k3s: {}, rancher: {} } }
  mlm:      { on: hv-north, os: sl-micro-6.1, cpu: 4, memory: 16Gi, disk: 300Gi, profiles: { mlm-server: {} } }
  registry: { on: hv-north, os: leap-16,      cpu: 2, memory: 4Gi,  disk: 200Gi, profiles: { hauler: { manifests: [rancher-2.15] } } }
```

**2. Rancher provisioning RKE2 on Harvester, labelled for Fleet**

```yaml
lab: rancher-harvester-rke2
hosts:
  rancher: { on: hv-north, os: leap-16-k8s, cpu: 4, memory: 16Gi, disk: 100Gi,
             profiles: { k3s: {}, rancher: {} } }
catalog:
  fleet: { groups: { demo: { matchLabels: { env: demo } } } }
downstream:
  apps:
    type: harvester
    rancher: rancher
    harvester: hv-north
    distro: rke2
    labels: { env: demo }
    pools:
      - { name: all, quantity: 3, roles: [etcd, controlplane, worker], cpu: 4, memory: 8Gi, disk: 60Gi, os: sles-16-k8s }
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

**4. Rancher + metal cluster on a physical machine**

```yaml
lab: rancher-custom-edge
hosts:
  rancher: { on: hv-north, os: leap-16-k8s, cpu: 4, memory: 16Gi, disk: 100Gi, profiles: { k3s: {}, rancher: {} } }
  nuc-01:  { on: ssh, address: nuc-01.lab.geeko.me, user: root, os: sles-16-k8s }
downstream:
  edge:
    type: metal
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
| M4 ✅ | SSH hosts, `downstream.type: metal` (was `custom`), node cleanup | Reference lab 4. Done on asgard: a metal cluster on a lab VM (`labs/asgard-m4.yaml`); profiles on `Machine`s (`labs/asgard-m4-machines.yaml` on the bare VMs of `labs/asgard-m4-vms.yaml`: k3s with ServiceLB, RKE2 with MetalLB); Rancher on a `Machine` with a metal RKE2 cluster on two more (`labs/asgard-m4-custom.yaml`, on the same VMs); each with clean teardown and uninstall |
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
2. **`k3s` / `rke2`.** Installed from cloud-init as their `KubernetesDistribution` documents say
   (install command, config file; §17), with the built-in ingress disabled there (Traefik is its own profile), on a `-k8s` OS
   profile (§6), which turns firewalld off. The kubeconfig is read over SSH, its server
   rewritten to the host's address, and kept as a Pulumi secret: the one credential in state,
   encrypted, gone with the lab.
3. **`cert-manager`.** Chart, Cloudflare token secret, a ClusterIssuer for the `AcmeServer`
   `tls.acme` names (named after it), and the wildcard certificate labelled
   `sprouter.geeko.me/enabled`.
4. **`sprouter`**, **`traefik`** (Gateway API CRDs first), **`outrider`**: as in `pulumi/` today.
5. **`rancher`.** Rancher Prime chart with the Traefik ingress and the propagated wildcard secret,
   `server-url`, the profile's `settings` and `features` (by default the
   `harvester-baremetal-container-workload` feature), wait for the `local` Fleet
   cluster to be Ready, bootstrap the admin password. Produces `RancherAccess`.
6. **Plugins and Liz** inside the `rancher` profile (they are Rancher extensions).
7. **Fleet** inside the `rancher` profile: the Fleet secrets named explicitly under
   `fleet.secrets` (appco and scc as credentials, the observability license as a string),
   ClusterGroups from `fleet.groups`, GitRepos (`default` = today's `lab-setup-*` repos).
   Since replaced by the Fleet catalog (§16.3).
8. **Versions** of everything in `program/versions.ts`, overridable per lab. Since moved to the
   catalog (§16.2).
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

---

## 16. Catalog: defaults as data

> **File format.** The catalog, lab files and the personal config are documents now (§17), and a
> lab's Harvesters, hosts and downstream clusters are documents of their own. This
> section describes *what* the catalog holds; where its examples show the earlier map-style
> syntax (`catalog.components.rancher.version`, `components/<name>.yaml` with a `profile:`
> section), read them through §17's mapping: each entry is a document of the matching kind, and an
> override is a document of the same kind and name.

**Problem.** Much of what a lab installs is fixed in TypeScript: the Fleet GitRepos and their
ClusterGroup (`DEFAULT_REPOS`), which secrets and values files the `apps/` tree expects and how
they're rendered (`fleet.ts`), chart repositories and names (Rancher Prime, cert-manager, Traefik,
Sprouter, Outrider, the DNS controller, the cloud provider, Liz), the UI plugin repository and the
default plugin set, default versions (`versions.ts`), and smaller choices (downstream CNI, chart
values like Sprouter's excluded namespaces). Changing any of them means changing code, which goes
against §2: lab authors write YAML only. Typical needs we can't meet today:

- test a branch or fork of the `apps/` tree, or only some of its repos;
- add a team's own Fleet repo with its own secrets;
- use community Rancher instead of Prime, or a mirror for charts (needed for the airgap lab, M5);
- bump a version or add a UI plugin for everyone without a code change;
- set a chart value the profile doesn't expose.

**Idea.** Same model as OS profiles (§6): defaults are YAML documents in a **catalog** shipped with
the engine, and the personal config and the lab file can override or extend them, later sources
winning. The engine keeps only what is truly its contract (Rancher's namespaces, Kubernetes and
Harvester API paths, the labels that tie cert-manager to Sprouter, the ACME endpoints behind
`tls.acme`).

### 16.1 Layout and layering

```
lab/catalog/
  components/            # one file per component: chart/manifest, version, its profile (16.2, 16.10)
  plugins.yaml           # UI plugin repository, plugin versions, the default set
  os/                    # OS profiles, one file each (§6)
  secrets/, configmaps/  # built from the lab's inputs, placed on any cluster (16.6)
  fleet/
    groups.yaml, repos/  # Fleet: one file per GitRepo (16.3)
```

Each catalog section can be overridden under `catalog:` in the personal config and in the lab
file, entry by entry and field by field (a lab can set just a component's `version`; lists are
replaced, not merged). `lab catalog [lab.yaml]` lists the effective catalog and the layer each
entry comes from.

A version is a string, or a map of Harvester minor to version for components that follow the
Harvester they run on (the vm-dhcp-controller add-on); an unknown, newer Harvester gets the newest
version listed.

### 16.2 Components and chart values

Every component the lab installs is one entry with its version: a Helm chart, a manifest URL
template, or only a version for what the engine installs itself (k3s, RKE2).

```yaml
# lab/catalog/components/*.yaml (excerpts, one file each)
k3s:          { version: v1.36.4+k3s1 }
rancher:      { repo: https://charts.rancher.com/server-charts/prime, chart: rancher, version: v2.15.2 }
sprouter:     { chart: oci://ghcr.io/hierynomus/sprouter/charts/sprouter, version: 0.11.1 }
gateway-api:  { manifest: "https://github.com/kubernetes-sigs/gateway-api/releases/download/{version}/{channel}-install.yaml", version: v1.6.2 }
harvester-vm-dhcp-controller:
  repo: https://charts.harvesterhci.io
  chart: harvester-vm-dhcp-controller
  version: { "1.8": 1.8.2, "1.9": 1.9.0 }   # per Harvester minor
```

- A version is a string, or a map of Harvester minor to version for components that follow the
  Harvester they run on; an unknown, newer Harvester gets the newest version listed.
- A profile's own `version:` setting still wins over the catalog (a downstream cluster's
  `version:` likewise).
- Every chart-based profile gets an optional `values:` setting, deep-merged over the engine's
  values. Values the engine depends on (Rancher's `hostname`, `ingress.tls`, `privateCA`) are
  checked: overriding one is a validation error, so a lab can't break the wiring silently. Each
  Profile document declares them in `lockedValues` (merged last), next to `values` (defaults) and
  `namespace` (§7.6). The merge order is profile `values`, the lab's `values`, `lockedValues`.
  Values that depend on the host or other profiles are Jinja2 templates (§17).
  `"{{ secrets.name }}"` works anywhere in a lab's `values`.

```yaml
hosts:
  rancher:
    profiles:
      rancher:
        adminPassword: "{{ secrets['rancher-admin'] }}"
        values: { auditLog: { enabled: true } }
catalog:
  components:
    rancher: { repo: https://releases.rancher.com/server-charts/latest, version: v2.14.3 }   # community Rancher
```

### 16.3 Fleet: repos and groups

Fleet is two catalog sections, one GitRepo per file, so each can be read, overridden and added on
its own. The secrets its bundles need are ordinary catalog secrets (16.6).

```
lab/catalog/fleet/
  groups.yaml                              # ClusterGroups by name
  repos/<name>.yaml                        # one GitRepo each
```

```yaml
# repos/lab-setup-appco.yaml
default: true                              # created when a rancher profile lists no fleet.repos
url: https://github.com/SUSE-Technical-Marketing/suse-rancher-prime-setup.git
branch: main
paths: [/apps/appco]
target: all-downstream-clusters            # a group from groups.yaml
helm: { secret: application-collection-basicauth, repoURLRegex: "oci://dp.apps.rancher.io/*" }
uses: [fleet-secrets]                      # catalog secrets its bundles read when there
```

**In the lab file** the `rancher` profile picks repos; inputs are lab-wide (16.6), and
everything else is a catalog override:

```yaml
hosts:
  rancher:
    profiles:
      rancher:
        adminPassword: "{{ secrets['rancher-admin'] }}"
        fleet:
          repos: [lab-setup-base, lab-setup-appco, team-apps]   # default: repos with default: true
inputs:
  appco: "{{ secrets.appco }}"
catalog:
  fleet:
    groups: { demo: { matchLabels: { env: demo } } }
    repos:
      lab-setup-base: { branch: my-feature }                   # change one field
      team-apps: { url: https://github.com/example/team-apps.git, paths: [/], target: demo }
```

Rules, all checked by `validate`:

- A repo's secrets are created on the Rancher host, in the GitRepo's namespace (where Fleet looks
  for them), whatever namespace the secret's own definition names.
- **A repo's `helm.secret` is required**: Fleet rejects the GitRepo without it. A default repo
  whose Helm secret can't be built is skipped; one the lab lists by name is an error. Secrets in
  `uses:` are created when possible and otherwise only reported.
- **One vocabulary with profiles**: `requires` is a hard dependency, `uses` a soft one. A repo
  requires its `helm.secret` and uses the secrets in `uses:`; a secret `requires` capabilities of
  the host it lands on, exactly like a profile.
- Every catalog group is created, so groups are also there for GitRepos made in the UI.
- `lab plan` lists each repo, and every repo skipped with what it waits for.

### 16.4 UI plugins

```yaml
# lab/catalog/plugins.yaml
repo: { name: rancher-ui-plugins, gitRepo: https://github.com/rancher/ui-plugin-charts, branch: main }
versions: { harvester: 1.8.2, kubewarden: 4.2.1, ... }
default: [harvester, virtual-clusters, kubewarden, vulnerability-scanner, rancher-ai-ui]
```

The `rancher` profile's `plugins:` takes names (versions from the catalog; default set when
absent, `[]` for none) or `{ name: version }`. A layer can override parts of `repo` (a fork, a
branch) and single versions; `default` is replaced whole.

### 16.5 Downstream clusters

`downstream.<name>` gets `cni` (default `calico` for RKE2, `flannel` for k3s), and two
passthroughs for anything else Rancher supports: `machineGlobalConfig` and `chartValues`, merged
over the engine's. `machineGlobalConfig.cni` (use `cni`) and `chartValues.harvester-cloud-provider`
stay engine-owned: setting them is a validation error, like 16.2's protected values.

Every k3s or RKE2 server the lab makes (a single-node host, a downstream pool or metal-cluster node with
the etcd or control-plane role) starts `lab-helm-watch` first: a transient systemd unit that, for
`timeouts.helmJobWatch` (60m), deletes helm-controller Jobs (`helmcharts.helm.cattle.io/chart`)
that stay suspended for 90s. helm-controller suspends a Job before it replaces it and sometimes
never comes back to it; then that chart is never installed (once, the Harvester cloud provider,
which kept a downstream node tainted for an hour). Deleted, helm-controller makes it again. The
fix runs on the node because the cluster can't be reached through Rancher before its agent runs.
`journalctl -u lab-helm-watch` shows what it deleted.

### 16.6 Secrets and configmaps

Credentials, licenses and settings that clusters need are catalog entries of their own, built from
the lab's **inputs** and placed on any cluster: a host's k3s/RKE2, a downstream cluster, or the
Rancher cluster for Fleet (16.3).

```
lab/catalog/
  secrets/<name>.yaml                      # one Secret each
  configmaps/<name>.yaml                   # one ConfigMap each (same fields, no `type`)
```

```yaml
# secrets/application-collection-basicauth.yaml
type: kubernetes.io/basic-auth
inputs: { appco: credentials }             # input name -> shape (string | credentials)
data:
  username: "{{ inputs.appco.username }}"
  password: "{{ inputs.appco.password }}"

# secrets/fleet-secrets.yaml (excerpt)
requires: [downstream-secrets]             # Outrider, on the host it lands on, copies it downstream
annotations: { outrider.geeko.me/enabled: "true", outrider.geeko.me/namespace: kube-system }
inputs: { appco: credentials, scc: credentials, suse-observability-license: string }
data:                                      # a map is stored as a YAML document (a values file)
  appco-values.yaml: { username: "{{ inputs.appco.username }}", token: "{{ inputs.appco.password }}" }
  cert-manager-values.yaml: { letsencrypt: { prod: { email: "{{ lab.tls.email }}" } }, cloudflare: { token: "{{ lab.tls.cloudflare }}" } }
```

**In the lab file**, `inputs:` gives the values (the personal config can hold defaults, the lab
wins), and hosts and downstream clusters list what they want:

```yaml
inputs:
  appco: "{{ secrets.appco }}"
  scc: { username: me, password: "{{ secrets['scc-pw'] }}" }
hosts:
  rancher:
    secrets: [scc-suse-basicauth]                        # default namespace from the definition
    configmaps: [{ name: proxy-config, namespace: kube-system }]
downstream:
  apps:
    secrets: [{ name: application-collection-basicauth, namespace: apps }]
```

Rules, all checked by `validate`:

- **Values.** A `data` value is a single value, or a map or list stored as a YAML document. A key
  whose inputs aren't all given is left out; an object with no keys left isn't created.
- **Jinja2 templates.** Strings in `data` are templates over `inputs` and `lab`, as in Profiles.
  `inputs.<name>` must be an input the object lists, used as its shape says
  (`inputs.appco.username`, plain `inputs.license`); `lab` has `tls.email`, `tls.cloudflare` and
  `domain`. A template must give a single value. Each is rendered once by the resolver against
  placeholders, which checks it and finds what it uses. Without secrets in it, the resolver
  renders it; with them, it goes to the program as `{ $template, inputs, lab }` with only the
  values (secret refs) it uses, and the program renders it with the secrets.
- **Inputs**: a lab can only pass inputs some object takes, in the declared shape; two objects
  declaring the same input with different shapes is an error.
- **Listed by name means wanted**: an object a host or downstream cluster lists that can't be
  built (missing inputs, unmet `requires`) is an error. Only used by a Fleet repo, it is left out
  and reported.
- **`requires`** is checked on the host it lands on, like a profile's; downstream clusters have
  no profiles to check.
- Namespaces other than `default` and `kube-system` are created, or shared when they exist
  (Rancher's `fleet-default`, a chart's), and left in place when the objects go.
- On a host the objects go with the VM. On a downstream cluster they're applied through Rancher's
  proxy once the cluster is Ready, and go with the cluster.

### 16.7 Out of scope

- Fetching a source's contract from its own repository (e.g. `apps/lab-source.yaml`): appealing,
  but it makes `validate` depend on the network. Revisit when a second team source exists.
- Profile bundles (§14.1): unchanged, still possible later as data.

### 16.8 Decisions

- **The lab file format breaks**: `fleet.repos` and `fleet.secrets` are replaced by
  `fleet.repos` (names) and a lab-wide `inputs:`, and the top-level `os:` by `catalog.os`. Only our own lab files used them; they
  are migrated, with no compatibility layer.
- **Fleet's contract lives in the catalog**, not in the repository it describes (16.7).
- **One file per GitRepo and per secret** (a revision of the first version, which bundled a whole
  Git repository's repos, secrets and inputs into one "source" file): each piece can be
  overridden or added on its own, and repos only name the secrets they need.
- **Secrets and configmaps are top-level catalog entries** (16.6), not part of Fleet: the same
  definitions serve Fleet repos, host clusters and downstream clusters, and `inputs:` is lab-wide.
- **Protected chart values are rejected**, not overridden with a warning.
- **Profiles are catalog data** (16.10), with generated settings types for the builders, and their
  rules can only be changed in the built-in catalog.
- **OS profiles moved** to `lab/catalog/os/` (done in C1).
- **Versions live with their component** in `components/<name>.yaml` (and plugin versions in
  `plugins.yaml`); there is no separate versions file and no top-level `versions:` in a lab file.
  A lab overrides `catalog.components.<name>.version`.

### 16.9 Plan

Each step keeps `asgard-m2*` and `asgard-m3` working and ends with typecheck, tests and a
`preview` of the running lab that shows no unintended changes.

| Step | Scope | Done when |
|---|---|---|
| C1 ✅ | Catalog loader in `@lab/schema`: built-in → personal → lab layering (generalized from the OS loader), `catalog:` in both config files, `lab catalog` command; `versions.ts` → catalog data; `os/` → `catalog/os/` | Same versions resolved as today; loader tests (override, extend, unknown key errors) |
| C2 ✅ | `catalog/components/` (chart, manifest or plain version, each with its version; replaces separate versions and charts files); components take `{repo, chart, version}` from the resolved catalog; `values:` on chart profiles with protected keys | No literal chart URL left in `packages/`; preview of asgard-m3 unchanged |
| C3 ✅ | Fleet catalog (groups, secrets, repos): schema, `$input`/`$lab` refs, resolver checks (unknown repo, undeclared input, duplicate names, skip report in `plan`); generic rendering in `Fleet`; `catalog/fleet/suse-tmm.yaml`; lab files migrated | `DEFAULT_REPOS` and the hand-written secrets gone; asgard-m3 preview unchanged for GitRepos; a lab with `branch:` override and a repo subset previews as expected |
| C4 ✅ | `catalog/plugins.yaml`, plugin repo and default set from data | Preview unchanged |
| C5 ✅ | Downstream `cni`, `machineGlobalConfig`, `chartValues` | Schema tests; asgard-m3 preview unchanged |
| C6 ✅ | Docs: catalog section in `lab/README.md` (how to override, how to add a Fleet repo), DESIGN §5/§9 updated | Someone can add a Fleet repo without reading TypeScript |
| C7 ✅ | Profiles as data: `profile:` sections in `catalog/components/*.yaml` (rules, JSON Schema settings), registry built by the catalog, generated `ProfileSettings` for the builders; `packages/schema/src/profiles/<name>.ts` gone | Same validation messages and 87-unchanged preview of asgard-m3; generated-file and builder-coverage checks |

### 16.10 Profiles in the catalog

A host profile's contract is the `profile:` section of its component file (§7.6 lists the rules);
what it does stays a builder in `program/profiles.ts`.

- **Settings** are a JSON Schema subset: `type`, `enum`, `const`, `anyOf`/`oneOf`, `default`,
  `minimum`/`maximum`, `minLength`, `pattern`, `items`, `properties`, `required`,
  `additionalProperties`, `description`. `$ref` names a lab type (`dnsLabel`, `dnsName`,
  `quantity`, `ipv4`, `url`, `secretOrString`, `credentials`, `chartValues`), so its checks and
  messages are the lab's own. Objects reject unknown fields unless `additionalProperties` allows
  them. An unsupported keyword or unknown `$ref` is an error in the catalog file.
- The resolver checks each `profiles.<name>` on a host against its schema and applies defaults;
  an unknown profile name is an error that lists the known ones.
- **Generated types**: `mise run profile-types` writes `program/generated/profile-settings.ts`, one
  settings type per profile and the `ProfileSettings` map the builders are typed against (as
  `@lab/crds` does for CRDs). A test fails when it's out of date.
- **Locked**: a personal config or lab file can override a component's `version`, `repo` or
  `chart`, but not its `profile:` (the schema rejects the field), because the builders are written
  against those rules.

---

## 17. Files are documents

The catalog, lab files and the personal config are Kubernetes-style documents:

```yaml
apiVersion: lab.geeko.me/v1alpha1        # may be left out; anything else is an error
kind: HelmChart
metadata:
  name: rancher                          # unique per kind; how other documents refer to it
  description: Rancher Manager (Prime)   # one line, shown by `lab catalog` / `lab profiles`
  labels: {}                             # optional, free-form
spec: { ... }
```

A file can hold several documents, separated by `---`. Directories and file names mean nothing
to the loader: it reads every `*.yaml` under `lab/catalog/`, and the `kind` says what each
document is.

**Kinds**

| Kind | `spec` | Catalog section it fills |
|---|---|---|
| `KubernetesDistribution` | `version`; `install` (a template with `version`, run as root); `configFile` and `config` (written before installing, with the host's FQDN as a `tls-san`); `withCapability.<capability>` (merged into `config`, lists joined, when another profile on the host provides that capability: `ingress` turns the distribution's own Traefik off, `load-balancer` its ServiceLB, `cloud-provider` sets up an external cloud controller); `kubeconfig`, `kubectl`, `dataDir`; `uninstall` (scripts for metal-cluster machines); `cni` (downstream default). An override's `config` and `withCapability` merge key by key (lists replaced) | components (k3s, RKE2) |
| `AcmeServer` | `url` (the ACME directory), `ca` (PEM roots, for a CA nothing trusts) | ACME servers (`tls.acme`) |
| `Defaults` | one, named `default`: `ssh.user` (a lab's `ssh.user`, and a Machine's `user`, default to it), `vm` (`cpu`, `memory`, `disk` of a HarvesterVM or downstream pool that doesn't give them), `harvester.clusterNetwork`, `harvester.storageClass` (`name`, `replicas`, `parameters`), `timeouts.<step>` (durations like `15m`: `harvesterAddon`, `image`, `vmStart`, `vmAddress`, `cloudInit`, `loadBalancerCleanup`, `kubernetesApi`, `resourceReady`, `certificate`, `rancherReady`, `uiPlugin`, `harvesterImport`, `clusterRegistration`, `downstreamReady`, `downstreamDelete`, `helmJobWatch`), `aws` (`vpcCidr`, `zones` and `instanceType` of an AwsSite, EC2 pool or EKS node group that doesn't give them; `eksVersion` of an EKS cluster), `images.kubectl` (an image with kubectl and curl for jobs the engine runs on a cluster: a k3k cluster's import). Later layers override single fields, so a personal config can make one wait longer | what the engine uses where a lab doesn't say (`catalog/defaults.yaml`) |
| `HelmChart` | `repo`, `chart`, `version`, `namespace` (default for host placements) | components |
| `Manifest` | `url` (template), `version` | components |
| `Profile` | `charts` / `distribution`, the rules of §7.6, `outputs`, `settings` (JSON Schema object) | profiles (§16.10) |
| `SecretTemplate`, `ConfigMapTemplate` | `inputs`, `requires`, `template: { metadata: { namespace, labels, annotations }, type, data }` | secrets, configmaps (§16.6) |
| `FleetRepo` | as §16.3 | fleet repos |
| `ClusterGroup` | `selector` | fleet groups |
| `UiPluginRepository` | `gitRepo`, `branch` (one is supported) | UI plugins |
| `UiPlugin` | `repository`, `version`, `default` | UI plugins |
| `OperatingSystem` | as §6 (`metadata.description` is the display name) | OS profiles |
| `Lab` | the lab-wide fields of §5 (`domain`, `tls`, `ssh`, `inputs`, `images`), plus `include: [...]` | — (first document of a lab file) |
| `PersonalConfig` | secrets, harvesters, awsSites, images, inputs, `include` | — (first document of the personal config) |
| `Harvester` | as `harvesters.<name>` in §5.2 | the lab's Harvesters (lab file and its includes only) |
| `AwsSite` | `region`, `credentials`, `vpc.cidr`, `zones`, `ttl` (§5.6) | the lab's AWS sites, each with a VPC of its own (lab file and its includes only) |
| `HarvesterVM` | as a host in §5.3, with `harvester:` instead of `on:` | the lab's hosts |
| `Machine` | as an `on: ssh` host in §5.3 (no `cpu`, `memory`, `disk`, `network`, `macAddress`) | the lab's hosts |
| `DownstreamCluster` | as `downstream.<name>` in §5.5 | the lab's downstream clusters |

HelmChart, Manifest and KubernetesDistribution share one name space: profiles and the engine
refer to them by name.

**Lab documents.** `Harvester`, `HarvesterVM`, `Machine` and `DownstreamCluster` describe one lab:
they're only valid in a lab file and the files it includes (not in the personal config or the
built-in catalog). Each name is used once per kind; a HarvesterVM and a Machine can't share a name
(both are hosts). A second document with the same kind and name is an error for now; merging it
into the first, as catalog overrides do, could come later for "base lab plus variations".

**Layers.** Built-in documents first, then the personal config's (its `spec.include`
files and directories, then the documents after its first one), then the lab file's in the same
order. A document with the same kind and name as an earlier one merges its `spec` field by field
(a per-Harvester version map is replaced whole); a new name adds an entry. Rules:

- In the built-in catalog a name is defined once per kind.
- An override must have the same kind (a `Manifest/k3s` can't override `KubernetesDistribution/k3s`).
- `Profile` documents only come from the built-in catalog: the builders are written against them.
- `Lab` and `PersonalConfig` are only valid as the first document of their own file.

**Paths in messages** point into the file: `HarvesterVM/vm.spec.os` for a lab document (in the
file it's defined in, which may be an included one), `spec.tls.email` for the Lab's own fields,
`HelmChart/rancher.spec.version` for a catalog document, `document 3.kind` for one that couldn't
be read as a document at all.

**Charts on hosts.** `hosts.<name>.charts: [{ name, namespace?, values? }]` installs catalog
HelmCharts on a host's cluster after all of its profiles and objects, in the chart's namespace
unless the placement names another. They're outside the profile rules and build order: something
other profiles must be able to `require` is a Profile. A profile's own chart is installed by its
builder, in the namespace its Profile document names; a HelmChart's `namespace` matters only to
`charts:` (a lab can override a HelmChart, but not a Profile).

**Templates in Profiles.** String values in a `charts` entry's `values` and `lockedValues`, and its
`when`, `version` and `vars`, may be Jinja2 templates (Nunjucks). `when` must render to `true` or
`false`; an empty `version` means the catalog's. A string that is exactly one `{{ expression }}` yields the expression's own
value, so `"{{ lab.tls.privateCA }}"` is a boolean and `"{{ outputs['load-balancer'].serviceAnnotations
| default({}) }}"` a map; any other template renders to a string. The resolver renders them per host,
in strict mode (an undefined variable is an error at the value's path, naming the host), with:

| Variable | Value |
|---|---|
| `settings` | the profile's settings on this host, defaults applied |
| `host` | `name`, `fqdn` |
| `lab` | `name`, `domain`, `tls.acme`, `tls.privateCA` (the AcmeServer has a `ca`: Let's Encrypt staging), `tls.email` |
| `outputs` | by capability: the `outputs` the profile on this host providing it declares; only for capabilities this profile `requires`, `uses` or `requiresWhen`, so it can't read a profile built after it |

A secret setting reaches a chart through the `field` filter: `"{{ settings.applicationCollection |
field('username') }}"` gives `"{{ secrets.appco.username }}"` for `applicationCollection:
"{{ secrets.appco }}"` (or the `username` of a `{ username, password }` map, and `""` for an unset
setting). The program renders such secret templates in a chart-only profile's values when it
builds the lab, as a secret output, so the values stay encrypted in the state.

A profile whose requirements aren't met on a host isn't rendered there (the rules report that). The
program gets plain values; the protected paths are the leaves of `lockedValues`, templates or not.
Secret templates (§16.6) keep their `$input`/`$lab` refs: their values are secrets resolved at
deploy time, and a key is left out when its inputs are missing.
