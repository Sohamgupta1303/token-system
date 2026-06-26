import { mockAdapter } from './mock'
import { anthropicAdapter } from './anthropic'
import type { ProviderAdapter } from './types'

export function getProvider(): ProviderAdapter {
  const provider = process.env.PROVIDER ?? 'mock'
  switch (provider) {
    case 'anthropic': return anthropicAdapter
    case 'mock':      return mockAdapter
    default:
      throw new Error(`Unknown provider: "${provider}". Set PROVIDER=mock or PROVIDER=anthropic.`)
  }
}

export type { ProviderAdapter }
