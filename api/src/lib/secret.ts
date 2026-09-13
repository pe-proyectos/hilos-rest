import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto'

// Contenido que solo debe poder leerse a partir de cierta hora. Se guarda
// cifrado para que ni una copia de la base lo revele antes de tiempo; la clave
// vive en el servidor y el texto se descifra al entregarlo, nunca antes.
const clave = () =>
  createHash('sha256').update(String(process.env.HILOS_JWT_SECRET || 'hilos-dev-secret')).digest()

export function cifrar(texto: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', clave(), iv)
  const datos = Buffer.concat([c.update(texto, 'utf8'), c.final()])
  const tag = c.getAuthTag()
  return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${datos.toString('base64')}`
}

export function descifrar(guardado: string): string | null {
  try {
    const [version, iv, tag, datos] = guardado.split('.')
    if (version !== 'v1') return null
    const d = createDecipheriv('aes-256-gcm', clave(), Buffer.from(iv, 'base64'))
    d.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([d.update(Buffer.from(datos, 'base64')), d.final()]).toString('utf8')
  } catch {
    return null
  }
}
