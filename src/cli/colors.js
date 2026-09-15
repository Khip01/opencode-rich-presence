// Zero-dependency ANSI color helper for the CLI.
//
// Color is disabled automatically when stdout is not a TTY (piped,
// redirected, CI) so test assertions that read stdout keep matching
// plain text. NO_COLOR forces it off; FORCE_COLOR forces it on.

function colorEnabled() {
    if (process.env.FORCE_COLOR) return true;
    if (process.env.NO_COLOR !== undefined) return false;
    return process.stdout.isTTY === true;
}

function wrap(open, close) {
    return (s) => (colorEnabled() ? `\u001b[${open}m${s}\u001b[${close}m` : String(s));
}

export const bold = wrap("1", "22");
export const dim = wrap("2", "22");
export const red = wrap("31", "39");
export const green = wrap("32", "39");
export const yellow = wrap("33", "39");
export const cyan = wrap("36", "39");

export default { bold, dim, red, green, yellow, cyan };