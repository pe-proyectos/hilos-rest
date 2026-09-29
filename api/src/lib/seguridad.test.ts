import { describe, expect, test } from 'bun:test'
import { detectarImagen, imagenDeTipo, nombreSeguro, fechaNoFutura } from './seguridad'
import { requireScope, canWrite, type AuthCtx } from '../plugins/auth'

const bytes = (...partes: Array<number[] | string>) => {
  const out: number[] = []
  for (const p of partes) out.push(...(typeof p === 'string' ? [...p].map((ch) => ch.charCodeAt(0)) : p))
  while (out.length < 16) out.push(0)
  return new Uint8Array(out)
}

describe('detectarImagen', () => {
  test('reconoce los formatos permitidos por sus bytes', () => {
    expect(detectarImagen(bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a]))).toEqual({ type: 'image/png', ext: 'png' })
    expect(detectarImagen(bytes([0xff, 0xd8, 0xff, 0xe0]))).toEqual({ type: 'image/jpeg', ext: 'jpg' })
    expect(detectarImagen(bytes('GIF89a'))).toEqual({ type: 'image/gif', ext: 'gif' })
    expect(detectarImagen(bytes('GIF87a'))).toEqual({ type: 'image/gif', ext: 'gif' })
    expect(detectarImagen(bytes('RIFF', [1, 2, 3, 4], 'WEBPVP8 '))).toEqual({ type: 'image/webp', ext: 'webp' })
    expect(detectarImagen(bytes([0, 0, 0, 0x1c], 'ftypavif'))).toEqual({ type: 'image/avif', ext: 'avif' })
  })

  test('rechaza SVG, HTML y lo que no es imagen', () => {
    expect(detectarImagen(bytes('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull()
    expect(detectarImagen(bytes('<?xml version="1.0"?><svg/>'))).toBeNull()
    expect(detectarImagen(bytes('<!doctype html><script>x</script>'))).toBeNull()
    expect(detectarImagen(bytes('%PDF-1.7'))).toBeNull()
    expect(detectarImagen(bytes([0, 0, 0, 0x18], 'ftypmp42'))).toBeNull()
    expect(detectarImagen(new Uint8Array([0x89, 0x50]))).toBeNull()
    expect(detectarImagen(new Uint8Array())).toBeNull()
  })
})

describe('imagenDeTipo', () => {
  test('solo tipos rasterizados de la lista', () => {
    expect(imagenDeTipo('image/png')).toEqual({ type: 'image/png', ext: 'png' })
    expect(imagenDeTipo('IMAGE/JPEG; charset=binary')).toEqual({ type: 'image/jpeg', ext: 'jpg' })
    expect(imagenDeTipo('image/svg+xml')).toBeNull()
    expect(imagenDeTipo('text/html')).toBeNull()
    expect(imagenDeTipo('application/octet-stream')).toBeNull()
    expect(imagenDeTipo(undefined)).toBeNull()
    expect(imagenDeTipo('constructor')).toBeNull()
    expect(imagenDeTipo('__proto__')).toBeNull()
  })
})

describe('nombreSeguro', () => {
  test('fuerza la extensión del tipo real', () => {
    expect(nombreSeguro('foto.png', 'png')).toBe('foto.png')
    expect(nombreSeguro('phish.html', 'png')).toBe('phish.png')
    expect(nombreSeguro('a.svg', 'jpg')).toBe('a.jpg')
    expect(nombreSeguro('../../x y.php', 'gif')).toBe('x_y.gif')
    expect(nombreSeguro('', 'webp')).toBe('file.webp')
    expect(nombreSeguro(undefined, 'webp')).toBe('file.webp')
    expect(nombreSeguro('.htaccess', 'png')).toBe('file.png')
    expect(nombreSeguro('x'.repeat(200) + '.png', 'png').length).toBeLessThanOrEqual(54)
  })
})

describe('fechaNoFutura', () => {
  const ahora = new Date('2026-09-29T12:00:00Z')
  test('conserva fechas pasadas', () => {
    expect(fechaNoFutura('2024-01-02T03:04:05Z', ahora)?.toISOString()).toBe('2024-01-02T03:04:05.000Z')
  })
  test('recorta las futuras a ahora', () => {
    expect(fechaNoFutura('2099-01-01T00:00:00Z', ahora)?.toISOString()).toBe(ahora.toISOString())
  })
  test('null si no es una fecha', () => {
    expect(fechaNoFutura('mañana', ahora)).toBeNull()
    expect(fechaNoFutura('', ahora)).toBeNull()
    expect(fechaNoFutura(undefined, ahora)).toBeNull()
  })
})

describe('permisos de escritura', () => {
  const ctx = (mode: AuthCtx['mode'], scopes: AuthCtx['scopes']): AuthCtx => ({ appId: 1, mode, pageId: mode === 'page' ? 5 : null, scopes })
  test('la clave pública nunca escribe', () => {
    expect(canWrite(ctx('public', ['read']))).toBe(false)
    // Aunque alguien le colara scopes de escritura.
    expect(canWrite(ctx('public', ['post:write', 'comment:write']))).toBe(false)
    expect(requireScope(ctx('public', ['read']), 'read')).toBe(true)
  })
  test('page token según sus scopes; secret key siempre', () => {
    expect(canWrite(ctx('page', ['read']))).toBe(false)
    expect(canWrite(ctx('page', ['comment:write']))).toBe(true)
    expect(canWrite(ctx('page', ['post:write']))).toBe(true)
    expect(canWrite(ctx('secret', []))).toBe(true)
  })
})
