import type { ProviderAdapter } from './types'

// Anthropic streaming SSE format:
//   event: content_block_delta
//   data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}
//
//   event: message_stop
//   data: {"type":"message_stop"}

export const anthropicAdapter: ProviderAdapter = {
  modelName: 'claude-haiku-4-5-20251001',

  buildRequest(prompt, maxTokens) {
    return {
      url: 'https://api.anthropic.com/v1/messages',
      init: {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY!,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokens,
          stream: true,
        }),
      },
    }
  },

  parseChunk(line) {
    if (!line.startsWith('data: ')) return null
    try {
      const payload = JSON.parse(line.slice(6)) as {
        type: string
        delta?: { type: string; text?: string }
      }
      if (payload.type === 'content_block_delta' && payload.delta?.type === 'text_delta') {
        return payload.delta.text ?? null
      }
      return null
    } catch {
      return null
    }
  },

  isDone(line) {
    if (!line.startsWith('data: ')) return false
    try {
      const payload = JSON.parse(line.slice(6)) as { type: string }
      return payload.type === 'message_stop'
    } catch {
      return false
    }
  },
}
