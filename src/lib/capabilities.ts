// Real browser-side capability detection -- this is the layer that
// local-runtime (a plain Node process) cannot do itself: only a browser
// or Electron renderer context has navigator.mediaDevices/navigator.gpu.
// Detection is honest and additive: a capability that can't be determined
// is reported as 'unknown', never assumed true or false.

export type Availability = 'available' | 'unavailable' | 'unknown'

// weak/mid/strong drives which local model size (and, once the WASM
// fallback engine exists, which engine) a device gets -- real signal
// where the browser exposes it, not a UA-string guess. `deviceMemory` is
// Chrome/Edge/Android-only (Safari and Firefox never expose it, capped at
// 8 by spec even above that) and `hardwareConcurrency` is broadly
// supported but reports logical cores, not real single-core throughput --
// both are still meaningfully better than sniffing "iphone|android" out
// of the user agent string, which says nothing about the specific
// device's actual RAM/CPU.
export type HardwareTier = 'weak' | 'mid' | 'strong'

export type BrowserCapabilities = {
  camera: Availability
  microphone: Availability
  webgpu: Availability
  platform: string
  userAgent: string
  deviceMemoryGB: number | null
  cpuCores: number | null
  tier: HardwareTier
}

function isLikelyPhoneUA(): boolean {
  return typeof navigator !== 'undefined' && /iphone|ipad|android|mobile/i.test(navigator.userAgent)
}

// Falls back to the UA phone/desktop guess only for whichever of
// deviceMemory/cpuCores this browser doesn't expose -- never silently
// assumes "strong" just because a real number wasn't available. Exported
// as a pure function (real numbers in, tier out, no navigator access) so
// the tier boundaries themselves are directly unit-testable without
// needing to mock global navigator.
export function computeTier(deviceMemoryGB: number | null, cpuCores: number | null): HardwareTier {
  const memory = deviceMemoryGB ?? (isLikelyPhoneUA() ? 3 : 8)
  const cores = cpuCores ?? (isLikelyPhoneUA() ? 4 : 8)

  if (memory <= 2 || cores <= 2) return 'weak'
  if (memory >= 8 && cores >= 8) return 'strong'
  return 'mid'
}

// Synchronous and side-effect-free (no media permission prompts, no
// enumerateDevices call) -- this is the one meant to sit on the hot path
// of picking a model size (browserLLM.ts), which has no reason to touch
// camera/microphone APIs at all.
export function detectHardwareTier(): { tier: HardwareTier; deviceMemoryGB: number | null; cpuCores: number | null } {
  const deviceMemoryGB: number | null =
    typeof navigator !== 'undefined' && typeof (navigator as { deviceMemory?: number }).deviceMemory === 'number'
      ? (navigator as { deviceMemory?: number }).deviceMemory!
      : null
  const cpuCores: number | null =
    typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number' ? navigator.hardwareConcurrency : null

  return { tier: computeTier(deviceMemoryGB, cpuCores), deviceMemoryGB, cpuCores }
}

export async function detectBrowserCapabilities(): Promise<BrowserCapabilities> {
  let camera: Availability = 'unknown'
  let microphone: Availability = 'unknown'

  if (typeof navigator !== 'undefined' && navigator.mediaDevices?.enumerateDevices) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      camera = devices.some((d) => d.kind === 'videoinput') ? 'available' : 'unavailable'
      microphone = devices.some((d) => d.kind === 'audioinput') ? 'available' : 'unavailable'
    } catch {
      // enumerateDevices can throw in some locked-down/embedded contexts;
      // leave as 'unknown' rather than reporting a false negative.
    }
  }

  const webgpu: Availability =
    typeof navigator !== 'undefined' && 'gpu' in navigator ? 'available' : 'unavailable'

  const hardware = detectHardwareTier()

  return {
    camera,
    microphone,
    webgpu,
    platform: typeof navigator !== 'undefined' ? navigator.platform : 'unknown',
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
    deviceMemoryGB: hardware.deviceMemoryGB,
    cpuCores: hardware.cpuCores,
    tier: hardware.tier,
  }
}

// Explicit, user-initiated permission request -- never called
// automatically. Returns whether the browser actually granted access;
// the caller is responsible for stopping the returned tracks immediately
// if it only needed to confirm permission (e.g. for the capability
// detector), not to keep the camera/mic open.
export async function requestMediaPermission(modality: 'camera' | 'microphone'): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return false
  try {
    const stream = await navigator.mediaDevices.getUserMedia(
      modality === 'camera' ? { video: true } : { audio: true },
    )
    stream.getTracks().forEach((track) => track.stop())
    return true
  } catch {
    return false
  }
}
