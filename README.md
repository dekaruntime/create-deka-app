# create-deka-app

Scaffold a new [deka](https://deka.gg) app.

```sh
npx create-deka-app@latest myapp
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

See [deka#1091](https://github.com/dekaruntime/deka/issues/1091) for the
design history.

## Versioning

**create-deka-app's version always equals the deka runtime version it
scaffolds.** `create-deka-app@0.53.4` pins `@dekaruntime/deka@0.53.4` — not
some other version, and never its own separate `0.0.x` release line. The
two publish together, from the same CI run (`.github/workflows/publish-runtime.yml`,
the `deka` family), so a given create-deka-app version always produces the
same project: no registry lookup needed to decide the pin.

The one exception is a create-deka-app release whose exact-matching
runtime build isn't published yet (or a scaffolder-only release cut via
`publish.yml`'s `v*` tag path, which has no runtime counterpart at all).
If installing the exact pin fails, create-deka-app falls back to the
latest published `@dekaruntime/deka` version, prints a clear warning, and
never leaves a nonexistent version pinned in the generated
`package.json`.

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
