import { Elysia } from 'elysia'
import { v1 } from './routes/v1'
import { prisma } from './lib/prisma'

// CORS: refleja el Origin solo si pertenece a algun App registrado.
const originCache = { set: new Set<string>(), exp: 0 }
async function allowedOrigin(origin: string): Promise<boolean> {
  if (originCache.exp < Date.now()) {
    const apps = await prisma.app.findMany({ select: { allowedOrigins: true } })
    originCache.set = new Set(apps.flatMap((a) => (a.allowedOrigins || '').split(',').map((x) => x.trim()).filter(Boolean)))
    originCache.exp = Date.now() + 60_000
  }
  return originCache.set.has(origin)
}

const CORS_HEADERS = 'authorization, content-type, x-hilos-page, x-bootstrap-token'
const CORS_METHODS = 'GET, POST, DELETE, OPTIONS'

// CORS manual: el plugin no reflejaba el Origin con un allowlist asincrono,
// y sin Access-Control-Allow-Origin el navegador bloquea toda accion del cliente.
async function corsHeaders(origin: string | null): Promise<Record<string, string> | null> {
  if (!origin) return null
  if (!(await allowedOrigin(origin))) return null
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': CORS_METHODS,
    'access-control-allow-headers': CORS_HEADERS,
    'access-control-max-age': '600',
    vary: 'Origin',
  }
}

const app = new Elysia()
  .options('/*', async ({ request, set }) => {
    const h = await corsHeaders(request.headers.get('origin'))
    set.status = 204
    if (h) for (const [k, v] of Object.entries(h)) set.headers[k] = v
    return null
  })
  .onAfterHandle(async ({ request, set }) => {
    const h = await corsHeaders(request.headers.get('origin'))
    if (h) for (const [k, v] of Object.entries(h)) set.headers[k] = v
  })
  .get('/', () => ({ service: 'hilos.rest', status: 'ok', docs: '/v1/health' }))
  .use(v1())
  .onError(async ({ error, set, request }) => {
    const h = await corsHeaders(request.headers.get('origin'))
    if (h) for (const [k, v] of Object.entries(h)) set.headers[k] = v
    set.status = 400
    return { error: (error as any)?.message || 'error' }
  })
  .listen(Number(process.env.PORT) || 3100)

console.log(`hilos.rest api on :${(app.server?.port) || process.env.PORT || 3100}`)
export type App = typeof app
