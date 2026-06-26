# Token Gateway — Implementation Spec

> A spec-kit style guide for building an authenticated, metered, budget-enforcing LLM proxy. This document is written to be handed to Claude Code as the source of truth for the project. Work through it phase by phase. **Do not skip ahead.** Each phase must run and be testable before the next one begins.

---

## 0. What we are building and why

We are building a **gateway that sits in front of one or more LLM providers**. A client sends a request to *our* endpoint using a key *we* issued; we authenticate it, check it against a shared token budget, forward it to the real provider, stream the response back, and count the tokens as they flow through. Think of a lightweight, self-hosted slice of what OpenRouter, Helicone, or LiteLLM do.

**What this project is NOT:** it is not a CRUD app, and it is not "systems programming" in the low-level sense (no manual memory management, no syscalls, no kernel work). It is a **non-trivial backend / distributed-systems-concerns** project. The interesting engineering lives in four places:

1. **Streaming proxying** — forwarding a Server-Sent-Events (SSE) response chunk by chunk without buffering the whole thing, while simultaneously reading those chunks to count tokens.
2. **Atomic budget reservation under concurrency** — many requests can hit a shared pool at the same instant; a naive check-then-decrement double-spends. This is the centerpiece.
3. **Cache/durable-store consistency** — a fast in-memory counter (Redis) gates the hot path; a durable ledger (Postgres) is the source of truth. Keeping them coherent is real work.
4. **Partial failure handling** — what happens when a client disconnects mid-stream, or the pool runs dry mid-generation.

Keep these four problems in mind throughout. They are the reason this project is worth building, and they are the stories the author will tell in interviews. Every design decision should serve correctness on these four axes.

**A critical, deliberate constraint:** reselling provider API access violates provider terms of service. This project must be framed and built as **internal budget-pooling and metering infrastructure** (one org/account sharing a budget across members), NOT a marketplace for reselling tokens between strangers. Do not build resale, peer-to-peer token sales, or anything that brokers one user's provider quota to another unrelated user. The pool is a shared internal budget.

---

## 1. Tech stack (and why each piece is here)

| Layer | Technology | Why it's necessary |
|---|---|---|
| App framework | **Next.js (App Router)** | Route handlers give us a clean place for the API; one codebase serves both the proxy and the dashboard later. The author already knows it. |
| Language | **TypeScript** | Type safety across the whole stack. The only non-TS code is a ~15-line Lua script that runs inside Redis. |
| Durable store | **Postgres** | Source of truth: users, keys, pools, and the settled usage ledger. Transactional and durable — this is what survives a crash. |
| ORM / migrations | **Prisma** | Declarative schema, type-safe queries, painless migrations. Keeps the DB schema in version control. |
| Fast counter / gate | **Redis** | The hot-path budget check must be atomic and sub-millisecond. Redis gives us atomic ops and a place to run a Lua script that does check-and-decrement indivisibly. Postgres is too slow and contended for per-request gating. |
| Atomicity primitive | **Redis Lua script** | A Lua script executes atomically inside Redis — no other command runs during it. This is how we make "check budget, then decrement" a single indivisible operation, which is the whole solution to the race condition. |
| Token counting | **tiktoken** (`@dqbd/tiktoken` or `js-tiktoken`) | Estimates token counts client-side for the reservation. Once a real provider is wired in, prefer the provider's reported `usage` for the final settled count. |
| Streaming | **Web Streams API** (`ReadableStream`, `TransformStream`) | Built into the Next.js runtime. Lets us pipe upstream chunks to the client while tapping them to count tokens, without buffering the full response. |
| Load testing | **k6** (preferred) or a Node script using `Promise.all` | Proves the concurrency handling actually works by hammering a near-empty pool with simultaneous requests and asserting the budget never goes negative. |
| Dashboard charts | **React + Recharts** | Visualizes per-user and per-pool usage over time. React is already in Next.js. |
| Local infra | **Docker / docker-compose** | Runs Postgres and Redis reproducibly so the project works on any machine. |

