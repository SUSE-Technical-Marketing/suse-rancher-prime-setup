export { };

declare global {
    interface String {
        stripMargin(margin?: string): string;
    }
}


String.prototype.stripMargin = function (this, margin = "|") {
// Only escape if margin is a special regex character
    const specialChars = "\\^$.*+?()[]{}|";
    const escapedMargin = specialChars.includes(margin) ? `\\${margin}` : margin;
    const marginRegex = new RegExp(`^[ \\t]*${escapedMargin}`);
    return this.split("\n")
        .map(line => line.replace(marginRegex, ""))
        .filter(line => line.trim() !== "")
        .join("\n");
};
