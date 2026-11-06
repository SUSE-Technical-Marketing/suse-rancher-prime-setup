import * as pulumi from "@pulumi/pulumi";
import { kubeRequest } from "@lab/kube";

const DEFAULT = "storageclass.kubernetes.io/is-default-class";
const CLASSES = "/apis/storage.k8s.io/v1/storageclasses";

interface Inputs {
    harvester: string;
    /** The lab's class that becomes the default. */
    className: string;
    /** The classes this took the default from (kept for the delete). */
    previous?: string[];
}

async function setDefault(harvester: string, name: string, value: boolean): Promise<number> {
    const res = await kubeRequest({ context: harvester }, "PATCH", `${CLASSES}/${name}`, { metadata: { annotations: { [DEFAULT]: String(value) } } });
    return res.status;
}

/**
 * Takes the default storage class away from whichever class has it (Harvester's own
 * `harvester-longhorn`), so the lab's class can be the default: Harvester's webhook refuses a
 * second default ("reset it first"). The lab's class depends on this resource, and a separate
 * DefaultStorageClass resource promotes it after creation, without affecting preview.
 *
 * On delete the default goes back to what it was, once the lab's class is gone (the class depends
 * on this resource, so it's deleted first): a destroyed lab leaves the Harvester as it found it.
 */
export const defaultStorageClassResetProvider: pulumi.dynamic.ResourceProvider = {
    async create(inputs: Inputs) {
        const list = await kubeRequest({ context: inputs.harvester }, "GET", CLASSES);
        if (list.status !== 200) throw new Error(`listing storage classes on ${inputs.harvester} failed: HTTP ${list.status}`);
        const previous: string[] = (list.body?.items ?? [])
            .filter((c: any) => c.metadata?.annotations?.[DEFAULT] === "true" && c.metadata.name !== inputs.className)
            .map((c: any) => c.metadata.name);
        for (const name of previous) {
            const status = await setDefault(inputs.harvester, name, false);
            if (status !== 200) throw new Error(`resetting the default of storage class ${name} on ${inputs.harvester} failed: HTTP ${status}`);
        }
        return { id: `${inputs.harvester}/default-storage-class`, outs: { ...inputs, previous } };
    },
    async diff(_id: string, olds: Inputs, news: Inputs) {
        const replaces = (["harvester", "className"] as const).filter(k => olds[k] !== news[k]);
        return { changes: replaces.length > 0, replaces, deleteBeforeReplace: true };
    },
    async delete(_id: string, props: Inputs) {
        for (const name of props.previous ?? []) {
            // Gone already (a Harvester that was rebuilt): nothing to give back.
            const status = await setDefault(props.harvester, name, true);
            if (status !== 200 && status !== 404) throw new Error(`restoring the default of storage class ${name} on ${props.harvester} failed: HTTP ${status}`);
        }
    },
};

export class DefaultStorageClassReset extends pulumi.dynamic.Resource {
    constructor(name: string, args: { harvester: string; className: pulumi.Input<string> }, opts?: pulumi.CustomResourceOptions) {
        super(defaultStorageClassResetProvider, name, { ...args, previous: undefined }, opts, "lab", "DefaultStorageClassReset");
    }
}

export const defaultStorageClassProvider: pulumi.dynamic.ResourceProvider = {
    async create(inputs: Inputs) {
        const status = await setDefault(inputs.harvester, inputs.className, true);
        if (status !== 200) throw new Error(`setting storage class ${inputs.className} as default on ${inputs.harvester} failed: HTTP ${status}`);
        return { id: `${inputs.harvester}/${inputs.className}/default`, outs: inputs };
    },
    async diff(_id: string, olds: Inputs, news: Inputs) {
        const replaces = (["harvester", "className"] as const).filter(k => olds[k] !== news[k]);
        return { changes: replaces.length > 0, replaces, deleteBeforeReplace: true };
    },
    async delete(_id: string, props: Inputs) {
        const status = await setDefault(props.harvester, props.className, false);
        if (status !== 200 && status !== 404) throw new Error(`resetting the default of storage class ${props.className} on ${props.harvester} failed: HTTP ${status}`);
    },
};

/** Promotes an existing class on update, and demotes it before the class and reset are deleted. */
export class DefaultStorageClass extends pulumi.dynamic.Resource {
    constructor(name: string, args: { harvester: string; className: pulumi.Input<string> }, opts?: pulumi.CustomResourceOptions) {
        super(defaultStorageClassProvider, name, args, opts, "lab", "DefaultStorageClass");
    }
}
