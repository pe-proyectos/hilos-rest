// S3/R2 con el cliente nativo de Bun (sin dependencias). Guarda media de
// posts/comentarios que son propiedad de hilos.rest.
let _client: any = null
export function s3(): any | null {
  if (_client) return _client
  const { R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env
  if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) return null
  // @ts-ignore Bun.S3Client
  _client = new Bun.S3Client({ accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, bucket: R2_BUCKET, endpoint: R2_ENDPOINT })
  return _client
}
export const R2_PUBLIC = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')

// Sube un Buffer/Uint8Array directo (para la migración: copiar del R2 origen).
export async function putObject(key: string, data: Uint8Array | ArrayBuffer, contentType?: string): Promise<string | null> {
  const c = s3(); if (!c) return null
  await c.write(key, data, contentType ? { type: contentType } : undefined)
  return `${R2_PUBLIC}/${key}`
}
