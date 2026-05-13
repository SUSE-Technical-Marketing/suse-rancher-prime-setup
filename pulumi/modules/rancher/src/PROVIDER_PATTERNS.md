# Dynamic Provider vs ComponentResource - When to Use Which

## ClusterRegistrationToken - Dynamic Provider ✅

**Why it's correct as a Dynamic Provider:**

```typescript
class ClusterRegistrationTokenProvider implements pulumi.dynamic.ResourceProvider {
    async create(inputs: ClusterRegistrationTokenProviderInputs) {
        // Custom business logic - fetch token from API
        const token = await this.fetchClusterRegistrationToken(/* ... */);
        
        return {
            id: inputs.clusterName,
            outs: { ...inputs, token },
        };
    }
}
```

**Characteristics:**
- ✅ Custom API calls to Rancher
- ✅ Polling/waiting logic
- ✅ No existing Pulumi resource for this
- ✅ Simple state management (just a token)
- ✅ Pure functional operation

## HarvesterDownstreamCluster - ComponentResource ✅

**Why it's correct as a ComponentResource:**

```typescript
export class HarvesterDownstreamCluster extends pulumi.ComponentResource {
    constructor(name: string, args: HarvesterDownstreamClusterInputs) {
        super("suse-tmm:rancher:HarvesterDownstreamCluster", name, {}, opts);

        // Creates multiple Kubernetes resources
        const machineConfigs = this.createMachineConfigs(/* ... */);
        const cluster = this.createCluster(/* ... */);
    }
}
```

**Characteristics:**
- ✅ Orchestrates multiple Kubernetes CRDs
- ✅ Uses existing Pulumi Kubernetes provider
- ✅ Complex resource relationships
- ✅ Declarative resource management
- ✅ Leverages Kubernetes reconciliation

## When to Use Each Pattern

### Use Dynamic Provider When:
1. **Custom API Logic**: Making HTTP calls to non-standard APIs
2. **Polling/Waiting**: Need to wait for external conditions
3. **Simple State**: Resource has minimal state to track
4. **No Native Provider**: No existing Pulumi provider covers your use case
5. **Functional Operations**: Pure input → output transformations

**Examples:**
- Fetching credentials/tokens
- Triggering external webhooks
- Custom validation logic
- Waiting for external systems
- Non-CRUD operations

### Use ComponentResource When:
1. **Resource Composition**: Combining multiple existing resources
2. **Infrastructure Patterns**: Reusable infrastructure components
3. **Complex Dependencies**: Managing relationships between resources
4. **Existing Providers**: Can leverage existing cloud/k8s providers
5. **Declarative Management**: Want standard resource lifecycle

**Examples:**
- Creating multiple cloud resources together
- Kubernetes workload deployments
- Infrastructure modules
- Multi-resource patterns

## Could We Convert ClusterRegistrationToken?

**Option 1: Keep as Dynamic Provider** (Recommended ✅)
```typescript
// Current approach - simple and correct
class ClusterRegistrationTokenProvider implements pulumi.dynamic.ResourceProvider {
    async create(inputs) {
        const token = await this.fetchToken(/* ... */);
        return { id: inputs.clusterName, outs: { ...inputs, token } };
    }
}
```

**Option 2: Convert to ComponentResource** (Not recommended ❌)
```typescript
// Would be overly complex for this simple use case
class ClusterRegistrationToken extends pulumi.ComponentResource {
    constructor(name: string, args: ClusterRegistrationTokenInputs) {
        super("suse-tmm:rancher:ClusterRegistrationToken", name, {}, opts);
        
        // Would need complex async handling inside ComponentResource
        // Less natural for this use case
    }
}
```

## Verdict

The current implementation is **already optimal**:

- ✅ `ClusterRegistrationToken` correctly uses Dynamic Provider
- ✅ `HarvesterDownstreamCluster` correctly uses ComponentResource
- ✅ Each follows Pulumi best practices for their respective use cases

The key insight is that both patterns serve different purposes and the current implementations chose the right pattern for each use case.