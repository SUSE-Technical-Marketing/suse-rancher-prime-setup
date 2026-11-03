import { describe, expect, it } from "vitest";
import { rolloutProblem } from "../src/kube-ops";

// A Deployment's rollout as `kubectl rollout status` judges it: what rancher-webhook goes through
// when Rancher installs it and rolls it out again.

const deployment = (status: Record<string, number>, generation = 2, replicas = 1) => ({ metadata: { generation }, spec: { replicas }, status });

describe("a Deployment's rollout", () => {
    it("waits for its controller to see its latest spec", () => {
        expect(rolloutProblem(deployment({ observedGeneration: 1, replicas: 1, updatedReplicas: 1, availableReplicas: 1 }))).toBe("its latest spec isn't seen yet");
    });

    it("waits while the new pod isn't there or isn't available, and while an old one still runs", () => {
        expect(rolloutProblem(deployment({ observedGeneration: 2, replicas: 1, updatedReplicas: 0, availableReplicas: 1 }))).toBe("0 of 1 replicas updated");
        expect(rolloutProblem(deployment({ observedGeneration: 2, replicas: 2, updatedReplicas: 1, availableReplicas: 1 }))).toBe("1 old replicas still running");
        expect(rolloutProblem(deployment({ observedGeneration: 2, replicas: 1, updatedReplicas: 1, availableReplicas: 0 }))).toBe("0 of 1 updated replicas available");
        // Just created: no status yet.
        expect(rolloutProblem({ metadata: { generation: 1 }, spec: { replicas: 1 } })).toBe("its latest spec isn't seen yet");
    });

    it("is complete once every replica is updated and available, and no old one is left", () => {
        expect(rolloutProblem(deployment({ observedGeneration: 2, replicas: 1, updatedReplicas: 1, availableReplicas: 1 }))).toBeUndefined();
        expect(rolloutProblem(deployment({ observedGeneration: 3, replicas: 3, updatedReplicas: 3, availableReplicas: 3 }, 3, 3))).toBeUndefined();
    });
});
