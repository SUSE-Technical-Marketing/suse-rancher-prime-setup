import * as pulumi from "@pulumi/pulumi";

interface Inputs {
    /** What `value` was looked up for; a new key takes the value of that run. */
    key: string;
    value: string;
}

/**
 * A looked-up value, kept until what it was looked up for changes. An OS's AMI is the newest one
 * at lookup time; without this every new AMI release would change the machine pools, and Rancher
 * would replace their machines.
 */
const provider: pulumi.dynamic.ResourceProvider = {
    async create(inputs: Inputs) {
        return { id: inputs.key, outs: inputs };
    },
    async diff(_id: string, olds: Inputs, news: Inputs) {
        return { changes: olds.key !== news.key };
    },
    async update(_id: string, _olds: Inputs, news: Inputs) {
        return { outs: news };
    },
};

export class Pinned extends pulumi.dynamic.Resource {
    declare readonly value: pulumi.Output<string>;

    constructor(name: string, args: { key: pulumi.Input<string>; value: pulumi.Input<string> }, opts?: pulumi.CustomResourceOptions) {
        super(provider, name, args, opts, "lab", "Pinned");
    }
}
