const { TokenBucketRateLimiter } = require('./impl.js');

// Minimal test — verifies rate limiting logic
const limiter = new TokenBucketRateLimiter({ windowMs: 1000, maxRequests: 3 });
const mw = limiter.middleware();

let results = [];
const fakeReq = (ip) => ({ ip, connection: { remoteAddress: ip } });
const fakeRes = () => {
  const headers = {};
  let status = 200;
  let body = null;
  const obj = {
    set: (k, v) => { headers[k] = v; },
    status: (s) => { status = s; return obj; },
    json: (d) => { body = d; },
    getStatus: () => status,
    getBody: () => body,
    getHeaders: () => headers,
  };
  return obj;
};

// Should allow 3 requests, block the 4th
for (let i = 0; i < 4; i++) {
  const req = fakeReq('127.0.0.1');
  const res = fakeRes();
  mw(req, res, () => {});
  results.push({ req: i + 1, status: res.getStatus(), remaining: res.getHeaders()['X-RateLimit-Remaining'] });
}

let pass = true;
// First 3 should pass (200), 4th blocked (429)
if (results[0].status !== 200 || results[1].status !== 200 || results[2].status !== 200) {
  console.error('FAIL: first 3 requests should pass'); pass = false;
}
if (results[3].status !== 429) {
  console.error('FAIL: 4th request should be blocked with 429'); pass = false;
}
if (results[0].remaining !== '2' || results[2].remaining !== '0') {
  console.error('FAIL: remaining count incorrect', results[0].remaining, results[2].remaining); pass = false;
}

// Different IP should have its own bucket
const req2 = fakeReq('192.168.1.1');
const res2 = fakeRes();
mw(req2, res2, () => {});
if (res2.getStatus() !== 200) {
  console.error('FAIL: different IP should have own bucket'); pass = false;
}

limiter.close();
if (pass) {
  console.log('PASS: All rate limiting tests passed (3 allowed, 4th blocked, per-IP isolation)');
  process.exit(0);
} else {
  console.error('FAIL: Some tests failed');
  process.exit(1);
}
