import { Client } from 'pg'
import type { Db } from './db.js'
import { newId } from './db.js'

export type DatabaseConnectionSummary = { id: string; name: string; createdAt: string }

export function listDatabaseConnections(db: Db): DatabaseConnectionSummary[] {
  const rows = db.prepare('SELECT id, name, created_at FROM database_connections ORDER BY created_at DESC').all() as {
    id: string
    name: string
    created_at: string
  }[]
  return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at }))
}

function getConnectionString(db: Db, id: string): string | undefined {
  const row = db.prepare('SELECT connection_string FROM database_connections WHERE id = ?').get(id) as
    | { connection_string: string }
    | undefined
  return row?.connection_string
}

// Real validation, not a format check: actually connects and runs SELECT 1
// before this gets saved as "connected" -- a typo'd host or wrong password
// fails loudly here instead of surfacing later as a confusing tool error
// mid-conversation.
export async function addDatabaseConnection(db: Db, name: string, connectionString: string): Promise<DatabaseConnectionSummary> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 8000 })
  try {
    await client.connect()
    await client.query('SELECT 1')
  } finally {
    await client.end().catch(() => {})
  }
  const id = newId()
  const createdAt = new Date().toISOString()
  db.prepare('INSERT INTO database_connections (id, name, connection_string, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    name,
    connectionString,
    createdAt,
  )
  return { id, name, createdAt }
}

export function removeDatabaseConnection(db: Db, id: string): boolean {
  const result = db.prepare('DELETE FROM database_connections WHERE id = ?').run(id)
  return result.changes > 0
}

const MAX_ROWS = 200

// The real enforcement is BEGIN READ ONLY -- Postgres itself rejects any
// data-modifying statement inside a read-only transaction (INSERT, UPDATE,
// DELETE, DDL, ...) at the engine level, which holds regardless of how the
// query is phrased (CTEs, multiple statements, etc.). This is what makes
// db_query safe to expose without a human approval gate, unlike db_execute.
export async function queryDatabase(db: Db, connectionId: string, sql: string): Promise<Record<string, unknown>> {
  const connectionString = getConnectionString(db, connectionId)
  if (!connectionString) {
    return { success: false, message: `Unknown database connection "${connectionId}".` }
  }
  const client = new Client({ connectionString, connectionTimeoutMillis: 8000 })
  try {
    await client.connect()
    await client.query('BEGIN TRANSACTION READ ONLY')
    try {
      const result = await client.query(sql)
      await client.query('ROLLBACK')
      const rows = (result.rows ?? []).slice(0, MAX_ROWS)
      return {
        success: true,
        row_count: result.rows?.length ?? 0,
        truncated: (result.rows?.length ?? 0) > MAX_ROWS,
        rows,
        fields: (result.fields ?? []).map((f) => f.name),
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    }
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : 'Query failed.' }
  } finally {
    await client.end().catch(() => {})
  }
}

// Unlike queryDatabase, this runs in a normal read-write transaction and
// commits -- it is only ever reached via the db_execute tool, which
// requiresApproval like git_push/write_project_file, so a human sees the
// exact SQL before it runs.
export async function executeDatabase(db: Db, connectionId: string, sql: string): Promise<Record<string, unknown>> {
  const connectionString = getConnectionString(db, connectionId)
  if (!connectionString) {
    return { success: false, message: `Unknown database connection "${connectionId}".` }
  }
  const client = new Client({ connectionString, connectionTimeoutMillis: 8000 })
  try {
    await client.connect()
    const result = await client.query(sql)
    return {
      success: true,
      row_count: result.rowCount ?? 0,
      rows: (result.rows ?? []).slice(0, MAX_ROWS),
      fields: (result.fields ?? []).map((f) => f.name),
    }
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : 'Execution failed.' }
  } finally {
    await client.end().catch(() => {})
  }
}
