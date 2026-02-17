# Using Pulumi


## First time setup:

### Logging in to your local state directory:

```bash
mkdir ./pulumi-state
pulumi login file://$(pwd)/pulumi-state

# Setup passphrase file and setup as enviroment variable so we not bothered with having to re-enter it every time.
echo '<your-passphrass' > ~/.pulumi/config-passphrase
export PULUMI_CONFIG_PASSPHRASE_FILE=~/.pulumi/config-passphrase


```
### Creating a new stack:

```bash
cd sample-setup
pulumi stack init -s dev
```

This will output:

```bash
pulumi@60d2799eae2a:/workspaces/suse-rancher-prime-setup/pulumi/sample-setup> pulumi stack init -s dev
Created stack 'dev'
```

### Configuring the stack:
```bash
pulumi config set cert-manager:cloudflareApiKey --secret "<your-cloudflare-api-key>"
pulumi config set cert-manager:letsEncryptEmail "<your-email>"
pulumi config set cert-manager:staging false
pulumi config set harvester:name "<harvester-machine-name>" // Not the URL/FQDN, that will be constructed as "harvester.<harvester:name>.<lab:domain>"
pulumi config set --secret harvester:password "<password>"
pulumi config set harvester:username "<username>"
pulumi config set lab:domain "<your-domain>" // e.g. "geeko.me"
pulumi config set lab:appcoUsername "<your-appco-username>"
pulumi config set lab:appcoPassword --secret "<your-appco-password>"
pulumi config set lab:cloudflareApiToken --secret "<your-cloudflare-api-token>"
pulumi config set lab:cloudflareAccountId "<your-cloudflare-account-id>"
pulumi config set lab:sccUsername "<your-scc-username>"
pulumi config set lab:sccPassword --secret "<your-scc-password>"
pulumi config set lab:stackstateLicenseKey --secret "<your-suse-observability-license-key>"
pulumi config set lab:ssoEnabled "true" // Not yet used
pulumi config set rancher:adminPassword --secret "<your-rancher-admin-password>"
pulumi config set rancher:vmName "<rancher-machine-name>" // Not the URL/FQDN, that will be constructed as "rancher.<rancher:vmName>.<lab:domain>"
pulumi config set vm:sshUser "<you>"
pulumi config set vm:sshPubKey "$(cat ~/.ssh/id_rsa.pub)"
cat ~/.ssh/id_rsa | pulumi config set vm:sshPrivKey --secret
```

> [!NOTE]
> Change `cert-manager:staging` to `true` if you want to use the Let's Encrypt staging environment, which is recommended for testing purposes to avoid hitting rate limits.

### Initializing Pulumi and installing dependencies:
```bash
pulumi install
```

## Deploying the infrastructure:

If you've started a new terminal session, ensure you login to your local state directory again:

```bash
cd pulumi
pulumi login file://$(pwd)/pulumi-state
```

Create/Update the infrastructure:
```bash
cd sample-setup
pulumi up
```
