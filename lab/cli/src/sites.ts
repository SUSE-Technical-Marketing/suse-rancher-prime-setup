import type { SiteBackends } from "@lab/backends";
import { findAwsLeftovers, type AwsKeys } from "./aws";
import type { HarvesterSession } from "./harvesters";
import { findHarvesterLeftovers } from "./leftovers";

/** What the CLI has for reaching a lab's sites: a login per Harvester, the keys of each AWS site. */
export interface SiteAccess {
    sessions: HarvesterSession[];
    aws: AwsKeys[];
}

/** What each kind of site can say about a lab's leftovers: one per kind, the compiler checks none is missing. */
export const siteBackends: SiteBackends<SiteAccess> = {
    harvester: { kind: "harvester", leftovers: (lab, access) => findHarvesterLeftovers(lab, access.sessions) },
    aws: { kind: "aws", leftovers: (lab, access) => findAwsLeftovers(lab, access.aws) },
};

