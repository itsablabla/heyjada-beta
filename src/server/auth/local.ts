/**
 * Local account authentication: username/password with a single email OTP
 * (one-time passcode) verification step, delivered via Resend.
 *
 * This is independent from platform (OAuth) authentication. When a local
 * account has been fully set up (password set + email verified), API access
 * requires a valid local session cookie. When no local account exists the
 * app behaves exactly as before (anon mode / platform auth), so dev and test
 * flows are unaffected.
 */
import { randomInt, randomBytes, createHash } from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { User, ApiKey } from '../db/schema';
import { createChildLogger } from '../logger';

const log = createChildLogger({ component: 'local-auth' });

export const SESSION_COOKIE_NAME = 'sj_session';
const SESSION_KEY_NAME = 'local-session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OTP_RESEND_INTERVAL_MS = 30 * 1000; // min gap between OTP emails
const MAX_OTP_ATTEMPTS = 5;

// In-memory guards. This is a local single-user app so process-level state is fine.
let lastOtpSentAt = 0;
let otpAttempts = 0;
// Small cache so the per-request auth gate doesn't hit the DB every time.
let enforcementCache: { value: boolean; at: number } | null = null;
const ENFORCEMENT_CACHE_MS = 5_000;

/** The single local user record (this is a single-user application). */
export async function getLocalUserRecord(): Promise<typeof User.$inferSelect | null> {
    const [user] = await db.select().from(User).limit(1);
    return user ?? null;
}

/** Local auth is enforced once an account is fully set up (password + verified email). */
export async function isLocalAuthEnforced(): Promise<boolean> {
    if (enforcementCache && Date.now() - enforcementCache.at < ENFORCEMENT_CACHE_MS) {
        return enforcementCache.value;
    }
    const user = await getLocalUserRecord();
    const value = !!(user?.password && user.verifiedEmail);
    enforcementCache = { value, at: Date.now() };
    return value;
}

export function invalidateLocalAuthCache(): void {
    enforcementCache = null;
}

export async function hashPassword(password: string): Promise<string> {
    return Bun.password.hash(password);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
    try {
        return await Bun.password.verify(password, hash);
    } catch {
        return false;
    }
}

function generateOtpCode(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

/**
 * Send the OTP email through Resend. Falls back to logging the code when no
 * RESEND_API_KEY is configured (useful in development).
 */
async function sendOtpEmail(email: string, code: string): Promise<boolean> {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
        log.warn({ email }, `RESEND_API_KEY not configured; OTP code for local sign-in: ${code}`);
        return true;
    }
    const from = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
    try {
        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + apiKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from,
                to: [email],
                subject: 'Your verification code',
                text: `Your verification code is ${code}. It expires in 10 minutes.`,
            }),
        });
        if (!response.ok) {
            const errorText = await response.text();
            log.error({ status: response.status, errorText }, 'Failed to send OTP email via Resend');
            return false;
        }
        return true;
    } catch (err) {
        log.error({ err }, 'Failed to send OTP email via Resend');
        return false;
    }
}

/**
 * Generate and email a fresh OTP for the user. Rate limited so the code can
 * only be re-sent every 30 seconds.
 */
export async function issueOtp(user: typeof User.$inferSelect): Promise<{ ok: boolean; error?: string }> {
    if (!user.email) return { ok: false, error: 'No email on account' };
    const now = Date.now();
    if (now - lastOtpSentAt < OTP_RESEND_INTERVAL_MS) {
        return { ok: false, error: 'Please wait before requesting another code' };
    }

    const code = generateOtpCode();
    await db.update(User).set({
        accountVerificationCode: code,
        accountVerificationCodeExpiry: new Date(now + OTP_TTL_MS),
        updatedAt: new Date(),
    }).where(eq(User.id, user.id));

    const sent = await sendOtpEmail(user.email, code);
    if (!sent) return { ok: false, error: 'Failed to send verification email' };

    lastOtpSentAt = now;
    otpAttempts = 0;
    return { ok: true };
}

/** Verify the OTP code for the user; marks the email verified on success. */
export async function verifyOtp(user: typeof User.$inferSelect, code: string): Promise<{ ok: boolean; error?: string }> {
    if (otpAttempts >= MAX_OTP_ATTEMPTS) {
        return { ok: false, error: 'Too many attempts. Request a new code.' };
    }
    if (!user.accountVerificationCode || !user.accountVerificationCodeExpiry) {
        return { ok: false, error: 'No verification code pending' };
    }
    if (user.accountVerificationCodeExpiry.getTime() < Date.now()) {
        return { ok: false, error: 'Verification code expired' };
    }
    otpAttempts++;
    if (user.accountVerificationCode !== code.trim()) {
        return { ok: false, error: 'Invalid verification code' };
    }

    await db.update(User).set({
        verifiedEmail: true,
        accountVerificationCode: null,
        accountVerificationCodeExpiry: null,
        lastLogin: new Date(),
        updatedAt: new Date(),
    }).where(eq(User.id, user.id));
    invalidateLocalAuthCache();
    otpAttempts = 0;
    return { ok: true };
}

/** Create a persistent session and return the raw token for the cookie. */
export async function createSession(userId: number): Promise<string> {
    const token = randomBytes(32).toString('hex');
    await db.insert(ApiKey).values({
        userId,
        token: hashToken(token),
        name: SESSION_KEY_NAME,
        accessedAt: new Date(),
    });
    return token;
}

/** Validate a session cookie token, sliding its expiry on use. */
export async function validateSessionToken(token: string | undefined): Promise<boolean> {
    if (!token) return false;
    const hashed = hashToken(token);
    const [session] = await db.select().from(ApiKey).where(eq(ApiKey.token, hashed));
    if (!session || session.name !== SESSION_KEY_NAME) return false;

    const lastAccess = session.accessedAt?.getTime() ?? 0;
    if (Date.now() - lastAccess > SESSION_TTL_MS) {
        await db.delete(ApiKey).where(eq(ApiKey.id, session.id));
        return false;
    }
    // Slide expiry at most once an hour to avoid a write on every request
    if (Date.now() - lastAccess > 60 * 60 * 1000) {
        await db.update(ApiKey).set({ accessedAt: new Date() }).where(eq(ApiKey.id, session.id));
    }
    return true;
}

/** Destroy the session matching this cookie token (used on logout). */
export async function destroySession(token: string | undefined): Promise<void> {
    if (!token) return;
    await db.delete(ApiKey).where(eq(ApiKey.token, hashToken(token)));
}
