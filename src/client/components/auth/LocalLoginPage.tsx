import { useEffect, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { apiFetch, getApiBaseUrl } from '../../utils/api';

type LocalAuthMode = 'loading' | 'setup' | 'login' | 'otp';

interface LocalLoginPageProps {
    onLoginSuccess: () => void;
}

export function LocalLoginPage({ onLoginSuccess }: LocalLoginPageProps) {
    const [mode, setMode] = useState<LocalAuthMode>('loading');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [name, setName] = useState('');
    const [code, setCode] = useState('');
    const [message, setMessage] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [resendCountdown, setResendCountdown] = useState(0);
    const logoUrl = `${getApiBaseUrl()}/icons/pipali_128.png`;

    useEffect(() => {
        apiFetch('/api/auth/local/status')
            .then((res) => res.ok ? res.json() : Promise.reject())
            .then((status: { enabled: boolean; needsSetup: boolean }) => {
                setMode(status.needsSetup ? 'setup' : 'login');
            })
            .catch(() => {
                setError('Unable to load local login status.');
                setMode('login');
            });
    }, []);

    useEffect(() => {
        if (resendCountdown <= 0) return;
        const timer = window.setTimeout(() => setResendCountdown(resendCountdown - 1), 1000);
        return () => window.clearTimeout(timer);
    }, [resendCountdown]);

    const submitSetup = async (event: FormEvent) => {
        event.preventDefault();
        setIsLoading(true);
        setError(null);
        setMessage(null);

        try {
            const res = await apiFetch('/api/auth/local/setup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password, name }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Setup failed');

            if (data.authenticated) {
                onLoginSuccess();
                return;
            }

            setMessage('Account created. Sign in to receive your verification code.');
            setMode('login');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Setup failed');
        } finally {
            setIsLoading(false);
        }
    };

    const requestOtp = async (event?: FormEvent) => {
        event?.preventDefault();
        setIsLoading(true);
        setError(null);
        setMessage(null);

        try {
            const res = await apiFetch('/api/auth/local/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                if (res.status === 429) {
                    setMessage(data.error || 'A code was already sent. Please wait before requesting another one.');
                    setResendCountdown(60);
                    setMode('otp');
                    return;
                }
                throw new Error(data.error || 'Unable to request a verification code');
            }

            setMessage(data.message || 'If the credentials are valid, a verification code will be emailed shortly.');
            setCode('');
            setResendCountdown(60);
            setMode('otp');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unable to request a verification code');
        } finally {
            setIsLoading(false);
        }
    };

    const verifyOtp = async (event: FormEvent) => {
        event.preventDefault();
        setIsLoading(true);
        setError(null);

        try {
            const res = await apiFetch('/api/auth/local/verify-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, code }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Verification failed');

            onLoginSuccess();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Verification failed');
        } finally {
            setIsLoading(false);
        }
    };

    const title = mode === 'setup'
        ? 'Set up local login'
        : mode === 'otp'
            ? 'Enter verification code'
            : 'Sign in to Superjoy';
    const subtitle = mode === 'setup'
        ? 'Create the first local account for this server.'
        : mode === 'otp'
            ? 'Check your email for a 6-digit code.'
            : 'Use your local account password to receive an email code.';

    return (
        <div className="login-page">
            <div className="login-card">
                <div className="login-header">
                    <div className="login-logo">
                        <img src={logoUrl} alt="Superjoy" width="64" height="64" />
                    </div>
                    <h1>{title}</h1>
                    <p>{subtitle}</p>
                </div>

                {error && <div className="login-error">{error}</div>}
                {message && <div className="login-message">{message}</div>}

                {mode === 'loading' && (
                    <div className="login-waiting">
                        <Loader2 size={32} className="spinning" />
                        <p>Loading local login…</p>
                    </div>
                )}

                {mode === 'setup' && (
                    <form className="local-login-form" onSubmit={submitSetup}>
                        <label>
                            Name <span>optional</span>
                            <input
                                type="text"
                                value={name}
                                onChange={(event) => setName(event.target.value)}
                                autoComplete="name"
                            />
                        </label>
                        <label>
                            Email
                            <input
                                type="email"
                                value={email}
                                onChange={(event) => setEmail(event.target.value)}
                                autoComplete="email"
                                required
                            />
                        </label>
                        <label>
                            Password
                            <input
                                type="password"
                                value={password}
                                onChange={(event) => setPassword(event.target.value)}
                                autoComplete="new-password"
                                required
                            />
                        </label>
                        <button className="login-btn email" type="submit" disabled={isLoading}>
                            {isLoading ? <Loader2 size={20} className="spinning" /> : 'Create account'}
                        </button>
                    </form>
                )}

                {mode === 'login' && (
                    <form className="local-login-form" onSubmit={requestOtp}>
                        <label>
                            Email
                            <input
                                type="email"
                                value={email}
                                onChange={(event) => setEmail(event.target.value)}
                                autoComplete="email"
                                required
                            />
                        </label>
                        <label>
                            Password
                            <input
                                type="password"
                                value={password}
                                onChange={(event) => setPassword(event.target.value)}
                                autoComplete="current-password"
                                required
                            />
                        </label>
                        <button className="login-btn email" type="submit" disabled={isLoading}>
                            {isLoading ? <Loader2 size={20} className="spinning" /> : 'Email verification code'}
                        </button>
                    </form>
                )}

                {mode === 'otp' && (
                    <form className="local-login-form" onSubmit={verifyOtp}>
                        <label>
                            Verification code
                            <input
                                className="local-login-code-input"
                                type="text"
                                inputMode="numeric"
                                pattern="[0-9]{6}"
                                maxLength={6}
                                value={code}
                                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                                autoComplete="one-time-code"
                                required
                            />
                        </label>
                        <button className="login-btn email" type="submit" disabled={isLoading || code.length !== 6}>
                            {isLoading ? <Loader2 size={20} className="spinning" /> : 'Verify and sign in'}
                        </button>
                        <button
                            className="login-btn secondary"
                            type="button"
                            disabled={isLoading || resendCountdown > 0}
                            onClick={() => requestOtp()}
                        >
                            {resendCountdown > 0 ? `Resend in ${resendCountdown}s` : 'Resend code'}
                        </button>
                        <button
                            className="local-login-link"
                            type="button"
                            onClick={() => setMode('login')}
                        >
                            Use a different email
                        </button>
                    </form>
                )}
            </div>
        </div>
    );
}
