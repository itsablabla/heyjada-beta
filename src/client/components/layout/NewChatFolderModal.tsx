/**
 * Folder picker shown when a new chat is opened. Lets the user file the
 * upcoming conversation into an existing folder, create a new folder for it,
 * or continue without a folder.
 */
import { useMemo, useState } from 'react';
import { Folder, FolderPlus, MessageSquare, X, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ConversationFolder } from '../../types';

interface NewChatFolderModalProps {
    folders: ConversationFolder[];
    onSelect: (folderId: string | null) => void;
    /** Creates a folder and returns its ID, or null on failure */
    onCreateFolder: (name: string) => Promise<string | null>;
    onClose: () => void;
}

export function NewChatFolderModal({ folders, onSelect, onCreateFolder, onClose }: NewChatFolderModalProps) {
    const { t } = useTranslation();
    const [creatingFolder, setCreatingFolder] = useState(false);
    const [newFolderName, setNewFolderName] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [createError, setCreateError] = useState(false);

    // Flatten the folder tree (children under parents) for an indented list
    const flatFolders = useMemo(() => {
        const childrenByParent = new Map<string | null, ConversationFolder[]>();
        for (const folder of folders) {
            const key = folder.parentId ?? null;
            const group = childrenByParent.get(key) ?? [];
            group.push(folder);
            childrenByParent.set(key, group);
        }
        for (const group of childrenByParent.values()) {
            group.sort((a, b) => a.name.localeCompare(b.name));
        }
        const flat: Array<{ folder: ConversationFolder; depth: number }> = [];
        const walk = (parentId: string | null, depth: number) => {
            for (const folder of childrenByParent.get(parentId) ?? []) {
                flat.push({ folder, depth });
                walk(folder.id, depth + 1);
            }
        };
        walk(null, 0);
        return flat;
    }, [folders]);

    const submitNewFolder = async () => {
        const name = newFolderName.trim();
        if (!name || isSubmitting) return;
        setIsSubmitting(true);
        setCreateError(false);
        const folderId = await onCreateFolder(name.slice(0, 100));
        setIsSubmitting(false);
        if (folderId) {
            onSelect(folderId);
        } else {
            setCreateError(true);
        }
    };

    return (
        <div className="modal-backdrop" onClick={onClose}>
            <div
                className="modal new-chat-folder-modal"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label={t('folders.newChatTitle', 'Where should this chat go?')}
            >
                <div className="modal-header">
                    <h2>{t('folders.newChatTitle', 'Where should this chat go?')}</h2>
                    <button className="modal-close" onClick={onClose} aria-label={t('common.close', 'Close')}>
                        <X size={18} />
                    </button>
                </div>

                <div className="new-chat-folder-options">
                    <button
                        className="new-chat-folder-option"
                        onClick={() => onSelect(null)}
                    >
                        <MessageSquare size={16} />
                        <span>{t('folders.withoutFolder', 'Without a folder')}</span>
                    </button>

                    {flatFolders.map(({ folder, depth }) => (
                        <button
                            key={folder.id}
                            className="new-chat-folder-option"
                            style={{ paddingLeft: 16 + Math.min(depth, 6) * 16 }}
                            onClick={() => onSelect(folder.id)}
                        >
                            <Folder size={16} />
                            <span>{folder.name}</span>
                        </button>
                    ))}

                    {creatingFolder ? (
                        <div className="new-chat-folder-create">
                            <input
                                type="text"
                                value={newFolderName}
                                placeholder={t('folders.folderNamePrompt', 'Folder name')}
                                onChange={(e) => setNewFolderName(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') void submitNewFolder();
                                    if (e.key === 'Escape') setCreatingFolder(false);
                                }}
                                maxLength={100}
                                autoFocus
                            />
                            <button
                                className="new-chat-folder-create-btn"
                                onClick={() => void submitNewFolder()}
                                disabled={!newFolderName.trim() || isSubmitting}
                            >
                                {isSubmitting ? <Loader2 size={14} className="spinning" /> : t('common.create', 'Create')}
                            </button>
                        </div>
                    ) : (
                        <button
                            className="new-chat-folder-option new-folder"
                            onClick={() => setCreatingFolder(true)}
                        >
                            <FolderPlus size={16} />
                            <span>{t('folders.newFolder', 'New folder')}</span>
                        </button>
                    )}
                    {createError && (
                        <div className="form-hint error">{t('folders.createFolderError', 'Failed to create folder. Please try again.')}</div>
                    )}
                </div>
            </div>
        </div>
    );
}
