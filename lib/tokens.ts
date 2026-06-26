import { encodingForModel } from 'js-tiktoken'

// Initialized once at module load — creating it per-request is expensive
const enc = encodingForModel('gpt-4')

export function countTokens(text: string): number {
  return enc.encode(text).length
}
