import { prisma } from '../lib/prisma'
import { generateApiKey } from '../lib/crypto'

// Siembra el dev + app 'lacharca' + una secret key y una publishable key.
const dev = await prisma.developer.upsert({ where: { email: 'admin@capibaratraductor.com' }, update: {}, create: { email: 'admin@capibaratraductor.com', name: 'Capibara' } })
const app = await prisma.app.upsert({ where: { slug: 'lacharca' }, update: {}, create: { developerId: dev.id, name: 'La Charca', slug: 'lacharca' } })

async function mkKey(label: string, type: 'secret' | 'publishable') {
  const k = generateApiKey(type)
  await prisma.apiKey.create({ data: { appId: app.id, label, type, prefix: k.prefix, keyHash: k.hash } })
  return k.full
}
const secret = await mkKey('lacharca server (seed)', 'secret')
const pub = await mkKey('lacharca client (seed)', 'publishable')
console.log('APP_ID ' + app.id)
console.log('SECRET_KEY ' + secret)
console.log('PUBLISHABLE_KEY ' + pub)
await prisma.$disconnect()
