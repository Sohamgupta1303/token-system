import { NextRequest, NextResponse } from 'next/server'
import { randomBytes, createHash } from 'crypto'
import { prisma } from '@/lib/prisma'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const userId: string | undefined = body?.userId
  const label: string | undefined = body?.label

  if (!userId) {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 })
  }

  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) {
    return NextResponse.json({ error: 'user not found' }, { status: 404 })
  }

  // Generate a random key — returned once, never stored
  const rawKey = 'gw_sk_' + randomBytes(32).toString('hex')
  const keyHash = createHash('sha256').update(rawKey).digest('hex')

  await prisma.apiKey.create({
    data: { keyHash, label: label ?? null, userId },
  })

  return NextResponse.json({ key: rawKey }, { status: 201 })
}
