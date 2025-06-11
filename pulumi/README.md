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
pulumi config set harvester:url "https://harvester.<machine>.<domain>"
pulumi config set harvester:username "<username>"
pulumi config set --secret harvester:password "<password>"
pulumi config set vm:sshUser "<you>"
pulumi config set vm:sshPubKey "$(cat ~/.ssh/id_rsa.pub)"
cat ~/.ssh/id_rsa | pulumi config set vm:sshPrivKey --secret 
pulumi config set cert-manager:staging true
pulumi config set cert-manager:letsEncryptEmail "<your-email>"
pulumi config set cert-manager:cloudflareApiKey --secret "<your-cloudflare-api-key>"
pulumi config set rancher:adminPassword --secret "<your-rancher-admin-password>"
pulumi config set lab:domain "<your-domain>" // e.g. "geeko.me"
```

## Creating the resources:
```bash
pulumi up
```

