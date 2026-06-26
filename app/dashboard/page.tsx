import { prisma } from '@/lib/prisma'
import { redis } from '@/lib/redis'
import { POOL_KEY } from '@/lib/pool'
import { UsageLineChart, UserBarChart } from './charts'
import type { DailyUsage, UserUsage } from './charts'

export const dynamic = 'force-dynamic'

async function getData() {
  const [pools, ledger] = await Promise.all([
    prisma.pool.findMany({ include: { users: true } }),
    prisma.usageLedger.findMany({
      include: { user: true, pool: true },
      orderBy: { createdAt: 'asc' },
    }),
  ])

  // Pool remaining budgets from Redis
  const poolsWithRemaining = await Promise.all(
    pools.map(async (pool) => {
      const rem = await redis.get(POOL_KEY(pool.id))
      return {
        ...pool,
        remaining: rem ? parseInt(rem, 10) : 0,
        budgetTokens: Number(pool.budgetTokens),
      }
    })
  )

  // Daily usage — group ledger entries by date
  const dailyMap = new Map<string, number>()
  for (const row of ledger) {
    const date = row.createdAt.toISOString().slice(0, 10)
    dailyMap.set(date, (dailyMap.get(date) ?? 0) + row.inputTokens + row.outputTokens)
  }
  const dailyUsage: DailyUsage[] = Array.from(dailyMap.entries())
    .map(([date, tokens]) => ({ date, tokens }))
    .sort((a, b) => a.date.localeCompare(b.date))

  // Per-user usage
  const userMap = new Map<string, { email: string; tokens: number }>()
  for (const row of ledger) {
    const prev = userMap.get(row.userId)
    userMap.set(row.userId, {
      email: row.user.email,
      tokens: (prev?.tokens ?? 0) + row.inputTokens + row.outputTokens,
    })
  }
  const userUsage: UserUsage[] = Array.from(userMap.values())
    .sort((a, b) => b.tokens - a.tokens)

  // Recent requests
  const recent = ledger.slice(-10).reverse().map((r) => ({
    id: r.id,
    user: r.user.email,
    pool: r.pool.name,
    model: r.model,
    input: r.inputTokens,
    output: r.outputTokens,
    total: r.inputTokens + r.outputTokens,
    at: r.createdAt.toISOString().replace('T', ' ').slice(0, 19),
  }))

  return { poolsWithRemaining, dailyUsage, userUsage, recent }
}

export default async function DashboardPage() {
  const { poolsWithRemaining, dailyUsage, userUsage, recent } = await getData()

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-8 font-sans">
      <h1 className="text-2xl font-bold mb-1">Token Gateway</h1>
      <p className="text-slate-400 text-sm mb-8">Usage dashboard</p>

      {/* Pool budget cards */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-10">
        {poolsWithRemaining.map((pool) => {
          const pct = Math.max(0, Math.round((pool.remaining / pool.budgetTokens) * 100))
          return (
            <div key={pool.id} className="bg-slate-900 rounded-xl p-5 border border-slate-800">
              <p className="text-slate-400 text-xs uppercase tracking-widest mb-1">Pool</p>
              <p className="font-semibold text-lg mb-3">{pool.name}</p>
              <div className="w-full bg-slate-800 rounded-full h-2 mb-2">
                <div
                  className="bg-sky-400 h-2 rounded-full transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <p className="text-slate-400 text-xs">
                {pool.remaining.toLocaleString()} / {pool.budgetTokens.toLocaleString()} tokens remaining ({pct}%)
              </p>
              <p className="text-slate-500 text-xs mt-1">{pool.users.length} user{pool.users.length !== 1 ? 's' : ''}</p>
            </div>
          )
        })}
      </section>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-10">
        <div className="bg-slate-900 rounded-xl p-5 border border-slate-800">
          <p className="font-semibold mb-4">Tokens used over time</p>
          {dailyUsage.length > 0
            ? <UsageLineChart data={dailyUsage} />
            : <p className="text-slate-500 text-sm">No data yet</p>}
        </div>
        <div className="bg-slate-900 rounded-xl p-5 border border-slate-800">
          <p className="font-semibold mb-4">Tokens by user</p>
          {userUsage.length > 0
            ? <UserBarChart data={userUsage} />
            : <p className="text-slate-500 text-sm">No data yet</p>}
        </div>
      </div>

      {/* Recent requests table */}
      <div className="bg-slate-900 rounded-xl p-5 border border-slate-800">
        <p className="font-semibold mb-4">Recent requests</p>
        {recent.length === 0
          ? <p className="text-slate-500 text-sm">No requests yet</p>
          : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-slate-400 text-xs uppercase border-b border-slate-800">
                  <th className="text-left py-2 pr-4">Time</th>
                  <th className="text-left py-2 pr-4">User</th>
                  <th className="text-left py-2 pr-4">Pool</th>
                  <th className="text-left py-2 pr-4">Model</th>
                  <th className="text-right py-2 pr-4">In</th>
                  <th className="text-right py-2 pr-4">Out</th>
                  <th className="text-right py-2">Total</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                    <td className="py-2 pr-4 text-slate-400 font-mono text-xs">{r.at}</td>
                    <td className="py-2 pr-4">{r.user}</td>
                    <td className="py-2 pr-4 text-slate-400">{r.pool}</td>
                    <td className="py-2 pr-4 text-slate-400">{r.model}</td>
                    <td className="py-2 pr-4 text-right text-slate-300">{r.input}</td>
                    <td className="py-2 pr-4 text-right text-slate-300">{r.output}</td>
                    <td className="py-2 text-right font-medium">{r.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  )
}
