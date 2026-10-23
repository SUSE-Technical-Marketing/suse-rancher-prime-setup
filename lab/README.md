# Lab engine

Describe a lab environment on SUSE Virtualization (Harvester) in one YAML file and build it with
one command. See [DESIGN.md](DESIGN.md) for the full design and the lab file reference.

> **Status: M0.** The CLI, the lab file format, validation, secrets and the Harvester ownership
> check work. Nothing is built on Harvester yet: `up` of a lab with hosts only records the lab.
> Next up is M1 (Harvester base and VMs).

## Getting started

```bash
cd lab
mise install                 # node, pnpm, pulumi
mise exec -- pnpm install
mise run lab -- validate labs/rancher-harvester-rke2.yaml
mise run lab -- plan     labs/rancher-harvester-rke2.yaml
```

Commands: `validate`, `plan`, `preview`, `up`, `destroy`, `outputs`, `release`, and `profiles`
(lists every host profile with its rules). Run `mise run lab -- --help` for options.

## Personal config

Everything that belongs to you rather than to a lab goes in `~/.config/lab/config.yaml`
(or `$LAB_CONFIG`): secret values, your Harvesters' addresses and logins, and local image files.

```yaml
secrets:
  hv-north:         { username: admin, password: "cmd:pass show lab/hv-north" }
  cloudflare-token: env:CF_API_TOKEN
  ssh-key:          file:~/.ssh/id_ed25519
  rancher-admin:    "cmd:pass show lab/rancher-admin"
harvesters:
  hv-north: { url: https://hv-north.lab.geeko.me, credentials: { $secret: hv-north } }
images:
  sles-16: { file: ~/images/SLES-16.0-Minimal-VM.x86_64-Cloud.qcow2 }
```

Secret values may be literal, `env:VAR`, `file:path` or `cmd:<command>`. Any secret can also be set
as an environment variable `LAB_SECRET_<NAME>` (for example `LAB_SECRET_HV_NORTH`, as JSON
`{"username":"...","password":"..."}` for credentials). Lab files only ever say `{ $secret: name }`.

## State

Lab state lives in `~/.local/share/lab/state` (`$LAB_STATE_URL` to override). Secrets in it are
encrypted with a passphrase from `$PULUMI_CONFIG_PASSPHRASE(_FILE)`, or otherwise from
`~/.config/lab/passphrase`, which the CLI creates on first use. **Keep that file**: without it you
can't update or destroy your labs.

## One lab per Harvester

`up` claims every Harvester the lab uses by writing a `lab-owner` ConfigMap on it, and refuses to
touch a Harvester claimed by another lab or person. `destroy` releases the claim.
`release` (with `--force` for someone else's claim) clears a stale one.

## Development

```bash
mise run test        # unit tests
mise run typecheck   # tsc in every package
```

| Path | What |
|---|---|
| `cli/` | The `lab` command (Pulumi Automation API, secrets, Harvester claims) |
| `program/` | The Pulumi program the CLI runs; `profiles.ts` has one builder per profile |
| `packages/schema/` | Lab file schema, loading, validation and resolution |
| `packages/schema/src/profiles/` | Profile definitions: settings and rules, one file per profile |
| `packages/core/` | Harvester API client, ownership claims |
| `os/` | Built-in OS profiles (YAML) |
| `labs/` | Example labs |
