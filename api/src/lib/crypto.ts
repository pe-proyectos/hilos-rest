import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto'

export function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

// Genera una API key: prefijo visible + secreto aleatorio. Devuelve la clave
// completa (se muestra UNA vez), su prefijo y el hash a almacenar.
export function generateApiKey(type: 'secret' | 'publishable'): { full: string; prefix: string; hash: string } {
  const p = type === 'secret' ? 'sk_live' : 'pk_live'
  const rand = randomBytes(24).toString('hex')
  const full = `${p}_${rand}`
  return { full, prefix: full.slice(0, 15), hash: sha256hex(full) }
}

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

// JWT HS256 minimal (page tokens), sin dependencias externas.
export function signJwt(payload: Record<string, any>, secret: string, ttlSeconds = 3600): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const now = Math.floor(Date.now() / 1000)
  const body = b64url(Buffer.from(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds })))
  const data = `${header}.${body}`
  const sig = b64url(createHmac('sha256', secret).update(data).digest())
  return `${data}.${sig}`
}

export function verifyJwt(token: string, secret: string): Record<string, any> | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [h, b, s] = parts
  const expected = b64url(createHmac('sha256', secret).update(`${h}.${b}`).digest())
  const a = Buffer.from(s), e = Buffer.from(expected)
  if (a.length !== e.length || !timingSafeEqual(a, e)) return null
  try {
    const payload = JSON.parse(fromB64url(b).toString())
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch { return null }
}
