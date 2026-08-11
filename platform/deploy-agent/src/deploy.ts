import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type DeployTarget = {
  repoDir: string
  composeFile: string
  gitRef: string
}

export type DeployResult = {
  success: boolean
  log: string
}

// Git ref names accept a wide character set, but a value starting with "-"
// could be interpreted as a flag by the git subcommand it's passed to
// (argument injection, a distinct risk from shell injection -- execFile
// already rules out shell injection by never invoking a shell). A proposal's
// git_ref is reviewed as part of the diff at approval time, but this is
// cheap defense in depth against a malformed or malicious ref regardless.
export function isSafeGitRef(ref: string): boolean {
  return ref.length > 0 && !ref.startsWith('-') && /^[A-Za-z0-9._/-]+$/.test(ref)
}

async function run(command: string, args: string[], cwd: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync(command, args, { cwd, timeout: 5 * 60 * 1000 })
  return [stdout, stderr].filter(Boolean).join('\n')
}

// The one and only thing this service is allowed to do: fetch the exact
// approved ref, check it out, and bring the compose stack back up. No
// arbitrary command execution -- this function's shape is the entire
// attack surface, and it never takes anything but a ref string as input.
export async function runDeploy(target: DeployTarget): Promise<DeployResult> {
  if (!isSafeGitRef(target.gitRef)) {
    return { success: false, log: `Refusing to deploy: unsafe git ref "${target.gitRef}"` }
  }

  const log: string[] = []
  try {
    log.push(await run('git', ['-C', target.repoDir, 'fetch', 'origin', target.gitRef], target.repoDir))
    log.push(await run('git', ['-C', target.repoDir, 'checkout', 'FETCH_HEAD'], target.repoDir))
    log.push(await run('docker', ['compose', '-f', target.composeFile, 'up', '-d', '--build'], target.repoDir))
    return { success: true, log: log.join('\n') }
  } catch (error) {
    log.push(error instanceof Error ? error.message : String(error))
    return { success: false, log: log.join('\n') }
  }
}
