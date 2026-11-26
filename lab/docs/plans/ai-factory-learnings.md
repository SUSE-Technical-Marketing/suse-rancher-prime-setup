# Plan: taking in what the AI Factory repos learned

As of 2026-11-26. This turns [the comparison](../analysis/suse-ai-factory-repos.md) of our engine
with [suse-ai-factory-cloud-providers](https://github.com/e-minguez/suse-ai-factory-cloud-providers)
and [suse-ai-factory-baremetal](https://github.com/e-minguez/suse-ai-factory-baremetal) into work on
our codebase. It runs alongside DESIGN §18, the backend plan. Where an item belongs to a §18 phase,
it says so, and it doesn't repeat that phase.

The phases are ordered by what needs the least infrastructure. Each one is useful on its own.

| Phase | What | Needs | §18 link |
| --- | --- | --- | --- |
| A | Quick wins: leftover exit codes, CI hardening, a GPU example lab | Nothing | Phase 4 (examples) |
| B | GPUs on hosts and in clusters | A Harvester with a GPU for the live check | None; new |
| C | Preflight: check a site can hold the lab before `up` | Harvester and AWS logins for the live check | Phase 2's libvirt preflight uses the same seam |
| D | Cost estimate for cloud labs | Nothing (public price lists) | Next to phase 4's `ttl` |
| E | Their provider findings, written into phases 2 and 3 | Nothing to write; a KVM box and cloud accounts to build | Phases 2 and 3 |
| F | Metal3 downstream clusters, and Elemental images | Your decision; phase 2 (libvirt) | Phase 5 (version matrix) |

## Decisions needed first

These change scope, so they are yours. Each phase notes where it waits on one.

1. **Elemental images (phase F):** yes, no, or later. I recommend later, and only if a demo needs it.
2. **GPU operator on hosts (phase B):** add a ChartProfile next to the existing `gpu-operator`
   Fleet profile, or replace the Fleet profile? I recommend adding one, so host labs get it and
   cluster labs keep working.
3. **Second cloud in §18 phase 3 (phase E):** Hetzner as planned, or one the cloud repo already
   covers (exoscale, vultr, evroc)?
4. **Release process (phase A):** release-please and Conventional Commits for `lab/`, or not.

## Phase A: quick wins

Nothing here needs infrastructure.

**A1. Exit codes for `destroy --check`.** ✅ Done. The cloud repo's leftover checkers exit 0 for clean, 1 for
leftovers, 2 for a usage error and 3 for inconclusive. Today we exit 1 for leftovers. A check that
couldn't run (HTTP not 200) is listed among the leftovers, so a scripted caller can't tell "dirty"
from "couldn't look".

- `packages/backends/src/index.ts`: add `unknown: string[]` to `Leftovers`.
- `cli/src/leftovers.ts`: move the "couldn't check" lines from `found` to `unknown`. The AWS site
  backend does the same.
- `cli/src/main.ts`: exit 0, 1 or 3, and print the unknown lines separately. Usage errors already
  exit non-zero; make that exit 2.
- `lab reap`: after destroying, run the check and report a lab that left something behind.
- Tests: CLI tests for each exit code, using a fake site backend.

**A2. CI hardening.** ✅ Done: checkout v4.4.0 and mise-action v2.4.4 pinned by SHA, weekly dependabot PRs for actions.

- Pin the actions in `.github/workflows/lab.yml` to commit SHAs, with the version in a trailing
  comment.
- Add a dependabot config for GitHub Actions. npm or bun updates are a separate choice.
- ~~First, run the workflow on GitHub at all.~~ Wrong: it already runs on PR #4 and passes.
- Release-please waits on decision 4.

**A3. Example lab: management plus GPU downstream.** ✅ Done, with a placeholder `public-ingress` profile (`status: planned`): an `ec2` cluster needs its Rancher reachable from the internet, which waits on the Cloudflare tunnel operator. The example validates and plans; `preview` and `up` refuse it until then. This is their shape 03 in our terms. It
uses only what we have today:

- a Rancher VM on Harvester with `ai-factory`;
- an `ec2` downstream cluster whose pool uses a GPU instance type;
- the `gpu-operator` Fleet profile on that cluster.

Done in `examples/ai-factory-gpu.yaml`, loaded and planned by `cli/test/examples.test.ts`.

To check before calling it done:

- Does the GPU operator's driver install work on our `sles-16` AMI? The cloud repo needed a
  precompiled SLES 16.1 driver override.
- Does our EC2 pool need a larger root disk for the drivers?

Its live run costs GPU instance hours.

## Phase B: GPUs on hosts and in clusters

Today a `HarvesterVM` can't have a GPU. The `gpu` capability exists only for clusters, through the
`gpu-operator` Fleet profile. The cloud repo passes GPUs through to Harvester VMs as KubeVirt host
devices (`gpu_devices`: a resource name such as `nvidia.com/GA102GL_A10`, and a count).

**B1. A `gpus` field on `HarvesterVM`.**

- `packages/schema/src/schema.ts`: `gpus: [{ device: string, count?: number }]` on
  `HarvesterVMSpec` only, not on `VmCommon`. Cloud VMs get GPUs from an instance type, not from a
  device.
- `packages/harvester/src/vm.ts`: write them as `domain.devices.hostDevices`, one entry per device
  instance, as KubeVirt expects.
- `program/backends/harvester.ts`: pass the field through.
- Composer: the field appears through the schema form. Check that it renders well.
- Tests: schema, and a Pulumi-mock test that the VM gets its host devices.

**B2. A host with GPUs provides `gpu`.**

- `packages/schema/src/phases/hosts.ts`: a host with `gpus` provides `gpu`, as a cluster with the
  Fleet profile does today.
- Profiles can then say `requires: [gpu]`. Start with `vllm`, which today assumes a GPU. Check how
  it does that, so the DGX Spark machine (a `Machine`) keeps working. A `Machine` may need a way to
  declare that it has a GPU, for example `provides: [gpu]` on the document.

**B3. A `gpu-operator` ChartProfile** (waits on decision 2).

- `catalog/charts/gpu-operator.yaml` and `catalog/profiles/gpu-operator.yaml`: `targets: [host,
  cluster]`, `requires: [kubernetes, gpu]`, and a `driver` setting that holds the precompiled-driver
  override for SLES 16.
- Same method as Keycloak: resolver tests, a mock test, and `helm template` against the chart.

**B4. GPUs in Rancher-provisioned Harvester clusters.** I haven't checked whether Rancher's
Harvester machine config can carry PCI or vGPU devices. Look in the machine-config CRD under
`packages/` before designing anything. If it can, add `gpus` to the pool in
`packages/schema/src/clusters/harvester.ts`.

**B5. Example lab: inference in a box.** Their shape 01: one `HarvesterVM` with a GPU, running
rke2, rancher, ai-factory and gpu-operator. Add it to `examples/`.

**Done when:** a Harvester with a GPU runs B5, and `nvidia-smi` works in a pod. Until then, B1 to
B3 are complete but unverified, as Keycloak is now.

## Phase C: preflight checks

The cloud repo fails at plan time when a zone, an instance type or a quota can't hold the
cluster. We find out during `up`, when Harvester or AWS refuses. §18 phase 2 already plans a
preflight for libvirt (`virsh`, the pool, the network). Building the seam now gives Harvester and
AWS the same check, and gives libvirt a place to put its own.

**C1. The seam.**

- `packages/backends/src/index.ts`: `SiteBackend.preflight(lab, ctx) → Diagnostic[]`, using the
  diagnostic type `validate` already uses, so errors name the document and field.
- `cli/src/main.ts`: `up` and `preview` run it after login and before Pulumi.
  `validate --online` runs it alone.
- `plan` stays offline.

**C2. Harvester checks** (`cli/src/harvesters.ts`, or the Harvester site backend):

- The storage class and named networks exist. Check which of these the resolver already does.
- The GPU resource names from B1 are allocatable on some node.
- The lab's total CPU and memory fit the nodes' allocatable minus what is requested. This is a
  warning, not an error: Harvester overcommits.
- Each VM's cloud-init Secret stays under 1 MiB. The cloud repo hit this limit. It can be checked
  offline in the resolver too.

**C3. AWS checks** (`cli/src/aws.ts`):

- Each pool's instance type is offered in its zone (`DescribeInstanceTypeOfferings`).
- The vCPU quota for the instance family covers the lab (Service Quotas; the GPU families have
  their own quota).
- The AMI from the OS profile exists in the region.

**C4. Tests:** each check against a fake API response, as the leftover tests do.

**Done when:** a lab asking for a GPU instance type that the AWS region doesn't offer fails before
anything is created. The error names `DownstreamCluster/<name>.spec.pools[0].instanceType`.

## Phase D: cost estimate

The cloud repo prices a cluster from its variables before deploying, for 1h, 8h, 24h, 7d and 30d.
It always carries a disclaimer that this is an estimate, not a quote.

**D1. `lab cost <lab.yaml>`.**

- New file `cli/src/cost.ts`. It prices what the resolved lab would create on AWS: EC2
  downstream pools, EKS control planes and nodes, NAT gateways and load balancers where we make
  them.
- Later it covers `Ec2VM` and Hetzner from §18 phase 3.
- Harvester and `Machine` hosts are on premises: they count as 0 and are listed as such.
- Prices come from the public AWS price list for the region. They are cached, and an offline price
  file serves tests and air-gapped use.
- Output: a table per resource, plus the total until expiry when the lab has a `ttl`.

**D2. One line in `lab plan`:** an estimated cost per hour when a lab uses a cloud site, with the
same disclaimer.

**D3. Tests:** a fixed price file and the example labs, snapshotted.

**Done when:** `lab cost` on the A3 example prints per-resource and total figures, and the total
matches a manual calculation from the AWS price page.

## Phase E: their provider findings, written into §18 phases 2 and 3

This phase is writing, not code. It adds their findings to DESIGN §18 now, so phases 2 and 3 start
from them.

**E1. libvirt (§18 phase 2)**, from the bare-metal repo's VM scripts:

- Settings: UEFI firmware, q35, virtio disk and NIC, `host-passthrough` CPU, and
  `qemu:///system`.
- Create a disk as a qcow2 copy of the cached image, then resize it before first boot: the root
  partition grows to fill the disk only on that boot.
- Delete with `--remove-all-storage`.
- Fixed MACs in the `52:54:00` range. Ours should derive from the lab and host name, which also
  gives §18's deterministic addressing.

**E2. Harvester**, checked against our backend. Each finding becomes a test or a known limit:

- The 1 MiB cloud-init Secret limit. The check is in C2.
- Their nodes take addresses from the guest agent and wait for a lease. Compare that with
  `packages/harvester/src/vm.ts`.
- The Harvester API certificate has only IP SANs. Check what our sessions connect to.
- When MetalLB holds a VIP, no other component may announce it. Check this against our `metallb`
  profile.

**E3. Clouds (§18 phase 3):**

- **User-data limits as a backend trait.** EC2 allows 16 KiB, so ours must gzip it, or check its
  size, before phase 3 lands. Their other limits (exoscale about 24 KiB, gcp 256 KiB, oci about
  22 KB) go in the same trait.
- **Their per-provider ADRs** are the starting notes for whichever cloud decision 3 picks.

**E4. Hostnames without a DNS zone:** add sslip.io as an option. A lab with no domain or DNS
profile could still get names (`rancher-<ip>.sslip.io`) and Let's Encrypt certificates through
HTTP-01. It's useful for cloud labs and first-time users. This is a design note for §8 (DNS and
TLS) and a DNS profile of its own; it fits with §18 phase 3's DNS profiles.

**E5. Versions known to work together (§18 phase 5):** the bare-metal repo's tested set (Rancher
2.15.1, rancher-turtles-providers 307.0.8+up0.27.0, CAPI 1.13.3, CAPRKE2 0.25.0, CAPM3 1.13.2, RKE2
1.36.3) becomes the first entry in the catalog's compatibility matrix. Its known failure goes with
it: with an older Rancher, Turtles pins a CAPI provider version the chart doesn't ship.

