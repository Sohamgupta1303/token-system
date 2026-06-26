#!/usr/bin/env bash
set -e

BUDGET=1500          # tokens — allows exactly 2 requests (floor(1500/501) = 2)
POOL_KEY="pool:seed-pool-1:remaining"
API_KEY="${1:?Usage: ./load-test/run.sh <api_key>}"

reset_budget() {
  docker exec token-system-redis-1 redis-cli SET "$POOL_KEY" "$BUDGET" > /dev/null
  echo "  Redis budget reset to $BUDGET"
}

check_redis() {
  local val
  val=$(docker exec token-system-redis-1 redis-cli GET "$POOL_KEY")
  echo "  Redis counter after test: $val"
  if [ "$val" -lt 0 ]; then
    echo "  ❌  BUDGET WENT NEGATIVE — race condition confirmed"
  else
    echo "  ✅  Budget held — atomic enforcement confirmed"
  fi
}

echo ""
echo "========================================"
echo "  NAIVE (non-atomic) — expect overspend"
echo "========================================"
reset_budget
k6 run \
  -e API_KEY="$API_KEY" \
  -e ENDPOINT="/api/proxy-naive" \
  --quiet \
  load-test/budget.js
sleep 2  # let in-flight reconciliations settle before reading Redis
check_redis

echo ""
echo "========================================"
echo "  ATOMIC (Lua script) — expect holds"
echo "========================================"
reset_budget
k6 run \
  -e API_KEY="$API_KEY" \
  -e ENDPOINT="/api/proxy" \
  --quiet \
  load-test/budget.js
sleep 2
check_redis

echo ""
