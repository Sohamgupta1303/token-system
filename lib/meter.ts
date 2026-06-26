import { countTokens } from './tokens'

export type TokenCount = { input: number; output: number }

// Creates a TransformStream that sits in the pipe between upstream and client.
// Every chunk passes through unchanged, but we parse it to tally output tokens.
// When the stream closes normally, onFlush is called with the final counts.
// The caller is responsible for also calling writeLedger on client disconnect
// (via req.signal) since flush() does not fire on abort.
export function createMeterTransform(
  count: TokenCount,
  onFlush: () => Promise<void>
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()

  return new TransformStream({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true })

      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data: ') || trimmed === 'data: [DONE]') continue
        try {
          const payload = JSON.parse(trimmed.slice(6)) as { token?: string }
          if (typeof payload.token === 'string') {
            count.output += countTokens(payload.token)
          }
        } catch {
          // malformed chunk — skip, don't drop the chunk
        }
      }

      controller.enqueue(chunk)
    },

    flush() {
      return onFlush()
    },
  })
}
