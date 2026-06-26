import 'dotenv/config'
import { PrismaClient } from '../app/generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import Redis from 'ioredis'
import { POOL_KEY } from '../lib/pool'

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! })
const prisma = new PrismaClient({ adapter })
const redis = new Redis(process.env.REDIS_URL!)

async function main() {
  const pool = await prisma.pool.upsert({
    where: { id: 'seed-pool-1' },
    update: {},
    create: {
      id: 'seed-pool-1',
      name: 'Dev Pool',
      budgetTokens: BigInt(1_000_000),
    },
  })

  const user = await prisma.user.upsert({
    where: { email: 'dev@example.com' },
    update: {},
    create: {
      email: 'dev@example.com',
      poolId: pool.id,
    },
  })

  // Initialize the Redis budget counter from the Postgres budget value
  await redis.set(POOL_KEY(pool.id), Number(pool.budgetTokens))
  const remaining = await redis.get(POOL_KEY(pool.id))

  console.log('Seeded pool    :', pool.id, '|', pool.name)
  console.log('Seeded user    :', user.id, '|', user.email)
  console.log('Redis counter  :', POOL_KEY(pool.id), '=', remaining)
  console.log('\nUse this userId when calling POST /api/keys:')
  console.log(user.id)
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect()
    await redis.quit()
  })
