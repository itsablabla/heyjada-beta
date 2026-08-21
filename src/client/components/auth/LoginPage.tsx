import { useState, useEffect, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { apiFetch, getApiBaseUrl } from '../../utils/api';
import { getDeviceFingerprint, isDesktopMode, openInBrowser } from '../../utils/tauri';

interface AuthCapabilities {
    emailEnabled: boolean;
    googleEnabled: boolean;
}

interface LocalAuthInfo {
    enabled: boolean;
    needsVerification: boolean;
    authenticated: boolean;
    username: string | null;
}

type LocalMode = 'signin' | 'signup' | 'verify';

interface LoginPageProps {
    onLoginSuccess: () => void;
}

export function LoginPage({ onLoginSuccess }: LoginPageProps) {
    const { t } = useTranslation();
    const [isLoading, setIsLoading] = useState(false);
    const [isWaitingForAuth, setIsWaitingForAuth] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [authCapabilities, setAuthCapabilities] = useState<AuthCapabilities | null>(null);
    const [localAuth, setLocalAuth] = useState<LocalAuthInfo | null>(null);
    const [localMode, setLocalMode] = useState<LocalMode>('signup');
    const [username, setUsername] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [otpCode, setOtpCode] = useState('');
    const [resendCooldown, setResendCooldown] = useState(0);
    const logoUrl = `${getApiBaseUrl()}/icons/superjoy_128.png`;
    const isDesktop = isDesktopMode();

    // Fetch auth capabilities from platform on mount
    useEffect(() => {
        apiFetch('/api/auth/config')
            .then(res => res.ok ? res.json() : Promise.reject())
            .then(setAuthCapabilities)
            .catch(() => {
                // Default to showing all options if fetch fails
                setAuthCapabilities({ emailEnabled: true, googleEnabled: true });
            });
    }, []);

    // Fetch local account state so we know whether to offer sign-in or account creation
    useEffect(() => {
        apiFetch('/api/auth/status')
            .then(res => res.ok ? res.json() : Promise.reject())
            .then(data => {
                const info: LocalAuthInfo | null = data.localAuth ?? null;
                setLocalAuth(info);
                if (info?.enabled) setLocalMode('signin');
                else if (info?.needsVerification) setLocalMode('verify');
            })
            .catch(() => setLocalAuth(null));
    }, []);

    // Countdown for the OTP resend button
    useEffect(() => {
        if (resendCooldown <= 0) return;
        const timer = setTimeout(() => setResendCooldown(c => c - 1), 1000);
        return () => clearTimeout(timer);
    }, [resendCooldown]);

    const handleLocalRegister = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsLoading(true);
        setError(null);
        try {
            const res = await apiFetch('/api/auth/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ username: username.trim(), email: email.trim(), password }),
            });
            const data = await res.json();
            if (!res.ok) {
                setError(data.error || t('auth.localAuthError', 'Something went wrong. Please try again.'));
                return;
            }
            setLocalMode('verify');
            setResendCooldown(30);
        } catch (err) {
            console.error('Registration error:', err);
            setError(t('auth.localAuthError', 'Something went wrong. Please try again.'));
        } finally {
            setIsLoading(false);
        }
    };

    const handleLocalSignIn = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsLoading(true);
        setError(null);
        try {
            const res = await apiFetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ username: username.trim(), password }),
            });
            const data = await res.json();
            if (!res.ok) {
                setError(data.error || t('auth.localAuthError', 'Something went wrong. Please try again.'));
                return;
            }
            if (data.needsVerification) {
                setLocalMode('verify');
                setResendCooldown(30);
                return;
            }
            onLoginSuccess();
        } catch (err) {
            console.error('Sign-in error:', err);
            setError(t('auth.localAuthError', 'Something went wrong. Please try again.'));
        } finally {
            setIsLoading(false);
        }
    };

    const handleVerifyOtp = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsLoading(true);
        setError(null);
        try {
            const res = await apiFetch('/api/auth/verify-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ code: otpCode.trim() }),
            });
            const data = await res.json();
            if (!res.ok) {
                setError(data.error || t('auth.invalidOtp', 'Invalid verification code.'));
                return;
            }
            onLoginSuccess();
        } catch (err) {
            console.error('Verification error:', err);
            setError(t('auth.localAuthError', 'Something went wrong. Please try again.'));
        } finally {
            setIsLoading(false);
        }
    };

    const handleResendOtp = async () => {
        if (resendCooldown > 0) return;
        setError(null);
        try {
            const res = await apiFetch('/api/auth/resend-otp', { method: 'POST', credentials: 'include' });
            const data = await res.json();
            if (!res.ok) {
                setError(data.error || t('auth.localAuthError', 'Something went wrong. Please try again.'));
                return;
            }
            setResendCooldown(30);
        } catch (err) {
            console.error('Resend OTP error:', err);
            setError(t('auth.localAuthError', 'Something went wrong. Please try again.'));
        }
    };

    // Poll for auth status when waiting for external browser auth
    const checkAuthStatus = useCallback(async () => {
        try {
            const res = await apiFetch('/api/auth/status');
            if (res.ok) {
                const data = await res.json();
                if (data.authenticated) {
                    setIsWaitingForAuth(false);
                    onLoginSuccess();
                    return true;
                }
            }
        } catch (err) {
            console.error('[LoginPage] Auth status poll error:', err);
        }
        return false;
    }, [onLoginSuccess]);

    // Poll for auth completion when user is signing in via external browser
    useEffect(() => {
        if (!isWaitingForAuth) return;

        const interval = setInterval(async () => {
            const authenticated = await checkAuthStatus();
            if (authenticated) {
                clearInterval(interval);
            }
        }, 2000); // Poll every 2 seconds

        return () => clearInterval(interval);
    }, [isWaitingForAuth, checkAuthStatus]);

    const handleGoogleSignIn = async () => {
        setIsLoading(true);
        setError(null);

        try {
            // Build callback URL with desktop flag if in desktop mode
            const baseUrl = getApiBaseUrl() || window.location.origin;
            const callbackUrl = isDesktop
                ? `${baseUrl}/api/auth/callback?desktop=1`
                : `${baseUrl}/api/auth/callback`;

            // Get the OAuth URL from the server with custom callback
            const deviceFingerprint = await getDeviceFingerprint();
            const oauthUrlQuery = new URLSearchParams({ callback_url: callbackUrl });
            if (deviceFingerprint) {
                oauthUrlQuery.set('device_fingerprint', deviceFingerprint);
            }
            const res = await apiFetch(`/api/auth/oauth/google/url?${oauthUrlQuery.toString()}`);
            if (!res.ok) {
                throw new Error('Failed to get OAuth URL');
            }
            const { url } = await res.json();

            // In desktop mode, open in system browser and poll for completion
            if (isDesktop) {
                await openInBrowser(url);
                setIsLoading(false);
                setIsWaitingForAuth(true);
            } else {
                // Web mode - redirect in same window
                window.location.href = url;
            }
        } catch (err) {
            console.error('Google sign-in error:', err);
            setError(t('auth.googleSignInError'));
            setIsLoading(false);
        }
    };

    const handleEmailSignIn = async () => {
        setIsLoading(true);
        setError(null);

        try {
            // Get the platform URL and redirect to platform login
            const res = await apiFetch('/api/auth/platform-url');
            if (!res.ok) {
                throw new Error('Failed to get platform URL');
            }
            const { url } = await res.json();

            // Build callback URL with desktop flag if in desktop mode
            const baseUrl = getApiBaseUrl() || window.location.origin;
            const callbackUrl = isDesktop
                ? `${baseUrl}/api/auth/callback?desktop=1`
                : `${baseUrl}/api/auth/callback`;

            // Build full login URL with source=app to distinguish from direct platform login
            const loginUrl = `${url}/login?redirect_uri=${encodeURIComponent(callbackUrl)}&source=app`;

            // In desktop mode, open in system browser and poll for completion
            if (isDesktop) {
                await openInBrowser(loginUrl);
                setIsLoading(false);
                setIsWaitingForAuth(true);
            } else {
                // Web mode - redirect in same window
                window.location.href = loginUrl;
            }
        } catch (err) {
            console.error('Email sign-in error:', err);
            setError(t('auth.emailSignInError'));
            setIsLoading(false);
        }
    };

    // Show waiting state when authenticating in external browser
    if (isWaitingForAuth) {
        return (
            <div className="login-page">
                <div className="login-card">
                    <div className="login-header">
                        <div className="login-logo">
                            <img src={logoUrl} alt={t('common.pipali')} width="64" height="64" />
                        </div>
                        <h1>{t('auth.completeSignIn')}</h1>
                        <p>{t('auth.finishSignInBrowser')}</p>
                    </div>

                    <div className="login-waiting">
                        <Loader2 size={32} className="spinning" />
                        <p>{t('auth.waitingForAuth')}</p>
                    </div>

                    <div className="login-buttons">
                        <button
                            className="login-btn secondary"
                            onClick={() => setIsWaitingForAuth(false)}
                        >
                            {t('common.cancel')}
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="login-page">
            <div className="login-card">
                <div className="login-header">
                    <div className="login-logo">
                        <img src={logoUrl} alt={t('common.pipali')} width="64" height="64" />
                    </div>
                    <h1>{t('auth.welcome')}</h1>
                    <p>{t('auth.signInToContinue')}</p>
                </div>

                {error && (
                    <div className="login-error">
                        {error}
                    </div>
                )}

                {/* Local account: username + password with a one-time email code */}
                {localMode === 'verify' ? (
                    <form className="login-local-form" onSubmit={handleVerifyOtp}>
                        <div className="form-group">
                            <label htmlFor="login-otp">{t('auth.otpLabel', 'Verification code')}</label>
                            <input
                                id="login-otp"
                                type="text"
                                inputMode="numeric"
                                autoComplete="one-time-code"
                                maxLength={6}
                                placeholder="123456"
                                value={otpCode}
                                onChange={e => setOtpCode(e.target.value.replace(/\D/g, ''))}
                                autoFocus
                            />
                            <span className="form-hint">{t('auth.otpHint', 'We emailed you a 6-digit code. Enter it to verify your account.')}</span>
                        </div>
                        <button className="login-btn email" type="submit" disabled={isLoading || otpCode.length !== 6}>
                            {isLoading ? <Loader2 size={20} className="spinning" /> : <span>{t('auth.verify', 'Verify')}</span>}
                        </button>
                        <button
                            className="login-btn secondary"
                            type="button"
                            onClick={handleResendOtp}
                            disabled={resendCooldown > 0}
                        >
                            {resendCooldown > 0
                                ? t('auth.resendIn', { seconds: resendCooldown, defaultValue: 'Resend code in {{seconds}}s' })
                                : t('auth.resendCode', 'Resend code')}
                        </button>
                        <button className="login-link-btn" type="button" onClick={() => { setLocalMode(localAuth?.enabled ? 'signin' : 'signup'); setError(null); }}>
                            {t('common.back', 'Back')}
                        </button>
                    </form>
                ) : localMode === 'signin' ? (
                    <form className="login-local-form" onSubmit={handleLocalSignIn}>
                        <div className="form-group">
                            <label htmlFor="login-username">{t('auth.username', 'Username')}</label>
                            <input
                                id="login-username"
                                type="text"
                                autoComplete="username"
                                value={username}
                                onChange={e => setUsername(e.target.value)}
                                autoFocus
                            />
                        </div>
                        <div className="form-group">
                            <label htmlFor="login-password">{t('auth.password', 'Password')}</label>
                            <input
                                id="login-password"
                                type="password"
                                autoComplete="current-password"
                                value={password}
                                onChange={e => setPassword(e.target.value)}
                            />
                        </div>
                        <button className="login-btn email" type="submit" disabled={isLoading || !username.trim() || !password}>
                            {isLoading ? <Loader2 size={20} className="spinning" /> : <span>{t('auth.signIn', 'Sign in')}</span>}
                        </button>
                        {!localAuth?.enabled && (
                            <button className="login-link-btn" type="button" onClick={() => { setLocalMode('signup'); setError(null); }}>
                                {t('auth.needAccount', "Don't have an account? Create one")}
                            </button>
                        )}
                    </form>
                ) : (
                    <form className="login-local-form" onSubmit={handleLocalRegister}>
                        <div className="form-group">
                            <label htmlFor="signup-username">{t('auth.username', 'Username')}</label>
                            <input
                                id="signup-username"
                                type="text"
                                autoComplete="username"
                                value={username}
                                onChange={e => setUsername(e.target.value)}
                                autoFocus
                            />
                        </div>
                        <div className="form-group">
                            <label htmlFor="signup-email">{t('auth.email', 'Email')}</label>
                            <input
                                id="signup-email"
                                type="email"
                                autoComplete="email"
                                value={email}
                                onChange={e => setEmail(e.target.value)}
                            />
                            <span className="form-hint">{t('auth.emailHint', "We'll send a one-time code to verify your email.")}</span>
                        </div>
                        <div className="form-group">
                            <label htmlFor="signup-password">{t('auth.password', 'Password')}</label>
                            <input
                                id="signup-password"
                                type="password"
                                autoComplete="new-password"
                                minLength={8}
                                value={password}
                                onChange={e => setPassword(e.target.value)}
                            />
                            <span className="form-hint">{t('auth.passwordHint', 'At least 8 characters.')}</span>
                        </div>
                        <button className="login-btn email" type="submit" disabled={isLoading || !username.trim() || !email.trim() || password.length < 8}>
                            {isLoading ? <Loader2 size={20} className="spinning" /> : <span>{t('auth.createAccount', 'Create account')}</span>}
                        </button>
                        <button className="login-link-btn" type="button" onClick={() => { setLocalMode('signin'); setError(null); }}>
                            {t('auth.haveAccount', 'Already have an account? Sign in')}
                        </button>
                    </form>
                )}

                {(authCapabilities?.googleEnabled || authCapabilities?.emailEnabled) && !localAuth?.enabled && localMode !== 'verify' && (
                    <div className="login-divider">
                        <span>{t('common.or')}</span>
                    </div>
                )}

                {!localAuth?.enabled && localMode !== 'verify' && (
                <div className="login-buttons">
                    {authCapabilities?.googleEnabled && (
                        <button
                            className="login-btn google"
                            onClick={handleGoogleSignIn}
                            disabled={isLoading}
                        >
                            {isLoading ? (
                                <Loader2 size={20} className="spinning" />
                            ) : (
                                <svg width="20" height="20" viewBox="0 0 24 24">
                                    <path
                                        fill="currentColor"
                                        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                                    />
                                    <path
                                        fill="currentColor"
                                        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                                    />
                                    <path
                                        fill="currentColor"
                                        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                                    />
                                    <path
                                        fill="currentColor"
                                        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                                    />
                                </svg>
                            )}
                            <span>{t('auth.continueWithGoogle')}</span>
                        </button>
                    )}

                    {authCapabilities?.googleEnabled && authCapabilities?.emailEnabled && (
                        <div className="login-divider">
                            <span>{t('common.or')}</span>
                        </div>
                    )}

                    {authCapabilities?.emailEnabled && (
                        <button
                            className="login-btn email"
                            onClick={handleEmailSignIn}
                            disabled={isLoading}
                        >
                            {isLoading ? (
                                <Loader2 size={20} className="spinning" />
                            ) : (
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <rect x="2" y="4" width="20" height="16" rx="2" />
                                    <path d="M22 7l-10 6L2 7" />
                                </svg>
                            )}
                            <span>{t('auth.continueWithEmail')}</span>
                        </button>
                    )}
                </div>
                )}

                <div className="login-footer">
                    <p>
                        {t('auth.termsNotice')}
                    </p>
                </div>
            </div>
        </div>
    );
}
