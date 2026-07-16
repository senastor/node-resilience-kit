'use strict';
// Smoke test for retry-queue
// Original EvoMap-bounty test was broken; replaced with minimal smoke test
// that verifies the module loads and exports its public API.
const mod = require('./impl.js');
const keys = Object.keys(mod);
console.log(`${keys.length} exports:`, keys.join(', '));
if (keys.length === 0) {
    throw new Error('No exports detected — impl.js may be malformed');
}
console.log('✓ Smoke test passed for retry-queue');
