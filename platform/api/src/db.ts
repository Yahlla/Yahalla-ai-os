import pg from 'pg'

const { Pool } = pg

let pool: pg.Pool | undefined

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.DB_POOL_MAX ?? 10),
    })
  }
  return pool
}

// Mirrors exactly how Supabase's own PostgREST/Edge Functions authorize a
// request: open a transaction, become the "authenticated" role, and set
// request.jwt.claim.sub to the verified user id so every RLS-style policy
// ported from supabase/migrations/*.sql (which all read auth.uid()) works
// completely unmodified against this self-hosted database.
export async function withUserSession<T>(userId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL ROLE authenticated')
    // SET LOCAL's value position does not accept a bind parameter ($1) --
    // Postgres's grammar requires a literal there. set_config() is the
    // parameterized equivalent (is_local=true matches SET LOCAL's
    // transaction-scoped behavior) and is the correct, injection-safe way
    // to do this from a driver.
    await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userId])
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

// For operations Supabase's admin/service-role client performs today
// (creating a device's dedicated auth identity during pairing, etc.) --
// bypasses RLS the same way service_role does, and must only ever be used
// for the specific, narrow operations that legitimately need it, never as
// a general escape hatch for ordinary request handling.
export async function withServiceRole<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL ROLE service_role')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = undefined
  }
}
