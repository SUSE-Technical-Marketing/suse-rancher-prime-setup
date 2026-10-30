import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import type { ResolvedAwsSite } from "@lab/schema";

/** Tags on everything a lab creates on AWS: its own resources and the machines Rancher makes for it. */
export const TAGS = {
    lab: "lab.geeko.me/lab",
    site: "lab.geeko.me/site",
    owner: "lab.geeko.me/owner",
    expires: "lab.geeko.me/expires",
} as const;

export interface LabTagsArgs {
    lab: string;
    site: ResolvedAwsSite;
    owner: string;
    /** When the lab was first created (ISO 8601), for the expiry tag of a site with a `ttl`. */
    createdAt?: string;
}

export function labTags({ lab, site, owner, createdAt }: LabTagsArgs): Record<string, string> {
    const expires = site.ttl && createdAt ? new Date(Date.parse(createdAt) + site.ttl * 1000).toISOString() : undefined;
    return { [TAGS.lab]: lab, [TAGS.site]: site.name, [TAGS.owner]: owner, ...(expires ? { [TAGS.expires]: expires } : {}) };
}

/** The profile in the run's shared credentials file the CLI writes a site's keys under. */
export const awsProfile = (site: string) => `lab-${site}`;

export interface AwsNetworkArgs {
    lab: string;
    site: ResolvedAwsSite;
}

/**
 * A lab's network on an AWS site: a VPC, a public subnet per zone (machines get public addresses
 * and reach Rancher through the internet gateway), and the security group Rancher's EC2 machines
 * run in. Tags come from the provider's default tags.
 *
 * The security group lets the machines talk to each other, SSH in (Rancher's node driver sets them
 * up over SSH, from wherever Rancher runs) and HTTP(S) to ingress; everything out.
 */
export class AwsNetwork extends pulumi.ComponentResource {
    readonly vpc: aws.ec2.Vpc;
    /** By zone letter. */
    readonly subnets: Record<string, aws.ec2.Subnet> = {};
    readonly securityGroup: aws.ec2.SecurityGroup;
    /** What a machine in the network needs to exist first (the routes out), and outlive it. */
    readonly ready: pulumi.Resource[];

    constructor(name: string, args: AwsNetworkArgs, opts?: pulumi.ComponentResourceOptions) {
        super("lab:aws:Network", name, {}, opts);
        const o = { parent: this };
        const { lab, site } = args;

        this.vpc = new aws.ec2.Vpc(`${name}/vpc`, {
            cidrBlock: site.vpcCidr,
            enableDnsSupport: true,
            enableDnsHostnames: true,
            tags: { Name: lab },
        }, o);
        const gateway = new aws.ec2.InternetGateway(`${name}/gateway`, { vpcId: this.vpc.id, tags: { Name: lab } }, o);
        const routes = new aws.ec2.RouteTable(`${name}/routes`, {
            vpcId: this.vpc.id,
            routes: [{ cidrBlock: "0.0.0.0/0", gatewayId: gateway.id }],
            tags: { Name: lab },
        }, o);
        const associations = site.zones.map(zone => {
            const subnet = this.subnets[zone.letter] = new aws.ec2.Subnet(`${name}/subnet-${zone.letter}`, {
                vpcId: this.vpc.id,
                cidrBlock: zone.cidr,
                availabilityZone: zone.az,
                mapPublicIpOnLaunch: true,
                // Where Kubernetes puts internet-facing load balancers.
                tags: { Name: `${lab}-${zone.letter}`, "kubernetes.io/role/elb": "1" },
            }, o);
            return new aws.ec2.RouteTableAssociation(`${name}/subnet-${zone.letter}`, { subnetId: subnet.id, routeTableId: routes.id }, o);
        });

        const anywhere = { cidrBlocks: ["0.0.0.0/0"], ipv6CidrBlocks: ["::/0"] };
        this.securityGroup = new aws.ec2.SecurityGroup(`${name}/nodes`, {
            // Rancher's node driver finds it by name.
            name: `${lab}-nodes`,
            description: `Machines of lab ${lab}`,
            vpcId: this.vpc.id,
            ingress: [
                { description: "between the lab's machines", protocol: "-1", fromPort: 0, toPort: 0, self: true },
                { description: "SSH, for Rancher's node driver", protocol: "tcp", fromPort: 22, toPort: 22, ...anywhere },
                { description: "HTTP to ingress", protocol: "tcp", fromPort: 80, toPort: 80, ...anywhere },
                { description: "HTTPS to ingress", protocol: "tcp", fromPort: 443, toPort: 443, ...anywhere },
            ],
            egress: [{ protocol: "-1", fromPort: 0, toPort: 0, ...anywhere }],
            tags: { Name: `${lab}-nodes` },
        }, o);

        this.ready = [gateway, routes, ...associations, this.securityGroup];
        this.registerOutputs({});
    }
}
