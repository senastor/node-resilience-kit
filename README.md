# node-resilience-kit

> Production-tested Node.js resilience utilities — crafted as EvoMap bounty deliverables and consolidated into a single monorepo.

[![Tests](https://github.com/senastor/node-resilience-kit/actions/workflows/test.yml/badge.svg)](https://github.com/senastor/node-resilience-kit/actions/workflows/test.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D14-blue.svg)](package.json)
[![Packages](https://img.shields.io/badge/packages-18-blueviolet.svg)](packages)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](package.json)

A curated collection of **18 independent npm packages** covering common reliability patterns: circuit breaking, rate limiting, retries, caching, input sanitization, JWT auth, request tracing, and more.

Every package is:
- ✅ **Zero external dependencies** — Node.js built-ins only
- ✅ **Fully tested** — `node test.js` (no test framework needed)
- ✅ **MIT licensed** — use freely in commercial projects
- ✅ **Tree-shakeable** — install only what you need

---

## Quick Start

```bash
npm install @resilience/circuit-breaker
npm install @resilience/rate-limiter
npm install @resilience/retry-backoff
```

Or use the monorepo directly:

```bash
git clone https://github.com/senastor/node-resilience-kit
cd node-resilience-kit
npm test   # runs tests across all packages
```

## Packages

### 🛡️ Resilience
| Package | Description |
|---|---|
| `@resilience/circuit-breaker` | Circuit breaker pattern for fault-tolerant service calls |
| `@resilience/retry-backoff` | Exponential backoff retry with jitter |
| `@resilience/retry-queue` | Persistent retry queue with backoff |
| `@resilience/idempotency-store` | Idempotency key store for safe retries |

### 🚦 Flow Control
| Package | Description |
|---|---|
| `@resilience/rate-limiter` | Token bucket rate limiter middleware |
| `@resilience/sliding-window-limiter` | Sliding window rate limiter |
| `@resilience/debounce-throttle` | Debounce and throttle utilities |
| `@resilience/task-queue` | Persistent task queue |

### 🔒 Security
| Package | Description |
|---|---|
| `@resilience/sql-injection` | SQL injection sanitizer |
| `@resilience/input-sanitizer` | Input sanitization helpers |
| `@resilience/jwt-auth` | JWT authentication middleware |

### ⚡ Performance
| Package | Description |
|---|---|
| `@resilience/cache-lru` | LRU cache with TTL |
| `@resilience/n1-dataloader` | N+1 query dataloader |

### 📊 Observability
| Package | Description |
|---|---|
| `@resilience/health-check` | Health check endpoint |
| `@resilience/distributed-tracing` | Distributed tracing primitives |

### ✅ Validation & Utils
| Package | Description |
|---|---|
| `@resilience/config-validator` | Config schema validator |
| `@resilience/deep-merge` | Deep object merge utility |
| `@resilience/event-emitter` | Async event emitter |

## Origin Story

These utilities were originally crafted as deliverables for [EvoMap](https://evomap.ai) network bounties — a decentralized network where AI agents contribute reusable code genes to a shared asset pool. After completing 18 bounties across two nodes, the collection is now consolidated into this monorepo for easier installation, versioning, and maintenance.

## Why monorepo?

- **One PR = update all related utilities**
- **Single source of truth** for version + license
- **Single `npm publish --workspaces`** ships all packages
- **Centralized issue tracker** for related bugs
- **Portfolio piece** — clear signal of consistency + quality

## Contributing

PRs welcome. Each package must:
1. Use only Node.js built-ins (no external dependencies)
2. Include a `test.js` with passing tests
3. Have a JSDoc comment block at the top of `impl.js`
4. Pass `node test.js` cleanly

Run all tests:
```bash
npm test
```

## Release

```bash
# Bump version across all packages
npm version patch

# Publish all to npm
npm publish --workspaces --access public
```

## License

MIT © 2026 [Sen Markchain](https://github.com/senastor)
