import http from 'k6/http'
import { check, sleep } from 'k6'
import { Counter } from 'k6/metrics'

const ok = new Counter('requests_ok')
const exhausted = new Counter('requests_exhausted')

export const options = {
  // All 20 VUs start at the same instant — no ramp-up.
  // This maximises the chance of hitting the reservation race condition.
  vus: 20,
  iterations: 20,
}

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000'
const API_KEY  = __ENV.API_KEY

export default function () {
  const res = http.post(
    `${BASE_URL}${__ENV.ENDPOINT}`,
    JSON.stringify({ prompt: 'hi', max_tokens: 500 }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      timeout: '30s',
    }
  )

  if (res.status === 200) ok.add(1)
  if (res.status === 429) exhausted.add(1)

  check(res, {
    'no unexpected errors': (r) => r.status === 200 || r.status === 429,
  })
}
