import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import {
    DescribeInstancesCommand, DescribeInternetGatewaysCommand, DescribeKeyPairsCommand, DescribeNetworkInterfacesCommand,
    DescribeLaunchTemplatesCommand, DescribeRouteTablesCommand, DescribeSecurityGroupsCommand, DescribeSubnetsCommand, DescribeVolumesCommand, DescribeVpcsCommand,
    EC2Client, type Filter,
} from "@aws-sdk/client-ec2";
import { DescribeClusterCommand, EKSClient, ListClustersCommand } from "@aws-sdk/client-eks";
import { AWS_CREDENTIAL_FIELDS, mapOf, renderSecretTemplate, ResolvedAwsSite, ResolvedLab } from "@lab/schema";
import { ResolvedSecret } from "./secrets";

/** Keep in sync with packages/aws (TAGS, awsProfile). */
const LAB_TAG = "lab.geeko.me/lab";
const SITE_TAG = "lab.geeko.me/site";
export const awsProfile = (site: string) => `lab-${site}`;

export interface AwsKeys {
    site: ResolvedAwsSite;
    accessKey: string;
    secretKey: string;
}

export function awsKeys(lab: ResolvedLab, secrets: Record<string, ResolvedSecret>): AwsKeys[] {
    return lab.awsSites.map(site => ({ site, ...mapOf(site.credentials, AWS_CREDENTIAL_FIELDS, t => renderSecretTemplate(t, secrets)) }));
}

/** A shared credentials file with a profile per site, for Pulumi's AWS providers (they name their profile). */
export function credentialsFile(keys: AwsKeys[]): string {
    return keys.map(k => `[${awsProfile(k.site.name)}]\naws_access_key_id = ${k.accessKey}\naws_secret_access_key = ${k.secretKey}\n`).join("\n");
}

const options = (k: AwsKeys) => ({ region: k.site.region, credentials: { accessKeyId: k.accessKey, secretAccessKey: k.secretKey } });

/** The CloudFormation stacks Rancher's eks-operator makes for a cluster: its IAM roles, named after it. */
const EKS_STACKS = ["eks-service-role", "node-instance-role", "ebs-csi-driver-role"];

/**
 * What the lab may have left on its AWS sites, found by its tags: the VPC and what's in it, and the
 * machines Rancher's node driver made (tagged too). Network interfaces aren't tagged; any left in
 * the lab's VPCs (a load balancer's, say) block deleting them. For EKS clusters: the EKS cluster
 * (tagged), and the IAM stacks and launch template Rancher names after it.
 */
export async function findAwsLeftovers(lab: ResolvedLab, keys: AwsKeys[]): Promise<{ found: string[]; terminating: string[] }> {
    const found: string[] = [];
    const terminating: string[] = [];
    for (const k of keys) {
        const ec2 = new EC2Client(options(k));
        const at = `${k.site.name} (${k.site.region})`;
        const tagged: Filter[] = [{ Name: `tag:${LAB_TAG}`, Values: [lab.name] }, { Name: `tag:${SITE_TAG}`, Values: [k.site.name] }];
        const report = (what: string, ids: string[]) => { if (ids.length > 0) found.push(`${at}: ${what}: ${ids.join(", ")}`); };
        try {
            const instances = (await ec2.send(new DescribeInstancesCommand({ Filters: [...tagged, { Name: "instance-state-name", Values: ["pending", "running", "stopping", "stopped", "shutting-down"] }] })))
                .Reservations?.flatMap(r => r.Instances ?? []) ?? [];
            report("instances", instances.filter(i => i.State?.Name !== "shutting-down").map(i => i.InstanceId!));
            const dying = instances.filter(i => i.State?.Name === "shutting-down").map(i => i.InstanceId!);
            if (dying.length > 0) terminating.push(`${at}: instances: ${dying.join(", ")}`);
            report("volumes", ((await ec2.send(new DescribeVolumesCommand({ Filters: tagged }))).Volumes ?? []).map(v => v.VolumeId!));
            const vpcs = ((await ec2.send(new DescribeVpcsCommand({ Filters: tagged }))).Vpcs ?? []).map(v => v.VpcId!);
            report("VPCs", vpcs);
            report("subnets", ((await ec2.send(new DescribeSubnetsCommand({ Filters: tagged }))).Subnets ?? []).map(s => s.SubnetId!));
            report("internet gateways", ((await ec2.send(new DescribeInternetGatewaysCommand({ Filters: tagged }))).InternetGateways ?? []).map(g => g.InternetGatewayId!));
            report("route tables", ((await ec2.send(new DescribeRouteTablesCommand({ Filters: tagged }))).RouteTables ?? []).map(r => r.RouteTableId!));
            report("security groups", ((await ec2.send(new DescribeSecurityGroupsCommand({ Filters: tagged }))).SecurityGroups ?? []).map(g => `${g.GroupName} (${g.GroupId})`));
            if (vpcs.length > 0) {
                const enis = (await ec2.send(new DescribeNetworkInterfacesCommand({ Filters: [{ Name: "vpc-id", Values: vpcs }] }))).NetworkInterfaces ?? [];
                report("network interfaces in the lab's VPC", enis.map(e => `${e.NetworkInterfaceId}${e.Description ? ` (${e.Description})` : ""}`));
            }
            // The node driver names a machine's key pair after the machine: <cluster>-<pool>-<id>.
            const clusters = lab.downstream.filter(d => d.type === "ec2" && d.site === k.site.name).map(d => `${d.name}-`);
            const pairs = (await ec2.send(new DescribeKeyPairsCommand({}))).KeyPairs ?? [];
            report("key pairs of the lab's machines", pairs.map(p => p.KeyName!).filter(n => clusters.some(c => n.startsWith(c))));

            const eksNames = lab.downstream.filter(d => d.type === "eks" && d.site === k.site.name).map(d => d.name);
            if (eksNames.length > 0) {
                const eks = new EKSClient(options(k));
                const listed = new Set((await eks.send(new ListClustersCommand({}))).clusters ?? []);
                const mine: string[] = [];
                for (const name of eksNames.filter(n => listed.has(n))) {
                    const tags = (await eks.send(new DescribeClusterCommand({ name }))).cluster?.tags ?? {};
                    if (tags[LAB_TAG] === lab.name) mine.push(name);
                }
                report("EKS clusters", mine);
                const cfn = new CloudFormationClient(options(k));
                const stacks: string[] = [];
                for (const name of eksNames.flatMap(n => EKS_STACKS.map(s => `${n}-${s}`))) {
                    try {
                        const stack = (await cfn.send(new DescribeStacksCommand({ StackName: name }))).Stacks?.[0];
                        if (stack && stack.StackStatus !== "DELETE_COMPLETE") stacks.push(`${name} (${stack.StackStatus})`);
                    } catch (e) {
                        if (!/does not exist/.test((e as Error).message)) throw e;
                    }
                }
                report("CloudFormation stacks of the EKS clusters", stacks);
                const templates = await ec2.send(new DescribeLaunchTemplatesCommand({ Filters: [{ Name: "launch-template-name", Values: eksNames.map(n => `rancher-managed-lt-${n}`) }] }));
                report("launch templates of the EKS clusters", (templates.LaunchTemplates ?? []).map(t => t.LaunchTemplateName!));
            }
        } catch (e) {
            found.push(`${at}: couldn't check (${(e as Error).message})`);
        }
    }
    return { found, terminating };
}
