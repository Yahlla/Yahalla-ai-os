// Real browser-side capability detection -- this is the layer that
// local-runtime (a plain Node process) cannot do itself: only a browser
// or Electron renderer context has navigator.mediaDevices/navigator.gpu.
// Detection is honest and additive: a capability that can't be determined
// is reported as 'unknown', never assumed true or false.

export type Availability = 'available' | 'unavailable' | 'unknown'

export type BrowserCapabilities = {
  camera: Availability
  microphone: Availability
  webgpu: Availability
  platform: string
  userAgent: string
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

  return {
    camera,
    microphone,
    webgpu,
    platform: typeof navigator !== 'undefined' ? navigator.platform : 'unknown',
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
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
