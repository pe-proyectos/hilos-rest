import { Elysia, t } from 'elysia'
import { prisma } from '../lib/prisma'
import { resolveAuth, actingPage, viewerPage, requireScope, canWrite, rateLimit, CLIENT_SCOPES, type AuthCtx } from '../plugins/auth'
import { imagenDeTipo, detectarImagen, nombreSeguro, fechaNoFutura } from '../lib/seguridad'
import { signJwt, generateApiKey } from '../lib/crypto'
import { s3, R2_PUBLIC } from '../lib/s3'
import { cifrar, descifrar } from '../lib/secret'
import { randomBytes, createHmac } from 'crypto'
import { listInbox, inboxCounts, buildSummaries, messageMeta, messageMedia, engagedConversations } from '../lib/inbox'

// Posts automaticos (flag `automated`: avisos de capitulo nuevo, anclas de la
// caja de comentarios de cada obra). Existen porque de ellos cuelgan los
// comentarios, pero no se muestran en el feed (inicio, siguiendo, recientes).
const SIN_AUTOMATICOS = { automated: false }
const esAutomaticoPorConvencion = (ref: string | null) =>
  !!ref && (ref.startsWith('chapter:') || ref.startsWith('manga:'))

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
  for (const m of c.matchAll(/#([\p{L}\p{N}_]{1,80})/gu)) {
    const tag = m[1].toLowerCase()
    // Los titulos de capitulo traen "#90.5": un numero suelto no es una tendencia.
    if (/^\d+$/.test(tag)) continue
    out.add(tag)
  }
  return [...out].slice(0, 12)
}
const pageSel = { id: true, handle: true, type: true, parentPageId: true, parent: { select: { handle: true, displayName: true } }, externalId: true, displayName: true, avatarUrl: true, bannerUrl: true, bio: true, followersCount: true, followingCount: true, postsCount: true, createdAt: true }
function shapePage(p: any) {
  if (!p) return null
  const { parent, ...resto } = p
  // Las subpages (una obra dentro de un scan) viven bajo la ruta de su padre:
  // quien las pinta necesita el handle, no solo el id.
  return { ...resto, parentHandle: parent?.handle ?? null, parentDisplayName: parent?.displayName ?? null }
}
const wallSel = { id: true, handle: true, type: true, displayName: true, avatarUrl: true, parentPageId: true, parent: { select: { handle: true, displayName: true } } }
function shapePost(p: any, likedSet?: Set<number>, savedSet?: Set<number>) {
  // Contenido programado: hasta la hora señalada no se entrega ni al autor.
  const oculto = p.revealAt && new Date(p.revealAt) > new Date()
  const revelado = p.revealAt && !oculto && p.secretContent ? descifrar(p.secretContent) : null

  return {
    id: p.id,
    content: revelado ?? p.content,
    reveal: p.revealAt ? { at: p.revealAt, locked: !!oculto } : null,
    countdown: p.countdownAt ? { at: p.countdownAt, label: p.countdownLabel || null } : null,
    poll: p.poll
      ? {
          id: p.poll.id,
          options: Array.isArray(p.poll.options) ? p.poll.options : [],
          votesCount: p.poll.votesCount,
          endsAt: p.poll.endsAt,
          closed: !!(p.poll.endsAt && new Date(p.poll.endsAt) < new Date()),
          results: p.__pollResults ?? null,
          myVote: p.__myVote ?? null,
        }
      : null,
    media: p.media ?? null, repostOfId: p.repostOfId ?? null, externalRef: p.externalRef ?? null, automated: !!p.automated,
    likesCount: p.likesCount, commentsCount: p.commentsCount, repostCount: p.repostCount, pinned: p.pinned,
    createdAt: p.createdAt, liked: likedSet ? likedSet.has(p.id) : undefined, saved: savedSet ? savedSet.has(p.id) : undefined,
    author: shapePage(p.author), wallPageId: p.wallPageId,
    // Solo cuando el muro es otra page (p. ej. la obra donde se publica el capítulo).
    wall: p.wall && p.wall.id !== p.authorPageId ? shapePage(p.wall) : null,
  }
}
// Webhooks: hilos no sabe de correos ni de roles. Publica el evento firmado y
// cada app decide que hacer con el (avisar al staff, mandar un correo...).
const webhookCache = { exp: 0, map: new Map<number, { url: string; secret: string }>() }
async function appWebhook(appId: number) {
  if (webhookCache.exp < Date.now()) {
    const apps = await prisma.app.findMany({ select: { id: true, webhookUrl: true, webhookSecret: true } }).catch(() => [])
    webhookCache.map = new Map(apps.filter((a) => a.webhookUrl).map((a) => [a.id, { url: a.webhookUrl!, secret: a.webhookSecret || '' }]))
    webhookCache.exp = Date.now() + 60_000
  }
  return webhookCache.map.get(appId) || null
}

function emitEvent(appId: number, type: string, data: any) {
  appWebhook(appId).then(async (hook) => {
    if (!hook) return
    const body = JSON.stringify({ type, data, sentAt: new Date().toISOString() })
    const signature = createHmac('sha256', hook.secret).update(body).digest('hex')
    await fetch(hook.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hilos-event': type, 'x-hilos-signature': signature },
      body,
      signal: AbortSignal.timeout(8000),
    }).catch(() => {})
  }).catch(() => {})
}

// Los avisos nunca deben tumbar la accion que los genera: si fallan, se pierden
// en silencio y el usuario igual ve su comentario publicado.
function notify(appId: number, pageId: number, actorPageId: number | null, type: string, extra: { postId?: number; commentId?: number; preview?: string } = {}) {
  if (!pageId || pageId === actorPageId) return
  prisma.notification.create({
    data: {
      appId, pageId, actorPageId, type,
      postId: extra.postId ?? null,
      commentId: extra.commentId ?? null,
      preview: extra.preview ? extra.preview.slice(0, 200) : null,
    },
  }).catch(() => {})
}

// Menciones @handle dentro de un texto.
async function notifyMentions(appId: number, content: string, actorPageId: number, extra: { postId?: number; commentId?: number }) {
  const handles = [...new Set([...content.matchAll(/@([a-zA-Z0-9_]{3,40})/g)].map((m) => m[1].toLowerCase()))].slice(0, 10)
  if (!handles.length) return
  const pages = await prisma.page.findMany({ where: { appId, handle: { in: handles } }, select: { id: true } }).catch(() => [])
  for (const p of pages) notify(appId, p.id, actorPageId, 'mention', { ...extra, preview: content })
}

// Papel de una page dentro de otra (equipo de un scan). null = no pertenece.
async function memberRole(appId: number, pageId: number, memberPageId: number): Promise<string | null> {
  const m = await prisma.pageMember.findUnique({
    where: { pageId_memberPageId: { pageId, memberPageId } },
    select: { role: true, appId: true },
  }).catch(() => null)
  return m && m.appId === appId ? m.role : null
}

// ¿Esta page está silenciada por el staff? (metadata.mutedUntil)
async function isMuted(pageId: number): Promise<boolean> {
  const p = await prisma.page.findUnique({ where: { id: pageId }, select: { metadata: true } }).catch(() => null)
  const until = (p?.metadata as any)?.mutedUntil
  if (!until) return false
  if (until === 'forever') return true
  return new Date(until) > new Date()
}

// ── Moderación por alcance ───────────────────────────────────────────────────
// Un "alcance" es una page raíz (el scan de una app) y todas sus subpages (sus
// obras). La app modera SIEMPRE dentro de un alcance: el staff de un scan solo
// toca comentarios de su scan y solo silencia a alguien en su scan.

type Alcance = { roots: Array<{ id: number; handle: string; displayName: string | null }>; ids: Set<number> }

async function resolverAlcance(appId: number, refs: string): Promise<Alcance | null> {
  const lista = String(refs || '').split(',').map((r) => r.trim()).filter(Boolean).slice(0, 20)
  if (!lista.length) return null
  const roots: Alcance['roots'] = []
  for (const ref of lista) {
    const sel = { id: true, handle: true, displayName: true }
    const p = ref.startsWith('external:')
      ? await prisma.page.findUnique({ where: { appId_externalId: { appId, externalId: ref.slice(9) } }, select: sel })
      : await prisma.page.findUnique({ where: { appId_handle: { appId, handle: ref.toLowerCase() } }, select: sel })
    if (p) roots.push(p)
  }
  if (!roots.length) return null
  const hijos = await prisma.page.findMany({ where: { appId, parentPageId: { in: roots.map((r) => r.id) } }, select: { id: true } })
  return { roots, ids: new Set([...roots.map((r) => r.id), ...hijos.map((h) => h.id)]) }
}

const enAlcance = (a: Alcance, post: { wallPageId: number | null; authorPageId: number | null } | null) =>
  !!post && ((post.wallPageId != null && a.ids.has(post.wallPageId)) || (post.authorPageId != null && a.ids.has(post.authorPageId)))

// Silencios por alcance: metadata.mutes de la page raíz, por id de la page
// silenciada: { until: ISO | 'forever', reason, at, by }.
type Silencio = { until: string; reason?: string | null; at: string; by?: string | null }
const silencioVigente = (m?: Silencio | null) => !!m && (m.until === 'forever' || new Date(m.until) > new Date())

/** ¿Está silenciada esta page para escribir en ese muro (o en su scan)? */
async function silencioEnMuro(appId: number, authorPageId: number, wallPageId: number): Promise<{ until: string; scope: string | null } | null> {
  const wall = await prisma.page.findFirst({ where: { id: wallPageId, appId }, select: { id: true, displayName: true, metadata: true, parent: { select: { id: true, displayName: true, metadata: true } } } })
  if (!wall) return null
  for (const p of [wall, wall.parent].filter(Boolean) as any[]) {
    const m = (p.metadata as any)?.mutes?.[String(authorPageId)] as Silencio | undefined
    if (silencioVigente(m)) return { until: m!.until, scope: p.displayName ?? null }
  }
  return null
}

// Ordenaciones disponibles en las listas. 'reciente' es el valor por defecto
// en casi todo: lo último es lo que la gente viene a ver.
type SortKey = 'reciente' | 'antiguo' | 'popular' | 'comentado' | 'menos_popular' | 'menos_comentado'
const SORTS: SortKey[] = ['reciente', 'antiguo', 'popular', 'comentado', 'menos_popular', 'menos_comentado']
const asSort = (v: any, fallback: SortKey = 'reciente'): SortKey => (SORTS.includes(String(v) as SortKey) ? (String(v) as SortKey) : fallback)

function postOrder(sort: SortKey): any[] {
  switch (sort) {
    case 'antiguo': return [{ createdAt: 'asc' }]
    case 'popular': return [{ likesCount: 'desc' }, { createdAt: 'desc' }]
    case 'menos_popular': return [{ likesCount: 'asc' }, { createdAt: 'desc' }]
    case 'comentado': return [{ commentsCount: 'desc' }, { createdAt: 'desc' }]
    case 'menos_comentado': return [{ commentsCount: 'asc' }, { createdAt: 'desc' }]
    default: return [{ createdAt: 'desc' }]
  }
}

// Los comentarios no tienen respuestas contadas: los "menos/mas comentados"
// se resuelven por me gusta, que es la senal real de un comentario.
// En el directorio, "popular" son seguidores y "comentado" son publicaciones.
function directoryOrder(sort: SortKey): any[] {
  switch (sort) {
    case 'reciente': return [{ createdAt: 'desc' }]
    case 'antiguo': return [{ createdAt: 'asc' }]
    case 'popular': return [{ followersCount: 'desc' }, { postsCount: 'desc' }]
    case 'menos_popular': return [{ followersCount: 'asc' }, { postsCount: 'asc' }]
    case 'menos_comentado': return [{ postsCount: 'asc' }, { followersCount: 'asc' }]
    default: return [{ postsCount: 'desc' }, { followersCount: 'desc' }]
  }
}

function commentOrder(sort: SortKey): any[] {
  switch (sort) {
    case 'antiguo': return [{ createdAt: 'asc' }]
    case 'popular': case 'comentado': return [{ likesCount: 'desc' }, { createdAt: 'desc' }]
    case 'menos_popular': case 'menos_comentado': return [{ likesCount: 'asc' }, { createdAt: 'asc' }]
    default: return [{ createdAt: 'desc' }]
  }
}

// Vistazo rápido a la conversación de cada post: las últimas respuestas y las
// que más han gustado, sin repetir ninguna.
async function attachReplies(appId: number, shaped: any[], ids: number[]) {
  if (!ids.length) return
  const rows = await prisma.$queryRaw<any[]>`
    SELECT id, "postId", content, "createdAt", "authorPageId", "likesCount" FROM (
      SELECT c.id, c."postId", c.content, c."createdAt", c."authorPageId", c."likesCount",
             ROW_NUMBER() OVER (PARTITION BY c."postId" ORDER BY c."createdAt" DESC) AS rn_new,
             ROW_NUMBER() OVER (PARTITION BY c."postId" ORDER BY c."likesCount" DESC, c."createdAt" DESC) AS rn_top
      FROM comment c
      WHERE c."postId" = ANY(${ids}::int[]) AND c."deletedAt" IS NULL AND c."hiddenAt" IS NULL
    ) t WHERE t.rn_new <= 3 OR t.rn_top <= 3`

  const authorIds = [...new Set(rows.map((r) => r.authorPageId))]
  const authors = authorIds.length ? await prisma.page.findMany({ where: { id: { in: authorIds } }, select: pageSel }) : []
  const byPage = new Map(authors.map((a) => [a.id, a]))

  const byPost = new Map<number, any[]>()
  for (const r of rows) {
    const list = byPost.get(r.postId) || []
    // La consulta puede devolver la misma fila por las dos vías.
    if (!list.some((x) => x.id === r.id)) {
      list.push({ id: r.id, content: r.content, createdAt: r.createdAt, likesCount: r.likesCount, author: shapePage(byPage.get(r.authorPageId)) })
    }
    byPost.set(r.postId, list)
  }
  for (const [, list] of byPost) {
    list.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  }
  for (const p of shaped) p.recentComments = byPost.get(p.id) || []
}

