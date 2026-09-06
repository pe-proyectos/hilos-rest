import { Elysia } from 'elysia'
import { cors } from '@elysiajs/cors'
import { v1 } from './routes/v1'

const app = new Elysia()
  .use(cors())
  .get('/', () => ({ service: 'hilos.rest', status: 'ok', docs: '/v1/health' }))
  .use(v1())
  .onError(({ error, set }) => { set.status = 400; return { error: (error as any)?.message || 'error' } })
  .listen(Number(process.env.PORT) || 3100)

console.log(`hilos.rest api on :${(app.server?.port) || process.env.PORT || 3100}`)
export type App = typeof app
