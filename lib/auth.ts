import { createHash } from 'crypto'
import { prisma } from './prisma'
import type { User, Pool } from '../app/generated/prisma/client'

export type AuthContext = {
  user: User
  pool: Pool
}

export async function authenticate(authHeader: string | null): Promise<AuthContext | null> {
  if (!authHeader?.startsWith('Bearer ')) return null

  const rawKey = authHeader.slice(7)
  const keyHash = createHash('sha256').update(rawKey).digest('hex')

  const apiKey = await prisma.apiKey.findUnique({
    where: { keyHash },
    include: {
      user: {
        include: { pool: true },
      },
    },
  })

  if (!apiKey || apiKey.revokedAt !== null) return null

  return {
    user: apiKey.user,
    pool: apiKey.user.pool,
  }
}
