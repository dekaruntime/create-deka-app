// Detects which package manager invoked us, so we can shell out to the same
// one for the install step and tell the user which one we used.
//
// `npm_config_user_agent` is set by npm, pnpm, yarn and bun alike (it is how
// `npx create-deka-app`, `pnpm create deka-app`, `yarn create deka-app` and
// `bun create deka-app` all resolve to this package), and its first token
// before "/" names the tool, e.g. "pnpm/8.15.1 npm/? node/v20.11.0 darwin
// arm64". `npm_execpath` is a fallback for the rarer case where that header
// is absent but the package manager's own launcher script is still visible
// on the path it invoked us with.
const MANAGERS = {
  npm: { name: 'npm', install: ['npm', ['install']] },
  pnpm: { name: 'pnpm', install: ['pnpm', ['install']] },
  yarn: { name: 'yarn', install: ['yarn', ['install']] },
  bun: { name: 'bun', install: ['bun', ['install']] },
}

export function detectPackageManager(env = process.env) {
  const userAgent = env.npm_config_user_agent
  if (userAgent) {
    const name = userAgent.split('/')[0].toLowerCase()
    if (MANAGERS[name]) return MANAGERS[name]
  }

  const execPath = env.npm_execpath || ''
  if (/pnpm/i.test(execPath)) return MANAGERS.pnpm
  if (/yarn/i.test(execPath)) return MANAGERS.yarn
  if (/bun/i.test(execPath)) return MANAGERS.bun

  return MANAGERS.npm
}

export { MANAGERS }
