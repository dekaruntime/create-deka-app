# create-deka-app

Scaffold a new [deka](https://deka.gg) app.

```sh
npm create deka-app@latest myapp
cd myapp
npm run dev
```

Every package manager's `create` shortcut resolves to this package:

```sh
npm create deka-app@latest myapp
pnpm create deka-app myapp
yarn create deka-app myapp
bun create deka-app myapp
```

## What it does

`npx create-deka-app myapp` takes the directory as an argument and does
everything non-interactively — no prompts:

1. creates `myapp/` (refuses if it already exists and is non-empty)
2. writes `myapp/package.json`, pinning `@dekaruntime/deka` as a
   devDependency at this package's own version, with `dev`/`build`/`start`
   scripts that call `deka`
3. runs your package manager's install (detected automatically: npm, pnpm,
   yarn or bun)
4. runs `deka init` from the freshly installed binary — the real
   scaffolder, which never overwrites a file that's already there

`@dekaruntime/deka` is installed as a project **devDependency**, not
globally — the `deka` binary on your PATH is only ever there if you used
the separate curl installer. Inside a scaffolded project, run it through
your package manager instead: `npm run dev`, or directly via `npx deka
dev` (`pnpm dev` / `pnpm exec deka dev`, `yarn dev` / `yarn deka dev`,
`bun dev` / `bunx deka dev` for the other package managers). The printed
"Next steps" always matches whichever one scaffolded your project.

See [deka#1091](https://github.com/dekaruntime/deka/issues/1091) for the
design history.

## Versioning

**create-deka-app's version always equals the deka runtime version it
scaffolds.** `create-deka-app@0.53.4` pins `@dekaruntime/deka@0.53.4` — not
some other version, and never its own separate `0.0.x` release line. The
two publish together, from the same CI run (`.github/workflows/publish-runtime.yml`,
the `deka` family), so a given create-deka-app version always produces the
same project: no registry lookup needed to decide the pin.

There is one publish path for this whole repo: create-deka-app has no
standalone release of its own. The version in this repo's own
`package.json` is a `0.0.0` placeholder — it is never bumped by hand or
committed as part of a release; the workflow stamps the real version into
it at publish time, in the working tree only.

The one exception to the lockstep pin is a create-deka-app release whose
exact-matching runtime build isn't published yet. If installing the exact
pin fails, create-deka-app falls back to the latest published
`@dekaruntime/deka` version, prints a clear warning, and never leaves a
nonexistent version pinned in the generated `package.json`.

## Channels

There are two channels, [rfd#68](https://github.com/dekaruntime/rfd/issues/68):

```sh
npx create-deka-app@latest myapp   # stable (the default)
npx create-deka-app@canary myapp   # canary
```

**Stable** (`npx create-deka-app@latest`, or just `npx create-deka-app`) pins
a plain `X.Y.Z` deka runtime — the default, and what everyone not
deliberately opting in gets.

**Canary** (`npx create-deka-app@canary`) pins a prerelease version shaped
`X.Y.Z-canary-<7-char-commit-sha>` (e.g. `0.59.0-canary-d5661ed`) — every
merge to deka's `main` branch, published immediately, before a human has
promoted it to stable. Lockstep versioning holds within a channel: a canary
create-deka-app pins the *matching* canary `@dekaruntime/deka`, never a
stable one.

A canary's binaries report their **base version** on `deka --version` /
`dsc --version` — `0.59.0`, never `0.59.0-canary-d5661ed`. Promotion
republishes the exact same compiled bytes under the plain stable tag, so
the binary itself never learns it was ever a canary; only the git tag, the
R2 path and the npm version string say so.

## Platforms

| Platform | Status |
|---|---|
| macOS arm64 (Apple Silicon) | supported |
| macOS x64 (Intel) | supported |
| Linux x64 | supported |
| **Windows** | **coming** — tracked in [deka#1092](https://github.com/dekaruntime/deka/issues/1092) |
| Linux arm64 | not yet |

Unsupported platforms get a clear message, never a half-installed project.

## License

Apache-2.0, matching deka and dsc.
