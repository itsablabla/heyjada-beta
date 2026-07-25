// Empty state when no skills are available

import React from 'react';
import { ScrollText } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function SkillsEmpty() {
    const { t } = useTranslation();
    return (
        <div className="empty-state skills-empty">
            <ScrollText className="empty-icon" size={32} strokeWidth={1.5} />
            <h2>{t('skills.noSkillsTitle')}</h2>
            <p>{t('skills.noSkillsDescription')}</p>
            <p className="empty-hint">
                {t('skills.noSkillsHint')}<code>{t('skills.skillMdFile')}</code>{t('skills.fileIn')}
            </p>
            <ul className="skills-paths">
                <li><code>{t('skills.globalPath')}</code>{t('skills.globalLabel')}</li>
                <li><code>{t('skills.localPath')}</code>{t('skills.localLabel')}</li>
            </ul>
        </div>
    );
}
