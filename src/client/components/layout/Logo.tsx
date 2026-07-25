// Clickable Pipali wordmark - lives in the sidebar on desktop, the header on mobile

import { useTranslation } from 'react-i18next';
import { getApiBaseUrl } from '../../utils/api';

interface LogoProps {
    onClick: () => void;
}

export function Logo({ onClick }: LogoProps) {
    const { t } = useTranslation();
    return (
        <div
            className="logo clickable"
            onClick={onClick}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onClick();
                }
            }}
        >
            <img src={`${getApiBaseUrl()}/icons/pipali_64.png`} alt={t('common.pipali')} className="logo-icon" />
            <span className="logo-text">{t('common.pipali')}</span>
        </div>
    );
}
