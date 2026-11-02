import * as command from "@pulumi/command";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { runUploaded, sshConnection, type HostAccess } from "@lab/kubernetes";
import { CLOUD_INIT_REBOOT, LANDLOCK_CHECK, landlockScript, MACHINE_REBOOT } from "@lab/os";
import type { ResolvedOs } from "@lab/schema";
import type { ProfileBuilder } from "../profiles";

// The landlock profile (DESIGN.md §9.7), on hosts and on every node of a downstream cluster. A VM or
// a cluster's machine turns Landlock on at its first boot (`boot`); an existing machine over SSH,
// before its setup. Then each is checked: `up` fails on a node without it, before anything that
// needs it (OpenShell) is installed.

export const landlock: ProfileBuilder<"landlock"> = {
    boot: ({ os }) => [landlockScript(os, CLOUD_INIT_REBOOT)],
    setup({ host, access, os, machine, after }) {
        // A VM turned it on at its first boot: checked once cloud-init is done.
        return host.kind === "ssh"
            ? [landlockOnMachine(`${host.name}/landlock`, access, os, {})]
            : [landlockCheck(`${host.name}/landlock`, access, { dependsOn: after, deletedWith: machine })];
    },
    cluster({ lab, cluster, prefix, access, after }) {
        // A metal cluster's nodes are lab hosts: checked over SSH before they joined (`setup`).
        if (cluster.type === "metal") return [];
        return [landlockDaemonSet(`${prefix}/landlock`, lab.images.kubectl, lab.timeouts.resourceReady, {
            provider: access.provider, deletedWith: access.deletedWith, dependsOn: after,
        })];
    },
};

/** Fails unless Landlock is active on the host, saying which LSMs are. */
function landlockCheck(name: string, access: HostAccess, opts: pulumi.CustomResourceOptions): command.remote.Command {
    return new command.remote.Command(name, { connection: sshConnection(access), create: LANDLOCK_CHECK }, opts);
}

/**
 * Turn Landlock on on an existing machine: when it isn't active, the OS profile's `landlock.enable`
 * and a reboot, then wait for the machine to go down and come back, and check it. The machine
 * keeps it when the lab goes.
 */
function landlockOnMachine(name: string, access: HostAccess, os: ResolvedOs, opts: pulumi.CustomResourceOptions): command.remote.Command {
    const turnOn = new command.remote.Command(name, {
        connection: sshConnection(access),
        create: runUploaded("landlock"),
        stdin: landlockScript(os, MACHINE_REBOOT),
    }, opts);
    // The reboot starts 5 seconds after the script ends; the check connects once the machine is back
    // (its connection retries for up to 10 minutes).
    const down = new command.local.Command(`${name}/reboot`, {
        create: `case "$OUT" in *"lab: rebooting"*) sleep 60 ;; esac`,
        environment: { OUT: turnOn.stdout },
    }, { ...opts, dependsOn: [turnOn] });
    return landlockCheck(`${name}/check`, access, { ...opts, dependsOn: [down] });
}

/**
 * Every node of a downstream cluster whose machines Rancher creates: a DaemonSet whose pods only get
 * ready on a node with Landlock active (and crash on others, saying which LSMs it has), waited on
 * until all are ready. It stays: a node added later is checked too.
 */
function landlockDaemonSet(name: string, image: string, timeoutSeconds: number, opts: pulumi.CustomResourceOptions): k8s.apps.v1.DaemonSet {
    const labels = { "app.kubernetes.io/name": "landlock-check", "app.kubernetes.io/managed-by": "lab" };
    return new k8s.apps.v1.DaemonSet(name, {
        metadata: { name: "landlock-check", namespace: "kube-system", labels },
        spec: {
            selector: { matchLabels: labels },
            template: {
                metadata: { labels },
                spec: {
                    tolerations: [{ operator: "Exists" }],
                    containers: [{
                        name: "check",
                        image,
                        // The node's LSMs: securityfs, from the host.
                        command: ["sh", "-c", `${LANDLOCK_CHECK.replace("/sys/kernel/security/lsm", "/host/lsm").replace("$(hostname)", "$NODE")}\nexec sleep infinity`],
                        env: [{ name: "NODE", valueFrom: { fieldRef: { fieldPath: "spec.nodeName" } } }],
                        volumeMounts: [{ name: "security", mountPath: "/host", readOnly: true }],
                        resources: { requests: { cpu: "1m", memory: "8Mi" } },
                    }],
                    volumes: [{ name: "security", hostPath: { path: "/sys/kernel/security", type: "Directory" } }],
                },
            },
        },
    }, { ...opts, customTimeouts: { create: `${timeoutSeconds}s`, update: `${timeoutSeconds}s` } });
}
