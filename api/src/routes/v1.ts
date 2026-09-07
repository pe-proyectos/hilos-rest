import { Elysia, t } from 'elysia'
import { prisma } from '../lib/prisma'
import { resolveAuth, actingPage, type AuthCtx } from '../plugins/auth'
import { signJwt, generateApiKey } from '../lib/crypto'

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

    .get('/pages/:handle', async ({ auth, params }: any) => {
      if (!auth) return { error: 'unauthorized' }
      const page = await prisma.page.findUnique({ where: { appId_handle: { appId: auth.appId, handle: params.handle } }, select: pageSel })
      if (!page) return { error: 'not_found' }
      return { data: shapePage(page) }
    })

    // Mintea un page token (JWT app+page) desde el server del consumidor.
    .post('/page-tokens', async ({ auth, body }: any) => {
      if (!auth || auth.mode !== 'secret') return { error: 'secret_key_required' }
      let pageId: number | null = null
      if (body.pageId) { const p = await prisma.page.findFirst({ where: { id: Number(body.pageId), appId: auth.appId }, select: { id: true } }); pageId = p?.id ?? null }
      else if (body.externalId) { const p = await prisma.page.findUnique({ where: { appId_externalId: { appId: auth.appId, externalId: String(body.externalId) } }, select: { id: true } }); pageId = p?.id ?? null }
      if (!pageId) return { error: 'page_not_found' }
      const ttl = Math.min(86400, Math.max(60, Number(body.ttl) || 3600))
      return { data: { token: signJwt({ t: 'page', appId: auth.appId, pageId }, SECRET, ttl), pageId, expiresIn: ttl } }
    }, { body: t.Object({ pageId: t.Optional(t.Union([t.String(), t.Number()])), externalId: t.Optional(t.Union([t.String(), t.Number()])), ttl: t.Optional(t.Number()) }) })

    .get('/pages/:handle/posts', async ({ auth, params, query }: any) => {
      if (!auth) return { error: 'unauthorized' }
      const page = await prisma.page.findUnique({ where: { appId_handle: { appId: auth.appId, handle: params.handle } }, select: { id: true } })
      if (!page) return { error: 'not_found' }
      const limit = Math.min(50, Math.max(1, Number(query.limit) || 20)), pg = Math.max(0, Number(query.page) || 0)
      const rows = await prisma.post.findMany({ where: { appId: auth.appId, wallPageId: page.id, deletedAt: null, hiddenAt: null }, orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }], skip: pg * limit, take: limit + 1, include: { author: { select: pageSel } } })
      const has = rows.length > limit, items = rows.slice(0, limit)
      const likes = await likedPosts(auth.appId, auth.pageId, items.map((p) => p.id))
      return { data: { items: items.map((p) => shapePost(p, likes)), hasMore: has } }
    })

    // ---- Posts ----
    .post('/posts', async ({ auth, body, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      let authorPageId: number
      try { authorPageId = await actingPage(auth, request.headers) } catch (e: any) { return { error: e.message } }
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
      let authorPageId: number
      try { authorPageId = await actingPage(auth, request.headers) } catch (e: any) { return { error: e.message } }
      const post = await prisma.post.findFirst({ where: { id: Number(params.id), appId: auth.appId, deletedAt: null }, select: { id: true } })
      if (!post) return { error: 'post_not_found' }
      const content = String(body.content || '').trim().slice(0, MAX_CONTENT)
      if (!content) return { error: 'empty_comment' }
      const c = await prisma.comment.create({ data: { appId: auth.appId, postId: post.id, authorPageId, parentCommentId: body.parentCommentId ? Number(body.parentCommentId) : null, content, createdAt: body.createdAt ? new Date(body.createdAt) : undefined }, include: { author: { select: pageSel } } })
      await prisma.post.update({ where: { id: post.id }, data: { commentsCount: { increment: 1 } } })
      return { data: { id: c.id, content: c.content, parentCommentId: c.parentCommentId, likesCount: 0, createdAt: c.createdAt, author: shapePage(c.author) } }
    }, { body: t.Object({ content: t.String(), parentCommentId: t.Optional(t.Union([t.String(), t.Number()])), createdAt: t.Optional(t.String()) }) })
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
      let pageId: number
      try { pageId = await actingPage(auth, request.headers) } catch (e: any) { return { error: e.message } }
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
