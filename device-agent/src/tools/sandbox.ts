import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

export class PathEscapeError extends Error {
  constructor(relativePath: string) {
    super(`Path "${relativePath}" is outside the project root.`)
    this.name = 'PathEscapeError'
  }
}

/**
 * Resolves a tool-supplied relative path against the project root and
 * verifies the result cannot escape it — no absolute paths, no "..",
 * and no symlink escape (resolved via realpath on the nearest existing
 * ancestor, since the target file itself may not exist yet on writes).
 */
export function resolveProjectPath(projectRoot: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new PathEscapeError(String(relativePath))
  }

  if (isAbsolute(relativePath)) {
    throw new PathEscapeError(relativePath)
  }

  const normalizedRoot = resolve(projectRoot)
  const candidate = normalize(join(normalizedRoot, relativePath))

  if (candidate !== normalizedRoot && !candidate.startsWith(normalizedRoot + sep)) {
    throw new PathEscapeError(relativePath)
  }

  // Resolve symlinks on the nearest existing ancestor directory so a
  // symlinked path component can't smuggle us outside the project root,
  // even for files that don't exist yet (write/patch targets).
  let probe = candidate
  while (true) {
    try {
      const real = realpathSync(probe)
      const suffix = relative(probe, candidate)
      const realCandidate = suffix ? join(real, suffix) : real
      const realRoot = realpathSync(normalizedRoot)

      if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + sep)) {
        throw new PathEscapeError(relativePath)
      }

      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const parent = dirname(probe)
        if (parent === probe) {
          // Reached filesystem root without finding an existing ancestor.
          return candidate
        }
        probe = parent
        continue
      }

      throw error
    }
  }
}
