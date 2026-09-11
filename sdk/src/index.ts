// SDK de hilos.rest — agnóstico (Bun/Node/navegador, usa fetch global).
// Server: pásale secretKey y actúa como una page vía actingPage.
// Cliente: pásale un pageToken (obtenido con secretKey en tu backend).

export interface HilosPage { id: number; handle: string; type: string; parentPageId: number | null; externalId: string | null; displayName: string | null; avatarUrl: string | null; bio: string | null; followersCount: number; followingCount: number; postsCount: number }
export interface HilosPost { id: number; content: string; media: any; repostOfId: number | null; externalRef: string | null; likesCount: number; commentsCount: number; repostCount: number; pinned: boolean; createdAt: string; liked?: boolean; author: HilosPage; wallPageId: number }
export interface HilosComment { id: number; content: string; parentCommentId: number | null; likesCount: number; createdAt: string; author: HilosPage }
export interface Paged<T> { items: T[]; hasMore: boolean }

export interface HilosOptions { baseUrl: string; secretKey?: string; publishableKey?: string; pageToken?: string; actingPage?: string | number }

export class HilosError extends Error { constructor(public code: string) { super(code) } }

export function createHilos(opts: HilosOptions) {
  const base = opts.baseUrl.replace(/\/$/, '')
  const authKey = opts.pageToken || opts.secretKey || opts.publishableKey
  if (!authKey) throw new Error('hilos: falta secretKey, publishableKey o pageToken')

  async function req(method: string, path: string, body?: any, acting?: string | number): Promise<any> {
    const headers: Record<string, string> = { Authorization: `Bearer ${authKey}` }
    if (body) headers['Content-Type'] = 'application/json'
    const act = acting ?? opts.actingPage
    if (act != null && opts.secretKey && !opts.pageToken) headers['X-Hilos-Page'] = String(act)
    const res = await fetch(`${base}/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
    const json = await res.json().catch(() => ({}))
    if (json?.error) throw new HilosError(json.error)
    return json?.data
  }

  return {
    health: () => req('GET', '/health'),
    pages: {
      upsert: (p: { externalId?: string | number; handle?: string; type?: string; displayName?: string; avatarUrl?: string; bio?: string; parentHandle?: string; parentExternalId?: string | number; metadata?: any; createdAt?: string }): Promise<HilosPage> => req('POST', '/pages', p),
      get: (handle: string): Promise<HilosPage> => req('GET', `/pages/${encodeURIComponent(handle)}`),
      posts: (handle: string, page = 0, limit = 20): Promise<Paged<HilosPost>> => req('GET', `/pages/${encodeURIComponent(handle)}/posts?page=${page}&limit=${limit}`),
      claim: (p: { fromExternalId: string; toExternalId: string; handle?: string; displayName?: string; avatarUrl?: string }): Promise<HilosPage> => req('POST', '/pages/claim', p),
      update: (handle: string, p: { displayName?: string; bio?: string; avatarUrl?: string | null; bannerUrl?: string | null; handle?: string }, acting?: string | number): Promise<HilosPage> => req('PATCH', `/pages/${encodeURIComponent(handle)}`, p, acting),
      follow: (handle: string, acting?: string | number): Promise<{ following: boolean }> => req('POST', `/pages/${encodeURIComponent(handle)}/follow`, undefined, acting),
      mute: (handle: string, muted = true, until?: string): Promise<{ handle: string; muted: boolean }> => req('POST', `/pages/${encodeURIComponent(handle)}/mute`, { muted, ...(until ? { until } : {}) }),
    },
    pageTokens: {
      create: (p: { pageId?: number; externalId?: string | number; ttl?: number; scopes?: string[]; origin?: string }): Promise<{ token: string; pageId: number; expiresIn: number; scopes?: string[] }> => req('POST', '/page-tokens', p),
    },
    posts: {
      create: (p: { content?: string; media?: any; wallHandle?: string; wallExternalId?: string | number; wallPageId?: number; repostOfId?: number; externalRef?: string; metadata?: any; createdAt?: string }, acting?: string | number): Promise<HilosPost> => req('POST', '/posts', p, acting),
      get: (id: number): Promise<HilosPost> => req('GET', `/posts/${id}`),
      save: (id: number): Promise<{ saved: boolean }> => req('POST', `/posts/${id}/save`),
      saved: (page = 0, limit = 20) => req('GET', `/saved?page=${page}&limit=${limit}`),
      byRef: (ref: string): Promise<{ id: number; wallPageId: number }> => req('GET', `/posts/by-ref?ref=${encodeURIComponent(ref)}`),
      remove: (id: number, acting?: string | number): Promise<{ ok: boolean }> => req('DELETE', `/posts/${id}`, undefined, acting),
      update: (id: number, p: { content?: string; wallExternalId?: string }, acting?: string | number): Promise<HilosPost> => req('PATCH', `/posts/${id}`, p, acting),
      like: (id: number, acting?: string | number): Promise<{ liked: boolean; likesCount: number }> => req('POST', `/posts/${id}/like`, undefined, acting),
    },
    uploads: {
      fromUrl: (url: string): Promise<{ key: string; publicUrl: string }> => req('POST', '/uploads/fetch', { url }),
    },
    feed: (opt: { scope?: 'following' | 'foryou'; page?: number; limit?: number } = {}): Promise<Paged<HilosPost>> => req('GET', `/feed?scope=${opt.scope || 'foryou'}&page=${opt.page || 0}&limit=${opt.limit || 20}`),
    messages: {
      conversations: (page = 0, limit = 20, acting?: string | number) => req('GET', `/conversations?page=${page}&limit=${limit}`, undefined, acting),
      list: (conversationId: number, page = 0, limit = 40, acting?: string | number) => req('GET', `/conversations/${conversationId}/messages?page=${page}&limit=${limit}`, undefined, acting),
      send: (handle: string, content: string, acting?: string | number) => req('POST', '/messages', { handle, content }, acting),
      unread: (acting?: string | number) => req('GET', '/messages/unread', undefined, acting),
    },
    notifications: {
      list: (page = 0, limit = 20, acting?: string | number) => req('GET', `/notifications?page=${page}&limit=${limit}`, undefined, acting),
      unread: (acting?: string | number) => req('GET', '/notifications/unread', undefined, acting),
      read: (id?: number, acting?: string | number) => req('POST', '/notifications/read', id ? { id } : {}, acting),
    },
    comments: {
      list: (postId: number): Promise<HilosComment[]> => req('GET', `/posts/${postId}/comments`),
      create: (postId: number, p: { content: string; parentCommentId?: number; parentExternalRef?: string; externalRef?: string; createdAt?: string }, acting?: string | number): Promise<HilosComment> => req('POST', `/posts/${postId}/comments`, p, acting),
      remove: (id: number, acting?: string | number): Promise<{ ok: boolean }> => req('DELETE', `/comments/${id}`, undefined, acting),
      like: (id: number, acting?: string | number): Promise<{ liked: boolean; likesCount: number }> => req('POST', `/comments/${id}/like`, undefined, acting),
      hide: (id: number, hidden = true): Promise<{ id: number; hidden: boolean }> => req('POST', `/comments/${id}/hide`, { hidden }),
      edit: (id: number, content: string, acting?: string | number): Promise<HilosComment> => req('PATCH', `/comments/${id}`, { content }, acting),
      byRef: (ref: string): Promise<{ id: number; content: string; postId: number }> => req('GET', `/comments/by-ref?ref=${encodeURIComponent(ref)}`),
    },
  }
}
export type HilosClient = ReturnType<typeof createHilos>
