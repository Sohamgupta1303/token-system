import type { ProviderAdapter } from './types'

export const mockAdapter: ProviderAdapter = {
  modelName: 'mock',

  buildRequest(_prompt, _maxTokens) {
    return {
      url: process.env.UPSTREAM_URL!,
      init: { method: 'GET' },
    }
  },

  parseChunk(line) {
    if (!line.startsWith('data: ') || line.trim() === 'data: [DONE]') return null
    try {
      const payload = JSON.parse(line.slice(6)) as { token?: string }
      return payload.token ?? null
    } catch {
      return null
    }
  },

  isDone(line) {
    return line.trim() === 'data: [DONE]'
  },
}
