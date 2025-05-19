# Using Pulumi


## Logging in to your local state directory:

```bash
mkdir ./pulumi-state
pulumi login file://$(pwd)/pulumi-state
```

## Creating a new stack:
```bash
cd sample-setup
pulumi stack init -s dev
```

This will output:

```bash
pulumi@60d2799eae2a:/workspaces/suse-rancher-prime-setup/pulumi/sample-setup> pulumi stack init -s dev
Enter your passphrase to protect config/secrets:
Re-enter your passphrase to confirm:
Created stack 'dev'
```

## Configuring the stack:
```bash
pulumi config set harvester:url "https://harvester.<machine>.<domain>"
pulumi config set harvester:username "<username>"
pulumi config set --secret harvester:password "<password>"
```

## Creating the resources:
```bash
pulumi up
```

