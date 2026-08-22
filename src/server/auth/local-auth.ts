import fs from 'fs';
import path from 'path';
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { and, desc, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../db';
import { LoginOtp, User } from '../db/schema';
import { getBrandedEnv } from '../env';
import { createChildLogger } from '../logger';
import { getAppDataDir } from '../paths';

const log = createChildLogger({ component: 'local-auth' });

const SESSION_COOKIE = 'superjoy_local_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const OTP_EXPIRY_MS = 10 * 60 * 1000;
const OTP_RESEND_THROTTLE_MS = 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 10;
const LOCAL_AUTH_STATUS_TTL_MS = 5 * 1000;
const GENERIC_LOGIN_MESSAGE = 'If the credentials are valid, a verification code will be emailed shortly.';

type LocalSessionPayload = {
    userId: number;
    exp: number;
};

type RateLimitBucket = {
    count: number;
    resetAt: number;
};

const rateLimits = new Map<string, RateLimitBucket>();
let lastRateLimitPrune = 0;
let sessionSecret: Buffer | null = null;
let localAuthStatusCache: { value: { enabled: boolean; needsSetup: boolean }; expiresAt: number } | null = null;
let localAuthDefaultEnabled = false;
const dummyHashPromise = Bun.password.hash('invalid-password', { algorithm: 'argon2id' });

export const localAuth = new Hono();

/**
 * Enable local auth by default (unless explicitly disabled via
 * SUPERJOY_LOCAL_AUTH=false). Called at startup for fresh deployments exposed
 * beyond localhost so the first user can register their email and password.
 */
export function setLocalAuthDefaultEnabled(enabled: boolean): void {
    localAuthDefaultEnabled = enabled;
    invalidateLocalAuthStatusCache();
}

export function isOtpEmailConfigured(): boolean {
    const resendApiKey = process.env.RESEND_API_KEY || getBrandedEnv('RESEND_API_KEY');
    const resendFrom = getBrandedEnv('OTP_FROM');
    return !!resendApiKey && !!resendFrom;
}

export async function getLocalAuthStatus(options: { fresh?: boolean } = {}): Promise<{ enabled: boolean; needsSetup: boolean }> {
    const now = Date.now();
    if (!options.fresh && localAuthStatusCache && localAuthStatusCache.expiresAt > now) {
        return localAuthStatusCache.value;
    }

    const [passwordUser] = await db
        .select({ id: User.id })
        .from(User)
        .where(isNotNull(User.passwordHash))
        .limit(1);

    const hasPasswordUser = !!passwordUser;
    const localAuthEnv = getBrandedEnv('LOCAL_AUTH');
    const forcedEnabled = localAuthEnv === 'true';
    const explicitlyDisabled = localAuthEnv === 'false';
    const enabled = hasPasswordUser
        || forcedEnabled
        || (localAuthDefaultEnabled && !explicitlyDisabled);

    const value = {
        enabled,
        needsSetup: !hasPasswordUser && enabled,
    };
    localAuthStatusCache = { value, expiresAt: now + LOCAL_AUTH_STATUS_TTL_MS };
    return value;
}

function invalidateLocalAuthStatusCache(): void {
    localAuthStatusCache = null;
}

export async function verifyLocalSessionFromRequest(req: Request): Promise<LocalSessionPayload | null> {
    const token = getCookie(req.headers.get('cookie'), SESSION_COOKIE);
    if (!token) return null;
    return verifySessionToken(token);
}

export function clearLocalSessionCookie(): string {
    return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

localAuth.get('/status', async (c) => {
    const status = await getLocalAuthStatus();
    return c.json({ ...status, otpEmailConfigured: isOtpEmailConfigured() });
});

localAuth.post('/setup', async (c) => {
    try {
        const status = await getLocalAuthStatus({ fresh: true });
        if (!status.needsSetup) {
            return c.json({ error: 'Local auth setup is not available' }, 403);
        }

        const body = await readJson(c.req.raw);
        const email = normalizeEmail(body.email);
        const password = typeof body.password === 'string' ? body.password : '';
        const name = typeof body.name === 'string' ? body.name.trim() : '';

        if (!email || !password) {
            return c.json({ error: 'Email and password are required' }, 400);
        }

        const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id' });
        const now = new Date();
        const [firstName, ...lastNameParts] = name.split(/\s+/).filter(Boolean);

        const [existingByEmail] = await db
            .select()
            .from(User)
            .where(sql`lower(${User.email}) = ${email}`)
            .limit(1);

        let setupUserId: number;
        if (existingByEmail) {
            await db
                .update(User)
                .set({
                    email,
                    username: existingByEmail.username || email,
                    firstName: firstName || existingByEmail.firstName,
                    lastName: lastNameParts.join(' ') || existingByEmail.lastName,
                    passwordHash,
                    verifiedEmail: true,
                    updatedAt: now,
                })
                .where(eq(User.id, existingByEmail.id));
            setupUserId = existingByEmail.id;
        } else {
            const [firstUser] = await db.select().from(User).orderBy(User.id).limit(1);
            if (firstUser) {
                await db
                    .update(User)
                    .set({
                        email,
                        username: firstUser.username || email,
                        firstName: firstName || firstUser.firstName,
                        lastName: lastNameParts.join(' ') || firstUser.lastName,
                        passwordHash,
                        verifiedEmail: true,
                        updatedAt: now,
                    })
                    .where(eq(User.id, firstUser.id));
                setupUserId = firstUser.id;
            } else {
                const [createdUser] = await db.insert(User).values({
                    email,
                    username: email,
                    firstName: firstName || undefined,
                    lastName: lastNameParts.join(' ') || undefined,
                    passwordHash,
                    verifiedEmail: true,
                }).returning({ id: User.id });
                if (!createdUser) {
                    throw new Error('Failed to create local auth user');
                }
                setupUserId = createdUser.id;
            }
        }

        invalidateLocalAuthStatusCache();

        // Sign the user in immediately after first-run setup. Setup is only
        // reachable while no password user exists, so the caller just proved
        // ownership of this fresh install; requiring an email OTP here would
        // lock out installs where email delivery is not configured yet.
        const token = signSessionToken({
            userId: setupUserId,
            exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
        });
        const response = c.json({ success: true, authenticated: true });
        response.headers.append('Set-Cookie', buildSessionCookie(token, c.req.raw));
        return response;
    } catch (err) {
        log.error({ err }, 'Local auth setup failed');
        return c.json({ error: 'Failed to complete local auth setup' }, 500);
    }
});

localAuth.post('/login', async (c) => {
    if (!checkRateLimit(c.req.raw, 'login')) {
        return c.json({ error: 'Too many login attempts. Please try again later.' }, 429);
    }

    const resendApiKey = process.env.RESEND_API_KEY || getBrandedEnv('RESEND_API_KEY') || '';
    const resendFrom = getBrandedEnv('OTP_FROM') || '';
    const otpEmailConfigured = isOtpEmailConfigured();

    try {
        const body = await readJson(c.req.raw);
        const email = normalizeEmail(body.email);
        const password = typeof body.password === 'string' ? body.password : '';

        // Without email delivery configured, OTP codes cannot be sent, so fall
        // back to password-only login instead of locking the server owner out.
        if (!otpEmailConfigured) {
            if (!email || !password) {
                return c.json({ error: 'Invalid email or password' }, 401);
            }

            const [user] = await db
                .select()
                .from(User)
                .where(sql`lower(${User.email}) = ${email}`)
                .limit(1);

            const passwordHash = user?.passwordHash || await dummyHashPromise;
            const passwordOk = await Bun.password.verify(password, passwordHash);
            if (!user || !user.passwordHash || !passwordOk) {
                return c.json({ error: 'Invalid email or password' }, 401);
            }

            const now = new Date();
            await db
                .update(User)
                .set({ lastLogin: now, updatedAt: now })
                .where(eq(User.id, user.id));

            const token = signSessionToken({
                userId: user.id,
                exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
            });
            const response = c.json({ success: true, authenticated: true });
            response.headers.append('Set-Cookie', buildSessionCookie(token, c.req.raw));
            return response;
        }

        if (!email || !password) {
            return c.json({ message: GENERIC_LOGIN_MESSAGE });
        }

        const [user] = await db
            .select()
            .from(User)
            .where(sql`lower(${User.email}) = ${email}`)
            .limit(1);

        const passwordHash = user?.passwordHash || await dummyHashPromise;
        const passwordOk = await Bun.password.verify(password, passwordHash);
        if (!user || !user.passwordHash || !passwordOk) {
            return c.json({ message: GENERIC_LOGIN_MESSAGE });
        }

        const now = new Date();
        const throttleSince = new Date(now.getTime() - OTP_RESEND_THROTTLE_MS);
        const [recentOtp] = await db
            .select({ id: LoginOtp.id })
            .from(LoginOtp)
            .where(and(
                eq(LoginOtp.userId, user.id),
                isNull(LoginOtp.consumedAt),
                gt(LoginOtp.expiresAt, now),
                gt(LoginOtp.createdAt, throttleSince),
            ))
            .limit(1);

        if (recentOtp) {
            return c.json({ error: 'Please wait before requesting another code.' }, 429);
        }

        const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
        await db.insert(LoginOtp).values({
            userId: user.id,
            codeHash: hashOtpCode(code),
            expiresAt: new Date(now.getTime() + OTP_EXPIRY_MS),
            attempts: 0,
        });

        const sent = await sendOtpEmail({
            apiKey: resendApiKey,
            from: resendFrom,
            to: email,
            code,
        });

        if (!sent) {
            return c.json({ error: 'Failed to send the verification email. Please check the server email configuration and try again.' }, 502);
        }

        return c.json({ message: GENERIC_LOGIN_MESSAGE });
    } catch (err) {
        log.error({ err }, 'Local login failed');
        if (!otpEmailConfigured) {
            return c.json({ error: 'Login failed. Please try again.' }, 500);
        }
        return c.json({ message: GENERIC_LOGIN_MESSAGE });
    }
});

localAuth.post('/verify-otp', async (c) => {
    if (!checkRateLimit(c.req.raw, 'verify-otp')) {
        return c.json({ error: 'Too many verification attempts. Please try again later.' }, 429);
    }

    try {
        const body = await readJson(c.req.raw);
        const email = normalizeEmail(body.email);
        const code = typeof body.code === 'string' ? body.code.trim() : '';

        if (!email || !/^\d{6}$/.test(code)) {
            return c.json({ error: 'Invalid or expired verification code' }, 400);
        }

        const [user] = await db
            .select()
            .from(User)
            .where(sql`lower(${User.email}) = ${email}`)
            .limit(1);

        if (!user) {
            return c.json({ error: 'Invalid or expired verification code' }, 400);
        }

        const now = new Date();
        const [otp] = await db
            .select()
            .from(LoginOtp)
            .where(and(
                eq(LoginOtp.userId, user.id),
                isNull(LoginOtp.consumedAt),
            ))
            .orderBy(desc(LoginOtp.createdAt))
            .limit(1);

        if (!otp || otp.expiresAt <= now || otp.attempts >= 5) {
            return c.json({ error: 'Invalid or expired verification code' }, 400);
        }

        const codeMatches = constantTimeEqualHex(hashOtpCode(code), otp.codeHash);
        if (!codeMatches) {
            await db
                .update(LoginOtp)
                .set({ attempts: otp.attempts + 1 })
                .where(eq(LoginOtp.id, otp.id));
            return c.json({ error: 'Invalid or expired verification code' }, 400);
        }

        await db.transaction(async (tx) => {
            await tx
                .update(LoginOtp)
                .set({ consumedAt: now })
                .where(eq(LoginOtp.id, otp.id));
            await tx
                .update(User)
                .set({ lastLogin: now, updatedAt: now })
                .where(eq(User.id, user.id));
        });

        const token = signSessionToken({
            userId: user.id,
            exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
        });

        const response = c.json({ success: true });
        response.headers.append('Set-Cookie', buildSessionCookie(token, c.req.raw));
        return response;
    } catch (err) {
        log.error({ err }, 'Local OTP verification failed');
        return c.json({ error: 'Invalid or expired verification code' }, 400);
    }
});

localAuth.post('/logout', (c) => {
    const response = c.json({ success: true });
    response.headers.append('Set-Cookie', clearLocalSessionCookie());
    return response;
});

function normalizeEmail(value: unknown): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
    try {
        const parsed = await req.json();
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {};
    } catch {
        return {};
    }
}

function hashOtpCode(code: string): string {
    return createHash('sha256').update(code).digest('hex');
}

function constantTimeEqualHex(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left, 'hex');
    const rightBuffer = Buffer.from(right, 'hex');
    if (leftBuffer.length !== rightBuffer.length) return false;
    return timingSafeEqual(leftBuffer, rightBuffer);
}