## Phase F: Metal3 downstream clusters and Elemental images

Both are large. F1 waits on §18 phase 2. F2 waits on decision 1.

**F1. A `metal3` downstream cluster type**, built from the bare-metal repo's manual steps:

- **Profiles on the Rancher host:** `metal3` (Ironic and the baremetal-operator, needing
  `metallb` for the Ironic IP) and `capi-providers` (`rancher-turtles-providers`, version-locked
  to Rancher through E5).
- **A `BareMetalHost` document kind** with the BMC address and credentials, the boot MAC, and the
  root device hints. The repo shows a BMH fails without them on virtio disks.
- **The cluster type:** `packages/schema/src/clusters/metal3.ts`, generating the CAPI `Cluster`,
  `RKE2ControlPlane` and `MachineDeployment` from pools, as their `cluster/*.yaml` do by hand.
- **For labs without real BMCs:** a `sushy-tools` profile on a libvirt `Machine` (§18 phase 2), with
  `LibvirtVM` hosts powered off and empty as the "bare metal".
- **Done when:** a lab on one KVM box creates a management Rancher, emulated BMHs and a CAPI RKE2
  cluster, and `destroy` removes them all.

**F2. Elemental images.** Only if decision 1 says yes. The work would be:

- an OS profile kind that builds an Elemental image (their `elemental-config` module, rebuilt only
  when a hashed input changes) instead of using a stock cloud image;
- a place to run the build: a build VM on the site, as they do, so the workstation needs no image
  tools;
- Ignition instead of cloud-init for those hosts.

Spike it on Harvester first, where their `export-from-volume` path already works.

## Order and size

| Phase | Rough size | Can start |
| --- | --- | --- |
| A | 1 to 2 days | Now |
| B | 3 to 4 days, then a live check | Now; B3 after decision 2 |
| C | 3 to 5 days | Now |
| D | 3 days | Now |
| E | 1 day of writing | Now; E3 after decision 3 |
| F1 | 2 weeks or more | After §18 phase 2 |
| F2 | Unknown | After decision 1 |

These are guesses, not measurements. I'd go A, then B, then C, because they have the most effect
on AI Factory demos. D and E fit in between.

Live verification is the common gap. B needs a GPU Harvester, C and D need AWS access, and F needs
a KVM box. None of it should count as done until those runs happen.
