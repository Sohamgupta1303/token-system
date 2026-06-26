import { NextRequest, NextResponse } from 'next/server'
import { authenticate } from '@/lib/auth'
import { countTokens } from '@/lib/tokens'
import { createMeterTransform, type TokenCount } from '@/lib/meter'
import { prisma } from '@/lib/prisma'

export async function POST(req: NextRequest) {
  const auth = await authenticate(req.headers.get('authorization'))
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({})) as { prompt?: string }
  const prompt = typeof body.prompt === 'string' ? body.prompt : ''

  const upstreamUrl = process.env.UPSTREAM_URL
  if (!upstreamUrl) {
    return NextResponse.json({ error: 'UPSTREAM_URL not configured' }, { status: 500 })
  }

  const upstream = await fetch(upstreamUrl)
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: 'upstream request failed' }, { status: 502 })
  }

  const count: TokenCount = { input: countTokens(prompt), output: 0 }

  // Guard so we never write the ledger twice (normal close + abort can both fire)
  let ledgerWritten = false
  const writeLedger = async () => {
    if (ledgerWritten) return
    ledgerWritten = true
    await prisma.usageLedger.create({
      data: {
        userId: auth.user.id,
        poolId: auth.pool.id,
        model: 'mock',
        inputTokens: count.input,
        outputTokens: count.output,
        estimated: count.input + count.output,
      },
    })
  }

  // Client disconnects mid-stream: flush() won't fire, so we handle it here.
  // The provider already generated those tokens, so we still record them.
  req.signal.addEventListener('abort', () => { void writeLedger() })

  // upstream → meter (counts tokens, passes chunks through) → client
  const meter = createMeterTransform(count, writeLedger)

  return new Response(upstream.body.pipeThrough(meter), {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
