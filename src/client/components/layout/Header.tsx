// Mobile-only app header - on desktop the logo and sidebar toggle live in the sidebar

import { PanelLeftClose, PanelLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Logo } from './Logo';

interface HeaderProps {
    sidebarOpen: boolean;
    onToggleSidebar: () => void;
    onGoHome: () => void;
}

export function Header({
    sidebarOpen,
    onToggleSidebar,
    onGoHome,
}: HeaderProps) {
    const { t } = useTranslation();
    return (
        <header className="header">
            <div className="header-content">
                <div className="header-left">
                    <button
                        className="sidebar-toggle"
                        onClick={onToggleSidebar}
                        aria-label={sidebarOpen ? t('sidebar.collapseSidebar') : t('sidebar.expandSidebar')}
                        aria-expanded={sidebarOpen}
                    >
                        {sidebarOpen ? <PanelLeftClose size={20} /> : <PanelLeft size={20} />}
                    </button>
                    <Logo onClick={onGoHome} />
                </div>
            </div>
        </header>
    );
}
