import { NextRequest, NextResponse } from 'next/server'
import { authenticate } from '@/lib/auth'
import { countTokens } from '@/lib/tokens'
import { createMeterTransform, type TokenCount } from '@/lib/meter'
import { reserveTokens, reconcile } from '@/lib/pool'
import { prisma } from '@/lib/prisma'

// Ceiling used when the client doesn't specify max_tokens.
// We over-reserve intentionally and reconcile down after the stream.
const DEFAULT_MAX_OUTPUT = 500

export async function POST(req: NextRequest) {
  const auth = await authenticate(req.headers.get('authorization'))
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({})) as { prompt?: string; max_tokens?: number }
  const prompt = typeof body.prompt === 'string' ? body.prompt : ''
  const maxOutput = typeof body.max_tokens === 'number' ? body.max_tokens : DEFAULT_MAX_OUTPUT

  const upstreamUrl = process.env.UPSTREAM_URL
  if (!upstreamUrl) {
    return NextResponse.json({ error: 'UPSTREAM_URL not configured' }, { status: 500 })
  }

  const count: TokenCount = { input: countTokens(prompt), output: 0 }

  // Reserve a ceiling up front — we don't know the output length yet.
  // The Lua script does the check-and-decrement atomically in Redis.
  const estimate = count.input + maxOutput
  const remaining = await reserveTokens(auth.pool.id, estimate)

  if (remaining === -1) {
    return NextResponse.json({ error: 'budget exhausted' }, { status: 429 })
  }

  const upstream = await fetch(upstreamUrl)
  if (!upstream.ok || !upstream.body) {
    // Reservation already happened — give it back before returning the error
    await reconcile(auth.pool.id, estimate, 0)
    return NextResponse.json({ error: 'upstream request failed' }, { status: 502 })
  }

  let settled = false
  const settle = async () => {
    if (settled) return
    settled = true
    const actual = count.input + count.output
    // Release unused portion of reservation back to the pool
    await reconcile(auth.pool.id, estimate, actual)
    // Write the durable usage record
    await prisma.usageLedger.create({
      data: {
        userId: auth.user.id,
        poolId: auth.pool.id,
        model: 'mock',
        inputTokens: count.input,
        outputTokens: count.output,
        estimated: estimate,
      },
    })
  }

  // Client disconnects mid-stream: flush() won't fire, so we settle here.
  req.signal.addEventListener('abort', () => { void settle() })

  const meter = createMeterTransform(count, settle)

  return new Response(upstream.body.pipeThrough(meter), {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
