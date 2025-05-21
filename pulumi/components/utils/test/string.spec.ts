import { assert } from "chai";
import "../src/stripMargin";

describe("stripMargin", () => {
    it("should strip leading whitespace and pipe characters", () => {
        const input = `
            |  line1
            |  line2
            |  line3
        `.stripMargin();
        const expected = `  line1\n  line2\n  line3`;
        assert.equal(input, expected);
    });
});
