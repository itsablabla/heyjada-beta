// Dismissible picker shown when starting a new chat: file the upcoming chat
// into an existing folder, create a new folder inline, or skip (unfiled).
// It never blocks chat creation — the user can keep typing and sending while
// it is open, and Esc/Skip simply dismiss it.

import React, { useEffect, useRef, useState } from 'react';
import { Folder, FolderPlus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ConversationFolder } from '../../types';
import { apiFetch } from '../../utils/api';

export const NEW_CHAT_FOLDER_DONT_ASK_KEY = 'heyjada.newChatFolderPrompt.dontAsk.v1';

interface NewChatFolderPromptProps {
    folders: ConversationFolder[];
    /** Called with a folder id (or null for "no folder"); dismisses the prompt. */
    onPick: (folderId: string | null) => void;
    /** Dismiss without picking — the chat stays unfiled. */
    onSkip: () => void;
    /** Refresh the folder list after an inline create. */
    onFoldersChanged: () => void;
}

export function NewChatFolderPrompt({ folders, onPick, onSkip, onFoldersChanged }: NewChatFolderPromptProps) {
    const { t } = useTranslation();
    const [creating, setCreating] = useState(false);
    const [newFolderName, setNewFolderName] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [dontAskAgain, setDontAskAgain] = useState(false);
    const createInputRef = useRef<HTMLInputElement>(null);

    // Esc dismisses the prompt (files the chat as unfiled)
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                onSkip();
            }
        };
        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
    }, [onSkip]);

    useEffect(() => {
        if (creating) requestAnimationFrame(() => createInputRef.current?.focus());
    }, [creating]);

    const persistDontAskAgain = (value: boolean) => {
        setDontAskAgain(value);
        try {
            if (value) localStorage.setItem(NEW_CHAT_FOLDER_DONT_ASK_KEY, 'true');
            else localStorage.removeItem(NEW_CHAT_FOLDER_DONT_ASK_KEY);
        } catch { /* storage unavailable */ }
    };

    const createFolderInline = async () => {
        const name = newFolderName.trim().slice(0, 100);
        if (!name || isSubmitting) return;
        setIsSubmitting(true);
        try {
            const res = await apiFetch('/api/folders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, parentId: null }),
            });
            if (res.ok) {
                const data = await res.json();
                onFoldersChanged();
                onPick(data.folder?.id ?? null);
                return;
            }
        } catch (e) {
            console.error('Failed to create folder', e);
        } finally {
            setIsSubmitting(false);
        }
    };

    const sortedFolders = [...folders].sort((a, b) => a.name.localeCompare(b.name));

    return (
        <div className="new-chat-folder-prompt" role="dialog" aria-label={t('folders.newChatPromptTitle', 'Save this chat to a folder?')}>
            <div className="new-chat-folder-prompt-header">
                <span className="new-chat-folder-prompt-title">
                    {t('folders.newChatPromptTitle', 'Save this chat to a folder?')}
                </span>
                <button
                    className="new-chat-folder-prompt-close"
                    onClick={onSkip}
                    aria-label={t('common.skip', 'Skip')}
                >
                    <X size={14} />
                </button>
            </div>

            <div className="new-chat-folder-prompt-options">
                {sortedFolders.map(folder => (
                    <button
                        key={folder.id}
                        className="new-chat-folder-prompt-option"
                        onClick={() => onPick(folder.id)}
                    >
                        <Folder size={14} />
                        <span>{folder.name}</span>
                    </button>
                ))}

                {creating ? (
                    <div className="new-chat-folder-prompt-create">
                        <input
                            ref={createInputRef}
                            value={newFolderName}
                            onChange={(e) => setNewFolderName(e.target.value)}
                            onKeyDown={(e) => {
                                e.stopPropagation();
                                if (e.key === 'Enter') void createFolderInline();
                                if (e.key === 'Escape') setCreating(false);
                            }}
                            placeholder={t('folders.folderNamePrompt', 'Folder name')}
                            maxLength={100}
                        />
                        <button
                            onClick={() => void createFolderInline()}
                            disabled={!newFolderName.trim() || isSubmitting}
                        >
                            {t('common.create', 'Create')}
                        </button>
                    </div>
                ) : (
                    <button
                        className="new-chat-folder-prompt-option"
                        onClick={() => setCreating(true)}
                    >
                        <FolderPlus size={14} />
                        <span>{t('folders.newFolder', 'New folder')}</span>
                    </button>
                )}
            </div>

            <div className="new-chat-folder-prompt-footer">
                <label className="new-chat-folder-prompt-dont-ask">
                    <input
                        type="checkbox"
                        checked={dontAskAgain}
                        onChange={(e) => persistDontAskAgain(e.target.checked)}
                    />
                    <span>{t('folders.dontAskAgain', "Don't ask again")}</span>
                </label>
                <button className="new-chat-folder-prompt-skip" onClick={onSkip}>
                    {t('common.skip', 'Skip')}
                </button>
            </div>
        </div>
    );
}
