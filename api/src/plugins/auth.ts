import { prisma } from '../lib/prisma'
import { sha256hex, verifyJwt } from '../lib/crypto'

export type AuthMode = 'secret' | 'public' | 'page'
export type Scope = 'post:write' | 'comment:write' | 'react' | 'follow' | 'read'
export interface AuthCtx { appId: number; mode: AuthMode; pageId: number | null; scopes: Scope[]; jti?: string }

const SECRET = process.env.HILOS_JWT_SECRET || 'dev-secret'
// Scopes que puede tener un page token (nunca administrativos).
export const CLIENT_SCOPES: Scope[] = ['post:write', 'comment:write', 'react', 'follow', 'read']

// Cache corto de apps (origenes permitidos) para no pegar a la DB en cada request.
const appCache = new Map<number, { origins: string[]; exp: number }>()
async function appOrigins(appId: number): Promise<string[]> {
  const hit = appCache.get(appId)
  if (hit && hit.exp > Date.now()) return hit.origins
  const app = await prisma.app.findUnique({ where: { id: appId }, select: { allowedOrigins: true } })
  const origins = (app?.allowedOrigins || '').split(',').map((s) => s.trim()).filter(Boolean)
  appCache.set(appId, { origins, exp: Date.now() + 60_000 })
  return origins
}

async function isRevoked(jti?: string): Promise<boolean> {
  if (!jti) return false
  const row = await prisma.revokedToken.findUnique({ where: { jti }, select: { id: true } })
  return !!row
}

export async function resolveAuth(headers: Headers): Promise<AuthCtx | null> {
  const raw = headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
  if (!raw) return null

  // API keys (server-to-server): confianza total dentro del app.
  if (raw.startsWith('sk_') || raw.startsWith('pk_')) {
    const key = await prisma.apiKey.findUnique({ where: { keyHash: sha256hex(raw) }, select: { appId: true, type: true, revokedAt: true } })
    if (!key || key.revokedAt) return null
    const mode: AuthMode = key.type === 'secret' ? 'secret' : 'public'
    return { appId: key.appId, mode, pageId: null, scopes: mode === 'secret' ? [...CLIENT_SCOPES] : ['read'] }
  }

  // Page token (JWT de corta vida, usado desde el navegador).
  const payload = verifyJwt(raw, SECRET)
  if (!payload || payload.t !== 'page' || !payload.appId || !payload.pageId) return null
  if (payload.iss && payload.iss !== 'https://hilos.rest') return null
  if (await isRevoked(payload.jti)) return null

  // El token declara su audiencia (origen). Debe coincidir con el Origin real
  // y estar en la allowlist del App.
  const origin = headers.get('origin') || headers.get('referer')?.replace(/^(https?:\/\/[^/]+).*$/, '$1') || null
  const allowed = await appOrigins(payload.appId)
  if (allowed.length) {
    if (!origin || !allowed.includes(origin)) return null
    if (payload.aud && payload.aud !== origin) return null
  }

  const scopes = (Array.isArray(payload.scope) ? payload.scope : String(payload.scope || '').split(' '))
    .filter((x: string): x is Scope => (CLIENT_SCOPES as string[]).includes(x))
  return { appId: payload.appId, mode: 'page', pageId: payload.pageId, scopes: scopes.length ? scopes : ['read'], jti: payload.jti }
}

export function requireScope(auth: AuthCtx, scope: Scope): boolean {
  if (auth.mode === 'secret') return true
  return auth.scopes.includes(scope)
}

// Page que actua: token de page, o X-Hilos-Page con secret key.
export async function actingPage(auth: AuthCtx, headers: Headers): Promise<number> {
  if (auth.mode === 'page' && auth.pageId) return auth.pageId
  if (auth.mode !== 'secret') throw new Error('Se requiere un page token o secret key con X-Hilos-Page.')
  const ref = headers.get('x-hilos-page')?.trim()
  if (!ref) throw new Error('Falta X-Hilos-Page.')
  let page: { id: number } | null = null
  if (ref.startsWith('external:')) page = await prisma.page.findUnique({ where: { appId_externalId: { appId: auth.appId, externalId: ref.slice(9) } }, select: { id: true } })
  else if (/^\d+$/.test(ref)) page = await prisma.page.findFirst({ where: { id: Number(ref), appId: auth.appId }, select: { id: true } })
  else page = await prisma.page.findUnique({ where: { appId_handle: { appId: auth.appId, handle: ref } }, select: { id: true } })
  if (!page) throw new Error('Page no encontrada para X-Hilos-Page.')
  return page.id
}

// Rate limit en memoria por clave (page/ip + accion).
const buckets = new Map<string, { n: number; reset: number }>()
export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now()
  const b = buckets.get(key)
  if (!b || b.reset < now) { buckets.set(key, { n: 1, reset: now + windowMs }); return true }
  if (b.n >= max) return false
  b.n++
  return true
}
