const color = process.stderr.isTTY && !process.env.NO_COLOR;
const paint = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);

/** CLI messages go to stderr, so `lab outputs` stays clean on stdout. */
export const log = {
    info: (msg: string) => console.error(msg),
    step: (msg: string) => console.error(paint("1", `==> ${msg}`)),
    ok: (msg: string) => console.error(paint("32", msg)),
    warn: (msg: string) => console.error(paint("33", `warning: ${msg}`)),
    error: (msg: string) => console.error(paint("31", `error: ${msg}`)),
    dim: (msg: string) => paint("2", msg),
};
