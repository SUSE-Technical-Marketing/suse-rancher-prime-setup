import { z } from "zod";
import { form } from "./form";
import { ipv4, MAC } from "./primitives";

// A machine's own network settings, for networks without DHCP: a VM's (HarvesterVM) or a
// one-machine pool's of a downstream cluster on a Harvester (DESIGN.md §5.3, §5.5).

export const addressFields = {
    macAddress: z.string().regex(MAC, "must be a MAC address like 52:54:00:aa:bb:01").optional()
        .meta(form({ label: "MAC address", placeholder: "default: one of its own with a fixed address" })),
    /**
     * A fixed address, set in the VM itself (cloud-init's network config), no DHCP involved: in the
     * network's subnet, outside its DHCP range. On a network already on the Harvester, with its
     * prefix (`10.29.40.200/24`) and `gateway`, since the lab doesn't know that network.
     */
    ip: z.string().regex(/^(\d{1,3}\.){3}\d{1,3}(\/([0-9]|[12][0-9]|3[0-2]))?$/, "must be an IPv4 address, with /prefix on a network the lab doesn't declare").optional()
        .meta(form({ label: "fixed address", format: "ip-or-cidr", placeholder: "{ipPlaceholder}", hint: "{ipHint}" })),
    /** For `ip` on a network already on the Harvester: its gateway and (default the gateway) DNS servers. */
    gateway: ipv4.optional().meta(form({ format: "ip", when: { field: "network", matches: "/" } })),
    dns: z.array(ipv4).optional().meta(form({ label: "DNS servers", format: "ip", placeholder: "default: the gateway", when: { field: "network", matches: "/" } })),
};
