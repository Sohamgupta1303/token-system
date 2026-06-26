import { redis } from './redis'
import { prisma } from './prisma'

export const POOL_KEY = (poolId: string) => `pool:${poolId}:remaining`

// The atomic gate. Runs as a single indivisible operation inside Redis —
// no other command can execute between the GET and the DECRBY.
// Returns the new remaining value, or -1 if the pool has insufficient budget.
const RESERVE_SCRIPT = `
local remaining = tonumber(redis.call('GET', KEYS[1]))
local estimate  = tonumber(ARGV[1])
if remaining == nil then return redis.error_reply('pool not initialized') end
if remaining < estimate then return -1 end
return redis.call('DECRBY', KEYS[1], estimate)
`

// Sets the Redis counter from Postgres — used on first init and cold-start recovery.
export async function syncPoolToRedis(poolId: string): Promise<number> {
  const pool = await prisma.pool.findUniqueOrThrow({ where: { id: poolId } })

  const agg = await prisma.usageLedger.aggregate({
    where: { poolId },
    _sum: { inputTokens: true, outputTokens: true },
  })

  const used = (agg._sum.inputTokens ?? 0) + (agg._sum.outputTokens ?? 0)
  const remaining = Number(pool.budgetTokens) - used

  await redis.set(POOL_KEY(poolId), remaining)
  return remaining
}

// Atomically check-and-decrement the estimate.
// On 'pool not initialized' error, auto-recovers by syncing from Postgres then retrying once.
export async function reserveTokens(poolId: string, estimate: number): Promise<number> {
  try {
    const result = await redis.eval(RESERVE_SCRIPT, 1, POOL_KEY(poolId), String(estimate))
    return result as number
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('pool not initialized')) {
      await syncPoolToRedis(poolId)
      const result = await redis.eval(RESERVE_SCRIPT, 1, POOL_KEY(poolId), String(estimate))
      return result as number
    }
    throw err
  }
}

// Called after the stream closes and actual token count is known.
// Releases the unused portion of the reservation back to the pool.
export async function reconcile(poolId: string, estimate: number, actual: number) {
  const slack = estimate - actual
  if (slack > 0) {
    await redis.incrby(POOL_KEY(poolId), slack)
  }
}
