import { countTokens } from './tokens'

export type TokenCount = { input: number; output: number }

export function createMeterTransform(
  count: TokenCount,
  parseChunk: (line: string) => string | null,
  onFlush: () => Promise<void>
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()

  return new TransformStream({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true })

      for (const line of text.split('\n')) {
        const content = parseChunk(line.trim())
        if (content !== null) {
          count.output += countTokens(content)
        }
      }

      controller.enqueue(chunk)
    },

    flush() {
      return onFlush()
    },
  })
}
