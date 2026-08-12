// Pairs this local-runtime instance against a Strato platform-api deployment
// so tasks created from any browser/device (the web chat composer, Cloud
// Boost, a phone) can be routed here and executed with this machine's real
// file/git/tool access -- see taskPoller.ts for what happens once paired.

export type PairResult = { deviceId: string; deviceName: string; token: string }

export async function pairDevice(platformApiUrl: string, code: string, deviceName: string): Promise<PairResult> {
  const response = await fetch(`${trimTrailingSlash(platformApiUrl)}/device_exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, device_name: deviceName, platform: process.platform }),
  })
  const body = (await response.json().catch(() => ({}))) as { success?: boolean; device_id?: string; device_name?: string; token?: string; error?: string }
  if (!response.ok || !body.success || !body.token || !body.device_id) {
    throw new Error(body.error ?? `Pairing failed (${response.status}).`)
  }
  return { deviceId: body.device_id, deviceName: body.device_name ?? deviceName, token: body.token }
}

export async function sendHeartbeat(platformApiUrl: string, deviceToken: string): Promise<void> {
  await fetch(`${trimTrailingSlash(platformApiUrl)}/device_heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deviceToken}` },
    body: JSON.stringify({}),
  }).catch(() => {
    // best-effort -- a missed heartbeat just leaves the device looking
    // offline on the Devices page until the next one lands
  })
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}
