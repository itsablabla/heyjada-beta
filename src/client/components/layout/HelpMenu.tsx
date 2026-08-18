// Help & feedback section for the sidebar footer:
// - a hoverable explainer that shows the app's main features and how to use them
// - a help chat entry point that starts a guided conversation with the assistant
// - an always-visible button to leave feedback

import { useEffect, useRef, useState } from 'react';
import { HelpCircle, MessageCircleQuestion, MessagesSquare, Megaphone, Mic, ScrollText, Clock, Hammer, Folder } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { openInBrowser } from '../../utils/tauri';

const FEEDBACK_URL = 'https://github.com/itsablabla/heyjada-beta/issues/new';

interface HelpMenuProps {
    /** Whether the sidebar is expanded (labels visible) or collapsed to the icon rail. */
    isOpen: boolean;
    /** Start a new help chat conversation with the assistant. */
    onStartHelpChat: () => void;
}

export function HelpMenu({ isOpen, onStartHelpChat }: HelpMenuProps) {
    const { t } = useTranslation();
    const [explainerVisible, setExplainerVisible] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    // Close the explainer when clicking or focusing outside (for touch/keyboard users)
    useEffect(() => {
        if (!explainerVisible) return;
        const handlePointerDown = (e: MouseEvent | TouchEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setExplainerVisible(false);
            }
        };
        document.addEventListener('mousedown', handlePointerDown);
        document.addEventListener('touchstart', handlePointerDown);
        return () => {
            document.removeEventListener('mousedown', handlePointerDown);
            document.removeEventListener('touchstart', handlePointerDown);
        };
    }, [explainerVisible]);

    const iconOnly = (label: string) => (isOpen ? {} : { title: label, 'aria-label': label });

    const features = [
        { icon: <MessagesSquare size={14} />, title: t('help.featureChatTitle'), text: t('help.featureChatText') },
        { icon: <Mic size={14} />, title: t('help.featureVoiceTitle'), text: t('help.featureVoiceText') },
        { icon: <ScrollText size={14} />, title: t('help.featureSkillsTitle'), text: t('help.featureSkillsText') },
        { icon: <Clock size={14} />, title: t('help.featureRoutinesTitle'), text: t('help.featureRoutinesText') },
        { icon: <Hammer size={14} />, title: t('help.featureToolsTitle'), text: t('help.featureToolsText') },
        { icon: <Folder size={14} />, title: t('help.featureFoldersTitle'), text: t('help.featureFoldersText') },
    ];

    return (
        <div className="sidebar-help-section" ref={containerRef}>
            <div
                className="help-explainer-container"
                onMouseEnter={() => setExplainerVisible(true)}
                onMouseLeave={() => setExplainerVisible(false)}
            >
                <button
                    className="sidebar-nav-btn help-explainer-btn"
                    onClick={() => setExplainerVisible(prev => !prev)}
                    aria-expanded={explainerVisible}
                    {...iconOnly(t('help.whatCanItDo'))}
                >
                    <HelpCircle size={16} />
                    <span>{t('help.whatCanItDo')}</span>
                </button>

                {explainerVisible && (
                    <div className="help-explainer-popover" role="tooltip">
                        <div className="help-explainer-title">{t('help.explainerTitle')}</div>
                        <ul className="help-explainer-features">
                            {features.map((feature, i) => (
                                <li key={i}>
                                    <span className="help-explainer-feature-icon">{feature.icon}</span>
                                    <span>
                                        <strong>{feature.title}</strong> — {feature.text}
                                    </span>
                                </li>
                            ))}
                        </ul>
                        <div className="help-explainer-howto">{t('help.howToUse')}</div>
                    </div>
                )}
            </div>

            <button
                className="sidebar-nav-btn"
                onClick={onStartHelpChat}
                {...iconOnly(t('help.helpChat'))}
            >
                <MessageCircleQuestion size={16} />
                <span>{t('help.helpChat')}</span>
            </button>

            <button
                className="sidebar-nav-btn feedback-btn"
                onClick={() => openInBrowser(FEEDBACK_URL)}
                {...iconOnly(t('help.leaveFeedback'))}
            >
                <Megaphone size={16} />
                <span>{t('help.leaveFeedback')}</span>
            </button>
        </div>
    );
}
