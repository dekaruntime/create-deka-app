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

## Status

**Placeholder.** This package reserves the name while the real scaffolder is built ([deka#1091](https://github.com/dekaruntime/deka/issues/1091)). It does not scaffold a project yet; it points you at deka.

Install deka directly in the meantime:

```sh
curl -fsSL https://deka.gg/install.sh | sh
```

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
