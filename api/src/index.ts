import { Elysia } from 'elysia'
import { cors } from '@elysiajs/cors'
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

const app = new Elysia()
  .use(cors({ origin: (request) => {
    const o = request.headers.get('origin')
    if (!o) return true
    return allowedOrigin(o)
  }, credentials: true, allowedHeaders: ['authorization', 'content-type', 'x-hilos-page', 'x-bootstrap-token'] }))
  .get('/', () => ({ service: 'hilos.rest', status: 'ok', docs: '/v1/health' }))
  .use(v1())
  .onError(({ error, set }) => { set.status = 400; return { error: (error as any)?.message || 'error' } })
  .listen(Number(process.env.PORT) || 3100)

console.log(`hilos.rest api on :${(app.server?.port) || process.env.PORT || 3100}`)
export type App = typeof app
