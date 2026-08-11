import { cpus, freemem, platform, arch, totalmem } from 'node:os'

export type HardwareInfo = {
  platform: string
  arch: string
  cpuModel: string
  cpuCores: number
  totalMemoryBytes: number
  freeMemoryBytes: number
  recommendedTier: 'small' | 'medium' | 'large'
  perception: PerceptionCapabilityHint
}

// Node (the local-runtime process) has no portable, dependency-free way to
// enumerate cameras/microphones or query GPU/NPU presence -- those live
// behind platform-specific native APIs or the browser's own
// navigator.mediaDevices/navigator.gpu, which only exist in the Electron
// renderer (see src/lib/capabilities.ts in the frontend), not here. Rather
// than guess, this reports the honest boundary: what this process can and
// cannot determine on its own, and what layer is responsible for the rest.
export type PerceptionCapabilityHint = {
  cameraDetectable: false
  microphoneDetectable: false
  gpuDetectable: false
  npuDetectable: false
  detectVia: 'frontend (navigator.mediaDevices / navigator.gpu) or a future native platform module'
}

// Best-effort, dependency-free hardware read. GPU detection is
// intentionally not attempted here: there is no portable, dependency-free
// way to query GPU VRAM across macOS/Windows/Linux from Node without
// shelling out to platform-specific tools (system_profiler, nvidia-smi,
// dxdiag, ...). The model manager only relies on CPU/RAM, which is
// reachable everywhere and always allows a safe recommendation --
// exposing an "gpuDetectionSupported: false" flag rather than guessing.
export function detectHardware(): HardwareInfo {
  const cpuList = cpus()
  const totalMemoryBytes = totalmem()
  const totalMemoryGb = totalMemoryBytes / 1024 ** 3

  let recommendedTier: HardwareInfo['recommendedTier'] = 'small'
  if (totalMemoryGb >= 32 && cpuList.length >= 8) {
    recommendedTier = 'large'
  } else if (totalMemoryGb >= 16 && cpuList.length >= 4) {
    recommendedTier = 'medium'
  }

  return {
    platform: platform(),
    arch: arch(),
    cpuModel: cpuList[0]?.model ?? 'unknown',
    cpuCores: cpuList.length,
    totalMemoryBytes,
    freeMemoryBytes: freemem(),
    recommendedTier,
    perception: {
      cameraDetectable: false,
      microphoneDetectable: false,
      gpuDetectable: false,
      npuDetectable: false,
      detectVia: 'frontend (navigator.mediaDevices / navigator.gpu) or a future native platform module',
    },
  }
}
