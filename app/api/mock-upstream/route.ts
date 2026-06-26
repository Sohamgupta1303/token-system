const FAKE_TOKENS = [
  'The', ' quick', ' brown', ' fox', ' jumps',
  ' over', ' the', ' lazy', ' dog', '.',
  ' Pack', ' my', ' box', ' with', ' five',
  ' dozen', ' liquor', ' jugs', '.',
]

const CHUNK_DELAY_MS = 100

export async function GET() {
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()

      for (const token of FAKE_TOKENS) {
        await new Promise((r) => setTimeout(r, CHUNK_DELAY_MS))
        const chunk = `data: ${JSON.stringify({ token })}\n\n`
        controller.enqueue(encoder.encode(chunk))
      }

      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}
