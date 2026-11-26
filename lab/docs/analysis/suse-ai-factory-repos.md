# Lab engine vs the SUSE AI Factory deployment repos

As of 2026-11-26. Compares our lab engine (`lab/`) with two community repos by Eduardo Mínguez:

- [suse-ai-factory-cloud-providers](https://github.com/e-minguez/suse-ai-factory-cloud-providers):
  Terraform that deploys SUSE AI Factory on seven providers.
- [suse-ai-factory-baremetal](https://github.com/e-minguez/suse-ai-factory-baremetal): notes,
  manifests and libvirt scripts for an AI Factory cluster on Metal3 bare metal, emulated with
  sushy-tools.

The earlier comparison with lab-in-a-box, and the plan it produced, is in
[Lab engine vs lab-in-a-box](https://claude.ai/artifact/Js7df1nNqAchg8KSBc2V3h) and DESIGN §18.

**How I compared them:** I read both READMEs, the cloud repo's `CLAUDE.md`, catalog, ADR index,
CI jobs and layout, and every file of the bare-metal repo. I did not read the Terraform modules
line by line. I did not run either repo, or their tests.

## Summary

The three overlap less than they first seem to, because each solves a different problem:

- **The cloud repo** builds one production-shaped AI Factory cluster on any of seven providers. It
  is thorough about each provider.
- **The bare-metal repo** records how to bring up a cluster on Metal3 by hand.
- **Our engine** composes a whole demo lab: Rancher, downstream clusters, profiles and teardown,
  in one typed graph.

**Recommendation:** don't merge with either repo. Take four things:

- GPU nodes.
- Their cluster shapes, as example labs.
- Their provider knowledge, when we build phases 2 and 3.
- A few of their quality habits.

The open choice is whether Elemental images become a way our hosts can boot.

## suse-ai-factory-cloud-providers

**What it is:** one Terraform repository that deploys SLES, RKE2, Rancher, the AI Factory operator
and the NVIDIA GPU operator. Nodes boot a SUSE Elemental image with the cluster configuration built
in.

- **Providers (7):** aws, evroc, exoscale, gcp, harvester, oci, vultr. gcp is experimental.
  Harvester's single-node and HA deploys passed on 2026-11-19; its GPU path is untested.
- **Shape of the code:**
  - **Modules:** one per provider, plus shared ones (`elemental-config`, `image-factory`,
    `rke2-ports`).
  - **Common variables:** 67, declared once and symlinked into every provider.
  - **`examples/<provider>`:** one root per provider, each with a `deploy.sh` that has the same
    interface everywhere.
  - **Size:** about 24k lines of HCL, plus 37k lines of shell, Go and tests.
- **Image pipeline:** the Elemental image is built on a jumphost at the provider, then turned into
  that provider's image format: an AMI, a snapshot, a template or a Harvester image exported from
  a volume. It is rebuilt only when `build_hash` changes, and every build input feeds that hash.
  `--rebuild` bumps a counter that is part of the hash.
- **Deploys in passes:** some providers need 2 or 3 applies to break dependency cycles, for example
  between a load balancer and its nodes. Every pass plans, lists what would be replaced or
  destroyed, asks, then applies the saved plan.
- **Cluster model:** `control_plane_count`, `worker_pools` and `gpu_pools`. Storage is either
  local-path or SUSE Storage on selected nodes. Clusters grow without a new image.
- **Extras:**
  - **`tools/multicluster`:** several clusters from one checkout, imported into a management
    Rancher.
  - **`catalog/`:** five documented shapes, from one GPU node up to a four-cluster platform.
  - **Observability and security:** optional SUSE Observability and SUSE Security components.
  - **Cost estimates:** a Go tool that estimates cost before a deploy.
  - **Leftovers:** a read-only checker per provider, with exit codes 0, 1, 2 and 3.
  - **Orphans:** for evroc, a tool that adopts objects missing from state.
  - **Web UI:** an alpha web UI in a hardened container.
- **Discipline:**
  - **CI:** 19 required checks on a protected `main`: fmt, validate, tflint, `terraform test` with
    mocked providers (34 suites), shellcheck, 32 shell test scripts, Go tests, an image build and
    an OpenTofu run.
  - **Releases:** release-please with Conventional Commits.
  - **Dependencies:** actions pinned to SHAs, with dependabot.
  - **Docs:** 13 ADRs, plus workarounds filed as labelled issues.
- **History:** 82 commits since 2026-10-02. 68 are by the author and 12 by dependabot.
- **Limits:**
  - **Hostnames:** sslip.io or load-balancer names by default; real DNS is up to you.
  - **One cluster per state:** clusters are separate Terraform states, and `multicluster` ties
    them together afterwards.
  - **Scope:** no profiles beyond its fixed component list, and no downstream clusters provisioned
    by Rancher.
  - **Secrets in state:** Terraform state holds them, which ADR 005 accepts.

## suse-ai-factory-baremetal

**What it is:** a guide, not automation. It brings up a 3 control-plane, 2 worker RKE2 cluster
through Metal3 (Ironic and the baremetal-operator) and Cluster API (CAPRKE2, CAPM3, Rancher
Turtles). The "bare metal" is libvirt VMs behind sushy-tools, which emulates a Redfish BMC.

- **Contents:**
  - **Image:** the Elemental config for a raw image.
  - **Machines:** five BareMetalHost manifests.
  - **Cluster:** CAPI cluster, control-plane and worker manifests.
  - **Scripts:** libvirt scripts to create and delete VMs (virt-install, UEFI, virtio, fixed MACs).
  - **Teardown:** a brute-force teardown.
- **The management cluster** comes from quickstart.ai.suse.com. Metal3 and the Turtles providers
  are added by hand, with a validated version table: Rancher 2.15.1, turtles-providers
  307.0.8+up0.27.0, CAPI 1.13.3, CAPRKE2 0.25.0, CAPM3 1.13.2, RKE2 1.36.3.
- **Most useful part:** the troubleshooting.
  - BMHs need `rootDeviceHints`, because virtio disks are `/dev/vda`.
  - An older Turtles pins a CAPI provider version the chart doesn't ship.
  - Disk cleaning slows every provision.
- **History:** 13 commits on 2026-10-27 and 28. Every value is a placeholder you fill in by hand.
- The cloud repo reserves ADR 011 for "bare metal provider, in review on branch
  `feat/baremetal`". This repo looks like the groundwork for that.

## Side by side

| Dimension | Our lab engine | AI Factory cloud repo | AI Factory bare-metal repo |
| --- | --- | --- | --- |
| Purpose | Demo labs of the SUSE stack | AI Factory clusters, production-shaped | How-to for Metal3 bare metal |
| Tooling | TypeScript, Pulumi, zod schema | Terraform or OpenTofu, bash, Go tools | kubectl, helm, virsh, YAML |
| Unit of work | A lab: many hosts and clusters in one graph | One cluster per state; `multicluster` links them | One CAPI cluster |
| Where it runs | Harvester, AWS, existing machines | aws, evroc, exoscale, gcp, harvester, oci, vultr | libvirt with emulated BMCs (real BMCs in principle) |
| OS on nodes | Stock cloud images and cloud-init (SLES 16, SL Micro 6.1, Leap 16, Rocky 9, Ubuntu 24.04) | Elemental image built per cluster, configured by Ignition | Elemental raw image, Ignition from CAPRKE2 |
| Kubernetes | k3s or RKE2 on hosts; downstream clusters through Rancher (Harvester, EC2, EKS, k3k, custom) | RKE2 baked into the image | RKE2 through CAPRKE2 |
| AI Factory | `ai-factory` profile: the `aif-operator` chart on Rancher (2.4.0) | Release manifest or version (`aif_release`), GPU operator | Release manifest 2.3.1 |
| GPUs | `gpu-operator` Fleet profile; no GPU device on a `HarvesterVM` | `gpu_pools`, passthrough on Harvester (untested), bare-metal GPU plans | Not covered |
| Composition | Profiles with settings, requirements and conflicts; Fleet profiles | Fixed component list, switched by variables | Fixed |
| DNS and TLS | Lab domain, cert-manager, wildcard certificates | sslip.io or your own names; TLS from Terraform | sslip.io |
| Preview | `plan` and `preview` of the whole lab | Plan per pass, with replacements and destroys listed | None |
| Teardown | Ownership claims, `destroy --check` | `--destroy` and a leftover checker per provider | Brute-force script |
| Cost | Lab `ttl` and `reap` | Estimate before deploy (aws, evroc, exoscale, gcp, oci, vultr) | None |
| Tests and CI | Over 360 tests; CI written, not yet run | 19 required checks, mocked `terraform test`, shell and Go tests | None |
| Release process | None | release-please, Conventional Commits, protected `main` | None |

## Where each is stronger

**Ours:**

- **Whole labs:** a single lab can hold Rancher, its downstream clusters, Fleet, Hauler air-gap,
  MLM, observability and SSO. They cover one AI Factory cluster.
- **Typed composition:** profiles declare what they need and what they conflict with, and errors
  name the document and field.
- **Real DNS and certificates** for demos, instead of sslip.io.

**The cloud repo:**

- **Reach:** seven providers, each with a written ADR for its quirks.
- **Immutable nodes:** an Elemental image with the configuration baked in, rebuilt only when an
  input changes.
- **GPU pools** as a first-class idea.
- **Quotas and availability** are checked at plan time and fail hard.
- **Cost estimates** before a deploy.
- **Process:** required checks, release automation, pinned dependencies.

**The bare-metal repo:**

- It is the only one of the three that touches Metal3 and Cluster API, which is how SUSE Edge
  provisions bare metal.

## What to take

Ranked by value to us, with the DESIGN §18 phase each fits:

| # | Take | From | Where it lands |
| --- | --- | --- | --- |
| 1 | **GPU nodes:** a GPU device field on `HarvesterVM` (PCI passthrough), and later GPU instance types on cloud VMs | cloud repo (`gpu_pools`, Harvester `gpu_devices`) | New; small schema and backend change; testable live only on a Harvester with a GPU |
| 2 | **Their catalog shapes as example labs:** 01 inference in a box, 03 management plus GPU downstream, 05 platform | cloud repo `catalog/` | Phase 4 `lab examples`; 03 and 05 suit our downstream-cluster model better than theirs |
| 3 | **Provider knowledge for phases 2 and 3**, see the list after this table | both repos | Phases 2 and 3 |
| 4 | **Quota and availability checks** at `validate` for cloud sites | cloud repo | Phase 3 |
| 5 | **Cost estimate** for cloud labs, next to `ttl` | cloud repo `tools/cost` | Phase 3 or 4 |
| 6 | **Exit codes for `destroy --check`** (clean, leftovers, usage, inconclusive), so scripts and `reap` can act on it | cloud repo `tools/leftovers` | Small; any time |
| 7 | **Process:** release-please, Conventional Commits, SHA-pinned actions, dependabot | cloud repo | A repo decision for you |

For item 3, the provider knowledge:

- **libvirt VMs** (from the bare-metal scripts): UEFI, virtio, `host-passthrough`, fixed MACs,
  `qemu:///system`.
- **Harvester's limits** (from the cloud repo): a 1 MiB cloud-init Secret, an API certificate with
  only IP SANs, guest-agent leases, and MetalLB as the only owner of a VIP.
- **Per-provider image formats and user-data size limits.** These also bear on which clouds phase
  3 should pick (see the open questions).

**Not to take:**

- **Their pass-based deploy:** Pulumi resolves dependencies inside one graph, so we don't need it.
- **One state per cluster:** our lab-level graph is the point of our engine.
- **sslip.io hostnames:** we already have real DNS and certificates.

## Open questions

1. **Elemental as a way to boot hosts.** We could add an OS profile, or a host option, that boots a
   built Elemental image instead of a stock image with cloud-init. That would align us with how
   SUSE ships AI Factory and Edge, but it adds an image-build step, and we would have to choose
   where it runs. I'd only do it if demos need it.
2. **Which clouds for phase 3.** The plan says EC2 then Hetzner. The cloud repo shows demand for
   European providers: evroc, exoscale and vultr all work there, with sslip.io. Should Hetzner stay
   the second cloud, or should we pick one of theirs and reuse what they learned?
3. **Metal3 and Cluster API as a downstream-cluster type.** A `DownstreamCluster` of type `metal3`,
   on BareMetalHosts emulated by sushy-tools on a libvirt site, would let an Edge demo show real
   bare-metal provisioning. It depends on phase 2 (libvirt), and on whether Edge demos want it.
4. **Working with the author.** Both projects hit the same Harvester problems. Sharing findings, or
   a shared catalog of versions that work together, would help both. That's your call.

## Next steps

The phase-by-phase plan for these is in [docs/plans/ai-factory-learnings.md](../plans/ai-factory-learnings.md).

- [ ] Decide on open questions 1 and 2. They change phase 2 and 3 scope.
- [ ] Item 1: GPU passthrough on `HarvesterVM`, if a GPU Harvester is available to test on.
- [ ] Item 2: add "inference in a box" and "management plus GPU downstream" as example labs.
- [ ] Item 6: exit codes for `destroy --check`.
