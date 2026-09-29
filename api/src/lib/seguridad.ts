// Validaciones puras (sin base de datos) de lo que entra por la API: tipos de
// imagen reales, nombres de archivo y fechas que manda la app.

// Formatos de imagen que se aceptan en las subidas, por su tipo MIME. Solo
// rasterizados: un SVG puede llevar script y se serviría desde el dominio de media.
export const TIPOS_IMAGEN: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
}

/** Tipo MIME declarado, si es de los permitidos (sin tocar el prototipo del objeto). */
export function imagenDeTipo(tipo: unknown): { type: string; ext: string } | null {
  const t = String(tipo || '').toLowerCase().split(';')[0].trim()
  return Object.prototype.hasOwnProperty.call(TIPOS_IMAGEN, t) ? { type: t, ext: TIPOS_IMAGEN[t] } : null
}

const ascii = (b: Uint8Array, desde: number, largo: number) =>
  String.fromCharCode(...b.subarray(desde, desde + largo))

/**
 * Identifica la imagen por sus primeros bytes (no por lo que diga el cliente).
 * Devuelve el tipo MIME y la extensión, o null si no es un formato permitido.
 */
export function detectarImagen(b: Uint8Array): { type: string; ext: string } | null {
  if (!b || b.length < 12) return null
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return { type: 'image/png', ext: 'png' }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' }
  const gif = ascii(b, 0, 6)
  if (gif === 'GIF87a' || gif === 'GIF89a') return { type: 'image/gif', ext: 'gif' }
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return { type: 'image/webp', ext: 'webp' }
  if (ascii(b, 4, 4) === 'ftyp' && ['avif', 'avis'].includes(ascii(b, 8, 4))) return { type: 'image/avif', ext: 'avif' }
  return null
}

/** Nombre de archivo apto para la clave del bucket, con la extensión del tipo real. */
export function nombreSeguro(nombre: unknown, ext: string): string {
  const limpio = String(nombre || 'file').replace(/[^a-zA-Z0-9._-]/g, '_')
  const base = limpio.replace(/\.[^.]*$/, '').replace(/^[._-]+/, '').slice(-50) || 'file'
  return `${base}.${ext}`
}

/**
 * Fecha original de una importación: válida y nunca en el futuro (una fecha
 * futura rompe el ranking del feed y fija el post arriba). null si no se entiende.
 */
export function fechaNoFutura(valor: unknown, ahora: Date = new Date()): Date | null {
  if (valor == null || valor === '') return null
  const d = new Date(valor as any)
  if (Number.isNaN(d.getTime())) return null
  return d > ahora ? new Date(ahora) : d
}
