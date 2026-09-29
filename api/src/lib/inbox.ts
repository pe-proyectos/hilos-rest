import { Prisma } from '@prisma/client'
import { prisma } from './prisma'

// Bandeja de una page con filtros, orden, búsqueda y conteos. La usan las apps
// consumidoras (con secret key) para armar bandejas de soporte: el scan que
// atiende a sus lectores, por ejemplo.
//
// Un mensaje puede "abrir un tema" con meta.topic = { tag, title, ref }. La
// etiqueta de una conversación es la del tema más reciente.

export interface InboxQuery {
  status?: 'open' | 'archived' | 'all'
  unread?: boolean
  tag?: string | null
  q?: string | null
  sort?: 'recent' | 'oldest' | 'unread'
  type?: string | null
  withPageId?: number | null
  conversationId?: number | null
  page?: number
  limit?: number
}

export interface InboxRow {
  id: number
  other_id: number
  lastMessageAt: Date
  createdAt: Date
  archivedAt: Date | null
  lastReadAt: Date | null
  unread: number
  topic: any
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

function baseCte(appId: number, me: number, type?: string | null, withPageId?: number | null, conversationId?: number | null) {
  return Prisma.sql`
    WITH base AS (
      SELECT c.id, c."lastMessageAt", c."createdAt", cm."archivedAt", cm."lastReadAt",
             CASE WHEN c."pageAId" = ${me} THEN c."pageBId" ELSE c."pageAId" END AS other_id
      FROM conversation_member cm
      JOIN conversation c ON c.id = cm."conversationId"
      WHERE cm."pageId" = ${me} AND c."appId" = ${appId}
        ${conversationId ? Prisma.sql`AND c.id = ${conversationId}` : Prisma.empty}
    ),
    enriched AS (
      SELECT b.*, p.handle AS other_handle, p."displayName" AS other_name,
        (SELECT count(*)::int FROM message m
          WHERE m."conversationId" = b.id AND m."deletedAt" IS NULL AND m."senderPageId" <> ${me}
            AND (b."lastReadAt" IS NULL OR m."createdAt" > b."lastReadAt")) AS unread,
        (SELECT m.media->'meta'->'topic' FROM message m
          WHERE m."conversationId" = b.id AND m."deletedAt" IS NULL AND m.media->'meta'->'topic' IS NOT NULL
          ORDER BY m."createdAt" DESC, m.id DESC LIMIT 1) AS topic
      FROM base b
      JOIN page p ON p.id = b.other_id
      WHERE TRUE
        ${type ? Prisma.sql`AND p.type = ${type}` : Prisma.empty}
        ${withPageId ? Prisma.sql`AND b.other_id = ${withPageId}` : Prisma.empty}
    )`
}

export async function listInbox(appId: number, me: number, o: InboxQuery) {
  const limit = Math.min(200, Math.max(1, Number(o.limit) || 20))
  const page = Math.max(0, Number(o.page) || 0)
  const conds: Prisma.Sql[] = []
  if (o.status === 'open') conds.push(Prisma.sql`"archivedAt" IS NULL`)
  else if (o.status === 'archived') conds.push(Prisma.sql`"archivedAt" IS NOT NULL`)
  if (o.unread) conds.push(Prisma.sql`unread > 0`)
  if (o.tag) conds.push(Prisma.sql`topic->>'tag' = ${o.tag}`)
  const q = (o.q || '').trim().slice(0, 100)
  if (q) {
    const like = `%${likeEscape(q)}%`
    conds.push(Prisma.sql`(
      other_handle ILIKE ${like} OR other_name ILIKE ${like} OR topic->>'title' ILIKE ${like}
      OR EXISTS (SELECT 1 FROM message m WHERE m."conversationId" = enriched.id AND m."deletedAt" IS NULL AND m.content ILIKE ${like})
    )`)
  }
  const where = conds.length ? Prisma.sql`WHERE ${Prisma.join(conds, ' AND ')}` : Prisma.empty
  const order =
    o.sort === 'oldest'
      ? Prisma.sql`ORDER BY "lastMessageAt" ASC, id ASC`
      : o.sort === 'unread'
        ? Prisma.sql`ORDER BY (unread > 0) DESC, "lastMessageAt" DESC, id DESC`
        : Prisma.sql`ORDER BY "lastMessageAt" DESC, id DESC`
  const cte = baseCte(appId, me, o.type, o.withPageId, o.conversationId)

  const [rows, totalRow, countsRow] = await Promise.all([
    prisma.$queryRaw<InboxRow[]>`${cte}
      SELECT id, other_id, "lastMessageAt", "createdAt", "archivedAt", "lastReadAt", unread, topic
      FROM enriched ${where} ${order} LIMIT ${limit} OFFSET ${page * limit}`,
    prisma.$queryRaw<{ n: number }[]>`${cte} SELECT count(*)::int AS n FROM enriched ${where}`,
    prisma.$queryRaw<{ open: number; archived: number; all: number; unread: number }[]>`${cte}
      SELECT count(*) FILTER (WHERE "archivedAt" IS NULL)::int AS open,
             count(*) FILTER (WHERE "archivedAt" IS NOT NULL)::int AS archived,
             count(*)::int AS "all",
             count(*) FILTER (WHERE unread > 0)::int AS unread
      FROM enriched`,
  ])
  return {
    rows,
    total: totalRow[0]?.n ?? 0,
    counts: countsRow[0] ?? { open: 0, archived: 0, all: 0, unread: 0 },
    page,
    limit,
  }
}

/** Solo los conteos (burbujas de "sin leer"), sin armar la lista. */
export async function inboxCounts(appId: number, me: number, type?: string | null) {
  const cte = baseCte(appId, me, type, null)
  const r = await prisma.$queryRaw<{ open: number; archived: number; all: number; unread: number; unreadMessages: number }[]>`${cte}
    SELECT count(*) FILTER (WHERE "archivedAt" IS NULL)::int AS open,
           count(*) FILTER (WHERE "archivedAt" IS NOT NULL)::int AS archived,
           count(*)::int AS "all",
           count(*) FILTER (WHERE unread > 0)::int AS unread,
           COALESCE(sum(unread), 0)::int AS "unreadMessages"
    FROM enriched`
  return r[0] ?? { open: 0, archived: 0, all: 0, unread: 0, unreadMessages: 0 }
}

/** meta guardado dentro de message.media (sin cambiar el esquema). */
export function messageMeta(media: any): any {
  return media && typeof media === 'object' && !Array.isArray(media) && media.meta && typeof media.meta === 'object' ? media.meta : null
}
/** Adjuntos reales del mensaje (lo que no es meta). */
export function messageMedia(media: any): any {
  if (!media) return null
  if (typeof media === 'object' && !Array.isArray(media) && 'meta' in media) return media.items ?? null
  return media
}

/** Conversaciones (de entre ids) en las que la page ya escribió al menos una vez. */
export async function engagedConversations(me: number, ids: number[]): Promise<Set<number>> {
  if (!ids.length) return new Set()
  const rows = await prisma.message.findMany({
    where: { conversationId: { in: ids }, senderPageId: me, deletedAt: null },
    distinct: ['conversationId'],
    select: { conversationId: true },
  })
  return new Set(rows.map((r) => r.conversationId))
}

/**
 * Arma el resumen de cada fila: la otra page, su lectura/archivo, el último
 * mensaje y el tema vigente. Todo en lote (sin N+1).
 */
export async function buildSummaries(me: number, rows: InboxRow[], pageSel: any, shapePage: (p: any) => any) {
  if (!rows.length) return []
  const ids = rows.map((r) => r.id)
  const [pages, others, lasts] = await Promise.all([
    prisma.page.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.other_id))] } }, select: pageSel }),
    prisma.conversationMember.findMany({ where: { conversationId: { in: ids }, pageId: { not: me } }, select: { conversationId: true, lastReadAt: true, archivedAt: true } }),
    prisma.$queryRaw<{ conversationId: number; id: number; content: string; createdAt: Date; senderPageId: number; media: any }[]>`
      SELECT DISTINCT ON ("conversationId") "conversationId", id, content, "createdAt", "senderPageId", media
      FROM message WHERE "conversationId" IN (${Prisma.join(ids)}) AND "deletedAt" IS NULL
      ORDER BY "conversationId", "createdAt" DESC, id DESC`,
  ])
  const pageById = new Map((pages as any[]).map((p) => [p.id, p]))
  const otherBy = new Map(others.map((o) => [o.conversationId, o]))
  const lastBy = new Map(lasts.map((l) => [l.conversationId, l]))
  return rows.map((r) => {
    const o = otherBy.get(r.id)
    const l = lastBy.get(r.id)
    return {
      id: r.id,
      page: shapePage(pageById.get(r.other_id)),
      archived: !!r.archivedAt,
      archivedAt: r.archivedAt,
      lastReadAt: r.lastReadAt,
      otherArchived: !!o?.archivedAt,
      otherArchivedAt: o?.archivedAt ?? null,
      otherLastReadAt: o?.lastReadAt ?? null,
      unread: r.unread,
      topic: r.topic ?? null,
      lastMessageAt: r.lastMessageAt,
      createdAt: r.createdAt,
      lastMessage: l ? { id: l.id, content: l.content.slice(0, 280), createdAt: l.createdAt, mine: l.senderPageId === me, meta: messageMeta(l.media) } : null,
    }
  })
}
