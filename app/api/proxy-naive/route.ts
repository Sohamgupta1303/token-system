import { NextRequest, NextResponse } from 'next/server'
import { authenticate } from '@/lib/auth'
import { countTokens } from '@/lib/tokens'
import { createMeterTransform, type TokenCount } from '@/lib/meter'
import { POOL_KEY, reconcile } from '@/lib/pool'
import { redis } from '@/lib/redis'
import { prisma } from '@/lib/prisma'

// DELIBERATELY NON-ATOMIC — for load test comparison only.
// The GET and DECRBY are two separate Redis commands.
// Under concurrency, many requests can read the budget before any of them
// decrement it, causing all of them to pass the check and overspend the pool.
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
  const estimate = count.input + maxOutput
  const key = POOL_KEY(auth.pool.id)

  // ⚠️  RACE CONDITION: two separate Redis commands.
  // Another request can slip in between the GET and the DECRBY.
  const remaining = parseInt((await redis.get(key)) ?? '0', 10)
  if (remaining < estimate) {
    return NextResponse.json({ error: 'budget exhausted' }, { status: 429 })
  }
  await redis.decrby(key, estimate) // ← the window between here and the GET above is the bug

  const upstream = await fetch(upstreamUrl)
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
        model: 'mock-naive',
        inputTokens: count.input,
        outputTokens: count.output,
        estimated: estimate,
      },
    })
  }

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