async function sendOtpEmail(args: { apiKey: string; from: string; to: string; code: string }): Promise<boolean> {
    try {
        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: ['Bearer', args.apiKey].join(' '),
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from: args.from,
                to: args.to,
                subject: 'Your Superjoy verification code',
                text: `Your Superjoy verification code is ${args.code}. It expires in 10 minutes.`,
            }),
        });

        if (!response.ok) {
            const body = await response.text().catch(() => '');
            log.error({ status: response.status, body: body.slice(0, 500) }, 'Resend OTP email failed');
            return false;
        }
        return true;
    } catch (err) {
        log.error({ err }, 'Resend OTP email request failed');
        return false;
    }
}

function signSessionToken(payload: LocalSessionPayload): string {
    const payloadPart = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${payloadPart}.${sign(payloadPart)}`;
}

function verifySessionToken(token: string): LocalSessionPayload | null {
    const [payloadPart, signaturePart, ...extraParts] = token.split('.');
    if (!payloadPart || !signaturePart || extraParts.length > 0) return null;

    const expectedSignature = sign(payloadPart);
    if (!constantTimeEqualBase64Url(signaturePart, expectedSignature)) return null;

    try {
        const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as Partial<LocalSessionPayload>;
        if (typeof payload.userId !== 'number' || typeof payload.exp !== 'number') return null;
        if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
        return { userId: payload.userId, exp: payload.exp };
    } catch {
        return null;
    }
}

function sign(payloadPart: string): string {
    return createHmac('sha256', getSessionSecret()).update(payloadPart).digest('base64url');
}

function getSessionSecret(): Buffer {
    if (sessionSecret) return sessionSecret;

    const envSecret = getBrandedEnv('SESSION_SECRET');
    if (envSecret) {
        sessionSecret = Buffer.from(envSecret);
        return sessionSecret;
    }

    const secretPath = path.join(getAppDataDir(), 'local-session-secret');
    try {
        const existing = fs.readFileSync(secretPath, 'utf8').trim();
        if (existing) {
            sessionSecret = Buffer.from(existing, 'hex');
            return sessionSecret;
        }
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw err;
        }
    }

    const generated = randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(secretPath), { recursive: true });
    fs.writeFileSync(secretPath, generated, { mode: 0o600 });
    sessionSecret = Buffer.from(generated, 'hex');
    return sessionSecret;
}

function constantTimeEqualBase64Url(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    if (leftBuffer.length !== rightBuffer.length) return false;
    return timingSafeEqual(leftBuffer, rightBuffer);
}

function buildSessionCookie(token: string, req: Request): string {
    const forwardedProto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
    const proto = forwardedProto || new URL(req.url).protocol.replace(':', '');
    const secure = proto === 'https' ? '; Secure' : '';
    return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}${secure}`;
}

function getCookie(cookieHeader: string | null, name: string): string | null {
    if (!cookieHeader) return null;
    for (const part of cookieHeader.split(';')) {
        const [rawName, ...rawValue] = part.trim().split('=');
        if (rawName === name) {
            return rawValue.join('=') || null;
        }
    }
    return null;
}

function checkRateLimit(req: Request, keyPrefix: string): boolean {
    const ip = getClientIp(req);
    const key = `${keyPrefix}:${ip}`;
    const now = Date.now();
    pruneRateLimits(now);
    const bucket = rateLimits.get(key);

    if (!bucket || bucket.resetAt <= now) {
        rateLimits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
        return true;
    }

    if (bucket.count >= RATE_LIMIT_MAX) return false;
    bucket.count += 1;
    return true;
}

function pruneRateLimits(now: number): void {
    if (now - lastRateLimitPrune < RATE_LIMIT_WINDOW_MS) return;
    lastRateLimitPrune = now;
    for (const [key, bucket] of rateLimits) {
        if (bucket.resetAt <= now) {
            rateLimits.delete(key);
        }
    }
}

function getClientIp(req: Request): string {
    const forwardedFor = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    return forwardedFor || req.headers.get('x-real-ip') || 'unknown';
}
