// Resolves deka/dsc release manifests. Both hosts are public and need no
// token to read (deka#1091). The two families use different URL shapes:
//
//   deka: https://releases.deka.gg/latest.json                (version hint)
//         https://releases.deka.gg/<version>/release.json     (no "v")
//         https://releases.deka.gg/<version>/deka-<platform>
//
//   dsc:  https://dsc-wasm.deka.gg/latest/release.json
//         https://dsc-wasm.deka.gg/v<version>/release.json    (with "v")
//         https://dsc-wasm.deka.gg/v<version>/dsc-<platform>

export const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64']

const FAMILIES = {
  deka: {
    binaryName: 'deka',
    latestUrl: 'https://releases.deka.gg/latest.json',
    manifestUrl: (version) => `https://releases.deka.gg/${version}/release.json`,
    binaryUrl: (version, name) => `https://releases.deka.gg/${version}/${name}`,
  },
  dsc: {
    binaryName: 'dsc',
    latestUrl: 'https://dsc-wasm.deka.gg/latest/release.json',
    manifestUrl: (version) => `https://dsc-wasm.deka.gg/v${version}/release.json`,
    binaryUrl: (version, name) => `https://dsc-wasm.deka.gg/v${version}/${name}`,
  },
}

export function familyConfig(family) {
  const config = FAMILIES[family]
  if (!config) {
    throw new Error(`unknown family "${family}" (expected "deka" or "dsc")`)
  }
  return config
}

export async function fetchJson(url, fetchImpl = fetch) {
  const res = await fetchImpl(url)
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`)
  }
  return res.json()
}

// Resolves the latest published version for a family, straight from
// latest.json / latest/release.json.
export async function resolveLatestVersion(family, fetchImpl = fetch) {
  const config = familyConfig(family)
  const latest = await fetchJson(config.latestUrl, fetchImpl)
  if (!latest || typeof latest.version !== 'string' || !latest.version) {
    throw new Error(`${config.latestUrl} did not return a "version" field`)
  }
  return latest.version
}

// Resolves the full per-platform manifest (binary name + sha256) for a
// specific version. The version-specific release.json, not latest.json, is
// the source of truth for checksums -- latest.json's version is only a
// hint about which one to fetch.
export async function resolveManifest(family, version, fetchImpl = fetch) {
  const config = familyConfig(family)
  const manifest = await fetchJson(config.manifestUrl(version), fetchImpl)
  if (!manifest || manifest.version !== version) {
    throw new Error(
      `${config.manifestUrl(version)} reports version "${manifest && manifest.version}", expected "${version}"`
    )
  }

  const binaries = {}
  for (const platform of PLATFORMS) {
    const entry = manifest.binaries && manifest.binaries[platform]
    if (!entry || typeof entry.name !== 'string' || typeof entry.sha256 !== 'string') {
      throw new Error(`${config.manifestUrl(version)} is missing a binaries.${platform} entry`)
    }
    if (!/^[0-9a-f]{64}$/i.test(entry.sha256)) {
      throw new Error(`${config.manifestUrl(version)} binaries.${platform}.sha256 is not a 64-hex sha256`)
    }
    binaries[platform] = {
      name: entry.name,
      sha256: entry.sha256.toLowerCase(),
      url: config.binaryUrl(version, entry.name),
    }
  }

  return { family, version, binaries }
}

// Convenience: resolve the latest version and its manifest in one call.
export async function resolveLatest(family, fetchImpl = fetch) {
  const version = await resolveLatestVersion(family, fetchImpl)
  return resolveManifest(family, version, fetchImpl)
}
