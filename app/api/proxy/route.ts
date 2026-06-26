import { NextRequest, NextResponse } from 'next/server'
import { authenticate } from '@/lib/auth'

export async function POST(req: NextRequest) {
  const auth = await authenticate(req.headers.get('authorization'))
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const upstreamUrl = process.env.UPSTREAM_URL
  if (!upstreamUrl) {
    return NextResponse.json({ error: 'UPSTREAM_URL not configured' }, { status: 500 })
  }

  const upstream = await fetch(upstreamUrl)
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: 'upstream request failed' }, { status: 502 })
  }

  // Pipe the upstream stream straight to the client — no buffering.
  // Phase 3 will insert a TransformStream here to count tokens mid-flight.
  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
