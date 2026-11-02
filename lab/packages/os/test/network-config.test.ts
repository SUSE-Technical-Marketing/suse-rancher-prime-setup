import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { renderNetworkConfig } from "../src";

describe("renderNetworkConfig", () => {
    it("gives the interface with the VM's MAC its fixed address, gateway and DNS, without DHCP", () => {
        expect(parse(renderNetworkConfig({ macAddress: "52:54:00:AB:CD:EF", address: "203.0.113.20", prefix: 24, gateway: "203.0.113.1", dns: ["9.9.9.9"], search: ["lab.geeko.me"] }))).toEqual({
            version: 2,
            ethernets: {
                lab0: {
                    match: { macaddress: "52:54:00:ab:cd:ef" },
                    dhcp4: false,
                    dhcp6: false,
                    addresses: ["203.0.113.20/24"],
                    routes: [{ to: "0.0.0.0/0", via: "203.0.113.1" }],
                    nameservers: { addresses: ["9.9.9.9"], search: ["lab.geeko.me"] },
                },
            },
        });
    });
});
