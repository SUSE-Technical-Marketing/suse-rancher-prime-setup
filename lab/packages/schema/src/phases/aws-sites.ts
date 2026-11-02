// AWS sites: region, credentials and the lab's VPC there, a subnet per zone.

import { durationSeconds } from "../schema";
import { nthAddress } from "../net";
import type { Resolution } from "./context";

/** The lab's AWS sites, with the personal config's region and keys. */
export function resolveAwsSites(r: Resolution): void {
    const { lab, L, P, personal, diags, useAwsCredentials, awsSites, awsDefaults } = r;
    for (const [name, s] of Object.entries(lab.awsSites)) {
        const at = `awsSites.${name}`;
        const mine = personal.awsSites[name] ?? {};
        const region = s.region ?? mine.region;
        const credentials = s.credentials ?? mine.credentials;
        if (!region) diags.error(L, `${at}.region`, `missing; set it here or in the personal config under awsSites.${name}.region`);
        if (!credentials) diags.error(L, `${at}.credentials`, `missing; set it here or in the personal config under awsSites.${name}.credentials`);
        else useAwsCredentials(credentials, s.credentials ? L : P, s.credentials ? `${at}.credentials` : `awsSites.${name}.credentials`);

        const vpcCidr = s.vpc?.cidr ?? awsDefaults.vpcCidr;
        const letters = s.zones ?? awsDefaults.zones;
        const prefix = Number(vpcCidr.split("/")[1]);
        // A subnet per zone, a sixteenth of the VPC each; AWS takes VPCs from /16 to /28, subnets down to /28.
        if (prefix < 16 || prefix > 24) diags.error(L, `${at}.vpc.cidr`, `must be a /16 to /24: each zone gets a sixteenth of it`);
        if (nthAddress(vpcCidr, 0) !== vpcCidr.split("/")[0]) diags.error(L, `${at}.vpc.cidr`, `${vpcCidr} isn't the start of its range; use ${nthAddress(vpcCidr, 0)}/${prefix}`);
        const seen = new Set<string>();
        letters.forEach((l, i) => {
            if (seen.has(l)) diags.error(L, `${at}.zones[${i}]`, `zone ${l} is listed twice`);
            seen.add(l);
        });
        const subnetSize = 2 ** (32 - prefix - 4);
        awsSites.set(name, {
            name,
            region: region ?? "",
            credentials: credentials ?? "",
            vpcCidr,
            zones: letters.map((letter, i) => ({ letter, az: `${region ?? ""}${letter}`, cidr: `${nthAddress(vpcCidr, i * subnetSize)}/${prefix + 4}` })),
            ...(s.ttl ? { ttl: durationSeconds(s.ttl) } : {}),
        });
    }
}
