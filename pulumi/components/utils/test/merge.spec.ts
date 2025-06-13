import { assert } from "chai";
import { it, describe } from "mocha";
import { deepMerge } from "../src/merge";

describe("deepMerge", () => {
    type T = { [key: string]: any };
    it("should merge two objects deeply", () => {
        const defaults: T = { a: 1, b: { c: 2, d: 3 } };
        const user: T = { b: { d: 4 }, e: 5 };
        const result = deepMerge(defaults, user);
        assert.deepEqual(result, { a: 1, b: { c: 2, d: 4 }, e: 5 });
    });

    it("should return defaults if user is undefined", () => {
        const defaults: T = { a: 1, b: { c: 2 } };
        const result:T = deepMerge(defaults);
        assert.deepEqual(result, defaults);
    });

    it("should handle arrays correctly", () => {
        const defaults: T = { a: [1, 2], b: { c: [3] } };
        const user:T = { a: [4], b: { c: [5] } };
        const result = deepMerge(defaults, user);
        assert.deepEqual(result, { a: [4], b: { c: [5] } });
    });

    it("should handle nested objects", () => {
        const defaults:T = { a: { x: 1, y: { z: 2 } } };
        const user:T = { a: { y: { z: 3 } } };
        const result = deepMerge(defaults, user);
        assert.deepEqual(result, { a: { x: 1, y: { z: 3 } } });
    });
});