**Why two data stores instead of one?** This is the single most important architectural decision and the author should be able to defend it. Redis is the **bouncer** counting heads at the door in real time — fast, atomic, in-memory, but volatile. Postgres is the **accounting books** that get squared up — durable, transactional, the thing you rebuild Redis from if it falls over. Using only Postgres would put a slow, lock-contended DB on the per-request hot path. Using only Redis would risk losing the durable financial record on a restart. Each store does the half it's good at.

---

## 2. The request path (reference)

Every request flows through this path. Each layer adds exactly one responsibility.

```
Client (our issued key)
  → Auth + identity      (resolve user + pool from the key)
  → Routing policy       (pick which model/provider)
  → Pool reservation     (atomic budget check + decrement an ESTIMATE)   ← the hard part
  → Streaming proxy      (pipe SSE chunks back, parse them to tally tokens)
  → Provider adapter     (normalize across OpenAI / Anthropic / mock)
  → Upstream LLM         (real provider, or the mock during early phases)
  ← stream flows back to client, tokens tallied as chunks pass
  → on stream close: reconcile (release estimate − actual back to pool), write ledger
```

Redis holds the live counters and does the atomic gate. Postgres holds keys, the ledger, and settled usage. The token tally is written back as the stream completes.

---

## 3. Phase-by-phase implementation

> **Rule for every phase:** end the phase with something that *runs* and a concrete way to *test* it. If you can't test it, the phase isn't done.

### Phase 0 — Scaffold + schema

**Goal:** a running Next.js app, Postgres + Redis up in Docker, and the four core tables defined and migrated. Nothing is wired together yet.

**Stack:** Next.js (App Router), Postgres, Prisma, Docker, Redis (container only for now).

**Steps:**
1. `create-next-app` with TypeScript and the App Router.
2. `docker-compose.yml` with a Postgres service and a Redis service. Expose standard ports, set env vars.
3. Install and init Prisma. Point `DATABASE_URL` at the Docker Postgres.
4. Define the schema (see section 4 for the exact models): `User`, `ApiKey`, `Pool`, `UsageLedger`.
5. Run the first migration. Confirm tables exist.

**Why it matters:** you cannot build auth on tables that don't exist, and you cannot reproduce the project on another machine without containerized infra. This phase is deliberately short — resist the urge to add anything clever here.

**Done when:** `docker-compose up` brings up both stores, `prisma migrate` succeeds, and you can see the four tables in the DB.

---

### Phase 1 — Keys + auth

**Goal:** issue API keys and authenticate incoming requests against them.

