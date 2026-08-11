import pg from 'pg'

const { Pool } = pg

let pool: pg.Pool | undefined

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.DB_POOL_MAX ?? 5),
    })
  }
  return pool
}

// deploy-agent is a trusted background worker, not acting on behalf of any
// one user -- it must see and update every proposal regardless of who
// created it, so it always runs as service_role (unlike platform-api,
// which scopes every request to the authenticated caller).
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
