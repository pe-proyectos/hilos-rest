import { Elysia, t } from 'elysia'
import { prisma } from '../lib/prisma'
import { resolveAuth, actingPage, requireScope, rateLimit, CLIENT_SCOPES, type AuthCtx } from '../plugins/auth'
import { signJwt, generateApiKey } from '../lib/crypto'
import { s3, R2_PUBLIC } from '../lib/s3'
import { randomBytes } from 'crypto'

const SECRET = process.env.HILOS_JWT_SECRET || 'dev-secret'
const MAX_CONTENT = 8000

function slugifyHandle(s: string): string {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'page'
}
async function uniqueHandle(appId: number, base: string): Promise<string> {
  let h = slugifyHandle(base)
  for (let i = 0; i < 50; i++) {
    const exists = await prisma.page.findUnique({ where: { appId_handle: { appId, handle: h } }, select: { id: true } })
    if (!exists) return h
    h = `${slugifyHandle(base)}_${Math.floor(1000 + Math.random() * 9000)}`
  }
  return `${slugifyHandle(base)}_${Date.now().toString(36)}`
}
function parseHashtags(c: string): string[] {
  const out = new Set<string>()
  for (const m of c.matchAll(/#([\p{L}\p{N}_]{1,80})/gu)) out.add(m[1].toLowerCase())
  return [...out].slice(0, 12)
}
const pageSel = { id: true, handle: true, type: true, parentPageId: true, externalId: true, displayName: true, avatarUrl: true, bio: true, followersCount: true, followingCount: true, postsCount: true }
function shapePage(p: any) { return p ? { ...p } : null }
function shapePost(p: any, likedSet?: Set<number>) {
  return {
    id: p.id, content: p.content, media: p.media ?? null, repostOfId: p.repostOfId ?? null, externalRef: p.externalRef ?? null,
    likesCount: p.likesCount, commentsCount: p.commentsCount, repostCount: p.repostCount, pinned: p.pinned,
    createdAt: p.createdAt, liked: likedSet ? likedSet.has(p.id) : undefined,
    author: shapePage(p.author), wallPageId: p.wallPageId,
  }
}
async function likedPosts(appId: number, pageId: number | null | undefined, postIds: number[]): Promise<Set<number>> {
  if (!pageId || !postIds.length) return new Set()
  const r = await prisma.reaction.findMany({ where: { appId, pageId, type: 'like', targetType: 'post', targetId: { in: postIds } }, select: { targetId: true } })
  return new Set(r.map((x) => x.targetId))
}

export const v1 = () =>
  new Elysia({ prefix: '/v1' })
    .derive(async ({ request }) => ({ auth: await resolveAuth(request.headers) as AuthCtx | null }))
    .get('/health', () => ({ ok: true, service: 'hilos.rest', version: '0.1.0' }))

    // Admin: borra SOLO los comentarios del app (para re-migrar). Mantiene
    // posts y pages.
    .post('/admin/purge-comments', async ({ auth, request, body }: any) => {
      if (!auth || auth.mode !== 'secret') return { error: 'secret_key_required' }
      if (!process.env.HILOS_BOOTSTRAP_TOKEN || request.headers.get('x-bootstrap-token') !== process.env.HILOS_BOOTSTRAP_TOKEN) return { error: 'forbidden' }
      if (body?.confirm !== 'PURGE_COMMENTS') return { error: 'confirm_required' }
      const before = await prisma.comment.count({ where: { appId: auth.appId } })
      await prisma.comment.deleteMany({ where: { appId: auth.appId } })
      await prisma.post.updateMany({ where: { appId: auth.appId }, data: { commentsCount: 0 } })
      const after = await prisma.comment.count({ where: { appId: auth.appId } })
      return { data: { before, after } }
    }, { body: t.Object({ confirm: t.String() }) })

    // Config del App (origenes permitidos para page tokens). Admin.
    .post('/admin/app-config', async ({ auth, request, body }: any) => {
      if (!auth || auth.mode !== 'secret') return { error: 'secret_key_required' }
      if (!process.env.HILOS_BOOTSTRAP_TOKEN || request.headers.get('x-bootstrap-token') !== process.env.HILOS_BOOTSTRAP_TOKEN) return { error: 'forbidden' }
      const origins = String(body.allowedOrigins || '').split(',').map((x: string) => x.trim()).filter(Boolean).join(',')
      const app = await prisma.app.update({ where: { id: auth.appId }, data: { allowedOrigins: origins || null }, select: { id: true, slug: true, allowedOrigins: true } })
      return { data: app }
    }, { body: t.Object({ allowedOrigins: t.String() }) })

    // Purga de contenido de la app (mantiene app y API keys). Protegido por
    // HILOS_BOOTSTRAP_TOKEN + confirmacion explicita. Uso administrativo.
    .post('/admin/purge', async ({ auth, request, body }: any) => {
      if (!auth || auth.mode !== 'secret') return { error: 'secret_key_required' }
      if (!process.env.HILOS_BOOTSTRAP_TOKEN || request.headers.get('x-bootstrap-token') !== process.env.HILOS_BOOTSTRAP_TOKEN) return { error: 'forbidden' }
      if (body?.confirm !== 'PURGE') return { error: 'confirm_required' }
      const appId = auth.appId
      const before = {
        pages: await prisma.page.count({ where: { appId } }),
        posts: await prisma.post.count({ where: { appId } }),
        comments: await prisma.comment.count({ where: { appId } }),
      }
      // Orden: hijos -> padres (los FK tienen cascade, pero somos explicitos).
      await prisma.hashtag.deleteMany({ where: { appId } })
      await prisma.reaction.deleteMany({ where: { appId } })
      await prisma.follow.deleteMany({ where: { appId } })
      await prisma.comment.deleteMany({ where: { appId } })
      await prisma.post.deleteMany({ where: { appId } })
      await prisma.page.deleteMany({ where: { appId } })
      const after = {
        pages: await prisma.page.count({ where: { appId } }),
        posts: await prisma.post.count({ where: { appId } }),
        comments: await prisma.comment.count({ where: { appId } }),
      }
      return { data: { purged: true, before, after } }
    }, { body: t.Object({ confirm: t.String() }) })

    // Ingesta de media por URL (migracion opcion B): descarga y guarda en el R2
    // de hilos. Devuelve la URL publica propia.
    .post('/uploads/fetch', async ({ auth, body }: any) => {
      if (!auth || auth.mode !== 'secret') return { error: 'secret_key_required' }
      const c = s3(); if (!c) return { error: 'storage_not_configured' }
      const src = String(body.url || '')
      if (!/^https?:\/\//i.test(src)) return { error: 'invalid_url' }
      try {
        const res = await fetch(src)
        if (!res.ok) return { error: 'fetch_failed' }
        const ct = res.headers.get('content-type') || 'application/octet-stream'
        const buf = new Uint8Array(await res.arrayBuffer())
        if (buf.byteLength > 15 * 1024 * 1024) return { error: 'too_large' }
        const name = (src.split('/').pop() || 'file').split('?')[0].replace(/[^a-zA-Z0-9._-]/g, '_').slice(-60)
        const key = `${auth.appId}/media/${randomBytes(6).toString('hex')}-${name}`
        await c.write(key, buf, { type: ct })
        return { data: { key, publicUrl: `${R2_PUBLIC}/${key}` } }
      } catch (e: any) { return { error: 'fetch_failed' } }
    }, { body: t.Object({ url: t.String() }) })

    // URL prefirmada para subir media (imagenes de posts/comentarios).
    .post('/uploads', async ({ auth, body }: any) => {
      if (!auth) return { error: 'unauthorized' }
      const c = s3(); if (!c) return { error: 'storage_not_configured' }
      const name = String(body.filename || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-60)
      const ct = String(body.contentType || 'application/octet-stream')
      const key = `${auth.appId}/media/${Date.now()}-${randomBytes(6).toString('hex')}-${name}`
      const uploadUrl = c.presign(key, { method: 'PUT', expiresIn: 900, type: ct })
      return { data: { uploadUrl, key, publicUrl: `${R2_PUBLIC}/${key}`, expiresIn: 900 } }
    }, { body: t.Object({ filename: t.Optional(t.String()), contentType: t.Optional(t.String()) }) })

    // Bootstrap unico: crea el dev+app+keys si no existe ninguna app todavia.
    // Protegido por HILOS_BOOTSTRAP_TOKEN; inerte tras el primer uso.
    .post('/bootstrap', async ({ request, body }: any) => {
      const token = request.headers.get('x-bootstrap-token')
      if (!process.env.HILOS_BOOTSTRAP_TOKEN || token !== process.env.HILOS_BOOTSTRAP_TOKEN) return { error: 'forbidden' }
      const count = await prisma.app.count()
      if (count > 0) return { error: 'already_bootstrapped' }
      const dev = await prisma.developer.create({ data: { email: body?.email || 'admin@capibaratraductor.com', name: 'Capibara' } })
      const app = await prisma.app.create({ data: { developerId: dev.id, name: body?.appName || 'La Charca', slug: body?.appSlug || 'lacharca' } })
      const sk = generateApiKey('secret'); const pk = generateApiKey('publishable')
      await prisma.apiKey.create({ data: { appId: app.id, label: 'server', type: 'secret', prefix: sk.prefix, keyHash: sk.hash } })
      await prisma.apiKey.create({ data: { appId: app.id, label: 'client', type: 'publishable', prefix: pk.prefix, keyHash: pk.hash } })
      return { data: { appId: app.id, appSlug: app.slug, secretKey: sk.full, publishableKey: pk.full } }
    })

    // ---- Pages ----
    .post('/pages', async ({ auth, body, request }: any) => {
      if (!auth || auth.mode !== 'secret') return { error: 'secret_key_required' }
      const type = ['user', 'scan', 'manga', 'custom'].includes(body.type) ? body.type : 'user'
      let parentPageId: number | null = null
      if (body.parentHandle || body.parentExternalId) {
        const parent = body.parentExternalId
          ? await prisma.page.findUnique({ where: { appId_externalId: { appId: auth.appId, externalId: String(body.parentExternalId) } }, select: { id: true } })
          : await prisma.page.findUnique({ where: { appId_handle: { appId: auth.appId, handle: String(body.parentHandle) } }, select: { id: true } })
        if (!parent) return { error: 'parent_not_found' }
        parentPageId = parent.id
      }
      // Upsert por externalId (idempotente para provisioning/migracion).
      if (body.externalId) {
        const existing = await prisma.page.findUnique({ where: { appId_externalId: { appId: auth.appId, externalId: String(body.externalId) } }, select: pageSel })
        if (existing) {
          const upd = await prisma.page.update({ where: { id: existing.id }, data: {
            displayName: body.displayName ?? undefined, avatarUrl: body.avatarUrl ?? undefined, bio: body.bio ?? undefined,
            parentPageId: parentPageId ?? undefined, metadata: body.metadata ?? undefined,
            createdAt: body.createdAt ? new Date(body.createdAt) : undefined,
          }, select: pageSel })
          return { data: shapePage(upd), created: false }
        }
      }
      const handle = body.handle ? await uniqueHandle(auth.appId, body.handle) : await uniqueHandle(auth.appId, body.displayName || body.externalId || type)
      const page = await prisma.page.create({ data: {
        appId: auth.appId, handle, type, parentPageId, externalId: body.externalId ? String(body.externalId) : null,
        displayName: body.displayName ?? null, avatarUrl: body.avatarUrl ?? null, bio: body.bio ?? null, metadata: body.metadata ?? undefined,
        createdAt: body.createdAt ? new Date(body.createdAt) : undefined,
      }, select: pageSel })
      return { data: shapePage(page), created: true }
    }, { body: t.Object({ externalId: t.Optional(t.Union([t.String(), t.Number()])), handle: t.Optional(t.String()), type: t.Optional(t.String()), displayName: t.Optional(t.String()), avatarUrl: t.Optional(t.String()), bio: t.Optional(t.String()), parentHandle: t.Optional(t.String()), parentExternalId: t.Optional(t.Union([t.String(), t.Number()])), metadata: t.Optional(t.Any()), createdAt: t.Optional(t.String()) }) })

    // Reclamo de page: re-asigna el externalId de una page existente (p.ej. una
    // page migrada 'capibara:user:5' pasa a 'lacharca:user:12'). Solo secret key.
    .post('/pages/claim', async ({ auth, body }: any) => {
      if (!auth || auth.mode !== 'secret') return { error: 'secret_key_required' }
      const from = String(body.fromExternalId || '')
      const to = String(body.toExternalId || '')
      if (!from || !to) return { error: 'missing_ids' }
      const page = await prisma.page.findUnique({ where: { appId_externalId: { appId: auth.appId, externalId: from } }, select: { id: true } })
      if (!page) return { error: 'not_found' }
      const taken = await prisma.page.findUnique({ where: { appId_externalId: { appId: auth.appId, externalId: to } }, select: { id: true } })
      if (taken && taken.id !== page.id) return { error: 'target_exists' }
      const updated = await prisma.page.update({
        where: { id: page.id },
        data: {
          externalId: to,
          handle: body.handle ? String(body.handle) : undefined,
          displayName: body.displayName ?? undefined,
          avatarUrl: body.avatarUrl ?? undefined,
        },
        select: pageSel,
      })
      return { data: shapePage(updated), claimed: true }
    }, { body: t.Object({ fromExternalId: t.String(), toExternalId: t.String(), handle: t.Optional(t.String()), displayName: t.Optional(t.String()), avatarUrl: t.Optional(t.String()) }) })

    .get('/pages/:handle', async ({ auth, params, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      const page = await prisma.page.findUnique({ where: { appId_handle: { appId: auth.appId, handle: params.handle } }, select: pageSel })
      if (!page) return { error: 'not_found' }
      let viewerFollows = false
      const viewerPageId = auth.pageId ?? (await actingPage(auth, request.headers).catch(() => null))
      if (viewerPageId && viewerPageId !== page.id) {
        const f = await prisma.follow.findUnique({ where: { appId_followerPageId_followedPageId: { appId: auth.appId, followerPageId: viewerPageId, followedPageId: page.id } }, select: { id: true } })
        viewerFollows = !!f
      }
      return { data: { ...shapePage(page), viewerFollows } }
    })

    // Mintea un page token (JWT app+page) desde el server del consumidor.
    .post('/page-tokens', async ({ auth, body }: any) => {
      if (!auth || auth.mode !== 'secret') return { error: 'secret_key_required' }
      let pageId: number | null = null
      if (body.pageId) { const p = await prisma.page.findFirst({ where: { id: Number(body.pageId), appId: auth.appId }, select: { id: true } }); pageId = p?.id ?? null }
      else if (body.externalId) { const p = await prisma.page.findUnique({ where: { appId_externalId: { appId: auth.appId, externalId: String(body.externalId) } }, select: { id: true } }); pageId = p?.id ?? null }
      if (!pageId) return { error: 'page_not_found' }
      // TTL corto por defecto (15 min): el cliente renueva desde su backend.
      const ttl = Math.min(3600, Math.max(60, Number(body.ttl) || 900))
      const scopes = Array.isArray(body.scopes) && body.scopes.length
        ? body.scopes.filter((x: string) => (CLIENT_SCOPES as string[]).includes(x))
        : ['read', 'post:write', 'comment:write', 'react', 'follow']
      const aud = body.origin ? String(body.origin) : undefined
      const token = signJwt({ t: 'page', appId: auth.appId, pageId, sub: `page:${pageId}`, scope: scopes.join(' '), ...(aud ? { aud } : {}) }, SECRET, ttl)
      return { data: { token, pageId, expiresIn: ttl, scopes } }
    }, { body: t.Object({ pageId: t.Optional(t.Union([t.String(), t.Number()])), externalId: t.Optional(t.Union([t.String(), t.Number()])), ttl: t.Optional(t.Number()), scopes: t.Optional(t.Array(t.String())), origin: t.Optional(t.String()) }) })

    .post('/page-tokens/revoke', async ({ auth, body }: any) => {
      if (!auth) return { error: 'unauthorized' }
      const jti = String(body.jti || auth.jti || '')
      if (!jti) return { error: 'missing_jti' }
      await prisma.revokedToken.upsert({
        where: { jti }, update: {},
        create: { jti, expiresAt: new Date(Date.now() + 3600_000) },
      }).catch(() => {})
      return { data: { revoked: true } }
    }, { body: t.Object({ jti: t.Optional(t.String()) }) })

    .get('/pages/:handle/posts', async ({ auth, params, query }: any) => {
      if (!auth) return { error: 'unauthorized' }
      const page = await prisma.page.findUnique({ where: { appId_handle: { appId: auth.appId, handle: params.handle } }, select: { id: true } })
      if (!page) return { error: 'not_found' }
      const limit = Math.min(50, Math.max(1, Number(query.limit) || 20)), pg = Math.max(0, Number(query.page) || 0)
      // Por defecto el perfil muestra lo que la page PUBLICÓ (autoría) y lo que
      // hay en su muro. ?only=wall|authored acota.
      const only = String(query.only || '')
      const where: any = { appId: auth.appId, deletedAt: null, hiddenAt: null }
      if (only === 'wall') where.wallPageId = page.id
      else if (only === 'authored') where.authorPageId = page.id
      else where.OR = [{ authorPageId: page.id }, { wallPageId: page.id }]
      const rows = await prisma.post.findMany({ where, orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }], skip: pg * limit, take: limit + 1, include: { author: { select: pageSel } } })
      const has = rows.length > limit, items = rows.slice(0, limit)
      const likes = await likedPosts(auth.appId, auth.pageId, items.map((p) => p.id))
      return { data: { items: items.map((p) => shapePost(p, likes)), hasMore: has } }
    })

    // ---- Posts ----
    .post('/posts', async ({ auth, body, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      if (!requireScope(auth, 'post:write')) return { error: 'insufficient_scope' }
      let authorPageId: number
      try { authorPageId = await actingPage(auth, request.headers) } catch (e: any) { return { error: e.message } }
      if (auth.mode === 'page' && !rateLimit(`post:${authorPageId}`, 10, 5 * 60_000)) return { error: 'rate_limited' }
      const content = String(body.content || '').slice(0, MAX_CONTENT)
      if (!content.trim() && !body.media && !body.repostOfId) return { error: 'empty_post' }
      let wallPageId = authorPageId
      if (body.wallHandle || body.wallExternalId || body.wallPageId) {
        const w = body.wallPageId ? await prisma.page.findFirst({ where: { id: Number(body.wallPageId), appId: auth.appId }, select: { id: true } })
          : body.wallExternalId ? await prisma.page.findUnique({ where: { appId_externalId: { appId: auth.appId, externalId: String(body.wallExternalId) } }, select: { id: true } })
          : await prisma.page.findUnique({ where: { appId_handle: { appId: auth.appId, handle: String(body.wallHandle) } }, select: { id: true } })
        if (!w) return { error: 'wall_not_found' }
        wallPageId = w.id
      }
      // Dedupe por externalRef (auto-post/migracion idempotente).
      if (body.externalRef) {
        const dup = await prisma.post.findUnique({ where: { appId_externalRef: { appId: auth.appId, externalRef: String(body.externalRef) } }, include: { author: { select: pageSel } } }).catch(() => null)
        if (dup) return { data: shapePost(dup), deduped: true }
      }
      const post = await prisma.post.create({ data: {
        appId: auth.appId, authorPageId, wallPageId, content, media: body.media ?? undefined,
        repostOfId: body.repostOfId ? Number(body.repostOfId) : null, externalRef: body.externalRef ? String(body.externalRef) : null,
        metadata: body.metadata ?? undefined, createdAt: body.createdAt ? new Date(body.createdAt) : undefined,
      }, include: { author: { select: pageSel } } })
      const tags = parseHashtags(content)
      if (tags.length) await prisma.hashtag.createMany({ data: tags.map((tag) => ({ appId: auth.appId, postId: post.id, tag })) }).catch(() => {})
      await prisma.page.update({ where: { id: authorPageId }, data: { postsCount: { increment: 1 } } }).catch(() => {})
      return { data: shapePost(post) }
    }, { body: t.Object({ content: t.Optional(t.String()), media: t.Optional(t.Any()), wallHandle: t.Optional(t.String()), wallExternalId: t.Optional(t.Union([t.String(), t.Number()])), wallPageId: t.Optional(t.Union([t.String(), t.Number()])), repostOfId: t.Optional(t.Union([t.String(), t.Number()])), externalRef: t.Optional(t.String()), metadata: t.Optional(t.Any()), createdAt: t.Optional(t.String()) }) })

    // Buscar post por su externalRef (p.ej. 'chapter:123'). Util en migraciones.
    .get('/posts/by-ref', async ({ auth, query }: any) => {
      if (!auth) return { error: 'unauthorized' }
      const ref = String(query.ref || '')
      if (!ref) return { error: 'missing_ref' }
      const p = await prisma.post.findUnique({ where: { appId_externalRef: { appId: auth.appId, externalRef: ref } }, select: { id: true, wallPageId: true } })
      if (!p) return { error: 'not_found' }
      return { data: p }
    })

    .get('/posts/:id', async ({ auth, params }: any) => {
      if (!auth) return { error: 'unauthorized' }
      const p = await prisma.post.findFirst({ where: { id: Number(params.id), appId: auth.appId, deletedAt: null }, include: { author: { select: pageSel } } })
      if (!p) return { error: 'not_found' }
      const likes = await likedPosts(auth.appId, auth.pageId, [p.id])
      return { data: shapePost(p, likes) }
    })

    .delete('/posts/:id', async ({ auth, params, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      const p = await prisma.post.findFirst({ where: { id: Number(params.id), appId: auth.appId, deletedAt: null }, select: { id: true, authorPageId: true } })
      if (!p) return { error: 'not_found' }
      const canDelete = auth.mode === 'secret' || (auth.mode === 'page' && auth.pageId === p.authorPageId)
      if (!canDelete) return { error: 'forbidden' }
      await prisma.post.update({ where: { id: p.id }, data: { deletedAt: new Date() } })
      await prisma.page.update({ where: { id: p.authorPageId }, data: { postsCount: { decrement: 1 } } }).catch(() => {})
      return { data: { ok: true } }
    })

    // Feed: timeline de las pages que sigue la page actuante (o global reciente).
    .get('/feed', async ({ auth, query }: any) => {
      if (!auth) return { error: 'unauthorized' }
      const limit = Math.min(50, Math.max(1, Number(query.limit) || 20)), pg = Math.max(0, Number(query.page) || 0)
      const where: any = { appId: auth.appId, deletedAt: null, hiddenAt: null }
      if (query.scope === 'following' && auth.pageId) {
        const f = await prisma.follow.findMany({ where: { appId: auth.appId, followerPageId: auth.pageId }, select: { followedPageId: true } })
        const ids = f.map((x) => x.followedPageId)
        where.authorPageId = { in: ids.length ? [...ids, auth.pageId] : [auth.pageId] }
      }
      const rows = await prisma.post.findMany({ where, orderBy: [{ createdAt: 'desc' }], skip: pg * limit, take: limit + 1, include: { author: { select: pageSel } } })
      const has = rows.length > limit, items = rows.slice(0, limit)
      const likes = await likedPosts(auth.appId, auth.pageId, items.map((p) => p.id))
      return { data: { items: items.map((p) => shapePost(p, likes)), hasMore: has } }
    })

    // ---- Comments ----
    .get('/posts/:id/comments', async ({ auth, params }: any) => {
      if (!auth) return { error: 'unauthorized' }
      const rows = await prisma.comment.findMany({ where: { appId: auth.appId, postId: Number(params.id), deletedAt: null, hiddenAt: null }, orderBy: { createdAt: 'asc' }, take: 200, include: { author: { select: pageSel } } })
      return { data: rows.map((c) => ({ id: c.id, content: c.content, parentCommentId: c.parentCommentId, likesCount: c.likesCount, createdAt: c.createdAt, author: shapePage(c.author) })) }
    })
    .post('/posts/:id/comments', async ({ auth, params, body, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      if (!requireScope(auth, 'comment:write')) return { error: 'insufficient_scope' }
      let authorPageId: number
      try { authorPageId = await actingPage(auth, request.headers) } catch (e: any) { return { error: e.message } }
      if (auth.mode === 'page' && !rateLimit(`comment:${authorPageId}`, 30, 5 * 60_000)) return { error: 'rate_limited' }
      const post = await prisma.post.findFirst({ where: { id: Number(params.id), appId: auth.appId, deletedAt: null }, select: { id: true } })
      if (!post) return { error: 'post_not_found' }
      const content = String(body.content || '').trim().slice(0, MAX_CONTENT)
      if (!content) return { error: 'empty_comment' }
      // Dedupe por externalRef (migraciones idempotentes).
      if (body.externalRef) {
        const dup = await prisma.comment.findUnique({ where: { appId_externalRef: { appId: auth.appId, externalRef: String(body.externalRef) } }, include: { author: { select: pageSel } } }).catch(() => null)
        if (dup) return { data: { id: dup.id, content: dup.content, parentCommentId: dup.parentCommentId, likesCount: dup.likesCount, createdAt: dup.createdAt, author: shapePage(dup.author) }, deduped: true }
      }
      // El padre puede venir por id propio o por su externalRef original.
      let parentCommentId: number | null = body.parentCommentId ? Number(body.parentCommentId) : null
      if (!parentCommentId && body.parentExternalRef) {
        const p = await prisma.comment.findUnique({ where: { appId_externalRef: { appId: auth.appId, externalRef: String(body.parentExternalRef) } }, select: { id: true } }).catch(() => null)
        parentCommentId = p?.id ?? null
      }
      const c = await prisma.comment.create({ data: { appId: auth.appId, postId: post.id, authorPageId, parentCommentId, externalRef: body.externalRef ? String(body.externalRef) : null, content, createdAt: body.createdAt ? new Date(body.createdAt) : undefined }, include: { author: { select: pageSel } } })
      await prisma.post.update({ where: { id: post.id }, data: { commentsCount: { increment: 1 } } })
      return { data: { id: c.id, content: c.content, parentCommentId: c.parentCommentId, likesCount: 0, createdAt: c.createdAt, author: shapePage(c.author) } }
    }, { body: t.Object({ content: t.String(), parentCommentId: t.Optional(t.Union([t.String(), t.Number()])), parentExternalRef: t.Optional(t.String()), externalRef: t.Optional(t.String()), createdAt: t.Optional(t.String()) }) })
    .delete('/comments/:id', async ({ auth, params }: any) => {
      if (!auth) return { error: 'unauthorized' }
      const c = await prisma.comment.findFirst({ where: { id: Number(params.id), appId: auth.appId, deletedAt: null }, select: { id: true, postId: true, authorPageId: true } })
      if (!c) return { error: 'not_found' }
      if (!(auth.mode === 'secret' || (auth.mode === 'page' && auth.pageId === c.authorPageId))) return { error: 'forbidden' }
      await prisma.comment.update({ where: { id: c.id }, data: { deletedAt: new Date() } })
      await prisma.post.update({ where: { id: c.postId }, data: { commentsCount: { decrement: 1 } } }).catch(() => {})
      return { data: { ok: true } }
    })

    // ---- Reactions & Follows ----
    .post('/posts/:id/like', async ({ auth, params, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      if (!requireScope(auth, 'react')) return { error: 'insufficient_scope' }
      let pageId: number
      try { pageId = await actingPage(auth, request.headers) } catch (e: any) { return { error: e.message } }
      if (auth.mode === 'page' && !rateLimit(`like:${pageId}`, 120, 60_000)) return { error: 'rate_limited' }
      const id = Number(params.id)
      const existing = await prisma.reaction.findUnique({ where: { appId_targetType_targetId_pageId_type: { appId: auth.appId, targetType: 'post', targetId: id, pageId, type: 'like' } } })
      if (existing) {
        await prisma.$transaction([prisma.reaction.delete({ where: { id: existing.id } }), prisma.post.update({ where: { id }, data: { likesCount: { decrement: 1 } } })])
        const p = await prisma.post.findUnique({ where: { id }, select: { likesCount: true } })
        return { data: { liked: false, likesCount: Math.max(0, p?.likesCount ?? 0) } }
      }
      await prisma.$transaction([prisma.reaction.create({ data: { appId: auth.appId, targetType: 'post', targetId: id, pageId, type: 'like' } }), prisma.post.update({ where: { id }, data: { likesCount: { increment: 1 } } })])
      const p = await prisma.post.findUnique({ where: { id }, select: { likesCount: true } })
      return { data: { liked: true, likesCount: p?.likesCount ?? 1 } }
    })
    .post('/pages/:handle/follow', async ({ auth, params, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      if (!requireScope(auth, 'follow')) return { error: 'insufficient_scope' }
      let followerPageId: number
      try { followerPageId = await actingPage(auth, request.headers) } catch (e: any) { return { error: e.message } }
      const target = await prisma.page.findUnique({ where: { appId_handle: { appId: auth.appId, handle: params.handle } }, select: { id: true } })
      if (!target) return { error: 'not_found' }
      if (target.id === followerPageId) return { error: 'cannot_follow_self' }
      const existing = await prisma.follow.findUnique({ where: { appId_followerPageId_followedPageId: { appId: auth.appId, followerPageId, followedPageId: target.id } } })
      if (existing) {
        await prisma.$transaction([prisma.follow.delete({ where: { id: existing.id } }), prisma.page.update({ where: { id: target.id }, data: { followersCount: { decrement: 1 } } }), prisma.page.update({ where: { id: followerPageId }, data: { followingCount: { decrement: 1 } } })])
        return { data: { following: false } }
      }
      await prisma.$transaction([prisma.follow.create({ data: { appId: auth.appId, followerPageId, followedPageId: target.id } }), prisma.page.update({ where: { id: target.id }, data: { followersCount: { increment: 1 } } }), prisma.page.update({ where: { id: followerPageId }, data: { followingCount: { increment: 1 } } })])
      return { data: { following: true } }
    })
