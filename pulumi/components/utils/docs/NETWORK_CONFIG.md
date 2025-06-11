# Network Configuration for Cloud-Init

This document describes how to use the network configuration functionality in the cloud-init utility.

## Overview

The cloud-init utility now supports defining network configurations that will be included in the generated cloud-config YAML. This allows you to configure network interfaces, IP addresses, DNS settings, and more during VM initialization.

## Basic Usage

### DHCP Interface

To configure an interface to use DHCP:

```typescript
import { cloudInit, renderCloudInit, DhcpInterface } from "@suse-tmm/utils";

const config = cloudInit(
    DhcpInterface("enp1s0")
);

console.log(renderCloudInit(config));
```

### Static Interface

To configure an interface with a static IP:

```typescript
import { cloudInit, renderCloudInit, StaticInterface } from "@suse-tmm/utils";

const config = cloudInit(
    StaticInterface(
        "enp1s0",           // interface name
        "192.168.1.100",    // IP address
        "255.255.255.0",    // netmask
        "192.168.1.1",      // gateway (optional)
        ["8.8.8.8", "8.8.4.4"], // DNS servers (optional)
        "00:11:22:33:44:55" // MAC address (optional)
    )
);
```

### Multiple Interfaces

You can configure multiple interfaces by chaining processor functions:

```typescript
import { cloudInit, DhcpInterface, StaticInterface } from "@suse-tmm/utils";

const config = cloudInit(
    DhcpInterface("enp1s0"),
    StaticInterface("enp2s0", "10.0.0.100", "255.255.255.0", "10.0.0.1")
);
```

## Advanced Usage

### Pre-built Network Configuration

For more complex scenarios, you can create a complete network configuration and apply it:

```typescript
import { 
    cloudInit, 
    createNetworkConfig, 
    createDhcpInterface, 
    createStaticInterface 
} from "@suse-tmm/utils";
import { NetworkConfiguration } from "@suse-tmm/utils";

const networkConfig = createNetworkConfig([
    createDhcpInterface("enp1s0", "00:11:22:33:44:55"),
    createStaticInterface("enp2s0", "192.168.1.100", "255.255.255.0")
]);

const config = cloudInit(
    NetworkConfiguration(networkConfig)
);
```

### Custom Network Configuration

You can also define a completely custom network configuration:

```typescript
import { cloudInit, NetworkConfiguration } from "@suse-tmm/utils";

const config = cloudInit(
    NetworkConfiguration({
        version: 1,
        config: [
            {
                type: "physical",
                name: "enp1s0",
                subnets: [{ type: "dhcp" }]
            },
            {
                type: "physical",
                name: "enp2s0",
                subnets: [{
                    type: "static",
                    address: "192.168.1.100",
                    netmask: "255.255.255.0",
                    gateway: "192.168.1.1",
                    dns_nameservers: ["8.8.8.8", "8.8.4.4"]
                }]
            }
        ]
    })
);
```

## Generated Output

The network configuration will be included in the cloud-config YAML under the `network` section:

```yaml
#cloud-config
network:
  version: 1
  config:
    - type: physical
      name: enp1s0
      subnets:
        - type: dhcp
    - type: physical
      name: enp2s0
      subnets:
        - type: static
          address: 192.168.1.100
          netmask: 255.255.255.0
          gateway: 192.168.1.1
          dns_nameservers:
            - 8.8.8.8
            - 8.8.4.4
```

## Supported Interface Types

- **physical**: Physical network interfaces
- **bond**: Bonded interfaces (future enhancement)
- **bridge**: Bridge interfaces (future enhancement)
- **vlan**: VLAN interfaces (future enhancement)

## Supported Subnet Types

- **dhcp**: Dynamic IP configuration via DHCP
- **static**: Static IP configuration
- **dhcp6**: IPv6 DHCP (future enhancement)
- **static6**: Static IPv6 configuration (future enhancement)

## API Reference

### Processor Functions (from processors.ts)

- `DhcpInterface(name: string, macAddress?: string)`: Creates a DHCP interface processor
- `StaticInterface(name, address, netmask, gateway?, dnsServers?, macAddress?)`: Creates a static interface processor
- `NetworkConfiguration(networkConfig: NetworkConfig)`: Applies a complete network configuration

### Helper Functions (from cloud-init.ts)

- `createDhcpInterface(name: string, macAddress?: string)`: Creates a DHCP interface object
- `createStaticInterface(...)`: Creates a static interface object
- `createNetworkConfig(interfaces: NetworkInterface[], version?)`: Creates a network configuration object

### Types

- `NetworkConfig`: Complete network configuration
- `NetworkInterface`: Individual network interface configuration
- `NetworkSubnet`: Subnet configuration for an interface

## Complete Example

```typescript
import { 
    cloudInit, 
    renderCloudInit,
    createNetworkConfig,
    createDhcpInterface,
    createStaticInterface
} from "@suse-tmm/utils";
import {
    DhcpInterface,
    StaticInterface,
    NetworkConfiguration
} from "@suse-tmm/utils";

// Example 1: Simple DHCP interfaces
const example1 = cloudInit(
    DhcpInterface("enp1s0"),
    DhcpInterface("enp2s0")
);

// Example 2: Mixed DHCP and static
const example2 = cloudInit(
    DhcpInterface("enp1s0"),
    StaticInterface("enp2s0", "10.0.0.100", "255.255.255.0", "10.0.0.1")
);

// Example 3: Pre-built configuration
const networkConfig = createNetworkConfig([
    createDhcpInterface("enp1s0"),
    createStaticInterface("enp2s0", "192.168.1.100", "255.255.255.0")
]);

const example3 = cloudInit(
    NetworkConfiguration(networkConfig)
);

console.log(renderCloudInit(example1));
```

This matches your original network configuration format and follows the processors implementation pattern used throughout the codebase.
