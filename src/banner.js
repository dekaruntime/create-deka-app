// The deka ASCII banner, copied byte-for-byte (including its ANSI truecolor
// + bold escape codes) from what `deka init` prints today -- captured by
// running the real published binary and extracting the exact bytes between
// its first escape code and its trailing reset (see PR description for how).
// Kept here as a single literal, not regenerated, so it can never drift
// from what deka would have printed itself: create-deka-app prints this
// once, up front, and suppresses deka init's own copy (see
// suppressBannerAndNextSteps in init-output-filter.js) so the banner shows
// exactly once instead of twice.
export const BANNER = "\u001b[38;2;224;140;11m\u001b[1m       ░██            ░██                  \n       ░██            ░██                  \n ░████████  ░███████  ░██    ░██ ░██████   \n░██    ░██ ░██    ░██ ░██   ░██       ░██  \n░██    ░██ ░█████████ ░███████   ░███████  \n░██   ░███ ░██        ░██   ░██ ░██   ░██  \n ░█████░██  ░███████  ░██    ░██ ░█████░██\u001b[0m"
