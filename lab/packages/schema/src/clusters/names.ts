// The downstream cluster types, by name, with no imports: the lab UI imports this file (its build
// can't take the schema's own modules), and clusters/index.ts checks its union is the same.

export const CLUSTER_TYPE_NAMES = ["harvester", "ec2", "eks", "metal", "k3k"] as const;
export type ClusterTypeName = (typeof CLUSTER_TYPE_NAMES)[number];