**Stack:** Next.js route handlers, Postgres (via Prisma), a hashing function (Node's `crypto`).

**Steps:**
1. A route (e.g. `POST /api/keys`) that generates a random key, stores **only its hash** in `ApiKey`, and returns the raw key **once** (never store or log the raw key).
2. An auth helper / middleware that reads the `Authorization: Bearer <key>` header, hashes the presented key, looks up the hash, and resolves the owning `User` and their `Pool`. Reject with 401 if no match.
3. A trivial protected test route that just echoes back the resolved user/pool, to prove auth works.

**Why it matters:** every downstream layer assumes "I know which user and which pool this request belongs to." Storing only the hash (not the raw key) is the standard security practice — if the DB leaks, the keys aren't usable. This mirrors how real API providers handle keys.

**Done when:** `curl` with a valid key returns the user/pool; `curl` with a bad key returns 401.

---

### Phase 2 — Streaming proxy against a mock upstream

**Goal:** the heart of the project. Pipe a streaming SSE response from a fake upstream through our proxy to the client, without buffering.

**Stack:** Web Streams API (`ReadableStream` / `TransformStream`), SSE, a mock upstream route.

**Steps:**
1. Build a **mock upstream**: a route that emits fake SSE chunks on a timer (e.g. one small JSON chunk every 50ms for a couple seconds, then a `[DONE]` sentinel). This imitates a provider's token-by-token stream.
2. Build the **proxy route**: it's authenticated (Phase 1), it calls the mock upstream, and it pipes the upstream's `ReadableStream` straight to the client response. Set the right SSE headers (`Content-Type: text/event-stream`, no buffering).
3. Verify the client receives chunks **as they're produced**, not all at once at the end.

**Why build a mock first?** It lets you nail the genuinely fiddly streaming mechanics — backpressure, headers, the response lifecycle — without spending money on a real API or fighting its quirks. Once the mock streams correctly through the proxy, swapping in a real provider later is a small, localized change (Phase 6). Build the hard plumbing against something free and deterministic.

**Why streaming (not buffering)?** Buffering the whole response before forwarding would destroy the user-perceived latency that streaming exists to provide, and would force you to hold large responses in memory. The skill is forwarding chunks while they're still arriving.

**Done when:** you `curl` the proxy endpoint and watch fake tokens arrive incrementally over a couple seconds.

---

### Phase 3 — Token metering

**Goal:** count tokens as the stream flows through, and write the total to the durable ledger when the stream closes.

**Stack:** `tiktoken` for counting, a `TransformStream` in the middle of the pipe, Postgres for the ledger write.

**Steps:**
1. Insert a `TransformStream` between upstream and client. It forwards each chunk **unchanged** while also parsing the chunk's content and incrementing a running token counter. (Count the input prompt tokens up front; count output tokens as they stream.)
2. Handle the stream's **close** event: when `[DONE]` arrives or the stream ends, write a row to `UsageLedger` (user, pool, model, input tokens, output tokens, timestamp).
3. Handle **early client disconnect**: if the client hangs up mid-stream, detect it (the response's abort signal), stop cleanly, and **still record the tokens consumed so far** — the provider already generated them, so they must be accounted for. Do not leak the upstream connection.

**Why it matters:** metering is the whole point of a gateway — you can't enforce a budget you can't measure. The subtle engineering is counting **without buffering** (the `TransformStream` taps the flow, it doesn't collect it) and **handling partial consumption** (a disconnect still costs tokens). The author should be ready to explain the disconnect case — it's a favorite interview probe.

**Done when:** after a streamed request, a correct `UsageLedger` row appears; killing the client mid-stream still records a partial, sensible count.

---

### Phase 4 — Pool + concurrency (the centerpiece)

**Goal:** enforce a shared token budget that is correct even when many requests hit it simultaneously.

**Stack:** Redis, a Redis **Lua script**, a reconciliation step, a background flush job.

**The problem (state it clearly):** a pool has, say, 100k tokens for the month, shared across five people. Two requests arrive at the same instant when 1k remains. The naive flow — *read remaining → check it's enough → forward → subtract what got used* — is a classic race: both read 1k, both think there's room, both forward, the pool overspends. Same shape as overselling concert tickets.

**The solution — reserve-then-reconcile:**
1. **Reserve up front, atomically.** You don't know the output length before generation, so you reserve a **conservative estimate** (a ceiling — e.g. input tokens + `max_tokens`). A **Lua script** in Redis reads the remaining budget, checks the estimate fits, and decrements — all as **one indivisible operation**. If the decrement would go negative, reject *before* forwarding to the provider. Because Lua runs atomically inside Redis, the two-simultaneous-requests race cannot happen: the second request sees the first's decrement.
2. **Forward** through the Phase 2/3 proxy, metering as usual.
3. **Reconcile on close.** When the stream finishes and you know the **actual** token count, release the difference (`estimate − actual`) back into the Redis counter. You over-reserved on purpose; now you give back the slack.
4. **Flush to Postgres.** A background job periodically writes the Redis counter state and the per-request actuals into the Postgres ledger — the durable record. Redis is the fast working copy; Postgres is the books.

**The Lua script is ~15 lines** and is the conceptual core. The reasoning around it (you can't transact on a number you don't know yet, so you reserve a ceiling and reconcile down) is the thing that makes this a real engineering story rather than a CRUD app.

**A decision to make explicitly (and document in the code):** what happens when the pool runs dry **mid-generation** — you reserved an estimate, the stream is flowing, and another request just drained the last of the budget?
- **Option A (lenient):** let in-flight requests finish. Simplest; can slightly overspend the pool because you already committed the reservation.
- **Option B (strict):** hard-cut the stream when the reservation is exhausted. Stricter budget adherence, worse UX, more complex.
There is no universally correct answer. **Pick one, implement it, and be able to defend it.** Interviewers dig here. (Recommendation: start with Option A — it's simpler and the reservation already bounds the overspend.)

**Why Redis for the gate and Postgres for the truth?** Putting the per-request atomic check on Postgres would mean row locks on the hot path under concurrency — slow and contended. Putting the durable financial record only in Redis would risk losing it on a restart. Redis gates; Postgres persists; the flush job bridges them.

**Done when:** single requests correctly decrement and reconcile the pool, and the ledger reflects settled usage. (Proving the *concurrent* case is Phase 5.)

---

### Phase 5 — Load test (the proof)

**Goal:** prove the concurrency handling is correct, not just claim it.

**Stack:** k6 (preferred — it's a real, resume-legible tool) or a Node script using `Promise.all` over many `fetch` calls.

**Steps:**
1. Set a pool to a small budget (enough for a handful of requests).
2. Fire **dozens of simultaneous requests** at it.
3. **Assert the pool never goes negative** and that the number of *accepted* requests matches what the budget allows — no more, no fewer.
4. **Do the before/after:** first run this against a deliberately *naive* (non-atomic) version and **watch it overspend**. Then run it against the Lua-script version and **watch it hold.** Screen-record this contrast — it's the most compelling 20 seconds of the demo.

**Why it matters:** this is what converts "I handle concurrency" into demonstrated fact. The before/after is the single best artifact for proving the engineering is real. Without this phase, the concurrency claim is just words.

**Done when:** the load test reliably shows the naive version breaking and the atomic version holding, repeatably.

---

### Phase 6 — Dashboard + one real provider

**Goal:** make it demo-able and make it legit.

**Stack:** React + Recharts (in the existing Next.js app), one real provider API.

**Steps:**
1. A dashboard page showing per-user and per-pool token usage over time, reading from the Postgres ledger. Recharts line/bar charts.
2. **Swap the mock upstream for one real provider** via the provider-adapter seam built in Phase 2. The adapter normalizes the provider's SSE format and `usage` reporting; everything downstream (metering, pooling) is unchanged. Prefer the provider's reported `usage` for the final settled count.
3. Deploy it so there's a live URL where someone can hit a real endpoint and watch the dashboard tick up.

**Why it's last:** it's polish on a system that already works. The proxy, metering, and pooling are all validated by now; this phase makes the value *visible* and the demo *real*. A deployed, hittable demo with a live dashboard is worth disproportionate credit when a project is being evaluated.

**Done when:** a real request through the gateway streams back correctly, is metered against a real budget, and shows up on a live dashboard at a public URL.

---

## 4. Concrete schema (Prisma — starting point)

Use this as the Phase 0 starting point. Adjust types/relations as needed, but keep the four entities and their relationships.

```prisma
model User {
  id        String       @id @default(uuid())
  email     String       @unique
  createdAt DateTime     @default(now())
  poolId    String
  pool      Pool         @relation(fields: [poolId], references: [id])
  apiKeys   ApiKey[]
  ledger    UsageLedger[]
}

model ApiKey {
  id        String   @id @default(uuid())
  keyHash   String   @unique          // store ONLY the hash, never the raw key
  label     String?
  createdAt DateTime @default(now())
  revokedAt DateTime?
  userId    String
  user      User     @relation(fields: [userId], references: [id])
}

model Pool {
  id            String        @id @default(uuid())
  name          String
  budgetTokens  BigInt                            // total budget for the period
  periodStart   DateTime      @default(now())
  users         User[]
  ledger        UsageLedger[]
  // Live remaining budget is tracked in Redis (key e.g. pool:{id}:remaining)
  // and flushed/reconciled into Postgres by the background job.
}

model UsageLedger {
  id           String   @id @default(uuid())
  userId       String
  user         User     @relation(fields: [userId], references: [id])
  poolId       String
  pool         Pool     @relation(fields: [poolId], references: [id])
  model        String
  inputTokens  Int
  outputTokens Int
  estimated    Int                       // what we reserved up front
  createdAt    DateTime @default(now())
  @@index([poolId, createdAt])
  @@index([userId, createdAt])
}
```

---

## 5. The Lua reservation script (conceptual shape)

Not final code — the structure Claude Code should implement in Phase 4. It must run as a single `EVAL` so it executes atomically.

```
-- KEYS[1] = pool remaining-budget key  (e.g. "pool:{id}:remaining")
-- ARGV[1] = estimate (tokens to reserve)
-- returns: new remaining if reserved, or -1 if insufficient

local remaining = tonumber(redis.call('GET', KEYS[1]))
local estimate  = tonumber(ARGV[1])
if remaining == nil then return redis.error_reply('pool not initialized') end
if remaining < estimate then
  return -1                      -- reject: not enough budget
end
return redis.call('DECRBY', KEYS[1], estimate)   -- reserve atomically
```

Reconciliation (after the stream closes and actual tokens are known) is a separate, simpler call:
```
INCRBY pool:{id}:remaining (estimate - actual)   -- release the unused slack
```

The atomicity guarantee comes from Redis running the whole Lua script with no other command interleaved. That is the entire fix for the race condition — everything else is bookkeeping around it.

---

## 6. Build order summary (matches the flowchart)

0. Scaffold + schema — Next.js, Postgres, Prisma, Docker
1. Keys + auth — route handlers, hashed keys, Postgres
2. Streaming proxy + mock — Web Streams, SSE, fake upstream
3. Token metering — tiktoken, parse chunks, ledger write
4. Pool + concurrency — Redis, Lua script, reconcile job  ← centerpiece
5. Load test — k6 or Promise.all, assert no overspend  ← the proof
6. Dashboard + real provider — React, Recharts, one live API

Phases 0–3 are the spine; they're concrete and low-risk. Phase 4 has the conceptual teeth. Phases 5–6 are what turn it from a class project into a portfolio piece. Even stopping at Phase 4 yields two genuine engineering stories (streaming proxy + atomic reservation).

---

## 7. Guardrails for the implementing agent

- **Never store or log raw API keys.** Hash on receipt, store the hash.
- **Never put the provider's real API key on the client** — it lives only server-side.
- **Build against the mock upstream until Phase 6.** Don't burn money or add real-API flakiness to early phases.
- **Don't buffer streams.** Tap them with a `TransformStream`; never collect the full response before forwarding.
- **Reserve a ceiling, reconcile down.** Never try to decrement the exact count up front — you don't know it yet.
- **The atomic gate is non-negotiable.** Every budget check-and-decrement goes through the Lua script. No read-then-write in application code.
- **Each phase must run and be testable before moving on.** No big-bang integration at the end.
- **Frame as internal budget-pooling, not token resale.** Keep the project on the right side of provider terms of service.
- When a design decision has no single right answer (e.g. the mid-generation drain case), **make a deliberate choice and leave a comment explaining the tradeoff.**

---

*End of spec. Start at Phase 0. Confirm each phase runs before advancing.*
