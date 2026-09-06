import { prisma } from '../lib/prisma'
import { sha256hex, verifyJwt } from '../lib/crypto'

export type AuthMode = 'secret' | 'public' | 'page'
export interface AuthCtx { appId: number; mode: AuthMode; pageId: number | null }

const SECRET = process.env.HILOS_JWT_SECRET || 'dev-secret'

// Resuelve el header Authorization: sk_ (server), pk_ (publishable, lectura),
// o un page token JWT (actua como esa page).
export async function resolveAuth(headers: Headers): Promise<AuthCtx | null> {
  const raw = headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
  if (!raw) return null
  if (raw.startsWith('sk_') || raw.startsWith('pk_')) {
    const key = await prisma.apiKey.findUnique({ where: { keyHash: sha256hex(raw) }, select: { appId: true, type: true, revokedAt: true } })
    if (!key || key.revokedAt) return null
    return { appId: key.appId, mode: key.type === 'secret' ? 'secret' : 'public', pageId: null }
  }
  const payload = verifyJwt(raw, SECRET)
  if (payload && payload.t === 'page' && payload.appId && payload.pageId) {
    return { appId: payload.appId, mode: 'page', pageId: payload.pageId }
  }
  return null
}

// Devuelve la page que actua: token de page, o header x-hilos-page (id|handle|
// external:<id>) resuelto contra el app cuando se usa secret key.
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
