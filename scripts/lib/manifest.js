// Resolves deka/dsc release manifests. Both hosts are public and need no
// token to read (deka#1091). rfd#68 (Release Channels) gives each family a
// second pointer file for the newest canary, alongside the existing
// "latest" pointer -- the per-version path shape is UNCHANGED and applies
// to the full version string as-is, canary suffix and all, for both
// channels (deka has never used a "v" prefix there; dsc has always used
// one):
//
//   deka: https://releases.deka.gg/latest.json                  (stable pointer)
//         https://releases.deka.gg/canary.json                  (newest-canary pointer)
//         https://releases.deka.gg/<version>/release.json       (no "v", either channel)
//         https://releases.deka.gg/<version>/deka-<platform>
//
//   dsc:  https://dsc-wasm.deka.gg/latest/release.json           (stable pointer)
//         https://dsc-wasm.deka.gg/canary/release.json           (newest-canary pointer)
//         https://dsc-wasm.deka.gg/v<version>/release.json       (with "v", either channel)
//         https://dsc-wasm.deka.gg/v<version>/dsc-<platform>
//
// e.g. deka canary: releases.deka.gg/0.59.0-canary-d5661ed/release.json
//      dsc canary:   dsc-wasm.deka.gg/v0.58.3-canary-a1b2c3d/release.json
import { versionChannel } from '../../src/channel.js'

export const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64']

const FAMILIES = {
  deka: {
    binaryName: 'deka',
    latestUrl: (channel) =>
      channel === 'canary' ? 'https://releases.deka.gg/canary.json' : 'https://releases.deka.gg/latest.json',
    manifestUrl: (version) => `https://releases.deka.gg/${version}/release.json`,
    binaryUrl: (version, name) => `https://releases.deka.gg/${version}/${name}`,
  },
  dsc: {
    binaryName: 'dsc',
    latestUrl: (channel) =>
      channel === 'canary' ? 'https://dsc-wasm.deka.gg/canary/release.json' : 'https://dsc-wasm.deka.gg/latest/release.json',
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

// Resolves the newest published version for a family on one channel,
// straight from that channel's pointer file: latest.json / latest/release.json
// for "stable" (the default, unchanged from pre-rfd#68 behavior), canary.json
// / canary/release.json for "canary". Callers that need "no canary yet" to
// be a quiet no-op (the schedule leg) check the HTTP status themselves
// (scripts/lib/manifest.js has no opinion on that -- fetchJson always
// throws on a non-ok response, 404 included).
export async function resolveLatestVersion(family, channel = 'stable', fetchImpl = fetch) {
  const config = familyConfig(family)
  const url = config.latestUrl(channel)
  const latest = await fetchJson(url, fetchImpl)
  if (!latest || typeof latest.version !== 'string' || !latest.version) {
    throw new Error(`${url} did not return a "version" field`)
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

  // rfd#68 manifests carry `base_version` (what the binary's own --version
  // actually reports -- see src/channel.js) and `channel`; a manifest from
  // before rfd#68 has neither, and callers fall back accordingly
  // (baseVersionOf in src/channel.js).
  return {
    family,
    version,
    channel: typeof manifest.channel === 'string' ? manifest.channel : versionChannel(version),
    base_version: typeof manifest.base_version === 'string' ? manifest.base_version : undefined,
    binaries,
  }
}

// Convenience: resolve the newest version on a channel and its manifest in
// one call.
export async function resolveLatest(family, channel = 'stable', fetchImpl = fetch) {
  const version = await resolveLatestVersion(family, channel, fetchImpl)
  return resolveManifest(family, version, fetchImpl)
}
