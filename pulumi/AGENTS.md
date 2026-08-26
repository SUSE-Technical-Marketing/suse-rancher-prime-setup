# Pulumi setup — agent guide

## Scope

This directory is the **entire** Pulumi setup. It is separate from `apps/`, which is deployed via
**Fleet** (GitOps bundles referenced from `fleet/`). The two mechanisms are unrelated: a Pulumi
question is answered inside `pulumi/`, a Fleet question inside `apps/`. Do not look outside
`pulumi/` when working on Pulumi code, and do not add Helm installs here that belong in a Fleet
bundle (or vice versa).

## Toolchain

Node, pnpm and the Pulumi CLI come from [mise-en-place](https://mise.jdx.dev/) — see
[mise.toml](mise.toml). There is no globally installed pnpm; plain `pnpm ...` fails with
"command not found".

Run everything through mise, with `pulumi/` as the working directory:

```bash
mise exec -- pnpm install
mise exec -- pnpm -r build          # build all workspace packages (tsc -p . per package)
mise exec -- pnpm -r generate       # regenerate CRD bindings via crd2pulumi
mise exec -- npx tsc --noEmit -p setups/sample-setup   # typecheck one stack
mise exec -- pulumi up              # from inside a setups/<name> directory
```

Because the mise config lives here, running from the repository root does not activate the right
toolchain.

## Workspace layout

pnpm workspace ([pnpm-workspace.yaml](pnpm-workspace.yaml)) over `modules/*` and `setups/*`, with
`linkWorkspacePackages: true`.

### `modules/` — reusable component libraries

| Package | Contents |
| --- | --- |
| `@suse-tmm/common` | [`HelmApp`](modules/common/src/kubernetes/helmapp.ts), [`RancherClient`](modules/common/src/rancher-client.ts), [`KubeWait`](modules/common/src/resources/kubewait.ts), kubeconfig resources, `waitFor`, cloud-init helpers, opts/merge utilities |
| `@suse-tmm/harvester` | Harvester + KubeVirt CRD bindings, VM/image/network/IP-pool components, `HarvesterSetting`, `HarvesterAddon` |
| `@suse-tmm/kubernetes-apps` | Opinionated app installs ([apps.ts](modules/kubernetes-apps/src/apps.ts)), TLS/cert-manager, Cloudflare ingress |
| `@suse-tmm/rancher` | Rancher install ([install/](modules/rancher/src/install/)), UI plugins, Fleet repos, Harvester cloud provider, Rancher CRD bindings |

Dependency direction is `common` → `harvester`/`kubernetes-apps` → `rancher`. Keep it that way;
nothing in `common` may import the others.

### `setups/` — the deployable Pulumi programs

`sample-setup` (Harvester → VM → Rancher → plugins → Fleet), `base-harvester`, `virtualmachine`,
`k3k-cluster-import`. Each has one `Pulumi.<stack>.yaml` per lab environment. State lives in the
local backend under [state/](state/).

## Conventions

**Versions are centralised per setup.** All chart/CRD/distro versions live in
`setups/<name>/versions.ts` (e.g. [sample-setup/versions.ts](setups/sample-setup/versions.ts)) and
are threaded through component args. Never hard-code a version inside a `modules/` component;
add an arg and pass it from `versions.ts`.

**Config is namespaced `pulumi.Config` read in one place.** Each setup has a `config.ts` exporting
typed interfaces plus a single `loadConfig()`. Add new settings there rather than calling
`new pulumi.Config()` deeper in the program.

**Helm installs go through `HelmApp`,** not `k8s.helm.v3.Release` directly. It handles namespace
creation, defaults the namespace to the release name (important for OCI charts, where the chart
string is a URL), omits `repositoryOpts` for OCI, and defaults `retainOnDelete: true`. Reusable
installs belong in [kubernetes-apps/src/apps.ts](modules/kubernetes-apps/src/apps.ts) as small
factory functions taking `(version, opts)`.

**Raw manifests use `k8s.yaml.v2.ConfigFile`,** which accepts a URL directly — used for the
Gateway API CRDs, which neither k3s/RKE2 nor the Traefik chart ship.

**Dynamic provider vs ComponentResource** is documented in
[modules/rancher/src/PROVIDER_PATTERNS.md](modules/rancher/src/PROVIDER_PATTERNS.md). Short version:
custom API calls, polling and token fetching → `pulumi.dynamic.Resource`; composing several real
resources → `pulumi.ComponentResource` with a `suse-tmm:...` type token.

**Talking to Rancher/Kubernetes outside a provider** goes through `RancherClient`. Built from a
kubeconfig it targets the API server directly, so any path works — `apis/<group>/<version>/...`
for CRDs and `api/v1/...` for core resources such as Secrets.

**`waitFor` retry semantics matter.** `undefined` means "not ready, poll again"; a thrown error
aborts the whole wait. Inside a poll probe, translate every expected not-yet condition (missing
status field, 404, empty secret) into `undefined`, and let only genuine failures throw.

**`KubeWait`** is the declarative counterpart — block until a named resource reaches a condition
(e.g. the `gitrepos.fleet.cattle.io` CRD becoming `Established` after a Rancher install).

**Two opts helpers** in [modules/common/src/opts.ts](modules/common/src/opts.ts):

- `noProvider(opts)` strips the `provider` — needed for dynamic resources and components that
  build their own provider, since they must not inherit a Kubernetes provider.
- `withDependsOn(opts, ...resources)` appends dependencies. Prefer it over spreading
  `{ ...opts, dependsOn: [x] }`, which silently discards the caller's own `dependsOn` — an easy way
  to make a chart install race the cluster it is installed into.

**Credentials never land in plaintext state.** Config secrets are `pulumi.Output<string>` from
`requireSecret`. When a dynamic provider output embeds a token (for example a Rancher cluster
registration manifest URL), set `additionalSecretOutputs` on the resource. Do not log token values.

## Generated CRD bindings

`modules/*/generated/` is produced by `crd2pulumi` from the YAML in `modules/*/crd-sources/` via
each package's `generate` script. Never hand-edit `generated/`; add or update a CRD source and
regenerate. The generated types are re-exported namespaced from the package `index.ts`
(`management`, `provisioning`, `fleet`, `harvesterhci`, `kubevirt`, ...).

## Build gotcha: modules are consumed as compiled output

`@suse-tmm/rancher` and `@suse-tmm/kubernetes-apps` declare `main: bin/index.js` / `types:
bin/index.d.ts`, so setups consume their **compiled** `bin/` output. After editing either module you
must `mise exec -- pnpm -r build` before `pulumi preview`/`up`, or the stack silently runs the
previous version.

`@suse-tmm/common` and `@suse-tmm/harvester` declare no `main`, so they resolve to their root
`index.ts` through Pulumi's ts-node runtime. Building them is still required for the other modules
to typecheck against them.

Each package's `tsconfig.json` uses `"files": ["index.ts"]`, so a file that nothing re-exports from
`index.ts` is never typechecked. Wire new files into the package `index.ts`.

## Known rough edges

- Three setups (`sample-setup`, `virtualmachine`, `base-harvester`) all declare
  `"name": "test"` in `package.json`, and `sample-setup/Pulumi.yaml` is also named `test`.
- Several scratch files (`Untitled-*.js`, `*.http`) sit in `pulumi/` and in the repository root.
- `@suse-tmm/common` has a `test` script wired to mocha, but there are no test directories in any
  module — there is currently no test suite to run.
