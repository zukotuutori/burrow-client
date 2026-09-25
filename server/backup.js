// Writes a consistent copy of the database next to it, e.g. /data/backup-2026-09-25.db
import { backup, DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'

const DB_PATH = process.env.DB_PATH ?? './sync.db'
const target = join(dirname(DB_PATH), `backup-${new Date().toISOString().slice(0, 10)}.db`)
const db = new DatabaseSync(DB_PATH)
await backup(db, target)
db.close()
console.log(target)
