import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { apiFetch } from '../../utils/api';
import { LoginPage as PlatformLoginPage } from './LoginPage';
import { LocalLoginPage } from './LocalLoginPage';

interface LoginPageSelectorProps {
    onLoginSuccess: () => void;
}

export function LoginPageSelector({ onLoginSuccess }: LoginPageSelectorProps) {
    const [localEnabled, setLocalEnabled] = useState<boolean | null>(null);

    useEffect(() => {
        apiFetch('/api/auth/local/status')
            .then((res) => res.ok ? res.json() : Promise.reject())
            .then((status: { enabled: boolean }) => setLocalEnabled(status.enabled))
            .catch(() => setLocalEnabled(false));
    }, []);

    if (localEnabled === null) {
        return (
            <div className="login-page">
                <div className="login-card">
                    <div className="login-waiting">
                        <Loader2 size={32} className="spinning" />
                        <p>Loading login…</p>
                    </div>
                </div>
            </div>
        );
    }

    if (localEnabled) {
        return <LocalLoginPage onLoginSuccess={onLoginSuccess} />;
    }

    return <PlatformLoginPage onLoginSuccess={onLoginSuccess} />;
}
