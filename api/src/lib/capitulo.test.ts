import { describe, expect, test } from 'bun:test'
import { capituloDePost } from './capitulo'

describe('capituloDePost', () => {
  test('posts de antes: número desde el aviso y referencia desde externalRef', () => {
    expect(capituloDePost({ externalRef: 'chapter:50718', content: 'Capítulo 186' }))
      .toEqual({ ref: 'chapter:50718', id: 50718, number: '186', url: null })
    expect(capituloDePost({ externalRef: 'chapter:7', content: 'Capítulo 183: Capítulo 1' })?.number).toBe('183')
    expect(capituloDePost({ externalRef: 'chapter:7', content: 'Chapter 12.5: The end' })?.number).toBe('12.5')
    expect(capituloDePost({ externalRef: 'chapter:7', content: 'Capitulo 90,5' })?.number).toBe('90.5')
  })

  test('sin número reconocible sigue siendo un capítulo (con su referencia)', () => {
    expect(capituloDePost({ externalRef: 'chapter:9', content: 'Especial de año nuevo' }))
      .toEqual({ ref: 'chapter:9', id: 9, number: null, url: null })
  })

  test('metadata.chapter manda sobre el texto y trae el enlace', () => {
    expect(capituloDePost({
      externalRef: 'chapter:52821',
      content: 'Capítulo 187',
      metadata: { chapter: { id: 52821, number: 187, url: 'https://capibaratraductor.com/rakuen/manga/mato/chapters/187' } },
    })).toEqual({ ref: 'chapter:52821', id: 52821, number: '187', url: 'https://capibaratraductor.com/rakuen/manga/mato/chapters/187' })
    expect(capituloDePost({ content: 'Hola', metadata: { chapter: { id: 3, number: '12', url: 'https://capybaratranslator.com/x/manga/y/chapters/12' } } })?.ref).toBe('chapter:3')
  })

  test('descarta enlaces que no son https y números raros', () => {
    const c = capituloDePost({ externalRef: 'chapter:1', content: 'Capítulo 4', metadata: { chapter: { number: '4<script>', url: 'javascript:alert(1)' } } })
    expect(c).toEqual({ ref: 'chapter:1', id: 1, number: '4', url: null })
    expect(capituloDePost({ externalRef: 'chapter:1', content: 'x', metadata: { chapter: { url: 'http://a.com/x' } } })?.url).toBeNull()
  })

  test('lo que no es un capítulo da null', () => {
    expect(capituloDePost({ externalRef: null, content: 'Le falta más texto al nombre hdtpm' })).toBeNull()
    expect(capituloDePost({ externalRef: 'manga:96', content: 'Capítulo 3' })).toBeNull()
    expect(capituloDePost({ externalRef: 'chapter:abc', content: 'Capítulo 3' })).toBeNull()
    expect(capituloDePost({ content: 'Capítulo 3', metadata: { nsfw: true } })).toBeNull()
    expect(capituloDePost({ content: 'x', metadata: { chapter: {} } })).toBeNull()
    expect(capituloDePost({ content: 'x', metadata: { chapter: 'chapter:3' } })).toBeNull()
  })
})
