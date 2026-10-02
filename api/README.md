# hilos.rest — motor social embebible (v1)

Backend reutilizable para redes sociales / comentarios (tipo Disqus, pero para
redes completas). Multi-tenant por **App** (con API keys). NO autentica end-users:
solo devs. Los end-users se autentican en la app del consumidor, que provisiona
**Pages** vía API key.

Stack: Bun + Elysia + Prisma + PostgreSQL.

## Primitivas
- **Page**: el actor (usuario, scan, obra=subpage, custom). @handle único por app.
- **Post**: en el muro de una page, escrito por una page autora.
- **Comment**: sobre un post, por una page (anidable).
- **Reaction** (like) y **Follow** (page↔page).

## Auth
- `sk_...` secret key (server-to-server): actúa como page vía `X-Hilos-Page: external:<id>|<handle>|<id>`. Provisiona pages, migración/auto-post.
- `pk_...` publishable (lectura, cliente).
- **page token** (JWT app+page) minteado con la secret key: el cliente actúa como esa page (habilita el embed).

## Endpoints v1
`/v1/health`, `POST /v1/pages` (upsert por externalId), `GET /v1/pages/:handle`,
`POST /v1/page-tokens`, `GET /v1/pages/:handle/posts`, `POST /v1/posts`,
`GET /v1/posts/:id`, `DELETE /v1/posts/:id`, `GET /v1/feed`,
`GET|POST /v1/posts/:id/comments`, `DELETE /v1/comments/:id`,
`POST /v1/posts/:id/like`, `POST /v1/pages/:handle/follow`.

Capítulos: con secret key, `POST /v1/posts` acepta `metadata.chapter = { id, number, url }`
(url https al lector). Los posts salen con `chapter: { ref, id, number, url } | null`,
que también se deriva de `externalRef: 'chapter:<id>'` + "Capítulo N"/"Chapter N" en el
texto (url null en ese caso). `GET /v1/notifications` añade `chapter` (con `work`) por aviso.

### Mensajería
`GET /v1/conversations`, `GET /v1/conversations/:id/messages`,
`POST /v1/conversations/:id/archive`, `POST /v1/messages`, `GET /v1/messages/unread`.
Para escribir hay que seguir a la otra page o haber escrito ya en esa conversación.

Con secret key + `X-Hilos-Page` (bandejas de soporte; sin la regla de seguir):
- `POST /v1/messages` acepta además `to` (external:<id> | id | handle), `meta`
  (p. ej. `meta.topic = { tag, title, ref }` abre un tema), `externalRef`
  (idempotente), `createdAt` (importación), `notify: false`, `reopen: true`.
- `GET /v1/inbox?status=open|archived|all&unread=1&tag=&q=&sort=recent|oldest|unread&type=&with=&page=&limit=`
  → `{ items, total, page, limit, counts: { open, archived, all, unread } }`.
- `GET /v1/inbox/counts?type=`, `GET /v1/inbox/:id`,
  `GET /v1/inbox/:id/messages?page=&limit=&markRead=0`, `POST /v1/inbox/:id/read { at? }`.
El meta interno solo sale con secret key; con page token solo se ve `topic`.

## Dev
```
cp .env.example .env   # DATABASE_URL, HILOS_JWT_SECRET
bun install && bunx prisma db push && bun run src/scripts/seed.ts
bun run dev
```