// Resultados de las encuestas de una tanda de posts, y qué votó el espectador.
async function attachPolls(shaped: any[], rows: any[], viewer: number | null) {
  const conEncuesta = rows.filter((r) => r.poll)
  if (!conEncuesta.length) return
  const pollIds = conEncuesta.map((r) => r.poll.id)

  const conteo = await prisma.postPollVote.groupBy({
    by: ['pollId', 'optionIndex'],
    where: { pollId: { in: pollIds } },
    _count: { optionIndex: true },
  }).catch(() => [])

  const mios = viewer
    ? await prisma.postPollVote.findMany({ where: { pollId: { in: pollIds }, pageId: viewer }, select: { pollId: true, optionIndex: true } }).catch(() => [])
    : []
  const miVoto = new Map(mios.map((m) => [m.pollId, m.optionIndex]))

  for (const p of shaped) {
    const fila = rows.find((r) => r.id === p.id)
    if (!fila?.poll || !p.poll) continue
    const opciones = Array.isArray(fila.poll.options) ? fila.poll.options : []
    p.poll.results = opciones.map((_: any, i: number) =>
      conteo.find((c) => c.pollId === fila.poll.id && c.optionIndex === i)?._count.optionIndex ?? 0)
    p.poll.myVote = miVoto.has(fila.poll.id) ? miVoto.get(fila.poll.id) : null
  }
}

