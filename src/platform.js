// Platforms deka ships a binary for today. Windows is dekaruntime/deka#1092.
const SUPPORTED = new Set(['darwin-arm64', 'darwin-x64', 'linux-x64'])

export function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`
}

export function isSupportedPlatform(platform = process.platform, arch = process.arch) {
  return SUPPORTED.has(platformKey(platform, arch))
}

export { SUPPORTED }
