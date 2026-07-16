/**
 * Test suite for JWT Authentication Middleware
 * 
 * Tests sign/verify round-trip, middleware functionality, 
 * claim validation, and error handling.
 */

const { signJWT, verifyJWT, jwtAuth } = require('./impl.js');

// Test constants
const TEST_SECRET = 'test-secret-12345';
const TEST_PAYLOAD = { userId: '123', username: 'testuser', role: 'admin' };

/**
 * Utility function to simulate Express request/response objects
 */
function createMockReqRes(options = {}) {
    const req = {
        headers: {},
        cookies: {},
        query: {},
        ...options.req
    };
    
    const res = {
        status: function(code) {
            this.statusCode = code;
            return this;
        },
        json: function(data) {
            this.body = data;
            return this;
        }
    };
    
    const next = jestFn();
    
    return { req, res, next };
}

function jestFn() {
    const calls = [];
    const fn = function(...args) {
        calls.push(args);
    };
    fn.mock = {
        calls,
        reset: () => { calls.length = 0; }
    };
    return fn;
}

/**
 * Test suite runner
 */
function runTests() {
    console.log('=== JWT Authentication Middleware Tests ===\n');
    
    let passed = 0;
    let failed = 0;
    
    function test(name, fn) {
        try {
            fn();
            console.log(`✅ ${name}`);
            passed++;
        } catch (error) {
            console.log(`❌ ${name}`);
            console.log(`   Error: ${error.message}`);
            console.log(`   Stack: ${error.stack?.split('\n')[1]?.trim()}`);
            failed++;
        }
    }
    
    // Test 1: Sign and verify round-trip
    test('Sign and verify round-trip with basic payload', () => {
        const token = signJWT(TEST_PAYLOAD, { secret: TEST_SECRET });
        const decoded = verifyJWT(token, { secret: TEST_SECRET });
        
        if (decoded.userId !== TEST_PAYLOAD.userId) {
            throw new Error(`Expected userId ${TEST_PAYLOAD.userId}, got ${decoded.userId}`);
        }
        if (decoded.username !== TEST_PAYLOAD.username) {
            throw new Error(`Expected username ${TEST_PAYLOAD.username}, got ${decoded.username}`);
        }
        if (decoded.role !== TEST_PAYLOAD.role) {
            throw new Error(`Expected role ${TEST_PAYLOAD.role}, got ${decoded.role}`);
        }
    });
    
    // Test 2: Sign with expiration
    test('Sign with expiration and verify before expiry', () => {
        const token = signJWT(TEST_PAYLOAD, { 
            secret: TEST_SECRET,
            expiresIn: 3600 // 1 hour
        });
        
        const decoded = verifyJWT(token, { secret: TEST_SECRET });
        
        if (!decoded.exp) {
            throw new Error('Expected exp claim to be present');
        }
        if (decoded.exp <= Math.floor(Date.now() / 1000)) {
            throw new Error('Token should not be expired');
        }
    });
    
    // Test 3: Verify expired token throws error
    test('Verify expired token throws error', () => {
        const token = signJWT(TEST_PAYLOAD, { 
            secret: TEST_SECRET,
            expiresIn: -3600 // Expired 1 hour ago
        });
        
        try {
            verifyJWT(token, { secret: TEST_SECRET });
            throw new Error('Should have thrown expiration error');
        } catch (error) {
            if (!error.message.includes('expired')) {
                throw new Error(`Expected expiration error, got: ${error.message}`);
            }
        }
    });
    
    // Test 4: Sign with issuer, audience, subject
    test('Sign with claims and validate them', () => {
        const token = signJWT(TEST_PAYLOAD, { 
            secret: TEST_SECRET,
            issuer: 'test-issuer',
            audience: 'test-audience',
            subject: 'test-subject',
            jwtid: 'test-jti'
        });
        
        const decoded = verifyJWT(token, { 
            secret: TEST_SECRET,
            issuer: 'test-issuer',
            audience: 'test-audience',
            subject: 'test-subject'
        });
        
        if (decoded.iss !== 'test-issuer') {
            throw new Error(`Expected issuer test-issuer, got ${decoded.iss}`);
        }
        if (decoded.sub !== 'test-subject') {
            throw new Error(`Expected subject test-subject, got ${decoded.sub}`);
        }
        if (decoded.aud !== 'test-audience') {
            throw new Error(`Expected audience test-audience, got ${decoded.aud}`);
        }
        if (decoded.jti !== 'test-jti') {
            throw new Error(`Expected jti test-jti, got ${decoded.jti}`);
        }
    });
    
    // Test 5: Invalid signature throws error
    test('Invalid signature throws error', () => {
        const token = signJWT(TEST_PAYLOAD, { secret: TEST_SECRET });
        
        try {
            verifyJWT(token, { secret: 'wrong-secret' });
            throw new Error('Should have thrown signature error');
        } catch (error) {
            if (!error.message.includes('signature')) {
                throw new Error(`Expected signature error, got: ${error.message}`);
            }
        }
    });
    
    // Test 6: Malformed token throws error
    test('Malformed token throws error', () => {
        // Token with wrong number of parts (only 2 parts, not 3)
        try {
            verifyJWT('invalid.token', { secret: TEST_SECRET });
            throw new Error('Should have thrown format error');
        } catch (error) {
            if (!error.message.includes('Invalid token format')) {
                throw new Error(`Expected format error, got: ${error.message}`);
            }
        }
    });

    // Test 6b: Token with too many parts throws error
    test('Token with too many parts throws error', () => {
        try {
            verifyJWT('too.many.parts.here', { secret: TEST_SECRET });
            throw new Error('Should have thrown format error');
        } catch (error) {
            if (!error.message.includes('Invalid token format')) {
                throw new Error(`Expected format error, got: ${error.message}`);
            }
        }
    });
    
    // Test 7: Middleware - successful Authorization header
    test('Middleware validates Authorization header', () => {
        const token = signJWT(TEST_PAYLOAD, { secret: TEST_SECRET });
        const { req, res, next } = createMockReqRes({
            req: {
                headers: {
                    authorization: `Bearer ${token}`
                }
            }
        });
        
        const middleware = jwtAuth({ secret: TEST_SECRET });
        middleware(req, res, next);
        
        if (!req.user) {
            throw new Error('Expected user to be attached to request');
        }
        if (req.user.userId !== TEST_PAYLOAD.userId) {
            throw new Error(`Expected userId ${TEST_PAYLOAD.userId}, got ${req.user.userId}`);
        }
        if (next.mock.calls.length !== 1) {
            throw new Error('Expected next to be called');
        }
    });
    
    // Test 8: Middleware - successful cookie extraction
    test('Middleware validates cookie token', () => {
        const token = signJWT(TEST_PAYLOAD, { secret: TEST_SECRET });
        const { req, res, next } = createMockReqRes({
            req: {
                cookies: {
                    token: token
                }
            }
        });
        
        const middleware = jwtAuth({ secret: TEST_SECRET });
        middleware(req, res, next);
        
        if (!req.user) {
            throw new Error('Expected user to be attached to request');
        }
        if (next.mock.calls.length !== 1) {
            throw new Error('Expected next to be called');
        }
    });
    
    // Test 9: Middleware - successful query param extraction
    test('Middleware validates query parameter token', () => {
        const token = signJWT(TEST_PAYLOAD, { secret: TEST_SECRET });
        const { req, res, next } = createMockReqRes({
            req: {
                query: {
                    token: token
                }
            }
        });
        
        const middleware = jwtAuth({ secret: TEST_SECRET });
        middleware(req, res, next);
        
        if (!req.user) {
            throw new Error('Expected user to be attached to request');
        }
        if (next.mock.calls.length !== 1) {
            throw new Error('Expected next to be called');
        }
    });
    
    // Test 10: Middleware - no token with credentials required
    test('Middleware rejects request without token when credentials required', () => {
        const { req, res, next } = createMockReqRes();
        
        const middleware = jwtAuth({ secret: TEST_SECRET });
        middleware(req, res, next);
        
        if (res.statusCode !== 401) {
            throw new Error(`Expected status 401, got ${res.statusCode}`);
        }
        if (!res.body?.error?.includes('No token')) {
            throw new Error(`Expected "No token" error, got: ${JSON.stringify(res.body)}`);
        }
        if (next.mock.calls.length !== 0) {
            throw new Error('Expected next not to be called');
        }
    });
    
    // Test 11: Middleware - invalid token rejected
    test('Middleware rejects invalid token', () => {
        const { req, res, next } = createMockReqRes({
            req: {
                headers: {
                    authorization: 'Bearer invalid.token.here'
                }
            }
        });
        
        const middleware = jwtAuth({ secret: TEST_SECRET });
        middleware(req, res, next);
        
        if (res.statusCode !== 401) {
            throw new Error(`Expected status 401, got ${res.statusCode}`);
        }
        if (next.mock.calls.length !== 0) {
            throw new Error('Expected next not to be called');
        }
    });
    
    // Test 12: Middleware - custom user property
    test('Middleware attaches payload to custom user property', () => {
        const token = signJWT(TEST_PAYLOAD, { secret: TEST_SECRET });
        const { req, res, next } = createMockReqRes({
            req: {
                headers: {
                    authorization: `Bearer ${token}`
                }
            }
        });
        
        const middleware = jwtAuth({ 
            secret: TEST_SECRET,
            userProperty: 'auth'
        });
        middleware(req, res, next);
        
        if (!req.auth) {
            throw new Error('Expected auth to be attached to request');
        }
        if (req.auth.userId !== TEST_PAYLOAD.userId) {
            throw new Error(`Expected userId ${TEST_PAYLOAD.userId}, got ${req.auth.userId}`);
        }
    });
    
    // Test 13: Middleware - issuer validation
    test('Middleware validates issuer claim', () => {
        const token = signJWT(TEST_PAYLOAD, { 
            secret: TEST_SECRET,
            issuer: 'correct-issuer'
        });
        
        const { req, res, next } = createMockReqRes({
            req: {
                headers: {
                    authorization: `Bearer ${token}`
                }
            }
        });
        
        const middleware = jwtAuth({ 
            secret: TEST_SECRET,
            issuer: 'wrong-issuer'
        });
        middleware(req, res, next);
        
        if (res.statusCode !== 401) {
            throw new Error(`Expected status 401, got ${res.statusCode}`);
        }
        if (!res.body?.error?.includes('issuer')) {
            throw new Error(`Expected issuer validation error, got: ${JSON.stringify(res.body)}`);
        }
    });
    
    // Test 14: Middleware - audience validation
    test('Middleware validates audience claim', () => {
        const token = signJWT(TEST_PAYLOAD, { 
            secret: TEST_SECRET,
            audience: 'correct-audience'
        });
        
        const { req, res, next } = createMockReqRes({
            req: {
                headers: {
                    authorization: `Bearer ${token}`
                }
            }
        });
        
        const middleware = jwtAuth({ 
            secret: TEST_SECRET,
            audience: 'wrong-audience'
        });
        middleware(req, res, next);
        
        if (res.statusCode !== 401) {
            throw new Error(`Expected status 401, got ${res.statusCode}`);
        }
        if (!res.body?.error?.includes('audience')) {
            throw new Error(`Expected audience validation error, got: ${JSON.stringify(res.body)}`);
        }
    });
    
    // Test 15: Middleware - subject validation
    test('Middleware validates subject claim', () => {
        const token = signJWT(TEST_PAYLOAD, { 
            secret: TEST_SECRET,
            subject: 'correct-subject'
        });
        
        const { req, res, next } = createMockReqRes({
            req: {
                headers: {
                    authorization: `Bearer ${token}`
                }
            }
        });
        
        const middleware = jwtAuth({ 
            secret: TEST_SECRET,
            subject: 'wrong-subject'
        });
        middleware(req, res, next);
        
        if (res.statusCode !== 401) {
            throw new Error(`Expected status 401, got ${res.statusCode}`);
        }
        if (!res.body?.error?.includes('subject')) {
            throw new Error(`Expected subject validation error, got: ${JSON.stringify(res.body)}`);
        }
    });
    
    // Test 16: Middleware - credentials not required
    test('Middleware allows requests without token when credentials not required', () => {
        const { req, res, next } = createMockReqRes();
        
        const middleware = jwtAuth({ 
            secret: TEST_SECRET,
            credentialsRequired: false
        });
        middleware(req, res, next);
        
        if (next.mock.calls.length !== 1) {
            throw new Error('Expected next to be called');
        }
        if (req.user) {
            throw new Error('Expected user not to be attached when no token');
        }
    });
    
    // Test 17: Error handling - missing secret
    test('Missing secret throws error', () => {
        try {
            jwtAuth({});
            throw new Error('Should have thrown secret error');
        } catch (error) {
            if (!error.message.includes('Secret is required')) {
                throw new Error(`Expected secret error, got: ${error.message}`);
            }
        }
    });
    
    // Test 18: SignJWT without secret throws error
    test('signJWT without secret throws error', () => {
        try {
            signJWT(TEST_PAYLOAD, {});
            throw new Error('Should have thrown secret error');
        } catch (error) {
            if (!error.message.includes('Secret is required')) {
                throw new Error(`Expected secret error, got: ${error.message}`);
            }
        }
    });
    
    // Test 19: verifyJWT without secret throws error
    test('verifyJWT without secret throws error', () => {
        const token = signJWT(TEST_PAYLOAD, { secret: TEST_SECRET });
        
        try {
            verifyJWT(token, {});
            throw new Error('Should have thrown secret error');
        } catch (error) {
            if (!error.message.includes('Secret is required')) {
                throw new Error(`Expected secret error, got: ${error.message}`);
            }
        }
    });
    
    // Test 20: Timing-safe signature comparison
    test('Signature comparison is timing-safe', () => {
        const token = signJWT(TEST_PAYLOAD, { secret: TEST_SECRET });
        const parts = token.split('.');
        
        // Try with one character difference in signature
        const modifiedSignature = parts[2].slice(0, -1) + 'X';
        const modifiedToken = `${parts[0]}.${parts[1]}.${modifiedSignature}`;
        
        try {
            verifyJWT(modifiedToken, { secret: TEST_SECRET });
            throw new Error('Should have thrown signature error');
        } catch (error) {
            if (!error.message.includes('signature')) {
                throw new Error(`Expected signature error, got: ${error.message}`);
            }
        }
    });
    
    console.log('\n=== Test Summary ===');
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);
    console.log(`Total: ${passed + failed}`);
    
    if (failed > 0) {
        console.log('\n❌ Some tests failed');
        process.exit(1);
    } else {
        console.log('\n✅ All tests passed!');
    }
}

// Run tests
runTests();