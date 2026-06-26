import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { syncPoolToRedis } from '@/lib/pool'

// Recomputes every pool's Redis counter from the Postgres ledger.
// Call this on cold start, after a Redis restart, or on a cron schedule.
export async function POST() {
  const pools = await prisma.pool.findMany()

  const results = await Promise.all(
    pools.map(async (pool) => {
      const remaining = await syncPoolToRedis(pool.id)
      return { poolId: pool.id, name: pool.name, remaining }
    })
  )

  return NextResponse.json({ synced: results })
}
