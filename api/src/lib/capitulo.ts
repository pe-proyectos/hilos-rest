// Capítulo al que se refiere un post (y, con él, todos sus comentarios).
//
// Dos fuentes, por orden:
//   1. `metadata.chapter` que manda la app con su clave secreta al publicar
//      ({ id, number, url }). Es lo único que trae el enlace al lector.
//   2. Lo que ya se guardaba antes: externalRef 'chapter:<id>' y el texto del
//      aviso ("Capítulo 12", "Capítulo 12: título", "Chapter 12").
// Un post sin ninguna de las dos no habla de un capítulo: null.

export type CapituloDePost = {
  ref: string | null
  id: number | null
  number: string | null
  url: string | null
}

const REF = /^chapter:(\d{1,12})$/
const NUMERO_EN_TEXTO = /^(?:Cap[ií]tulo|Chapter)\s+(\d{1,6}(?:[.,]\d{1,3})?)(?=$|[\s:.,])/i
const NUMERO = /^\d{1,6}(?:[.,]\d{1,3})?$/

function numeroLimpio(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return String(v)
  if (typeof v !== 'string') return null
  const s = v.trim()
  return NUMERO.test(s) ? s.replace(',', '.') : null
}

function urlSegura(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 500) return null
  try {
    const u = new URL(v)
    return u.protocol === 'https:' ? u.toString() : null
  } catch {
    return null
  }
}

export function capituloDePost(p: { externalRef?: string | null; content?: string | null; metadata?: unknown }): CapituloDePost | null {
  const porRef = typeof p.externalRef === 'string' ? p.externalRef.match(REF) : null
  const meta = p.metadata && typeof p.metadata === 'object' ? (p.metadata as any).chapter : null
  const m = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : null
  if (!porRef && !m) return null

  const idMeta = Number(m?.id)
  const id = porRef ? Number(porRef[1]) : Number.isSafeInteger(idMeta) && idMeta > 0 ? idMeta : null
  const enTexto = String(p.content || '').trim().match(NUMERO_EN_TEXTO)?.[1]
  const number = numeroLimpio(m?.number) ?? (enTexto ? enTexto.replace(',', '.') : null)
  const url = urlSegura(m?.url)
  if (!porRef && !number && !url) return null
  return { ref: id ? `chapter:${id}` : null, id, number, url }
}
