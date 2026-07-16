/**
 * JWT Authentication Middleware for Express.js
 * 
 * Production-ready JWT authentication using only Node.js built-in modules.
 * 
 * Features:
 * - HS256 signing with crypto.createHmac
 * - Token extraction from Authorization header, cookie, or query parameter
 * - Customizable validation options (issuer, audience, subject, algorithms)
 * - Automatic payload attachment to req.user
 * - Comprehensive error handling
 */

const crypto = require('crypto');

/**
 * JWT Authentication Middleware Factory
 * 
 * @param {Object} options - Configuration options
 * @param {string|Buffer} options.secret - Secret key for signing/verification
 * @param {string[]} [options.algorithms=['HS256']] - Allowed algorithms
 * @param {string} [options.issuer] - Expected issuer
 * @param {string} [options.audience] - Expected audience
 * @param {string} [options.subject] - Expected subject
 * @param {string} [options.cookieName='token'] - Cookie name for token extraction
 * @param {string} [options.queryParam='token'] - Query parameter name for token extraction
 * @param {string} [options.userProperty='user'] - Property name to attach payload to request
 * @param {boolean} [options.credentialsRequired=true] - Whether credentials are required
 * @returns {Function} Express middleware function
 */
function jwtAuth(options = {}) {
    const {
        secret,
        algorithms = ['HS256'],
        issuer,
        audience,
        subject,
        cookieName = 'token',
        queryParam = 'token',
        userProperty = 'user',
        credentialsRequired = true
    } = options;

    if (!secret) {
        throw new Error('Secret is required for JWT authentication');
    }

    // Validate algorithms
    if (!Array.isArray(algorithms) || algorithms.length === 0) {
        throw new Error('algorithms must be a non-empty array');
    }
    if (!algorithms.includes('HS256')) {
        throw new Error('HS256 algorithm is required for this implementation');
    }

    /**
     * Extract token from request
     */
    function extractToken(req) {
        // Check Authorization header (Bearer token)
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            return authHeader.substring(7);
        }

        // Check cookie
        if (req.cookies && req.cookies[cookieName]) {
            return req.cookies[cookieName];
        }

        // Check query parameter
        if (req.query && req.query[queryParam]) {
            return req.query[queryParam];
        }

        return null;
    }

    return function(req, res, next) {
        const token = extractToken(req);

        if (!token) {
            if (credentialsRequired) {
                return res.status(401).json({ error: 'No token provided' });
            }
            return next();
        }

        try {
            const payload = verifyJWT(token, {
                secret,
                algorithms,
                issuer,
                audience,
                subject
            });

            // Attach payload to request
            req[userProperty] = payload;
            next();
        } catch (error) {
            return res.status(401).json({ error: error.message });
        }
    };
}

/**
 * Sign JWT token
 * 
 * @param {Object} payload - JWT payload
 * @param {Object} options - Signing options
 * @param {string|Buffer} options.secret - Secret key
 * @param {number} [options.expiresIn] - Expiration time in seconds
 * @param {string} [options.issuer] - Token issuer
 * @param {string} [options.audience] - Token audience
 * @param {string} [options.subject] - Token subject
 * @param {string} [options.jwtid] - JWT ID
 * @returns {string} Signed JWT token
 */
function signJWT(payload, options = {}) {
    const {
        secret,
        expiresIn,
        issuer,
        audience,
        subject,
        jwtid
    } = options;

    if (!secret) {
        throw new Error('Secret is required for signing JWT');
    }

    // Create header
    const header = {
        alg: 'HS256',
        typ: 'JWT'
    };

    // Create claims
    const claims = { ...payload };
    const now = Math.floor(Date.now() / 1000);

    if (issuer) claims.iss = issuer;
    if (subject) claims.sub = subject;
    if (audience) claims.aud = audience;
    if (jwtid) claims.jti = jwtid;
    if (expiresIn) claims.exp = now + expiresIn;
    
    claims.iat = now;

    // Encode header and claims
    const encodedHeader = base64UrlEncode(JSON.stringify(header));
    const encodedClaims = base64UrlEncode(JSON.stringify(claims));
    const signingInput = `${encodedHeader}.${encodedClaims}`;

    // Create signature
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(signingInput);
    const signature = base64UrlEncode(hmac.digest());

    return `${signingInput}.${signature}`;
}

/**
 * Verify JWT token
 * 
 * @param {string} token - JWT token to verify
 * @param {Object} options - Verification options
 * @param {string|Buffer} options.secret - Secret key
 * @param {string[]} [options.algorithms=['HS256']] - Allowed algorithms
 * @param {string} [options.issuer] - Expected issuer
 * @param {string} [options.audience] - Expected audience
 * @param {string} [options.subject] - Expected subject
 * @returns {Object} Decoded and validated payload
 */
function verifyJWT(token, options = {}) {
    const {
        secret,
        algorithms = ['HS256'],
        issuer,
        audience,
        subject
    } = options;

    if (!secret) {
        throw new Error('Secret is required for verifying JWT');
    }

    // Parse token
    const parts = token.split('.');
    if (parts.length !== 3) {
        throw new Error('Invalid token format');
    }

    const [encodedHeader, encodedClaims, encodedSignature] = parts;

    // Verify signature (timing-safe comparison)
    const signingInput = `${encodedHeader}.${encodedClaims}`;
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(signingInput);
    const expectedSignature = hmac.digest(); // raw 32-byte digest
    const providedSignature = Buffer.from(encodedSignature, 'base64url');

    // crypto.timingSafeEqual requires equal-length buffers
    if (providedSignature.length !== expectedSignature.length ||
        !crypto.timingSafeEqual(providedSignature, expectedSignature)) {
        throw new Error('Invalid signature');
    }

    // Decode and parse claims
    const claims = JSON.parse(base64UrlDecode(encodedClaims));

    // Validate algorithm
    const header = JSON.parse(base64UrlDecode(encodedHeader));
    if (!algorithms.includes(header.alg)) {
        throw new Error(`Algorithm "${header.alg}" not allowed`);
    }

    // Validate expiration
    if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) {
        throw new Error('Token expired');
    }

    // Validate issuer
    if (issuer && claims.iss !== issuer) {
        throw new Error(`Invalid issuer: expected "${issuer}", got "${claims.iss}"`);
    }

    // Validate audience
    if (audience) {
        const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
        if (!aud.includes(audience)) {
            throw new Error(`Invalid audience: expected "${audience}", got "${claims.aud}"`);
        }
    }

    // Validate subject
    if (subject && claims.sub !== subject) {
        throw new Error(`Invalid subject: expected "${subject}", got "${claims.sub}"`);
    }

    // Validate issued at (not in the future)
    if (claims.iat && claims.iat > Math.floor(Date.now() / 1000) + 60) {
        throw new Error('Token issued in the future');
    }

    // Validate not before (if present)
    if (claims.nbf && claims.nbf > Math.floor(Date.now() / 1000)) {
        throw new Error('Token not yet valid');
    }

    return claims;
}

/**
 * Base64 URL encoding
 */
function base64UrlEncode(str) {
    return Buffer.from(str).toString('base64url');
}

/**
 * Base64 URL decoding
 */
function base64UrlDecode(str) {
    return Buffer.from(str, 'base64url').toString('utf8');
}

module.exports = {
    jwtAuth,
    signJWT,
    verifyJWT
};