# Using Pulumi


## Logging in to your local state directory:

```bash
mkdir ./pulumi-state
pulumi login file://$(pwd)/pulumi-state

# Setup passphrase file and setup as enviroment variable so we not bothered with having to re-enter it every time.
echo '<your-passphrass' > ~/.pulumi/config-passphrase
export PULUMI_CONFIG_PASSPHRASE_FILE=~/.pulumi/config-passphrase


```

## Creating a new stack:
```bash
cd sample-setup
pulumi stack init -s dev
```

This will output:

```bash
pulumi@60d2799eae2a:/workspaces/suse-rancher-prime-setup/pulumi/sample-setup> pulumi stack init -s dev
Created stack 'dev'
```

## Configuring the stack:
```bash
pulumi config set cert-manager:cloudflareApiKey --secret "<your-cloudflare-api-key>"
pulumi config set cert-manager:letsEncryptEmail "<your-email>"
pulumi config set cert-manager:staging true
pulumi config set harvester:name "<harvester-machine-name>" // Not the URL/FQDN, that will be constructed as "harvester.<harvester:name>.<lab:domain>"
pulumi config set --secret harvester:password "<password>"
pulumi config set harvester:username "<username>"
pulumi config set lab:domain "<your-domain>" // e.g. "geeko.me"
pulumi config set lab:sccUsername "<your-scc-username>"
pulumi config set lab:sccPassword --secret "<your-scc-password>"
pulumi config set lab:appcoUsername "<your-appco-username>"
pulumi config set lab:appcoPassword --secret "<your-appco-password>"
pulumi config set rancher:adminPassword --secret "<your-rancher-admin-password>"
pulumi config set rancher:vmName "<rancher-machine-name>" // Not the URL/FQDN, that will be constructed as "rancher.<rancher:vmName>.<lab:domain>"
pulumi config set vm:sshUser "<you>"
pulumi config set vm:sshPubKey "$(cat ~/.ssh/id_rsa.pub)"
cat ~/.ssh/id_rsa | pulumi config set vm:sshPrivKey --secret 
```

## Creating the resources:
```bash
pulumi up
```

