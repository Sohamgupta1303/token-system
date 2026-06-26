import { NextRequest, NextResponse } from 'next/server'
import { authenticate } from '@/lib/auth'

export async function GET(req: NextRequest) {
  const auth = await authenticate(req.headers.get('authorization'))

  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return NextResponse.json({
    user: { id: auth.user.id, email: auth.user.email },
    pool: {
      id: auth.pool.id,
      name: auth.pool.name,
      budgetTokens: auth.pool.budgetTokens.toString(), // BigInt → string for JSON
    },
  })
}
