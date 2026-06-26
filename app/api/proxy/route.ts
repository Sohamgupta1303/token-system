import { NextRequest, NextResponse } from 'next/server'
import { authenticate } from '@/lib/auth'
import { countTokens } from '@/lib/tokens'
import { createMeterTransform, type TokenCount } from '@/lib/meter'
import { reserveTokens, reconcile } from '@/lib/pool'
import { getProvider } from '@/lib/providers'
import { prisma } from '@/lib/prisma'

const DEFAULT_MAX_OUTPUT = 500

export async function POST(req: NextRequest) {
  const auth = await authenticate(req.headers.get('authorization'))
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({})) as { prompt?: string; max_tokens?: number }
  const prompt = typeof body.prompt === 'string' ? body.prompt : ''
  const maxOutput = typeof body.max_tokens === 'number' ? body.max_tokens : DEFAULT_MAX_OUTPUT

  const provider = getProvider()
  const count: TokenCount = { input: countTokens(prompt), output: 0 }
  const estimate = count.input + maxOutput

  const remaining = await reserveTokens(auth.pool.id, estimate)
  if (remaining === -1) {
    return NextResponse.json({ error: 'budget exhausted' }, { status: 429 })
  }

  const { url, init } = provider.buildRequest(prompt, maxOutput)
  const upstream = await fetch(url, init)

  if (!upstream.ok || !upstream.body) {
    await reconcile(auth.pool.id, estimate, 0)
    return NextResponse.json({ error: 'upstream request failed' }, { status: 502 })
  }

  let settled = false
  const settle = async () => {
    if (settled) return
    settled = true
    const actual = count.input + count.output
    await reconcile(auth.pool.id, estimate, actual)
    await prisma.usageLedger.create({
      data: {
        userId: auth.user.id,
        poolId: auth.pool.id,
        model: provider.modelName,
        inputTokens: count.input,
        outputTokens: count.output,
        estimated: estimate,
      },
    })
  }

  req.signal.addEventListener('abort', () => { void settle() })

  const meter = createMeterTransform(count, provider.parseChunk.bind(provider), settle)

  return new Response(upstream.body.pipeThrough(meter), {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
