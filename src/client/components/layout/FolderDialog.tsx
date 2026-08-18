// In-app dialog for creating, renaming and deleting conversation folders.
// Native window.prompt/window.confirm are unavailable in the desktop WebView
// (they silently return null), so folders need a real modal to work everywhere.

import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ConversationFolder } from '../../types';

export type FolderDialogRequest =
    | { mode: 'create'; parentId: string | null }
    | { mode: 'rename'; folder: ConversationFolder }
    | { mode: 'delete'; folder: ConversationFolder };

interface FolderDialogProps {
    request: FolderDialogRequest;
    onSubmit: (name: string) => void | Promise<void>;
    onClose: () => void;
}

export function FolderDialog({ request, onSubmit, onClose }: FolderDialogProps) {
    const { t } = useTranslation();
    const inputRef = useRef<HTMLInputElement>(null);
    const [name, setName] = useState(request.mode === 'rename' ? request.folder.name : '');

    useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, []);

    const title = request.mode === 'create'
        ? (request.parentId
            ? t('folders.subfolderNamePrompt', 'Subfolder name')
            : t('folders.folderNamePrompt', 'Folder name'))
        : request.mode === 'rename'
            ? t('folders.renameFolderPrompt', 'Rename folder')
            : t('folders.deleteFolder', 'Delete folder');

    const trimmed = name.trim();
    const canSubmit = request.mode === 'delete'
        || (trimmed.length > 0 && (request.mode !== 'rename' || trimmed !== request.folder.name));

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!canSubmit) return;
        await onSubmit(trimmed.slice(0, 100));
        onClose();
    };

    const handleBackdropClick = (e: React.MouseEvent) => {
        if (e.target === e.currentTarget) {
            onClose();
        }
    };

    return (
        <div className="modal-backdrop" onClick={handleBackdropClick}>
            <div className="modal folder-dialog" role="dialog" aria-modal="true" aria-label={title}>
                <div className="modal-header">
                    <h2>{title}</h2>
                    <button onClick={onClose} className="modal-close" aria-label={t('common.close', 'Close')}>
                        <X size={18} />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="folder-dialog-form">
                    {request.mode === 'delete' ? (
                        <p className="delete-confirm-text">
                            {t('folders.deleteFolderConfirm', 'Delete this folder? Subfolders will be deleted and chats will become unfiled.')}
                        </p>
                    ) : (
                        <div className="form-group">
                            <input
                                ref={inputRef}
                                type="text"
                                value={name}
                                maxLength={100}
                                onChange={(e) => setName(e.target.value)}
                                placeholder={t('folders.folderNamePlaceholder', 'e.g. Projects')}
                                onKeyDown={(e) => {
                                    if (e.key === 'Escape') onClose();
                                }}
                            />
                        </div>
                    )}

                    <div className="modal-actions">
                        <button type="button" onClick={onClose} className="btn-secondary">
                            {t('common.cancel')}
                        </button>
                        <button
                            type="submit"
                            disabled={!canSubmit}
                            className={request.mode === 'delete' ? 'btn-danger' : 'btn-primary'}
                        >
                            {request.mode === 'delete'
                                ? t('folders.deleteFolder', 'Delete folder')
                                : request.mode === 'rename'
                                    ? t('folders.renameFolderPrompt', 'Rename folder')
                                    : t('folders.newFolder', 'New folder')}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
