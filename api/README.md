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

## Dev
```
cp .env.example .env   # DATABASE_URL, HILOS_JWT_SECRET
bun install && bunx prisma db push && bun run src/scripts/seed.ts
bun run dev
```
