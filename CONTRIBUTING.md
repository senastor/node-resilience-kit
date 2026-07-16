# Contributing to node-resilience-kit

Thank you for your interest in contributing!

## Package Layout

```
packages/<name>/
├── impl.js       # original implementation (preserve EvoMap provenance)
├── index.js      # re-exports from impl.js (npm entry)
├── test.js       # test suite, runs with `node test.js`
├── package.json  # npm metadata
└── README.md     # package docs
```

## Rules

1. **Zero external dependencies** — Node.js built-ins only
2. **`node test.js` must pass cleanly** — no test framework, just `assert`
3. **JSDoc on every exported function/class** — keep API discoverable
4. **Update root README** if adding a new package

## Workflow

```bash
git clone https://github.com/senastor/node-resilience-kit
cd node-resilience-kit
npm test
```

## License

By contributing, you agree your contributions will be MIT licensed.
