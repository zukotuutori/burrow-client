// Burrow sync server. Stores one encrypted blob per account and never sees the key to read it.
// No dependencies: node:http, node:crypto and node:sqlite ship with Node 24.
import { createServer } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import { BlockList, isIPv6 } from 'node:net'
import { DatabaseSync } from 'node:sqlite'

const PORT = Number(process.env.PORT ?? 3000)
const DB_PATH = process.env.DB_PATH ?? './sync.db'
// Empty turns registration off. Set it only while you create accounts.
const REGISTRATION_CODE = process.env.REGISTRATION_CODE ?? ''
// Only set when the server is reachable through your reverse proxy alone, which sets X-Real-IP.
const TRUST_PROXY = process.env.TRUST_PROXY === '1'
const MAX_BODY = 5 * 1024 * 1024
const MAX_FAILS = 10
const LOCKOUT_MS = 15 * 60_000
// Caps the memory used for tracking failed attempts. When full, the oldest entry is dropped.
const MAX_TRACKED_IPS = 10_000

// ---------- Database ----------

const db = new DatabaseSync(DB_PATH)
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    auth_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS blobs (
    user_id INTEGER PRIMARY KEY,
    version INTEGER NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`)

function transaction(fn) {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

// ---------- Helpers ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const sha256 = (s) => createHash('sha256').update(s).digest()
const sha256hex = (s) => sha256(s).toString('hex')

function send(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new HttpError(413, 'Request too large')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'Invalid JSON')
  }
}

// A 32 byte key in base64 is 44 characters.
const isKey = (v) => typeof v === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(v)
const isSealed = (d) =>
  !!d &&
  typeof d === 'object' &&
  d.v === 1 &&
  ['iv', 'tag', 'data'].every((k) => typeof d[k] === 'string' && /^[A-Za-z0-9+/=]*$/.test(d[k]))

// ---------- Brute force protection ----------

const fails = new Map() // ip -> { count, until }

// A reverse proxy on the same server or in Docker connects from one of these. X-Real-IP from anywhere else
// is ignored, so a client that reaches the server directly cannot make up an address to dodge the lockout.
const proxyNets = new BlockList()
proxyNets.addSubnet('127.0.0.0', 8)
proxyNets.addSubnet('10.0.0.0', 8)
proxyNets.addSubnet('172.16.0.0', 12)
proxyNets.addSubnet('192.168.0.0', 16)
proxyNets.addAddress('::1', 'ipv6')
proxyNets.addSubnet('fc00::', 7, 'ipv6')

function clientIp(req) {
  const peer = req.socket.remoteAddress ?? ''
  const real = req.headers['x-real-ip']
  const fromProxy = TRUST_PROXY && proxyNets.check(peer, isIPv6(peer) ? 'ipv6' : 'ipv4')
  return fromProxy && typeof real === 'string' && real ? real : peer
}

function checkLimit(ip) {
  const f = fails.get(ip)
  if (f && f.count >= MAX_FAILS && Date.now() < f.until) {
    throw new HttpError(429, 'Too many failed attempts, try again in 15 minutes')
  }
}

function noteFail(ip) {
  if (!fails.has(ip) && fails.size >= MAX_TRACKED_IPS) fails.delete(fails.keys().next().value)
  const f = fails.get(ip) ?? { count: 0, until: 0 }
  if (Date.now() >= f.until) f.count = 0
  f.count++
  f.until = Date.now() + LOCKOUT_MS
  fails.set(ip, f)
}

setInterval(() => {
  const now = Date.now()
  for (const [ip, f] of fails) if (now >= f.until) fails.delete(ip)
}, 60_000).unref()

function authenticate(req) {
  const ip = clientIp(req)
  checkLimit(ip)
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')
  const user =
    m && isKey(m[1]) ? db.prepare('SELECT id, username FROM users WHERE auth_hash = ?').get(sha256hex(m[1])) : undefined
  if (!user) {
    noteFail(ip)
    throw new HttpError(401, 'Login failed')
  }
  fails.delete(ip)
  return user
}

// ---------- Endpoints ----------

function register(body, ip) {
  checkLimit(ip)
  if (!REGISTRATION_CODE) throw new HttpError(403, 'Registration is turned off on this server')
  const code = typeof body.code === 'string' ? body.code : ''
  if (!timingSafeEqual(sha256(code), sha256(REGISTRATION_CODE))) {
    noteFail(ip)
    throw new HttpError(403, 'Wrong invite code')
  }
  const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : ''
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    throw new HttpError(400, 'User name: 3 to 32 characters from a-z, 0-9, dot, underscore and dash')
  }
  if (!isKey(body.authKey)) throw new HttpError(400, 'Invalid authKey')
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    throw new HttpError(409, 'This user name is taken')
  }
  db.prepare('INSERT INTO users (username, auth_hash) VALUES (?, ?)').run(username, sha256hex(body.authKey))
  return { username }
}

function getBlob(user) {
  const row = db.prepare('SELECT version, data FROM blobs WHERE user_id = ?').get(user.id)
  return row ? { version: row.version, data: JSON.parse(row.data) } : { version: 0, data: null }
}

/** Optimistic locking: only succeeds when the client saw the current version. */
function writeBlob(userId, version, data) {
  const text = JSON.stringify(data)
  const r =
    version === 0
      ? db.prepare('INSERT OR IGNORE INTO blobs (user_id, version, data) VALUES (?, 1, ?)').run(userId, text)
      : db
          .prepare("UPDATE blobs SET data = ?, version = version + 1, updated_at = datetime('now') WHERE user_id = ? AND version = ?")
          .run(text, userId, version)
  if (r.changes === 0) throw new HttpError(409, 'Out of date, fetch again')
  return { version: version + 1 }
}

function putBlob(user, body) {
  if (!Number.isInteger(body.version) || body.version < 0 || !isSealed(body.data)) throw new HttpError(400, 'Invalid data')
  return writeBlob(user.id, body.version, body.data)
}

function changePassword(user, body) {
  if (!isKey(body.newAuthKey) || !Number.isInteger(body.version) || body.version < 0 || !isSealed(body.data)) {
    throw new HttpError(400, 'Invalid data')
  }
  return transaction(() => {
    const result = writeBlob(user.id, body.version, body.data)
    db.prepare('UPDATE users SET auth_hash = ? WHERE id = ?').run(sha256hex(body.newAuthKey), user.id)
    return result
  })
}

function deleteAccount(user) {
  transaction(() => {
    db.prepare('DELETE FROM blobs WHERE user_id = ?').run(user.id)
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id)
  })
  return {}
}

// ---------- Router ----------

const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    switch (`${req.method} ${path}`) {
      case 'GET /api/health':
        return send(res, 200, { ok: true })
      case 'POST /api/register':
        return send(res, 201, register(await readJson(req), clientIp(req)))
      case 'POST /api/login':
        return send(res, 200, { username: authenticate(req).username })
      case 'GET /api/blob':
        return send(res, 200, getBlob(authenticate(req)))
      case 'PUT /api/blob': {
        const user = authenticate(req)
        return send(res, 200, putBlob(user, await readJson(req)))
      }
      case 'POST /api/password': {
        const user = authenticate(req)
        return send(res, 200, changePassword(user, await readJson(req)))
      }
      case 'DELETE /api/account':
        return send(res, 200, deleteAccount(authenticate(req)))
      default:
        return send(res, 404, { error: 'Not found' })
    }
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message })
    console.error(e)
    send(res, 500, { error: 'Server error' })
  }
})

// Drop slow or stuck connections instead of holding them open.
server.headersTimeout = 10_000
server.requestTimeout = 30_000

server.listen(PORT, () => {
  console.log(`burrow-sync listening on port ${server.address().port}`)
  if (!REGISTRATION_CODE) console.log('Registration is off (REGISTRATION_CODE is empty)')
})

function shutdown() {
  server.close(() => {
    db.close()
    process.exit(0)
  })
  setTimeout(() => process.exit(0), 5000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