async function savedPosts(appId: number, pageId: number | null | undefined, postIds: number[]): Promise<Set<number>> {
  if (!pageId || !postIds.length) return new Set()
  const r = await prisma.save.findMany({ where: { appId, pageId, postId: { in: postIds } }, select: { postId: true } })
  return new Set(r.map((x) => x.postId))
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
    // Emite una publishable key nueva para la app (lectura publica desde el
    // navegador). Protegido por el token de bootstrap.
    .post('/admin/publishable-key', async ({ auth, request, body }: any) => {
      if (!auth || auth.mode !== 'secret') return { error: 'secret_key_required' }
      if (!process.env.HILOS_BOOTSTRAP_TOKEN || request.headers.get('x-bootstrap-token') !== process.env.HILOS_BOOTSTRAP_TOKEN) return { error: 'forbidden' }
      const pk = generateApiKey('publishable')
      await prisma.apiKey.create({ data: { appId: auth.appId, label: String(body?.label || 'client'), type: 'publishable', prefix: pk.prefix, keyHash: pk.hash } })
      return { data: { publishableKey: pk.full } }
    }, { body: t.Optional(t.Object({ label: t.Optional(t.String()) })) })

    // Radiografía de la app: cuánta gente, cuánto se publica y cuánto se habla.
    .get('/admin/stats', async ({ auth, request }: any) => {
      if (!auth || auth.mode !== 'secret') return { error: 'secret_key_required' }
      if (!process.env.HILOS_BOOTSTRAP_TOKEN || request.headers.get('x-bootstrap-token') !== process.env.HILOS_BOOTSTRAP_TOKEN) return { error: 'forbidden' }
      const appId = auth.appId
      const desde = (dias: number) => new Date(Date.now() - dias * 86400000)

      const [
        pages, usuarios, scans, obras,
        posts, postsPropios, comentarios, likes, guardados, seguimientos,
        conversaciones, mensajes, avisos,
        posts7, comentarios7, likes7, seguimientos7, usuarios7, mensajes7,
        posts1, comentarios1, usuarios1,
      ] = await Promise.all([
        prisma.page.count({ where: { appId } }),
        prisma.page.count({ where: { appId, type: 'user' } }),
        prisma.page.count({ where: { appId, type: 'scan' } }),
        prisma.page.count({ where: { appId, type: 'manga' } }),
        prisma.post.count({ where: { appId, deletedAt: null } }),
        prisma.post.count({ where: { appId, deletedAt: null, externalRef: null } }),
        prisma.comment.count({ where: { appId, deletedAt: null } }),
        prisma.reaction.count({ where: { appId, type: 'like' } }),
        prisma.save.count({ where: { appId } }),
        prisma.follow.count({ where: { appId } }),
        prisma.conversation.count({ where: { appId } }),
        prisma.message.count({ where: { appId, deletedAt: null } }),
        prisma.notification.count({ where: { appId } }),
        prisma.post.count({ where: { appId, deletedAt: null, createdAt: { gte: desde(7) } } }),
        prisma.comment.count({ where: { appId, deletedAt: null, createdAt: { gte: desde(7) } } }),
        prisma.reaction.count({ where: { appId, type: 'like', createdAt: { gte: desde(7) } } }),
        prisma.follow.count({ where: { appId, createdAt: { gte: desde(7) } } }),
        prisma.page.count({ where: { appId, type: 'user', createdAt: { gte: desde(7) } } }),
        prisma.message.count({ where: { appId, deletedAt: null, createdAt: { gte: desde(7) } } }),
        prisma.post.count({ where: { appId, deletedAt: null, createdAt: { gte: desde(1) } } }),
        prisma.comment.count({ where: { appId, deletedAt: null, createdAt: { gte: desde(1) } } }),
        prisma.page.count({ where: { appId, type: 'user', createdAt: { gte: desde(1) } } }),
      ])

      // Cuentas que han hecho algo (publicar o comentar) en la última semana.
      const activos = await prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(DISTINCT autor) AS n FROM (
          SELECT "authorPageId" AS autor FROM post
          WHERE "appId" = ${appId} AND "deletedAt" IS NULL AND "createdAt" > NOW() - interval '7 days'
          UNION
          SELECT "authorPageId" AS autor FROM comment
          WHERE "appId" = ${appId} AND "deletedAt" IS NULL AND "createdAt" > NOW() - interval '7 days'
        ) t`

      return {
        data: {
          pages: { total: pages, usuarios, scans, obras },
          contenido: { posts, postsPropios, comentarios, likes, guardados, seguimientos },
          mensajeria: { conversaciones, mensajes, avisos },
          semana: { posts: posts7, comentarios: comentarios7, likes: likes7, seguimientos: seguimientos7, usuariosNuevos: usuarios7, mensajes: mensajes7, cuentasActivas: Number(activos[0]?.n || 0) },
          hoy: { posts: posts1, comentarios: comentarios1, usuariosNuevos: usuarios1 },
        },
      }
    })

    .post('/admin/webhook', async ({ auth, request, body }: any) => {
      if (!auth || auth.mode !== 'secret') return { error: 'secret_key_required' }
      if (!process.env.HILOS_BOOTSTRAP_TOKEN || request.headers.get('x-bootstrap-token') !== process.env.HILOS_BOOTSTRAP_TOKEN) return { error: 'forbidden' }
      const app = await prisma.app.update({
        where: { id: auth.appId },
        data: { webhookUrl: body.url || null, webhookSecret: body.secret || null },
        select: { id: true, slug: true, webhookUrl: true },
      })
      webhookCache.exp = 0
      return { data: app }
    }, { body: t.Object({ url: t.Optional(t.String()), secret: t.Optional(t.String()) }) })

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
      // Un PUT prefirmado no puede acotar el tamaño ni comprobar lo que se sube:
      // solo para el backend de la app. El navegador sube por /uploads/direct.
      if (auth.mode !== 'secret') return { error: 'secret_key_required' }
      const img = imagenDeTipo(body.contentType)
      if (!img) return { error: 'only_images' }
      const c = s3(); if (!c) return { error: 'storage_not_configured' }
      const name = nombreSeguro(body.filename, img.ext)
      const key = `${auth.appId}/media/${Date.now()}-${randomBytes(6).toString('hex')}-${name}`
      const uploadUrl = c.presign(key, { method: 'PUT', expiresIn: 900, type: img.type })
      return { data: { uploadUrl, key, publicUrl: `${R2_PUBLIC}/${key}`, expiresIn: 900 } }
    }, { body: t.Object({ filename: t.Optional(t.String()), contentType: t.Optional(t.String()) }) })

    // Subida directa a través del motor. R2 no acepta PUT desde el navegador
    // sin reglas CORS propias, y esas reglas no las controla cada app: así que
    // el archivo entra por aquí y hilos lo guarda.
    .post('/uploads/direct', async ({ auth, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      // Secret key o page token con escritura; la clave pública no sube nada.
      if (!canWrite(auth)) return { error: 'insufficient_scope' }
      if (auth.mode === 'page' && !rateLimit(`upload:${auth.pageId}`, 60, 10 * 60_000)) return { error: 'rate_limited' }

      let file: any = null
      try {
        const form = await request.formData()
        file = form.get('file')
      } catch { return { error: 'invalid_form' } }
      if (!file || typeof file === 'string') return { error: 'no_file' }

      const MAX_BYTES = 8 * 1024 * 1024
      if (file.size > MAX_BYTES) return { error: 'file_too_large' }
      let bytes: Uint8Array
      try { bytes = new Uint8Array(await file.arrayBuffer()) } catch { return { error: 'invalid_form' } }
      if (bytes.byteLength > MAX_BYTES) return { error: 'file_too_large' }

      // El tipo sale de los bytes, no del cliente: solo imágenes rasterizadas
      // (nada de SVG ni HTML servido desde el dominio de media).
      const img = detectarImagen(bytes)
      if (!img) return { error: 'only_images' }

      const c = s3(); if (!c) return { error: 'storage_not_configured' }
      const name = nombreSeguro(file.name, img.ext)
      const key = `${auth.appId}/media/${Date.now()}-${randomBytes(6).toString('hex')}-${name}`
      try {
        await c.write(key, bytes, { type: img.type })
        return { data: { key, publicUrl: `${R2_PUBLIC}/${key}` } }
      } catch (e: any) {
        return { error: 'upload_failed' }
      }
    })

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
      // Para una obra, el número que la describe es el de su muro.
      let postsCount = page.postsCount
      if (page.type === 'manga') {
        postsCount = await prisma.post.count({ where: { appId: auth.appId, wallPageId: page.id, deletedAt: null, hiddenAt: null } })
      }

      let viewerFollows = false
      const viewerPageId = auth.pageId ?? (await actingPage(auth, request.headers).catch(() => null))
      if (viewerPageId && viewerPageId !== page.id) {
        const f = await prisma.follow.findUnique({ where: { appId_followerPageId_followedPageId: { appId: auth.appId, followerPageId: viewerPageId, followedPageId: page.id } }, select: { id: true } })
        viewerFollows = !!f
      }
      return { data: { ...shapePage(page), postsCount, viewerFollows } }
    })

    // Mintea un page token (JWT app+page) desde el server del consumidor.
    .post('/page-tokens', async ({ auth, body }: any) => {
      if (!auth || auth.mode !== 'secret') return { error: 'secret_key_required' }
      let pageId: number | null = null
      if (body.pageId) { const p = await prisma.page.findFirst({ where: { id: Number(body.pageId), appId: auth.appId }, select: { id: true } }); pageId = p?.id ?? null }
      else if (body.externalId) { const p = await prisma.page.findUnique({ where: { appId_externalId: { appId: auth.appId, externalId: String(body.externalId) } }, select: { id: true } }); pageId = p?.id ?? null }
      if (!pageId) return { error: 'page_not_found' }

      // Actuar en nombre de otra page (un scan): el motor comprueba que quien
      // lo pide pertenece a ese equipo, para que la app no pueda equivocarse.
      if (body.onBehalfOf) {
        const destino = await prisma.page.findUnique({
          where: { appId_handle: { appId: auth.appId, handle: String(body.onBehalfOf).toLowerCase() } },
          select: { id: true },
        })
        if (!destino) return { error: 'page_not_found' }
        const rol = await memberRole(auth.appId, destino.id, pageId)
        if (!rol) return { error: 'not_a_member' }
        pageId = destino.id
      }

      // TTL corto por defecto (15 min): el cliente renueva desde su backend.
      const ttl = Math.min(3600, Math.max(60, Number(body.ttl) || 900))
      const scopes = Array.isArray(body.scopes) && body.scopes.length
        ? body.scopes.filter((x: string) => (CLIENT_SCOPES as string[]).includes(x))
        : ['read', 'post:write', 'comment:write', 'react', 'follow']
      const aud = body.origin ? String(body.origin) : undefined
      const token = signJwt({ t: 'page', appId: auth.appId, pageId, sub: `page:${pageId}`, scope: scopes.join(' '), ...(aud ? { aud } : {}) }, SECRET, ttl)
      return { data: { token, pageId, expiresIn: ttl, scopes } }
    }, { body: t.Object({ pageId: t.Optional(t.Union([t.String(), t.Number()])), externalId: t.Optional(t.Union([t.String(), t.Number()])), ttl: t.Optional(t.Number()), scopes: t.Optional(t.Array(t.String())), origin: t.Optional(t.String()), onBehalfOf: t.Optional(t.String()) }) })

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

    // Sugerencias de pages a seguir (mas activas que el viewer aun no sigue).
    // Directorio paginado de pages (scroll infinito en Explorar).
    // ---- Descubrimiento (trending, busqueda, tags) ----

    // Hashtags con mas actividad en los ultimos 7 dias.
    .get('/socials/trending', async ({ auth, query }: any) => {
      if (!auth) return { error: 'unauthorized' }
      const limit = Math.min(20, Number(query.limit) || 8)
      const since = new Date(Date.now() - 7 * 24 * 3600 * 1000)
      const isNoise = (t: string) => /^\d+$/.test(t)
      const over = limit * 6
      const rows = await prisma.hashtag.groupBy({
        by: ['tag'],
        where: { appId: auth.appId, createdAt: { gte: since } },
        _count: { tag: true },
        orderBy: { _count: { tag: 'desc' } },
        take: over,
      })
      let src = rows.filter((r: any) => !isNoise(r.tag))
      // Si la ventana de 7 dias esta vacia (contenido historico migrado), caemos a todo el historico.
      if (!src.length) {
        const all = await prisma.hashtag.groupBy({
          by: ['tag'], where: { appId: auth.appId }, _count: { tag: true },
          orderBy: { _count: { tag: 'desc' } }, take: over,
        })
        src = all.filter((r: any) => !isNoise(r.tag))
      }
      return { data: src.slice(0, limit).map((r: any) => ({ tag: r.tag, count: r._count.tag })) }
    })

    // Rankings agregados de comentarios para el app consumidor (solo clave
    // secreta). Devuelve [{ externalId, count }] ordenado de mayor a menor.
    //   comments          comentarios escritos por cada page de usuario
    //   replies           respuestas escritas (comentarios que responden a otro)
    //   replies_received  respuestas que recibieron sus comentarios (sin contar
    //                     las que se hace uno mismo)
    //   scan_comments     comentarios en los muros de un scan o de sus obras
    .get('/socials/leaderboard', async ({ auth, query }: any) => {
      if (!auth || auth.mode !== 'secret') return { error: 'secret_key_required' }
      const limit = Math.min(500, Math.max(1, Number(query.limit) || 100))
      const metric = String(query.metric || '')
      let rows: { externalId: string | null; n: bigint }[] = []
      if (metric === 'comments' || metric === 'replies') {
        const soloRespuestas = metric === 'replies'
        rows = await prisma.$queryRaw`
          SELECT a."externalId", COUNT(*) AS n
          FROM comment c JOIN page a ON a.id = c."authorPageId"
          WHERE c."appId" = ${auth.appId} AND c."deletedAt" IS NULL AND c."hiddenAt" IS NULL
            AND a.type = 'user' AND a."externalId" IS NOT NULL
            AND (${soloRespuestas} = false OR c."parentCommentId" IS NOT NULL)
          GROUP BY a."externalId" ORDER BY n DESC LIMIT ${limit}`
      } else if (metric === 'replies_received') {
        rows = await prisma.$queryRaw`
          SELECT a."externalId", COUNT(*) AS n
          FROM comment c
          JOIN comment p ON p.id = c."parentCommentId"
          JOIN page a ON a.id = p."authorPageId"
          WHERE c."appId" = ${auth.appId} AND c."deletedAt" IS NULL AND c."hiddenAt" IS NULL
            AND c."authorPageId" <> p."authorPageId"
            AND a.type = 'user' AND a."externalId" IS NOT NULL
          GROUP BY a."externalId" ORDER BY n DESC LIMIT ${limit}`
      } else if (metric === 'scan_comments') {
        rows = await prisma.$queryRaw`
          SELECT CASE WHEN w.type = 'scan' THEN w."externalId" ELSE s."externalId" END AS "externalId", COUNT(*) AS n
          FROM comment c
          JOIN post po ON po.id = c."postId"
          JOIN page w ON w.id = po."wallPageId"
          LEFT JOIN page s ON s.id = w."parentPageId"
          WHERE c."appId" = ${auth.appId} AND c."deletedAt" IS NULL AND c."hiddenAt" IS NULL
            AND (w.type = 'scan' OR s.type = 'scan')
          GROUP BY 1 ORDER BY n DESC LIMIT ${limit}`
      } else {
        return { error: 'unknown_metric' }
      }
      return { data: rows.filter((r) => r.externalId).map((r) => ({ externalId: r.externalId, count: Number(r.n) })) }
    })

    // Muros (pages) con mas comentarios en los ultimos N dias. Lo usa el app
    // consumidor para ordenar lo mas comentado (ej. obras en su portada).
    .get('/socials/most-commented', async ({ auth, query }: any) => {
      if (!auth) return { error: 'unauthorized' }
      const limit = Math.min(200, Number(query.limit) || 20)
      const days = Math.min(90, Math.max(1, Number(query.days) || 7))
      const rows = await prisma.$queryRaw<{ externalId: string | null; n: bigint }[]>`
        SELECT w."externalId", COUNT(*) AS n
        FROM comment c
        JOIN post p ON p.id = c."postId"
        JOIN page w ON w.id = p."wallPageId"
        WHERE c."appId" = ${auth.appId}
          AND c."deletedAt" IS NULL AND c."hiddenAt" IS NULL
          AND c."createdAt" > NOW() - (${days} || ' days')::interval
          AND w."externalId" IS NOT NULL
        GROUP BY w."externalId"
        ORDER BY n DESC
        LIMIT ${limit}`
      return { data: rows.map((r) => ({ externalId: r.externalId, count: Number(r.n) })) }
    })

    // Pages con mas movimiento (posts recientes). Es lo que de verdad esta
    // pasando en la red cuando todavia no hay hashtags con traccion.
    .get('/socials/active', async ({ auth, query }: any) => {
      if (!auth) return { error: 'unauthorized' }
      const limit = Math.min(20, Number(query.limit) || 6)
      const days = Math.min(90, Math.max(1, Number(query.days) || 7))
      const since = new Date(Date.now() - days * 24 * 3600 * 1000)
      const rows = await prisma.post.groupBy({
        by: ['wallPageId'],
        where: { appId: auth.appId, deletedAt: null, hiddenAt: null, createdAt: { gte: since } },
        _count: { wallPageId: true },
        orderBy: { _count: { wallPageId: 'desc' } },
        take: limit,
      })
      if (!rows.length) return { data: [] }
      const pages = await prisma.page.findMany({ where: { id: { in: rows.map((r) => r.wallPageId) } }, select: pageSel })
      const byId = new Map(pages.map((p) => [p.id, p]))
      return {
        data: rows
          .map((r) => ({ page: shapePage(byId.get(r.wallPageId)), count: r._count.wallPageId }))
          .filter((r) => r.page),
      }
    })

    // Busqueda unificada: pages por handle/nombre + posts por contenido.
    .get('/socials/search', async ({ auth, query, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      const q = String(query.q || '').trim()
      if (q.length < 2) return { data: { users: [], items: [] } }
      const limit = Math.min(30, Number(query.limit) || 20)
      const term = q.replace(/^[#@]/, '')
      const [pages, rows] = await Promise.all([
        prisma.page.findMany({
          where: {
            appId: auth.appId,
            OR: [{ handle: { contains: term, mode: 'insensitive' } }, { displayName: { contains: term, mode: 'insensitive' } }],
          },
          orderBy: [{ followersCount: 'desc' }, { postsCount: 'desc' }],
          take: limit, select: pageSel,
        }),
        prisma.post.findMany({
          where: { appId: auth.appId, deletedAt: null, hiddenAt: null, content: { contains: term, mode: 'insensitive' } },
          orderBy: { createdAt: 'desc' }, take: limit, include: { author: { select: pageSel }, wall: { select: wallSel }, poll: true },
        }),
      ])
      const viewer = await viewerPage(auth, request.headers)
      const ids = rows.map((p) => p.id)
      const [likes, saves] = await Promise.all([likedPosts(auth.appId, viewer, ids), savedPosts(auth.appId, viewer, ids)])
      return { data: { users: pages.map(shapePage), items: rows.map((p) => shapePost(p, likes, saves)) } }
    })

    // Posts de un hashtag.
    .get('/socials/tag/:tag', async ({ auth, params, query, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      const tag = String(params.tag || '').replace(/^#/, '').toLowerCase()
      if (!tag) return { data: { items: [], hasMore: false } }
      const limit = Math.min(30, Number(query.limit) || 20)
      const pg = Math.max(0, Number(query.page) || 0)
      const refs = await prisma.hashtag.findMany({
        where: { appId: auth.appId, tag }, orderBy: { createdAt: 'desc' },
        skip: pg * limit, take: limit + 1, select: { postId: true },
      })
      const hasMore = refs.length > limit
      const ids = refs.slice(0, limit).map((r) => r.postId)
      if (!ids.length) return { data: { items: [], hasMore: false } }
      const rows = await prisma.post.findMany({ where: { id: { in: ids }, deletedAt: null, hiddenAt: null }, include: { author: { select: pageSel }, wall: { select: wallSel }, poll: true } })
      rows.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
      const viewer = await viewerPage(auth, request.headers)
      const [likes, saves] = await Promise.all([likedPosts(auth.appId, viewer, ids), savedPosts(auth.appId, viewer, ids)])
      return { data: { items: rows.map((p) => shapePost(p, likes, saves)), hasMore } }
    })

    .get('/pages/directory', async ({ auth, query }: any) => {
      if (!auth) return { error: 'unauthorized' }
      const limit = Math.min(48, Math.max(1, Number(query.limit) || 24))
      const page = Math.max(0, Number(query.page) || 0)
      const type = String(query.type || '')
      const q = String(query.q || '').trim()
      const types = type === 'user' ? ['user'] : type === 'scan' ? ['scan'] : ['scan', 'user']
      const where: any = { appId: auth.appId, type: { in: types } }
      if (q) where.OR = [{ displayName: { contains: q, mode: 'insensitive' } }, { handle: { contains: q.toLowerCase() } }]
      const rows = await prisma.page.findMany({
        where,
        orderBy: [...directoryOrder(asSort(query.sort, 'comentado')), { id: 'asc' }],
        skip: page * limit, take: limit + 1, select: pageSel,
      })
      const hasMore = rows.length > limit
      return { data: { items: rows.slice(0, limit).map(shapePage), hasMore } }
    })

    .get('/pages/suggested', async ({ auth, query, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      const limit = Math.min(10, Math.max(1, Number(query.limit) || 5))
      // El espectador puede venir por token o por cabecera: si no lo resolvemos,
      // seguimos sugiriendo cuentas que la persona ya sigue.
      const viewer = await viewerPage(auth, request.headers)
      let excludeIds: number[] = []
      if (viewer) {
        const f = await prisma.follow.findMany({ where: { appId: auth.appId, followerPageId: viewer }, select: { followedPageId: true } })
        excludeIds = [...f.map((x) => x.followedPageId), viewer]
      }
      const type = String(query.type || '')
      const types = type === 'user' ? ['user'] : type === 'scan' ? ['scan'] : ['scan', 'user']
      const rows = await prisma.page.findMany({
        where: { appId: auth.appId, ...(excludeIds.length ? { id: { notIn: excludeIds } } : {}), type: { in: types } },
        orderBy: [{ followersCount: 'desc' }, { postsCount: 'desc' }, { id: 'asc' }],
        take: limit, select: pageSel,
      })
      return { data: rows.map((p) => ({ ...shapePage(p), viewerFollows: false })) }
    })

    .get('/pages/:handle/followers', async ({ auth, params, query }: any) => {
      if (!auth) return { error: 'unauthorized' }
      const page = await prisma.page.findUnique({ where: { appId_handle: { appId: auth.appId, handle: params.handle } }, select: { id: true } })
      if (!page) return { error: 'not_found' }
      const limit = Math.min(50, Number(query.limit) || 30)
      const rows = await prisma.follow.findMany({ where: { appId: auth.appId, followedPageId: page.id }, orderBy: { createdAt: 'desc' }, take: limit, select: { followerPageId: true } })
      const pages = await prisma.page.findMany({ where: { id: { in: rows.map((r) => r.followerPageId) } }, select: pageSel })
      return { data: pages.map(shapePage) }
    })

    .get('/pages/:handle/following', async ({ auth, params, query }: any) => {
      if (!auth) return { error: 'unauthorized' }
      const page = await prisma.page.findUnique({ where: { appId_handle: { appId: auth.appId, handle: params.handle } }, select: { id: true } })
      if (!page) return { error: 'not_found' }
      const limit = Math.min(50, Number(query.limit) || 30)
      const rows = await prisma.follow.findMany({ where: { appId: auth.appId, followerPageId: page.id }, orderBy: { createdAt: 'desc' }, take: limit, select: { followedPageId: true } })
      const pages = await prisma.page.findMany({ where: { id: { in: rows.map((r) => r.followedPageId) } }, select: pageSel })
      return { data: pages.map(shapePage) }
    })

    // Editar el propio perfil. Con page token solo puede editarse uno mismo;
    // con secret key la app puede editar cualquiera de sus pages.
    .patch('/pages/:handle', async ({ auth, params, body, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      const page = await prisma.page.findUnique({ where: { appId_handle: { appId: auth.appId, handle: String(params.handle).toLowerCase() } }, select: { id: true, handle: true } })
      if (!page) return { error: 'not_found' }
      if (auth.mode !== 'secret') {
        let me: number
        try { me = await actingPage(auth, request.headers) } catch (e: any) { return { error: e.message } }
        if (me !== page.id) return { error: 'forbidden' }
      }
      const data: any = {}
      if (body.displayName !== undefined) data.displayName = String(body.displayName).trim().slice(0, 200) || null
      if (body.bio !== undefined) data.bio = String(body.bio).trim().slice(0, 600) || null
      if (body.avatarUrl !== undefined) data.avatarUrl = body.avatarUrl ? String(body.avatarUrl).slice(0, 500) : null
      if (body.bannerUrl !== undefined) data.bannerUrl = body.bannerUrl ? String(body.bannerUrl).slice(0, 500) : null
      if (body.handle !== undefined) {
        const h = String(body.handle).toLowerCase().replace(/[^a-z0-9_]/g, '')
        if (h.length < 3) return { error: 'handle_too_short' }
        if (h !== page.handle) {
          const taken = await prisma.page.findUnique({ where: { appId_handle: { appId: auth.appId, handle: h } }, select: { id: true } })
          if (taken) return { error: 'handle_taken' }
          data.handle = h
        }
      }
      if (!Object.keys(data).length) return { error: 'nothing_to_update' }
      const updated = await prisma.page.update({ where: { id: page.id }, data, select: pageSel })
      return { data: shapePage(updated) }
    }, { body: t.Object({ displayName: t.Optional(t.String()), bio: t.Optional(t.String()), avatarUrl: t.Optional(t.Union([t.String(), t.Null()])), bannerUrl: t.Optional(t.Union([t.String(), t.Null()])), handle: t.Optional(t.String()) }) })

    .get('/pages/:handle/posts', async ({ auth, params, query, request }: any) => {
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
      const rows = await prisma.post.findMany({ where, orderBy: [{ pinned: 'desc' }, ...postOrder(asSort(query.sort))], skip: pg * limit, take: limit + 1, include: { author: { select: pageSel }, wall: { select: wallSel }, poll: true } })
      const has = rows.length > limit, items = rows.slice(0, limit)
      const ids = items.map((p) => p.id)
      const viewer = await viewerPage(auth, request.headers)
      const [likes, saves] = await Promise.all([likedPosts(auth.appId, viewer, ids), savedPosts(auth.appId, viewer, ids)])
      const shaped = items.map((p) => shapePost(p, likes, saves))
      await attachPolls(shaped, items, viewer)
      if (query.replies === '1' || query.replies === 'true') await attachReplies(auth.appId, shaped, ids)
      return { data: { items: shaped, hasMore: has } }
    })

    // ---- Posts ----
    .post('/posts', async ({ auth, body, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      if (!requireScope(auth, 'post:write')) return { error: 'insufficient_scope' }
      let authorPageId: number
      try { authorPageId = await actingPage(auth, request.headers) } catch (e: any) { return { error: e.message } }
      if (auth.mode === 'page' && !rateLimit(`post:${authorPageId}`, 10, 5 * 60_000)) return { error: 'rate_limited' }
      // Los silencios valen para la page que actúa, venga con page token o con
      // la secret key + X-Hilos-Page (un backend que reenvía la acción).
      if (await isMuted(authorPageId)) return { error: 'muted' }
      const secreta = auth.mode === 'secret'
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
      // Publicar en el muro de un scan (o de sus obras) donde te silenciaron.
      if (wallPageId !== authorPageId) {
        const sil = await silencioEnMuro(auth.appId, authorPageId, wallPageId)
        if (sil) return { error: 'muted_scope', until: sil.until, scope: sil.scope }
      }
      // externalRef, metadata y createdAt son cosa de la app (auto-posts,
      // migraciones): con page token se ignoran. La fecha nunca va al futuro.
      const externalRef = secreta && body.externalRef ? String(body.externalRef) : null
      // Solo la app (clave secreta) marca un post como automatico. Si no manda
      // el flag, cuentan sus referencias de aviso de capitulo ('chapter:') o de
      // ancla de obra ('manga:'), para que nunca lleguen al feed.
      const automated = !!(secreta && (body.automated === true || esAutomaticoPorConvencion(externalRef)))
      let createdAt: Date | undefined
      if (secreta && body.createdAt) {
        const d = fechaNoFutura(body.createdAt)
        if (!d) return { error: 'bad_created_at' }
        createdAt = d
      }
      // Dedupe por externalRef (auto-post/migracion idempotente). Solo es el
      // mismo post si lo publicó la misma page; si no, la referencia es de otro.
      if (externalRef) {
        const dup = await prisma.post.findUnique({ where: { appId_externalRef: { appId: auth.appId, externalRef } }, include: { author: { select: pageSel }, wall: { select: wallSel }, poll: true } }).catch(() => null)
        if (dup && dup.authorPageId !== authorPageId) return { error: 'external_ref_taken', postId: dup.id }
        if (dup) return { data: shapePost(dup), deduped: true }
      }
      // Un mensaje programado se guarda cifrado y con un aviso en su lugar.
      const revealAt = body.revealAt ? new Date(body.revealAt) : null
      const programado = revealAt && revealAt > new Date()
      const contenidoVisible = programado
        ? String(body.revealPlaceholder || 'Mensaje programado').slice(0, 200)
        : content

      const post = await prisma.post.create({ data: {
        appId: auth.appId, authorPageId, wallPageId,
        content: contenidoVisible,
        ...(programado ? { revealAt, secretContent: cifrar(content) } : {}),
        ...(body.countdownAt ? { countdownAt: new Date(body.countdownAt), countdownLabel: body.countdownLabel ? String(body.countdownLabel).slice(0, 120) : null } : {}),
        media: body.media ?? undefined,
        repostOfId: body.repostOfId ? Number(body.repostOfId) : null, externalRef, automated,
        metadata: secreta ? (body.metadata ?? undefined) : undefined, createdAt,
      }, include: { author: { select: pageSel }, wall: { select: wallSel }, poll: true } })
      notifyMentions(auth.appId, content, authorPageId, { postId: post.id })
      // La encuesta se crea con el post: sin post no hay dónde votar.
      if (Array.isArray(body.poll?.options) && body.poll.options.length >= 2) {
        const opciones = body.poll.options
          .map((o: any) => String(o).trim().slice(0, 80))
          .filter(Boolean)
          .slice(0, 6)
        if (opciones.length >= 2) {
          await prisma.postPoll.create({
            data: {
              appId: auth.appId,
              postId: post.id,
              options: opciones,
              endsAt: body.poll.endsAt ? new Date(body.poll.endsAt) : null,
            },
          }).catch(() => {})
        }
      }

      const tags = parseHashtags(content)
      if (tags.length) await prisma.hashtag.createMany({ data: tags.map((tag) => ({ appId: auth.appId, postId: post.id, tag })) }).catch(() => {})
      await prisma.page.update({ where: { id: authorPageId }, data: { postsCount: { increment: 1 } } }).catch(() => {})
      return { data: shapePost(post) }
    }, { body: t.Object({
      content: t.Optional(t.String()), media: t.Optional(t.Any()),
      wallHandle: t.Optional(t.String()), wallExternalId: t.Optional(t.Union([t.String(), t.Number()])),
      wallPageId: t.Optional(t.Union([t.String(), t.Number()])), repostOfId: t.Optional(t.Union([t.String(), t.Number()])),
      externalRef: t.Optional(t.String()), metadata: t.Optional(t.Any()), createdAt: t.Optional(t.String()),
      revealAt: t.Optional(t.String()), revealPlaceholder: t.Optional(t.String()),
      countdownAt: t.Optional(t.String()), countdownLabel: t.Optional(t.String()),
      poll: t.Optional(t.Object({ options: t.Array(t.String()), endsAt: t.Optional(t.String()) })),
    }) })

    // Buscar post por su externalRef (p.ej. 'chapter:123'). Util en migraciones.
    .get('/posts/by-ref', async ({ auth, query }: any) => {
      if (!auth) return { error: 'unauthorized' }
      const ref = String(query.ref || '')
      if (!ref) return { error: 'missing_ref' }
      const p = await prisma.post.findUnique({ where: { appId_externalRef: { appId: auth.appId, externalRef: ref } }, select: { id: true, wallPageId: true } })
      if (!p) return { error: 'not_found' }
      return { data: p }
    })

    .get('/posts/:id', async ({ auth, params, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      const p = await prisma.post.findFirst({ where: { id: Number(params.id), appId: auth.appId, deletedAt: null }, include: { author: { select: pageSel }, wall: { select: wallSel }, poll: true } })
      if (!p) return { error: 'not_found' }
      const viewer = await viewerPage(auth, request.headers)
      const [likes, saves] = await Promise.all([likedPosts(auth.appId, viewer, [p.id]), savedPosts(auth.appId, viewer, [p.id])])
      const uno = shapePost(p, likes, saves)
      await attachPolls([uno], [p], viewer)
      return { data: uno }
    })

    .patch('/posts/:id', async ({ auth, params, body, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      const post = await prisma.post.findFirst({ where: { id: Number(params.id), appId: auth.appId, deletedAt: null }, select: { id: true, authorPageId: true, wallPageId: true } })
      if (!post) return { error: 'not_found' }
      // Page en cuyo nombre se edita: el page token, o la secret key con
      // X-Hilos-Page. La secret key sin cabecera es la propia app (moderación).
      let actor: number | null = null
      if (auth.mode !== 'secret') {
        if (!requireScope(auth, 'post:write')) return { error: 'insufficient_scope' }
        let me: number
        try { me = await actingPage(auth, request.headers) } catch (e: any) { return { error: e.message } }
        if (me !== post.authorPageId) return { error: 'forbidden' }
        actor = me
      } else if (request.headers.get('x-hilos-page')) {
        actor = await viewerPage(auth, request.headers)
      }
      // Silenciado (en toda la app o en el scan del muro): no reescribe lo publicado.
      if (actor != null) {
        if (await isMuted(actor)) return { error: 'muted' }
        if (post.wallPageId && post.wallPageId !== actor) {
          const sil = await silencioEnMuro(auth.appId, actor, post.wallPageId)
          if (sil) return { error: 'muted_scope', until: sil.until, scope: sil.scope }
        }
      }
      const data: any = {}
      if (body.content !== undefined) {
        const content = String(body.content).trim().slice(0, MAX_CONTENT)
        if (!content) return { error: 'empty_post' }
        data.content = content
      }
      if (body.wallExternalId) {
        const wall = await prisma.page.findUnique({ where: { appId_externalId: { appId: auth.appId, externalId: String(body.wallExternalId) } }, select: { id: true } })
        if (!wall) return { error: 'wall_not_found' }
        // Mover el post a un muro donde te silenciaron es publicar ahí.
        if (actor != null && wall.id !== actor) {
          const sil = await silencioEnMuro(auth.appId, actor, wall.id)
          if (sil) return { error: 'muted_scope', until: sil.until, scope: sil.scope }
        }
        data.wallPageId = wall.id
      }
      if (!Object.keys(data).length) return { error: 'nothing_to_update' }
      const up = await prisma.post.update({ where: { id: post.id }, data, include: { author: { select: pageSel }, wall: { select: wallSel }, poll: true } })
      return { data: shapePost(up) }
    }, { body: t.Object({ content: t.Optional(t.String()), wallExternalId: t.Optional(t.String()) }) })

    .post('/posts/:id/vote', async ({ auth, params, body, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      if (!requireScope(auth, 'react')) return { error: 'insufficient_scope' }
      let pageId: number
      try { pageId = await actingPage(auth, request.headers) } catch (e: any) { return { error: e.message } }

      const poll = await prisma.postPoll.findUnique({ where: { postId: Number(params.id) } })
      if (!poll || poll.appId !== auth.appId) return { error: 'not_found' }
      if (poll.endsAt && poll.endsAt < new Date()) return { error: 'poll_closed' }

      const opciones = Array.isArray(poll.options) ? poll.options : []
      const idx = Number(body.optionIndex)
      if (!Number.isInteger(idx) || idx < 0 || idx >= opciones.length) return { error: 'bad_option' }

      const previo = await prisma.postPollVote.findUnique({ where: { pollId_pageId: { pollId: poll.id, pageId } } })
      if (previo) {
        if (previo.optionIndex === idx) return { error: 'already_voted' }
        // Cambiar de opinión sí, votar dos veces no.
        await prisma.postPollVote.update({ where: { id: previo.id }, data: { optionIndex: idx } })
      } else {
        await prisma.postPollVote.create({ data: { pollId: poll.id, pageId, optionIndex: idx } })
        await prisma.postPoll.update({ where: { id: poll.id }, data: { votesCount: { increment: 1 } } })
      }

      const conteo = await prisma.postPollVote.groupBy({ by: ['optionIndex'], where: { pollId: poll.id }, _count: { optionIndex: true } })
      const resultados = opciones.map((_: any, i: number) => conteo.find((c) => c.optionIndex === i)?._count.optionIndex ?? 0)
      const total = resultados.reduce((a: number, b: number) => a + b, 0)
      return { data: { results: resultados, votesCount: total, myVote: idx } }
    }, { body: t.Object({ optionIndex: t.Number() }) })

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
    .get('/feed', async ({ auth, query, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      const limit = Math.min(50, Math.max(1, Number(query.limit) || 20)), pg = Math.max(0, Number(query.page) || 0)
      const viewer = await viewerPage(auth, request.headers)
      const scope = String(query.scope || 'foryou')
      const withReplies = query.replies === '1' || query.replies === 'true'

      let items: any[] = []
      let has = false

      if (scope === 'following') {
        // Tu manada: cronologico puro de a quien sigues. Sin ranking, para que
        // no se pierda nada de la gente que elegiste.
        if (!viewer) return { data: { items: [], hasMore: false } }
        const f = await prisma.follow.findMany({ where: { appId: auth.appId, followerPageId: viewer }, select: { followedPageId: true } })
        const ids = [...f.map((x) => x.followedPageId), viewer]
        const rows = await prisma.post.findMany({
          where: { appId: auth.appId, deletedAt: null, hiddenAt: null, ...SIN_AUTOMATICOS, OR: [{ authorPageId: { in: ids } }, { wallPageId: { in: ids } }] },
          orderBy: postOrder(asSort(query.sort)), skip: pg * limit, take: limit + 1,
          include: { author: { select: pageSel }, wall: { select: wallSel }, poll: true },
        })
        has = rows.length > limit
        items = rows.slice(0, limit)
      } else if (scope === 'recent') {
        const rows = await prisma.post.findMany({
          where: { appId: auth.appId, deletedAt: null, hiddenAt: null, ...SIN_AUTOMATICOS },
          orderBy: postOrder(asSort(query.sort)), skip: pg * limit, take: limit + 1,
          include: { author: { select: pageSel }, wall: { select: wallSel }, poll: true },
        })
        has = rows.length > limit
        items = rows.slice(0, limit)
      } else {
        // Inicio: mezcla de reciente y relevante. Puntuacion tipo Hacker News
        // sobre una ventana corta, para que lo que tiene conversacion suba sin
        // que el feed se congele en los mismos posts de siempre.
        const days = Math.min(30, Math.max(1, Number(query.days) || 10))
        const ranked = await prisma.$queryRaw<{ id: number }[]>`
          SELECT id FROM post
          WHERE "appId" = ${auth.appId}
            AND "deletedAt" IS NULL AND "hiddenAt" IS NULL
            AND "automated" = false
          -- Primero lo de la ventana corta, ordenado por relevancia; despues todo
          -- lo anterior por fecha, para que el scroll infinito no se corte cuando
          -- la ventana tiene pocos posts.
          ORDER BY ("createdAt" > NOW() - (${days} || ' days')::interval) DESC,
            CASE WHEN "createdAt" > NOW() - (${days} || ' days')::interval THEN (
              ("likesCount" * 3 + "commentsCount" * 5 + 1)::float
              / POWER(GREATEST(EXTRACT(EPOCH FROM (NOW() - "createdAt")) / 3600.0, 0) + 2.0, 1.4)
            ) END DESC NULLS LAST,
            "createdAt" DESC
          LIMIT ${limit + 1} OFFSET ${pg * limit}`
        const ids = ranked.map((r) => r.id)
        has = ids.length > limit
        const keep = ids.slice(0, limit)
        if (keep.length) {
          const rows = await prisma.post.findMany({ where: { id: { in: keep } }, include: { author: { select: pageSel }, wall: { select: wallSel }, poll: true } })
          const byId = new Map(rows.map((r) => [r.id, r]))
          items = keep.map((id) => byId.get(id)).filter(Boolean) as any[]
        }
        // Si la ventana esta vacia (app recien estrenada), no dejamos el feed en blanco.
        if (!items.length && pg === 0) {
          const rows = await prisma.post.findMany({
            where: { appId: auth.appId, deletedAt: null, hiddenAt: null, ...SIN_AUTOMATICOS },
            orderBy: [{ createdAt: 'desc' }], take: limit + 1, include: { author: { select: pageSel }, wall: { select: wallSel }, poll: true },
          })
          has = rows.length > limit
          items = rows.slice(0, limit)
        }
      }

      const ids = items.map((p) => p.id)
      const [likes, saves] = await Promise.all([likedPosts(auth.appId, viewer, ids), savedPosts(auth.appId, viewer, ids)])
      const shaped = items.map((p) => shapePost(p, likes, saves))

      await attachPolls(shaped, items, viewer)
      if (withReplies) await attachReplies(auth.appId, shaped, ids)

      return { data: { items: shaped, hasMore: has } }
    })

    // ---- Avisos ----
    .get('/notifications', async ({ auth, query, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      let me: number
      try { me = await actingPage(auth, request.headers) } catch (e: any) { return { error: e.message } }
      const limit = Math.min(50, Number(query.limit) || 20)
      const pg = Math.max(0, Number(query.page) || 0)
      const rows = await prisma.notification.findMany({
        where: { appId: auth.appId, pageId: me },
        orderBy: { createdAt: 'desc' }, skip: pg * limit, take: limit + 1,
        include: { actor: { select: pageSel } },
      })
      const hasMore = rows.length > limit
      return {
        data: {
          items: rows.slice(0, limit).map((n) => ({
            id: n.id, type: n.type, postId: n.postId, commentId: n.commentId,
            preview: n.preview, read: !!n.readAt, createdAt: n.createdAt, actor: shapePage(n.actor),
          })),
          hasMore,
        },
      }
    })

    .get('/notifications/unread', async ({ auth, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      let me: number
      try { me = await actingPage(auth, request.headers) } catch { return { data: { total: 0 } } }
      const total = await prisma.notification.count({ where: { appId: auth.appId, pageId: me, readAt: null } })
      return { data: { total } }
    })

    // Marcar como leidas (todas o una).
    .post('/notifications/read', async ({ auth, body, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      let me: number
      try { me = await actingPage(auth, request.headers) } catch (e: any) { return { error: e.message } }
      const where: any = { appId: auth.appId, pageId: me, readAt: null }
      if (body?.id) where.id = Number(body.id)
      const r = await prisma.notification.updateMany({ where, data: { readAt: new Date() } })
      return { data: { updated: r.count } }
    }, { body: t.Optional(t.Object({ id: t.Optional(t.Union([t.String(), t.Number()])) })) })

    // ---- Equipo de una page ----
    // Quién puede publicar en nombre de un scan y quién administra ese equipo.
    .get('/pages/:handle/members', async ({ auth, params, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      const page = await prisma.page.findUnique({ where: { appId_handle: { appId: auth.appId, handle: String(params.handle).toLowerCase() } }, select: { id: true } })
      if (!page) return { error: 'not_found' }

      // La lista del equipo solo la ve el propio equipo (o el backend).
      if (auth.mode !== 'secret') {
        const me = await viewerPage(auth, request.headers)
        if (!me || !(await memberRole(auth.appId, page.id, me))) return { error: 'forbidden' }
      }

      const rows = await prisma.pageMember.findMany({
        where: { appId: auth.appId, pageId: page.id },
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
        include: { member: { select: pageSel } },
      })
      return { data: rows.map((r) => ({ role: r.role, since: r.createdAt, page: shapePage(r.member) })) }
    })

    // Las pages que puedo manejar: alimenta el selector de identidad.
    .get('/me/pages', async ({ auth, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      let me: number
      try { me = await actingPage(auth, request.headers) } catch (e: any) { return { error: e.message } }
      const rows = await prisma.pageMember.findMany({
        where: { appId: auth.appId, memberPageId: me },
        orderBy: { createdAt: 'asc' },
        include: { page: { select: pageSel } },
      })
      return { data: rows.map((r) => ({ role: r.role, page: shapePage(r.page) })) }
    })

    .post('/pages/:handle/members', async ({ auth, params, body, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      const page = await prisma.page.findUnique({ where: { appId_handle: { appId: auth.appId, handle: String(params.handle).toLowerCase() } }, select: { id: true } })
      if (!page) return { error: 'not_found' }

      // Solo un owner reparte papeles. Con secret key manda la app (semillas).
      if (auth.mode !== 'secret') {
        const me = await viewerPage(auth, request.headers)
        if (!me || (await memberRole(auth.appId, page.id, me)) !== 'owner') return { error: 'forbidden' }
      }

      const target = await prisma.page.findUnique({ where: { appId_handle: { appId: auth.appId, handle: String(body.handle).toLowerCase() } }, select: { id: true, type: true } })
      if (!target) return { error: 'page_not_found' }
      if (target.id === page.id) return { error: 'cannot_add_self' }

      const role = body.role === 'owner' ? 'owner' : 'trusted'
      const m = await prisma.pageMember.upsert({
        where: { pageId_memberPageId: { pageId: page.id, memberPageId: target.id } },
        create: { appId: auth.appId, pageId: page.id, memberPageId: target.id, role },
        update: { role },
        include: { member: { select: pageSel } },
      })
      return { data: { role: m.role, page: shapePage(m.member) } }
    }, { body: t.Object({ handle: t.String(), role: t.Optional(t.String()) }) })

    .delete('/pages/:handle/members/:memberHandle', async ({ auth, params, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      const page = await prisma.page.findUnique({ where: { appId_handle: { appId: auth.appId, handle: String(params.handle).toLowerCase() } }, select: { id: true } })
      if (!page) return { error: 'not_found' }

      const target = await prisma.page.findUnique({ where: { appId_handle: { appId: auth.appId, handle: String(params.memberHandle).toLowerCase() } }, select: { id: true } })
      if (!target) return { error: 'page_not_found' }

      let me: number | null = null
      if (auth.mode !== 'secret') {
        me = await viewerPage(auth, request.headers)
        const miRol = me ? await memberRole(auth.appId, page.id, me) : null
        // Un owner echa a quien quiera; cualquiera puede irse por su cuenta.
        if (miRol !== 'owner' && me !== target.id) return { error: 'forbidden' }
      }

      const actual = await prisma.pageMember.findUnique({ where: { pageId_memberPageId: { pageId: page.id, memberPageId: target.id } }, select: { role: true } })
      if (!actual) return { error: 'not_found' }

      // Nunca dejamos una page sin responsable.
      if (actual.role === 'owner') {
        const owners = await prisma.pageMember.count({ where: { pageId: page.id, role: 'owner' } })
        if (owners <= 1) return { error: 'last_owner' }
      }

      await prisma.pageMember.delete({ where: { pageId_memberPageId: { pageId: page.id, memberPageId: target.id } } })
      return { data: { ok: true } }
    })

    // ---- Mensajeria directa ----
    // Reglas: puedes ESCRIBIR a alguien solo si tu lo sigues. Y solo puedes
    // LEER lo que te escriben si tu tambien sigues a esa persona. Asi un
    // desconocido puede dejarte un mensaje, pero no te invade: no lo ves hasta
    // que decides seguirlo.
    .get('/conversations', async ({ auth, query, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      let me: number
      try { me = await actingPage(auth, request.headers) } catch (e: any) { return { error: e.message } }
      const limit = Math.min(50, Number(query.limit) || 20)
      const pg = Math.max(0, Number(query.page) || 0)

      const archivadas = query.archived === '1' || query.archived === 'true'
      const rows = await prisma.conversationMember.findMany({
        where: { pageId: me, ...(archivadas ? { archivedAt: { not: null } } : { archivedAt: null }) },
        orderBy: { conversation: { lastMessageAt: 'desc' } },
        skip: pg * limit, take: limit + 1,
        include: { conversation: { include: { members: { include: { page: { select: pageSel } } } } } },
      })
      const hasMore = rows.length > limit
      const items = rows.slice(0, limit)

      const otherIds = items.map((r) => r.conversation.members.find((m) => m.pageId !== me)?.pageId).filter(Boolean) as number[]
      // A quien sigo: define que conversaciones puedo leer.
      const following = new Set(
        (await prisma.follow.findMany({ where: { appId: auth.appId, followerPageId: me, followedPageId: { in: otherIds } }, select: { followedPageId: true } }))
          .map((f) => f.followedPageId),
      )
      // Si ya escribiste en la conversación, la aceptaste: se lee sin seguir.
      const engaged = await engagedConversations(me, items.map((r) => r.conversationId))

      const out = []
      for (const r of items) {
        const other = r.conversation.members.find((m) => m.pageId !== me)
        if (!other) continue
        const canRead = following.has(other.pageId) || engaged.has(r.conversationId)
        const last = canRead
          ? await prisma.message.findFirst({ where: { conversationId: r.conversationId, deletedAt: null }, orderBy: { createdAt: 'desc' }, select: { content: true, createdAt: true, senderPageId: true } })
          : null
        const unread = canRead
          ? await prisma.message.count({ where: { conversationId: r.conversationId, deletedAt: null, senderPageId: { not: me }, ...(r.lastReadAt ? { createdAt: { gt: r.lastReadAt } } : {}) } })
          : 0
        out.push({
          id: r.conversationId,
          page: shapePage(other.page),
          archived: !!r.archivedAt,
          canRead,
          lastMessage: last ? { content: last.content.slice(0, 140), createdAt: last.createdAt, mine: last.senderPageId === me } : null,
          lastMessageAt: r.conversation.lastMessageAt,
          unread,
        })
      }
      return { data: { items: out, hasMore } }
    })

    // Archivar o recuperar una conversación (por persona, no para todos).
    .post('/conversations/:id/archive', async ({ auth, params, body, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      let me: number
      try { me = await actingPage(auth, request.headers) } catch (e: any) { return { error: e.message } }
      const conversationId = Number(params.id)
      const member = await prisma.conversationMember.findUnique({ where: { conversationId_pageId: { conversationId, pageId: me } }, select: { id: true } })
      if (!member) return { error: 'not_found' }
      const archivar = body?.archived === false ? false : true
      await prisma.conversationMember.update({ where: { id: member.id }, data: { archivedAt: archivar ? new Date() : null } })
      return { data: { id: conversationId, archived: archivar } }
    }, { body: t.Optional(t.Object({ archived: t.Optional(t.Boolean()) })) })

    // Subpages de una page: las obras de un scan.
    .get('/pages/:handle/subpages', async ({ auth, params, query }: any) => {
      if (!auth) return { error: 'unauthorized' }
      const parent = await prisma.page.findUnique({ where: { appId_handle: { appId: auth.appId, handle: String(params.handle).toLowerCase() } }, select: { id: true } })
      if (!parent) return { error: 'not_found' }
      const limit = Math.min(60, Math.max(1, Number(query.limit) || 30))
      const pg = Math.max(0, Number(query.page) || 0)
      const where: any = { appId: auth.appId, parentPageId: parent.id }
      if (query.q) where.OR = [
        { handle: { contains: String(query.q), mode: 'insensitive' } },
        { displayName: { contains: String(query.q), mode: 'insensitive' } },
      ]
      const rows = await prisma.page.findMany({
        where, orderBy: [{ postsCount: 'desc' }, { id: 'asc' }],
        skip: pg * limit, take: limit + 1, select: pageSel,
      })
      const hasMore = rows.length > limit
      const visibles = rows.slice(0, limit)
      const total = await prisma.page.count({ where: { appId: auth.appId, parentPageId: parent.id } })

      // Cuántas publicaciones hay en el muro de cada obra.
      const ids = visibles.map((p) => p.id)
      const enMuro = ids.length
        ? await prisma.post.groupBy({
            by: ['wallPageId'],
            where: { appId: auth.appId, deletedAt: null, hiddenAt: null, wallPageId: { in: ids } },
            _count: { wallPageId: true },
          })
        : []
      const porMuro = new Map(enMuro.map((r) => [r.wallPageId, r._count.wallPageId]))

      return {
        data: {
          items: visibles.map((p) => ({ ...shapePage(p), postsCount: porMuro.get(p.id) ?? p.postsCount })),
          hasMore,
          total,
        },
      }
    })

    // Mensajes de una conversacion (mas recientes primero para paginar hacia atras).
    .get('/conversations/:id/messages', async ({ auth, params, query, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      let me: number
      try { me = await actingPage(auth, request.headers) } catch (e: any) { return { error: e.message } }
      const conversationId = Number(params.id)
      const member = await prisma.conversationMember.findUnique({ where: { conversationId_pageId: { conversationId, pageId: me } }, select: { id: true, lastReadAt: true } })
      if (!member) return { error: 'not_found' }
      const other = await prisma.conversationMember.findFirst({ where: { conversationId, pageId: { not: me } }, include: { page: { select: pageSel } } })
      if (!other) return { error: 'not_found' }

      const follows = await prisma.follow.findFirst({ where: { appId: auth.appId, followerPageId: me, followedPageId: other.pageId }, select: { id: true } })
      const engaged = !follows && (await engagedConversations(me, [conversationId])).has(conversationId)
      if (!follows && !engaged) return { data: { items: [], hasMore: false, canRead: false, canWrite: false, page: shapePage(other.page) } }

      const limit = Math.min(100, Number(query.limit) || 40)
      const pg = Math.max(0, Number(query.page) || 0)
      const rows = await prisma.message.findMany({
        where: { conversationId, deletedAt: null },
        orderBy: { createdAt: 'desc' }, skip: pg * limit, take: limit + 1,
        select: { id: true, content: true, media: true, createdAt: true, senderPageId: true },
      })
      const hasMore = rows.length > limit
      // meta interno (quién del equipo respondió, referencias de importación)
      // no sale por aquí: solo el tema que abre el mensaje, si lo hay.
      const items = rows.slice(0, limit).reverse().map((m) => ({ id: m.id, content: m.content, media: messageMedia(m.media), topic: messageMeta(m.media)?.topic ?? null, createdAt: m.createdAt, mine: m.senderPageId === me }))

      if (pg === 0) await prisma.conversationMember.update({ where: { id: member.id }, data: { lastReadAt: new Date() } }).catch(() => {})
      return { data: { items, hasMore, canRead: true, canWrite: true, page: shapePage(other.page) } }
    })

    // Enviar mensaje a una page (por handle; con secret key también por `to`
    // = external:<id> | <id> | handle). Crea la conversacion si hace falta.
    // Solo con secret key (la app consumidora decide sus propias reglas):
    //   - no exige seguir a la otra page;
    //   - meta: datos del mensaje (meta.topic = { tag, title, ref } abre un tema);
    //   - externalRef: idempotencia (importaciones); si ya existe, lo devuelve;
    //   - createdAt: fecha original (importaciones);
    //   - notify: false para no avisar; reopen: true desarchiva para todos.
    .post('/messages', async ({ auth, body, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      if (!requireScope(auth, 'comment:write')) return { error: 'insufficient_scope' }
      let me: number
      try { me = await actingPage(auth, request.headers) } catch (e: any) { return { error: e.message } }
      if (auth.mode === 'page' && !rateLimit(`dm:${me}`, 60, 60_000)) return { error: 'rate_limited' }
      const secret = auth.mode === 'secret'

      let target: { id: number; type: string } | null = null
      if (secret && body.to) {
        const ref = String(body.to).trim()
        if (ref.startsWith('external:')) target = await prisma.page.findUnique({ where: { appId_externalId: { appId: auth.appId, externalId: ref.slice(9) } }, select: { id: true, type: true } })
        else if (/^\d+$/.test(ref)) target = await prisma.page.findFirst({ where: { id: Number(ref), appId: auth.appId }, select: { id: true, type: true } })
        else target = await prisma.page.findUnique({ where: { appId_handle: { appId: auth.appId, handle: ref.toLowerCase() } }, select: { id: true, type: true } })
      } else if (body.handle) {
        target = await prisma.page.findUnique({ where: { appId_handle: { appId: auth.appId, handle: String(body.handle).toLowerCase() } }, select: { id: true, type: true } })
      }
      if (!target) return { error: 'page_not_found' }
      if (target.id === me) return { error: 'cannot_message_self' }

      const [a, b] = me < target.id ? [me, target.id] : [target.id, me]
      let conv = await prisma.conversation.findUnique({ where: { appId_pageAId_pageBId: { appId: auth.appId, pageAId: a, pageBId: b } }, select: { id: true, lastMessageAt: true } })

      // Solo puedes escribir a quien sigues (o donde ya escribiste antes).
      if (!secret) {
        const follows = await prisma.follow.findFirst({ where: { appId: auth.appId, followerPageId: me, followedPageId: target.id }, select: { id: true } })
        const engaged = !follows && conv ? (await engagedConversations(me, [conv.id])).has(conv.id) : false
        if (!follows && !engaged) return { error: 'must_follow_first' }
      }

      const content = String(body.content || '').trim().slice(0, secret ? MAX_CONTENT : 4000)
      if (!content) return { error: 'empty_message' }

      let meta: any = null
      if (secret && body.meta && typeof body.meta === 'object' && !Array.isArray(body.meta)) {
        if (JSON.stringify(body.meta).length > 4000) return { error: 'meta_too_large' }
        meta = { ...body.meta }
      }
      const externalRef = secret && body.externalRef ? String(body.externalRef).slice(0, 256) : null
      if (externalRef) meta = { ...(meta || {}), ref: externalRef }
      let createdAt: Date | undefined
      if (secret && body.createdAt) {
        const d = new Date(body.createdAt)
        if (Number.isNaN(d.getTime())) return { error: 'bad_created_at' }
        createdAt = d
      }

      // Idempotencia: la misma referencia en la misma conversación no se duplica.
      if (externalRef && conv) {
        const dup = await prisma.message.findFirst({
          where: { conversationId: conv.id, media: { path: ['meta', 'ref'], equals: externalRef } },
          select: { id: true, content: true, media: true, createdAt: true },
        })
        if (dup) return { data: { id: dup.id, content: dup.content, media: messageMedia(dup.media), meta: messageMeta(dup.media), createdAt: dup.createdAt, mine: true, conversationId: conv.id, duplicate: true } }
      }

      if (!conv) {
        conv = await prisma.conversation.create({
          data: {
            appId: auth.appId, pageAId: a, pageBId: b, members: { create: [{ pageId: a }, { pageId: b }] },
            ...(createdAt ? { createdAt, lastMessageAt: createdAt } : {}),
          },
          select: { id: true, lastMessageAt: true },
        }).catch(async () => prisma.conversation.findUnique({ where: { appId_pageAId_pageBId: { appId: auth.appId, pageAId: a, pageBId: b } }, select: { id: true, lastMessageAt: true } }))
        if (!conv) return { error: 'conversation_failed' }
      }
      const media = meta ? { meta, ...(body.media != null ? { items: body.media } : {}) } : (body.media ?? undefined)
      const msg = await prisma.message.create({
        data: { appId: auth.appId, conversationId: conv.id, senderPageId: me, content, media, ...(createdAt ? { createdAt } : {}) },
        select: { id: true, content: true, media: true, createdAt: true },
      })
      // La última actividad nunca retrocede (una importación puede traer fechas viejas).
      if (!conv.lastMessageAt || msg.createdAt > conv.lastMessageAt || !createdAt) {
        await prisma.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: msg.createdAt } }).catch(() => {})
      }
      // Quien escribe ya leyó todo lo anterior.
      await prisma.conversationMember.updateMany({
        where: { conversationId: conv.id, pageId: me, OR: [{ lastReadAt: null }, { lastReadAt: { lt: msg.createdAt } }] },
        data: { lastReadAt: msg.createdAt },
      }).catch(() => {})
      if (secret && body.reopen === true) {
        await prisma.conversationMember.updateMany({ where: { conversationId: conv.id, archivedAt: { not: null } }, data: { archivedAt: null } }).catch(() => {})
      }
      if (!(secret && body.notify === false)) notify(auth.appId, target.id, me, 'message', { preview: content })
      return { data: { id: msg.id, content: msg.content, media: messageMedia(msg.media), ...(secret ? { meta: messageMeta(msg.media) } : { topic: messageMeta(msg.media)?.topic ?? null }), createdAt: msg.createdAt, mine: true, conversationId: conv.id } }
    }, {
      body: t.Object({
        handle: t.Optional(t.String()), to: t.Optional(t.String()), content: t.String(), media: t.Optional(t.Any()),
        meta: t.Optional(t.Any()), externalRef: t.Optional(t.String()), createdAt: t.Optional(t.String()),
        notify: t.Optional(t.Boolean()), reopen: t.Optional(t.Boolean()),
      }),
    })

    // Sondeo ligero para el widget flotante: cuantos mensajes sin leer hay y
    // cual fue el ultimo movimiento (para no recargar listas sin necesidad).
    .get('/messages/unread', async ({ auth, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      let me: number
      try { me = await actingPage(auth, request.headers) } catch { return { data: { total: 0, lastMessageAt: null } } }
      const members = await prisma.conversationMember.findMany({
        where: { pageId: me, archivedAt: null },
        select: { conversationId: true, lastReadAt: true, conversation: { select: { lastMessageAt: true, pageAId: true, pageBId: true } } },
      })
      if (!members.length) return { data: { total: 0, lastMessageAt: null } }
      const others = members.map((m) => (m.conversation.pageAId === me ? m.conversation.pageBId : m.conversation.pageAId))
      const following = new Set(
        (await prisma.follow.findMany({ where: { appId: auth.appId, followerPageId: me, followedPageId: { in: others } }, select: { followedPageId: true } }))
          .map((f) => f.followedPageId),
      )
      const engaged = await engagedConversations(me, members.map((m) => m.conversationId))
      let total = 0
      let lastMessageAt: Date | null = null
      for (const m of members) {
        const other = m.conversation.pageAId === me ? m.conversation.pageBId : m.conversation.pageAId
        if (!following.has(other) && !engaged.has(m.conversationId)) continue
        if (!lastMessageAt || m.conversation.lastMessageAt > lastMessageAt) lastMessageAt = m.conversation.lastMessageAt
        total += await prisma.message.count({ where: { conversationId: m.conversationId, deletedAt: null, senderPageId: { not: me }, ...(m.lastReadAt ? { createdAt: { gt: m.lastReadAt } } : {}) } })
      }
      return { data: { total, lastMessageAt } }
    })

    // ---- Bandeja (solo secret key) ----
    // Para apps que atienden conversaciones en nombre de una page (el staff de
    // un scan, soporte). La app consumidora aplica sus propios permisos; por
    // eso aquí no rige la regla de seguir, y todo exige la secret key.
    .get('/inbox', async ({ auth, query, request }: any) => {
      if (!auth || auth.mode !== 'secret') return { error: 'secret_key_required' }
      let me: number
      try { me = await actingPage(auth, request.headers) } catch (e: any) { return { error: e.message } }
      let withPageId: number | null = null
      if (query.with) {
        try { withPageId = await actingPage(auth, new Headers({ 'x-hilos-page': String(query.with) })) } catch { return { data: { items: [], total: 0, page: 0, limit: 0, counts: { open: 0, archived: 0, all: 0, unread: 0 } } } }
      }
      const r = await listInbox(auth.appId, me, {
        status: ['open', 'archived', 'all'].includes(query.status) ? query.status : 'all',
        unread: query.unread === '1' || query.unread === 'true',
        tag: query.tag ? String(query.tag).slice(0, 64) : null,
        q: query.q ? String(query.q) : null,
        sort: ['recent', 'oldest', 'unread'].includes(query.sort) ? query.sort : 'recent',
        type: query.type ? String(query.type).slice(0, 24) : null,
        withPageId,
        page: Number(query.page) || 0,
        limit: Number(query.limit) || 20,
      })
      const items = await buildSummaries(me, r.rows, pageSel, shapePage)
      return { data: { items, total: r.total, page: r.page, limit: r.limit, counts: r.counts } }
    })

    .get('/inbox/counts', async ({ auth, query, request }: any) => {
      if (!auth || auth.mode !== 'secret') return { error: 'secret_key_required' }
      let me: number
      try { me = await actingPage(auth, request.headers) } catch (e: any) { return { error: e.message } }
      return { data: await inboxCounts(auth.appId, me, query.type ? String(query.type).slice(0, 24) : null) }
    })

    // Resumen de una conversación de la page (sin marcar nada como leído).
    .get('/inbox/:id', async ({ auth, params, request }: any) => {
      if (!auth || auth.mode !== 'secret') return { error: 'secret_key_required' }
      let me: number
      try { me = await actingPage(auth, request.headers) } catch (e: any) { return { error: e.message } }
      const r = await listInbox(auth.appId, me, { conversationId: Number(params.id) || -1, limit: 1 })
      if (!r.rows.length) return { error: 'not_found' }
      const [item] = await buildSummaries(me, r.rows, pageSel, shapePage)
      return { data: item }
    })

    // Mensajes (más recientes primero para paginar hacia atrás; cada página
    // sale en orden cronológico). markRead=0 para mirar sin marcar leído.
    .get('/inbox/:id/messages', async ({ auth, params, query, request }: any) => {
      if (!auth || auth.mode !== 'secret') return { error: 'secret_key_required' }
      let me: number
      try { me = await actingPage(auth, request.headers) } catch (e: any) { return { error: e.message } }
      const conversationId = Number(params.id)
      const member = await prisma.conversationMember.findUnique({ where: { conversationId_pageId: { conversationId, pageId: me } }, select: { id: true } })
      if (!member) return { error: 'not_found' }
      const limit = Math.min(200, Math.max(1, Number(query.limit) || 50))
      const pg = Math.max(0, Number(query.page) || 0)
      const rows = await prisma.message.findMany({
        where: { conversationId, deletedAt: null },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: pg * limit, take: limit + 1,
        select: { id: true, content: true, media: true, createdAt: true, senderPageId: true },
      })
      const hasMore = rows.length > limit
      const items = rows.slice(0, limit).reverse().map((m) => ({
        id: m.id, content: m.content, media: messageMedia(m.media), meta: messageMeta(m.media),
        createdAt: m.createdAt, mine: m.senderPageId === me, senderPageId: m.senderPageId,
      }))
      if (pg === 0 && query.markRead !== '0' && query.markRead !== 'false') {
        await prisma.conversationMember.update({ where: { id: member.id }, data: { lastReadAt: new Date() } }).catch(() => {})
      }
      const r = await listInbox(auth.appId, me, { conversationId, limit: 1 })
      const [conversation] = await buildSummaries(me, r.rows, pageSel, shapePage)
      return { data: { conversation: conversation ?? null, items, hasMore } }
    })

    // Marca leída la conversación para la page (hasta `at`, o ahora). Sirve
    // también para importar el estado de lectura de otro sistema.
    .post('/inbox/:id/read', async ({ auth, params, body, request }: any) => {
      if (!auth || auth.mode !== 'secret') return { error: 'secret_key_required' }
      let me: number
      try { me = await actingPage(auth, request.headers) } catch (e: any) { return { error: e.message } }
      const conversationId = Number(params.id)
      const member = await prisma.conversationMember.findUnique({ where: { conversationId_pageId: { conversationId, pageId: me } }, select: { id: true } })
      if (!member) return { error: 'not_found' }
      let at = new Date()
      if (body?.at) { at = new Date(body.at); if (Number.isNaN(at.getTime())) return { error: 'bad_at' } }
      await prisma.conversationMember.update({ where: { id: member.id }, data: { lastReadAt: at } })
      return { data: { id: conversationId, lastReadAt: at } }
    }, { body: t.Optional(t.Object({ at: t.Optional(t.String()) })) })

    // ---- Comments ----
    .get('/posts/:id/comments', async ({ auth, params, query, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      const postId = Number(params.id)
      const where = { appId: auth.appId, postId, deletedAt: null, hiddenAt: null }
      // Paginado: un capitulo popular pasa de 300 comentarios y antes se cortaban.
      const paged = query.page !== undefined || query.limit !== undefined
      const limit = Math.min(200, Math.max(1, Number(query.limit) || 100))
      const pg = Math.max(0, Number(query.page) || 0)
      // Por defecto, lo último primero. Las respuestas de cada hilo se ordenan
      // luego en el cliente de forma cronológica, que es como se leen.
      const sort = asSort(query.sort)
      const rows = await prisma.comment.findMany({
        where,
        orderBy: commentOrder(sort),
        skip: paged ? pg * limit : 0,
        take: paged ? limit + 1 : 200,
        include: { author: { select: pageSel } },
      })
      const hasMore = paged && rows.length > limit
      const shown = paged ? rows.slice(0, limit) : rows
      // Que el espectador vea sus propios me gusta al cargar.
      const viewer = await viewerPage(auth, request.headers)
      let likedSet = new Set<number>()
      if (viewer && shown.length) {
        const r = await prisma.reaction.findMany({
          where: { appId: auth.appId, pageId: viewer, type: 'like', targetType: 'comment', targetId: { in: shown.map((c) => c.id) } },
          select: { targetId: true },
        })
        likedSet = new Set(r.map((x) => x.targetId))
      }
      const items = shown.map((c) => ({
        id: c.id, content: c.content, parentCommentId: c.parentCommentId,
        likesCount: c.likesCount, liked: viewer ? likedSet.has(c.id) : undefined,
        createdAt: c.createdAt, author: shapePage(c.author),
      }))
      // Sin parametros mantenemos la forma antigua (array) por compatibilidad.
      if (!paged) return { data: items }
      const total = await prisma.comment.count({ where })
      return { data: { items, hasMore, total } }
    })
    .post('/posts/:id/comments', async ({ auth, params, body, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      if (!requireScope(auth, 'comment:write')) return { error: 'insufficient_scope' }
      let authorPageId: number
      try { authorPageId = await actingPage(auth, request.headers) } catch (e: any) { return { error: e.message } }
      if (auth.mode === 'page' && !rateLimit(`comment:${authorPageId}`, 30, 5 * 60_000)) return { error: 'rate_limited' }
      // Silencios de la page que actúa, también con secret key + X-Hilos-Page.
      if (await isMuted(authorPageId)) return { error: 'muted' }
      const post = await prisma.post.findFirst({ where: { id: Number(params.id), appId: auth.appId, deletedAt: null }, select: { id: true, wallPageId: true } })
      if (!post) return { error: 'post_not_found' }
      // Silenciado por el scan dueño de ese muro (solo ahí, no en toda la app).
      if (post.wallPageId) {
        const sil = await silencioEnMuro(auth.appId, authorPageId, post.wallPageId)
        if (sil) return { error: 'muted_scope', until: sil.until, scope: sil.scope }
      }
      const content = String(body.content || '').trim().slice(0, MAX_CONTENT)
      if (!content) return { error: 'empty_comment' }
      // externalRef y createdAt solo los fija la app (migraciones); con page
      // token se ignoran. La fecha nunca va al futuro.
      const secreta = auth.mode === 'secret'
      const externalRef = secreta && body.externalRef ? String(body.externalRef) : null
      let createdAt: Date | undefined
      if (secreta && body.createdAt) {
        const d = fechaNoFutura(body.createdAt)
        if (!d) return { error: 'bad_created_at' }
        createdAt = d
      }
      // Dedupe por externalRef (migraciones idempotentes), solo del mismo autor.
      if (externalRef) {
        const dup = await prisma.comment.findUnique({ where: { appId_externalRef: { appId: auth.appId, externalRef } }, include: { author: { select: pageSel } } }).catch(() => null)
        if (dup && dup.authorPageId !== authorPageId) return { error: 'external_ref_taken', commentId: dup.id }
        if (dup) return { data: { id: dup.id, content: dup.content, parentCommentId: dup.parentCommentId, likesCount: dup.likesCount, createdAt: dup.createdAt, author: shapePage(dup.author) }, deduped: true }
      }
      // El padre puede venir por id propio o por su externalRef original, pero
      // siempre de esta misma conversación: nada de avisar a quien no está en ella.
      let parentCommentId: number | null = null
      if (body.parentCommentId) {
        const pid = Number(body.parentCommentId)
        const p = Number.isSafeInteger(pid) && pid > 0
          ? await prisma.comment.findFirst({ where: { id: pid, postId: post.id, appId: auth.appId, deletedAt: null }, select: { id: true } })
          : null
        if (!p) return { error: 'parent_not_found' }
        parentCommentId = p.id
      } else if (body.parentExternalRef) {
        // Importaciones: si el padre no está en este post queda como comentario
        // raíz, igual que antes cuando no existía.
        const p = await prisma.comment.findFirst({ where: { appId: auth.appId, externalRef: String(body.parentExternalRef), postId: post.id, deletedAt: null }, select: { id: true } }).catch(() => null)
        parentCommentId = p?.id ?? null
      }
      const c = await prisma.comment.create({ data: { appId: auth.appId, postId: post.id, authorPageId, parentCommentId, externalRef, content, createdAt }, include: { author: { select: pageSel } } })
      await prisma.post.update({ where: { id: post.id }, data: { commentsCount: { increment: 1 } } })

      // Avisos: al autor del post y, si es una respuesta, a quien respondes.
      const target = await prisma.post.findUnique({ where: { id: post.id }, select: { authorPageId: true } }).catch(() => null)
      if (target) notify(auth.appId, target.authorPageId, authorPageId, 'comment', { postId: post.id, commentId: c.id, preview: content })
      if (parentCommentId) {
        const parent = await prisma.comment.findUnique({ where: { id: parentCommentId }, select: { authorPageId: true } }).catch(() => null)
        if (parent) notify(auth.appId, parent.authorPageId, authorPageId, 'reply', { postId: post.id, commentId: c.id, preview: content })
      }
      notifyMentions(auth.appId, content, authorPageId, { postId: post.id, commentId: c.id })

      // Contexto para que la app pueda avisar por correo a quien corresponda.
      const full = await prisma.post.findUnique({
        where: { id: post.id },
        select: {
          id: true, content: true, externalRef: true, authorPageId: true,
          author: { select: { handle: true, externalId: true, displayName: true, type: true } },
          wall: { select: { handle: true, externalId: true, displayName: true, type: true } },
        },
      }).catch(() => null)
      // Participantes del hilo: quien ya ha hablado ahí merece enterarse.
      const rootId = parentCommentId
        ? ((await prisma.comment.findUnique({ where: { id: parentCommentId }, select: { parentCommentId: true, id: true } }).catch(() => null))?.parentCommentId ?? parentCommentId)
        : c.id
      const thread = await prisma.comment.findMany({
        where: { appId: auth.appId, postId: post.id, deletedAt: null, OR: [{ id: rootId }, { parentCommentId: rootId }] },
        select: { authorPageId: true, author: { select: { handle: true, externalId: true } } },
      }).catch(() => [])
      const parentAuthor = parentCommentId
        ? await prisma.comment.findUnique({ where: { id: parentCommentId }, select: { author: { select: { handle: true, externalId: true, displayName: true } } } }).catch(() => null)
        : null

      emitEvent(auth.appId, 'comment.created', {
        comment: { id: c.id, content: c.content, createdAt: c.createdAt, parentCommentId: c.parentCommentId },
        author: { handle: c.author.handle, externalId: c.author.externalId, displayName: c.author.displayName, avatarUrl: c.author.avatarUrl },
        post: full ? { id: full.id, content: full.content, externalRef: full.externalRef, author: full.author, wall: full.wall } : { id: post.id },
        replyTo: parentAuthor?.author ?? null,
        threadParticipants: [...new Map(thread.filter((t) => t.authorPageId !== authorPageId).map((t) => [t.author.externalId, t.author])).values()],
      })

      return { data: { id: c.id, content: c.content, parentCommentId: c.parentCommentId, likesCount: 0, createdAt: c.createdAt, author: shapePage(c.author) } }
    }, { body: t.Object({ content: t.String(), parentCommentId: t.Optional(t.Union([t.String(), t.Number()])), parentExternalRef: t.Optional(t.String()), externalRef: t.Optional(t.String()), createdAt: t.Optional(t.String()) }) })
    .delete('/comments/:id', async ({ auth, params, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      const c = await prisma.comment.findFirst({ where: { id: Number(params.id), appId: auth.appId, deletedAt: null }, select: { id: true, postId: true, authorPageId: true, createdAt: true } })
      if (!c) return { error: 'not_found' }

      // El backend de la app (secret key) modera sin límite de tiempo.
      if (auth.mode !== 'secret') {
        const yo = await viewerPage(auth, request.headers)
        if (!yo || yo !== c.authorPageId) return { error: 'forbidden' }
        // El autor puede retirar lo suyo durante 24 horas. Pasado ese plazo,
        // la conversación ya es de todos: se pide a un moderador.
        const horas = (Date.now() - new Date(c.createdAt).getTime()) / 3_600_000
        if (horas > 24) return { error: 'too_old' }
      }

      // Borrado lógico: el contenido se conserva para poder moderarlo después.
      await prisma.comment.update({ where: { id: c.id }, data: { deletedAt: new Date() } })
      await prisma.post.update({ where: { id: c.postId }, data: { commentsCount: { decrement: 1 } } }).catch(() => {})
      return { data: { ok: true } }
    })

    // Me gusta en comentarios (paridad con el lector de CapibaraTraductor).
    .post('/comments/:id/like', async ({ auth, params, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      if (!requireScope(auth, 'react')) return { error: 'insufficient_scope' }
      let pageId: number
      try { pageId = await actingPage(auth, request.headers) } catch (e: any) { return { error: e.message } }
      if (auth.mode === 'page' && !rateLimit(`clike:${pageId}`, 120, 60_000)) return { error: 'rate_limited' }
      const id = Number(params.id)
      const c = await prisma.comment.findFirst({ where: { id, appId: auth.appId, deletedAt: null }, select: { id: true } })
      if (!c) return { error: 'not_found' }
      const key = { appId_targetType_targetId_pageId_type: { appId: auth.appId, targetType: 'comment', targetId: id, pageId, type: 'like' } }
      const existing = await prisma.reaction.findUnique({ where: key })
      if (existing) {
        await prisma.reaction.delete({ where: { id: existing.id } })
        const u = await prisma.comment.update({ where: { id }, data: { likesCount: { decrement: 1 } }, select: { likesCount: true } })
        return { data: { liked: false, likesCount: Math.max(0, u.likesCount) } }
      }
      await prisma.reaction.create({ data: { appId: auth.appId, targetType: 'comment', targetId: id, pageId, type: 'like' } })
      const u = await prisma.comment.update({ where: { id }, data: { likesCount: { increment: 1 } }, select: { likesCount: true } })
      return { data: { liked: true, likesCount: u.likesCount } }
    })

    // Moderacion: ocultar o restaurar un comentario. Solo con secret key, es
    // decir desde el backend de la app, que es quien valida los permisos del
    // staff. Es reversible: nunca borramos el contenido.
    .post('/comments/:id/hide', async ({ auth, params, body }: any) => {
      if (!auth || auth.mode !== 'secret') return { error: 'secret_key_required' }
      const id = Number(params.id)
      const c = await prisma.comment.findFirst({ where: { id, appId: auth.appId }, select: { id: true, hiddenAt: true } })
      if (!c) return { error: 'not_found' }
      const hidden = body?.hidden === false ? false : true
      await prisma.comment.update({ where: { id }, data: { hiddenAt: hidden ? new Date() : null } })
      return { data: { id, hidden } }
    }, { body: t.Optional(t.Object({ hidden: t.Optional(t.Boolean()) })) })

    // Editar el propio comentario (o cualquiera desde el backend de la app).
    // Localizar un comentario por la referencia de la app (para migraciones).
    .get('/comments/by-ref', async ({ auth, query }: any) => {
      if (!auth || auth.mode !== 'secret') return { error: 'secret_key_required' }
      const ref = String(query.ref || '')
      if (!ref) return { error: 'bad_ref' }
      const c = await prisma.comment.findUnique({
        where: { appId_externalRef: { appId: auth.appId, externalRef: ref } },
        select: { id: true, content: true, postId: true, deletedAt: true },
      }).catch(() => null)
      if (!c || c.deletedAt) return { error: 'not_found' }
      return { data: { id: c.id, content: c.content, postId: c.postId } }
    })

    .patch('/comments/:id', async ({ auth, params, body, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      const c = await prisma.comment.findFirst({ where: { id: Number(params.id), appId: auth.appId, deletedAt: null }, select: { id: true, authorPageId: true, post: { select: { wallPageId: true } } } })
      if (!c) return { error: 'not_found' }
      // Igual que al editar un post: quien actúa (page token o secret key con
      // X-Hilos-Page) no reescribe comentarios si está silenciado ahí.
      let actor: number | null = null
      if (auth.mode !== 'secret') {
        if (!requireScope(auth, 'comment:write')) return { error: 'insufficient_scope' }
        let me: number
        try { me = await actingPage(auth, request.headers) } catch (e: any) { return { error: e.message } }
        if (me !== c.authorPageId) return { error: 'forbidden' }
        actor = me
      } else if (request.headers.get('x-hilos-page')) {
        actor = await viewerPage(auth, request.headers)
      }
      if (actor != null) {
        if (await isMuted(actor)) return { error: 'muted' }
        if (c.post?.wallPageId) {
          const sil = await silencioEnMuro(auth.appId, actor, c.post.wallPageId)
          if (sil) return { error: 'muted_scope', until: sil.until, scope: sil.scope }
        }
      }
      const content = String(body.content || '').trim().slice(0, MAX_CONTENT)
      if (!content) return { error: 'empty_comment' }
      const up = await prisma.comment.update({ where: { id: c.id }, data: { content }, include: { author: { select: pageSel } } })
      return { data: { id: up.id, content: up.content, parentCommentId: up.parentCommentId, likesCount: up.likesCount, createdAt: up.createdAt, author: shapePage(up.author) } }
    }, { body: t.Object({ content: t.String() }) })

    // Silenciar una page: deja de poder comentar y publicar. Reversible y solo
    // desde el backend de la app, que es quien conoce los roles del staff.
    .post('/pages/:handle/mute', async ({ auth, params, body }: any) => {
      if (!auth || auth.mode !== 'secret') return { error: 'secret_key_required' }
      const page = await prisma.page.findUnique({ where: { appId_handle: { appId: auth.appId, handle: String(params.handle).toLowerCase() } }, select: { id: true, metadata: true } })
      if (!page) return { error: 'not_found' }
      const muted = body?.muted === false ? false : true
      const until = muted && body?.until ? new Date(body.until) : null
      const meta: any = { ...(page.metadata as any ?? {}) }
      if (muted) meta.mutedUntil = until ? until.toISOString() : 'forever'
      else delete meta.mutedUntil
      await prisma.page.update({ where: { id: page.id }, data: { metadata: meta } })
      return { data: { handle: String(params.handle).toLowerCase(), muted, until: meta.mutedUntil ?? null } }
    }, { body: t.Optional(t.Object({ muted: t.Optional(t.Boolean()), until: t.Optional(t.String()) })) })

    // ---- Moderación por alcance (solo secret key: la app valida al staff) ----

    // ¿Este comentario o post es del alcance? Devuelve el detalle para que la
    // app decida y avise al autor. Sin alcance válido responde not_found.
    .get('/moderation/check', async ({ auth, query }: any) => {
      if (!auth || auth.mode !== 'secret') return { error: 'secret_key_required' }
      const a = await resolverAlcance(auth.appId, query.scope)
      if (!a) return { error: 'scope_not_found' }
      if (query.comment) {
        const c = await prisma.comment.findFirst({
          where: { id: Number(query.comment), appId: auth.appId },
          select: { id: true, content: true, hiddenAt: true, deletedAt: true, createdAt: true, parentCommentId: true, author: { select: pageSel }, post: { select: { id: true, content: true, externalRef: true, wallPageId: true, authorPageId: true, wall: { select: wallSel } } } },
        })
        if (!c || !enAlcance(a, c.post)) return { error: 'not_found' }
        return { data: { type: 'comment', id: c.id, content: c.content, hidden: !!c.hiddenAt, deleted: !!c.deletedAt, createdAt: c.createdAt, parentCommentId: c.parentCommentId, author: shapePage(c.author), post: { id: c.post.id, title: c.post.content?.slice(0, 90) || '', externalRef: c.post.externalRef, wall: c.post.wall } } }
      }
      if (query.post) {
        const p = await prisma.post.findFirst({ where: { id: Number(query.post), appId: auth.appId, deletedAt: null }, select: { id: true, content: true, externalRef: true, wallPageId: true, authorPageId: true } })
        if (!p || !enAlcance(a, p)) return { error: 'not_found' }
        return { data: { type: 'post', id: p.id, title: p.content?.slice(0, 90) || '', externalRef: p.externalRef } }
      }
      return { error: 'bad_request' }
    })

    // Silenciar a alguien SOLO en un alcance (scan y sus obras). Opcionalmente
    // borra (lógico) sus comentarios en ese alcance: todos o las últimas 24 h.
    .post('/moderation/mutes', async ({ auth, body }: any) => {
      if (!auth || auth.mode !== 'secret') return { error: 'secret_key_required' }
      const a = await resolverAlcance(auth.appId, String(body?.scope || '').split(',')[0])
      if (!a) return { error: 'scope_not_found' }
      const root = a.roots[0]
      const ref = String(body?.target || '')
      const target = ref.startsWith('external:')
        ? await prisma.page.findUnique({ where: { appId_externalId: { appId: auth.appId, externalId: ref.slice(9) } }, select: pageSel })
        : await prisma.page.findUnique({ where: { appId_handle: { appId: auth.appId, handle: ref.toLowerCase() } }, select: pageSel })
      if (!target) return { error: 'target_not_found' }
      if (a.ids.has(target.id)) return { error: 'cannot_mute_scope' }
      const until = body?.until ? new Date(body.until) : null
      if (until && (isNaN(until.getTime()) || until <= new Date())) return { error: 'bad_until' }
      const silencio: Silencio = { until: until ? until.toISOString() : 'forever', reason: body?.reason ? String(body.reason).slice(0, 300) : null, at: new Date().toISOString(), by: body?.by ? String(body.by).slice(0, 80) : null }
      // Atómico: no pisa otros silencios del mismo scan escritos a la vez.
      await prisma.$executeRaw`
        UPDATE "page" SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{mutes}', COALESCE(metadata->'mutes', '{}'::jsonb) || jsonb_build_object(${String(target.id)}::text, ${JSON.stringify(silencio)}::jsonb))
        WHERE id = ${root.id}`
      let borrados = 0
      const modo = String(body?.deleteComments || 'none')
      if (modo === 'all' || modo === '24h') {
        const where: any = { appId: auth.appId, authorPageId: target.id, deletedAt: null, post: { OR: [{ wallPageId: { in: [...a.ids] } }, { authorPageId: { in: [...a.ids] } }] } }
        if (modo === '24h') where.createdAt = { gte: new Date(Date.now() - 86_400_000) }
        const lista = await prisma.comment.findMany({ where, select: { id: true, postId: true } })
        if (lista.length) {
          await prisma.comment.updateMany({ where: { id: { in: lista.map((c) => c.id) } }, data: { deletedAt: new Date() } })
          const porPost = new Map<number, number>()
          for (const c of lista) porPost.set(c.postId, (porPost.get(c.postId) || 0) + 1)
          for (const [postId, n] of porPost) await prisma.post.update({ where: { id: postId }, data: { commentsCount: { decrement: n } } }).catch(() => {})
          borrados = lista.length
        }
      }
      return { data: { scope: root, target: shapePage(target), ...silencio, deletedComments: borrados } }
    })

    // Quitar el silencio de alguien en un alcance.
    .delete('/moderation/mutes', async ({ auth, query }: any) => {
      if (!auth || auth.mode !== 'secret') return { error: 'secret_key_required' }
      const a = await resolverAlcance(auth.appId, String(query.scope || '').split(',')[0])
      if (!a) return { error: 'scope_not_found' }
      const ref = String(query.target || '')
      const target = ref.startsWith('external:')
        ? await prisma.page.findUnique({ where: { appId_externalId: { appId: auth.appId, externalId: ref.slice(9) } }, select: { id: true } })
        : /^\d+$/.test(ref) ? { id: Number(ref) } : await prisma.page.findUnique({ where: { appId_handle: { appId: auth.appId, handle: ref.toLowerCase() } }, select: { id: true } })
      if (!target) return { error: 'target_not_found' }
      await prisma.$executeRaw`UPDATE "page" SET metadata = metadata #- ARRAY['mutes', ${String(target.id)}::text] WHERE id = ${a.roots[0].id}`
      return { data: { ok: true } }
    })

    // Silencios: de un alcance (panel del scan) o de una persona (sus sanciones).
    .get('/moderation/mutes', async ({ auth, query }: any) => {
      if (!auth || auth.mode !== 'secret') return { error: 'secret_key_required' }
      const soloVigentes = query.active === '1' || query.active === 'true'
      if (query.scope) {
        const a = await resolverAlcance(auth.appId, String(query.scope).split(',')[0])
        if (!a) return { error: 'scope_not_found' }
        const root = await prisma.page.findUnique({ where: { id: a.roots[0].id }, select: { metadata: true } })
        const mutes = ((root?.metadata as any)?.mutes || {}) as Record<string, Silencio>
        const ids = Object.keys(mutes).map(Number).filter(Boolean)
        const pages = ids.length ? await prisma.page.findMany({ where: { id: { in: ids }, appId: auth.appId }, select: pageSel }) : []
        const items = pages
          .map((p) => ({ target: shapePage(p), ...mutes[String(p.id)], active: silencioVigente(mutes[String(p.id)]) }))
          .filter((m) => !soloVigentes || m.active)
          .sort((x, y) => String(y.at).localeCompare(String(x.at)))
        return { data: { scope: a.roots[0], items } }
      }
      // Historial de varias personas a la vez (lista de moderación, usuarios de
      // un scan). Es visible entre scans: así cada scan sabe si alguien ya
      // tuvo mala conducta en otro lado. targets = handles o external:<id>.
      if (query.targets) {
        const refs = String(query.targets).split(',').map((r) => r.trim()).filter(Boolean).slice(0, 200)
        const ext = refs.filter((r) => r.startsWith('external:')).map((r) => r.slice(9))
        const handles = refs.filter((r) => !r.startsWith('external:')).map((r) => r.toLowerCase())
        const pages = await prisma.page.findMany({
          where: { appId: auth.appId, OR: [{ externalId: { in: ext } }, { handle: { in: handles } }] },
          select: { id: true, handle: true, externalId: true },
        })
        if (!pages.length) return { data: { items: {} } }
        const keys = pages.map((p) => String(p.id))
        const rows = await prisma.$queryRaw<Array<{ id: number; handle: string; displayName: string | null; avatarUrl: string | null; externalId: string | null; mutes: any }>>`
          SELECT id, handle, "displayName", "avatarUrl", "externalId", metadata->'mutes' AS mutes
          FROM "page" WHERE "appId" = ${auth.appId} AND metadata->'mutes' ?| ${keys}::text[]`
        const items: Record<string, any[]> = {}
        for (const p of pages) {
          const lista = rows
            .filter((r) => r.mutes && r.mutes[String(p.id)])
            .map((r) => ({ scope: { id: r.id, handle: r.handle, displayName: r.displayName, avatarUrl: r.avatarUrl, externalId: r.externalId }, ...(r.mutes[String(p.id)] as Silencio), active: silencioVigente(r.mutes[String(p.id)]) }))
          if (lista.length) {
            if (p.externalId) items[`external:${p.externalId}`] = lista
            items[p.handle] = lista
          }
        }
        return { data: { items } }
      }
      if (query.target) {
        const ref = String(query.target)
        const target = ref.startsWith('external:')
          ? await prisma.page.findUnique({ where: { appId_externalId: { appId: auth.appId, externalId: ref.slice(9) } }, select: { id: true } })
          : await prisma.page.findUnique({ where: { appId_handle: { appId: auth.appId, handle: ref.toLowerCase() } }, select: { id: true } })
        if (!target) return { data: { items: [] } }
        const key = String(target.id)
        const rows = await prisma.$queryRaw<Array<{ id: number; handle: string; displayName: string | null; avatarUrl: string | null; externalId: string | null; mute: any }>>`
          SELECT id, handle, "displayName", "avatarUrl", "externalId", metadata->'mutes'->${key} AS mute
          FROM "page" WHERE "appId" = ${auth.appId} AND metadata->'mutes' ? ${key}`
        const items = rows
          .map((r) => ({ scope: { id: r.id, handle: r.handle, displayName: r.displayName, avatarUrl: r.avatarUrl, externalId: r.externalId }, ...(r.mute as Silencio), active: silencioVigente(r.mute) }))
          .filter((m) => !soloVigentes || m.active)
        return { data: { items } }
      }
      return { error: 'bad_request' }
    })

    // Moderación: comentarios de todo lo que cuelga de una page (un scan y sus
    // obras). Solo con secret key: la app es quien sabe si quien pregunta es
    // staff de ese scan.
    .get('/moderation/comments', async ({ auth, query }: any) => {
      if (!auth || auth.mode !== 'secret') return { error: 'secret_key_required' }
      // Alcance: 'scope' (lista de refs) o 'page' (una sola, como antes). Se
      // admite handle o 'external:<id>': el externalId es estable aunque la app
      // renombre la page.
      const a = await resolverAlcance(auth.appId, String(query.scope || query.page || ''))
      if (!a) return { error: 'not_found' }
      const pageIds = [...a.ids]

      const limit = Math.min(200, Math.max(1, Number(query.limit) || 30))
      const pg = Math.max(0, Number(query.page_num) || 0)
      const status = String(query.status || 'all')
      const enScope = { post: { OR: [{ wallPageId: { in: pageIds } }, { authorPageId: { in: pageIds } }] } }

      const where: any = { appId: auth.appId, ...enScope }
      if (status === 'hidden') { where.hiddenAt = { not: null }; where.deletedAt = null }
      else if (status === 'deleted') where.deletedAt = { not: null }
      else if (status === 'active') { where.hiddenAt = null; where.deletedAt = null }
      else where.deletedAt = null
      if (query.q) where.content = { contains: String(query.q), mode: 'insensitive' }
      if (query.author) {
        const au = String(query.author)
        where.author = au.startsWith('external:') ? { externalId: au.slice(9) } : { handle: au.toLowerCase() }
      }
      if (query.post_id) where.postId = Number(query.post_id)
      if (query.replies === 'only') where.parentCommentId = { not: null }
      else if (query.replies === 'none') where.parentCommentId = null
      if (query.from || query.to) where.createdAt = { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lte: new Date(query.to) } : {}) }

      const orden: Record<string, any> = {
        recientes: [{ createdAt: 'desc' }],
        antiguos: [{ createdAt: 'asc' }],
        populares: [{ likesCount: 'desc' }, { createdAt: 'desc' }],
        menos_populares: [{ likesCount: 'asc' }, { createdAt: 'desc' }],
      }
      const orderBy = orden[String(query.sort || 'recientes')] || orden.recientes

      const base = { appId: auth.appId, ...enScope }
      const [rows, total, activos, ocultos, borrados] = await Promise.all([
        prisma.comment.findMany({
          where, orderBy, skip: pg * limit, take: limit + 1,
          include: {
            author: { select: pageSel },
            post: { select: { id: true, content: true, externalRef: true, wall: { select: wallSel } } },
          },
        }),
        prisma.comment.count({ where }),
        prisma.comment.count({ where: { ...base, deletedAt: null, hiddenAt: null } }),
        prisma.comment.count({ where: { ...base, deletedAt: null, hiddenAt: { not: null } } }),
        prisma.comment.count({ where: { ...base, deletedAt: { not: null } } }),
      ])

      const hasMore = rows.length > limit
      return {
        data: {
          items: rows.slice(0, limit).map((c) => ({
            id: c.id, content: c.content, createdAt: c.createdAt,
            likesCount: c.likesCount, parentCommentId: c.parentCommentId,
            hidden: !!c.hiddenAt, deleted: !!c.deletedAt,
            author: shapePage(c.author),
            post: c.post ? { id: c.post.id, title: c.post.content?.slice(0, 90) || '', externalRef: c.post.externalRef, wall: c.post.wall } : null,
          })),
          hasMore,
          total,
          // Conteos del alcance completo (sin filtros), para las pestañas.
          counts: { active: activos, hidden: ocultos, deleted: borrados, all: activos + ocultos },
          hidden: ocultos,
        },
      }
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
    .post('/posts/:id/save', async ({ auth, params, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      if (!requireScope(auth, 'react')) return { error: 'insufficient_scope' }
      let pageId: number
      try { pageId = await actingPage(auth, request.headers) } catch (e: any) { return { error: e.message } }
      const postId = Number(params.id)
      const existing = await prisma.save.findUnique({ where: { appId_postId_pageId: { appId: auth.appId, postId, pageId } }, select: { id: true } })
      if (existing) { await prisma.save.delete({ where: { id: existing.id } }); return { data: { saved: false } } }
      await prisma.save.create({ data: { appId: auth.appId, postId, pageId } })
      return { data: { saved: true } }
    })

    .get('/saved', async ({ auth, query, request }: any) => {
      if (!auth) return { error: 'unauthorized' }
      let pageId: number
      try { pageId = await actingPage(auth, request.headers) } catch (e: any) { return { error: e.message } }
      const limit = Math.min(30, Number(query.limit) || 20)
      const pg = Math.max(0, Number(query.page) || 0)
      const rows = await prisma.save.findMany({ where: { appId: auth.appId, pageId }, orderBy: { createdAt: 'desc' }, skip: pg * limit, take: limit + 1, select: { postId: true } })
      const hasMore = rows.length > limit
      const ids = rows.slice(0, limit).map((r) => r.postId)
      if (!ids.length) return { data: { items: [], hasMore: false } }
      const posts = await prisma.post.findMany({ where: { id: { in: ids }, deletedAt: null }, include: { author: { select: pageSel }, wall: { select: wallSel }, poll: true } })
      posts.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
      const likes = await likedPosts(auth.appId, pageId, ids)
      return { data: { items: posts.map((p) => ({ ...shapePost(p, likes), saved: true })), hasMore } }
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
      notify(auth.appId, target.id, followerPageId, 'follow')
      return { data: { following: true } }
    })
