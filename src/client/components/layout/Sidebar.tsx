// Sidebar with conversation list, collapsible to an icon rail

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Loader2, MessageSquare, AlertCircle, CheckCircle, Plus, MoreVertical, Trash2, ChevronRight, ChevronDown, Search, X, ScrollText, Clock, Hammer, Settings, LogOut, Shield, Sun, Moon, Monitor, Pencil, Pin, PinOff, Copy, Link, FileText, Gift, PanelLeft, PanelLeftClose, Folder, FolderOpen, FolderPlus } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { ConversationFolder, ConversationSummary, ConversationState, ConfirmationRequest, AuthStatus, BillingAlert } from '../../types';
import { useTheme } from '../../hooks';
import { BillingAlertBanner } from '../billing';
import { Logo } from './Logo';
import { apiFetch } from '../../utils/api';

import { MOD_KEY } from '../../utils/platform';
import { openInBrowser } from '../../utils/tauri';
import { useTranslation } from 'react-i18next';

const MAX_VISIBLE_CHATS = 5;
const EXPANDED_FOLDERS_STORAGE_KEY = 'heyjada.sidebar.expandedFolders.v1';

type FolderTreeNode = ConversationFolder & {
    children: FolderTreeNode[];
};

/**
 * Generate a Gravatar URL from an email address.
 * Falls back to a 404 if no Gravatar exists (so we can detect and show initials).
 */
async function getGravatarUrl(email: string, size = 64): Promise<string> {
    const trimmedEmail = email.trim().toLowerCase();
    const encoder = new TextEncoder();
    const data = encoder.encode(trimmedEmail);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    // d=404 returns a 404 if no Gravatar exists, allowing us to fall back to initials
    return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=404`;
}

/**
 * Get user initial from name or email for avatar fallback.
 */
function getUserInitial(name?: string, email?: string): string {
    if (name) {
        return name.charAt(0).toUpperCase();
    }
    if (email) {
        return email.charAt(0).toUpperCase();
    }
    return '?';
}

interface SidebarProps {
    isOpen: boolean;
    conversations: ConversationSummary[];
    folders: ConversationFolder[];
    conversationStates: Map<string, ConversationState>;
    pendingConfirmations: Map<string, ConfirmationRequest[]>;
    currentConversationId?: string;
    copyingConversationId: string | null;
    currentPage?: 'home' | 'chat' | 'skills' | 'automations' | 'mcp-tools' | 'settings';
    authStatus?: AuthStatus | null;
    userName?: string;
    billingAlerts?: BillingAlert[];
    platformFrontendUrl?: string;
    onNewChat: () => void;
    onSelectConversation: (id: string, highlightTerm?: string) => void;
    onDeleteConversation: (id: string, e: React.MouseEvent) => void;
    onCopyConversationLink: (id: string) => void;
    onCopyConversationChat: (id: string) => void;
    onCopyConversationRaw: (id: string) => void;
    onRenameConversation: (id: string, title: string) => Promise<boolean>;
    onPinConversation: (id: string, isPinned: boolean) => void;
    onCreateFolder: (name: string, parentId?: string | null) => Promise<boolean>;
    onRenameFolder: (id: string, name: string) => Promise<boolean>;
    onDeleteFolder: (id: string) => Promise<boolean>;
    onMoveConversationToFolder: (conversationId: string, folderId: string | null) => Promise<boolean>;
    onGoToSkills?: () => void;
    onGoToAutomations?: () => void;
    onGoToMcpTools?: () => void;
    onGoToSettings?: () => void;
    onGoHome: () => void;
    onLogout?: () => void;
    onClose?: () => void;
    onExpand?: () => void;
    onDismissAllBillingAlerts?: () => void;
}

export function Sidebar({
    isOpen,
    conversations,
    folders,
    conversationStates,
    pendingConfirmations,
    currentConversationId,
    copyingConversationId,
    currentPage,
    authStatus,
    userName,
    billingAlerts,
    platformFrontendUrl,
    onNewChat,
    onSelectConversation,
    onDeleteConversation,
    onCopyConversationLink,
    onCopyConversationChat,
    onCopyConversationRaw,
    onRenameConversation,
    onPinConversation,
    onCreateFolder,
    onRenameFolder,
    onDeleteFolder,
    onMoveConversationToFolder,
    onGoToSkills,
    onGoToAutomations,
    onGoToMcpTools,
    onGoToSettings,
    onGoHome,
    onLogout,
    onClose,
    onExpand,
    onDismissAllBillingAlerts,
}: SidebarProps) {
    const [openConversationMenuId, setOpenConversationMenuId] = useState<string | null>(null);
    const [openMenuContext, setOpenMenuContext] = useState<'sidebar' | 'modal' | null>(null);
    const [showCopySubmenu, setShowCopySubmenu] = useState(false);
    const [showMoveSubmenu, setShowMoveSubmenu] = useState(false);
    const [openFolderMenuId, setOpenFolderMenuId] = useState<string | null>(null);
    const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => {
        try {
            const stored = JSON.parse(localStorage.getItem(EXPANDED_FOLDERS_STORAGE_KEY) ?? '[]');
            return new Set(Array.isArray(stored) ? stored as string[] : []);
        } catch {
            return new Set();
        }
    });
    const [showAllChatsModal, setShowAllChatsModal] = useState(false);
    const [showUserMenu, setShowUserMenu] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [searchResults, setSearchResults] = useState<ConversationSummary[] | null>(null);
    const [isSearching, setIsSearching] = useState(false);
    const [renamingConversationId, setRenamingConversationId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState('');
    const renameInputRef = useRef<HTMLInputElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const [gravatarUrl, setGravatarUrl] = useState<string | null>(null);
    const [gravatarFailed, setGravatarFailed] = useState(false);
    const [showChangelog, setShowChangelog] = useState(false);
    const [changelogNotes, setChangelogNotes] = useState<string | null>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const { theme, setTheme, isDark } = useTheme();
    const { t } = useTranslation();

    // Load Gravatar URL when user email is available but no profile picture
    const userEmail = authStatus?.user?.email;
    const hasProfilePicture = !!authStatus?.user?.profilePictureUrl;
    useEffect(() => {
        if (userEmail && !hasProfilePicture) {
            setGravatarFailed(false);
            getGravatarUrl(userEmail).then(setGravatarUrl);
        } else {
            setGravatarUrl(null);
            setGravatarFailed(false);
        }
    }, [userEmail, hasProfilePicture]);

    // Get user initial for avatar fallback
    const displayName = userName || authStatus?.user?.name;
    const userInitial = getUserInitial(displayName, authStatus?.user?.email);

    // Close menus when clicking outside
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as HTMLElement | null;
            if (!target) return;
            // Close conversation menu
            if (!target.closest('.conversation-menu-container')) {
                setOpenConversationMenuId(null);
                setOpenMenuContext(null);
                setShowCopySubmenu(false);
                setShowMoveSubmenu(false);
            }
            // Close folder menu
            if (!target.closest('.folder-menu-container')) {
                setOpenFolderMenuId(null);
            }
            // Close user menu
            if (!target.closest('.user-profile-container')) {
                setShowUserMenu(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Reset selected index when search query changes or modal opens
    useEffect(() => {
        setSelectedIndex(0);
    }, [searchQuery, showAllChatsModal]);

    // Scroll selected item into view
    useEffect(() => {
        if (!showAllChatsModal || !listRef.current) return;
        const items = listRef.current.querySelectorAll('.conversation-item');
        const selectedItem = items[selectedIndex] as HTMLElement | undefined;
        selectedItem?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, [selectedIndex, showAllChatsModal]);

    // Global keyboard shortcut: Cmd/Ctrl+O to toggle all chats modal
    useEffect(() => {
        const handleGlobalKeyDown = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'o') {
                e.preventDefault();
                e.stopPropagation();
                setShowAllChatsModal(prev => {
                    if (prev) {
                        setSearchQuery('');
                        setSelectedIndex(0);
                    }
                    return !prev;
                });
            }
            // Close modals on Escape (capture phase to intercept before other handlers)
            if (e.key === 'Escape') {
                if (showChangelog) {
                    e.preventDefault();
                    e.stopPropagation();
                    setShowChangelog(false);
                    setChangelogNotes(null);
                } else if (showAllChatsModal && !renamingConversationId) {
                    e.preventDefault();
                    e.stopPropagation();
                    setShowAllChatsModal(false);
                    setSearchQuery('');
                    setSelectedIndex(0);
                }
            }
        };

        document.addEventListener('keydown', handleGlobalKeyDown, true);
        return () => document.removeEventListener('keydown', handleGlobalKeyDown, true);
    }, [showAllChatsModal, renamingConversationId, showChangelog]);

    // Debounced server-side full-text search across message content
    useEffect(() => {
        const trimmed = searchQuery.trim();
        if (!trimmed || trimmed.length < 2) {
            setSearchResults(null);
            setIsSearching(false);
            return;
        }

        setIsSearching(true);
        const controller = new AbortController();
        const timer = setTimeout(async () => {
            try {
                const res = await apiFetch(
                    `/api/conversations?q=${encodeURIComponent(trimmed)}`,
                    { signal: controller.signal },
                );
                if (res.ok) {
                    const data = await res.json();
                    setSearchResults(data.conversations);
                }
            } catch (e) {
                if (e instanceof DOMException && e.name === 'AbortError') return;
                console.error('Search failed', e);
            } finally {
                setIsSearching(false);
            }
        }, 300);

        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [searchQuery]);

    // Filter conversations: use server results when available, else client-side filter
    const filteredConversations = (() => {
        const trimmed = searchQuery.trim();
        if (!trimmed) return conversations;
        if (searchResults) return searchResults;
        // Instant client-side filter while waiting for server results
        return conversations.filter(conv =>
            conv.title.toLowerCase().includes(trimmed.toLowerCase()) ||
            conv.preview?.toLowerCase().includes(trimmed.toLowerCase())
        );
    })();

    useEffect(() => {
        localStorage.setItem(EXPANDED_FOLDERS_STORAGE_KEY, JSON.stringify([...expandedFolders]));
    }, [expandedFolders]);

    const { folderTree, flatFolderTree } = useMemo(() => {
        const nodeMap = new Map<string, FolderTreeNode>();
        for (const folder of folders) {
            nodeMap.set(folder.id, { ...folder, children: [] });
        }

        const roots: FolderTreeNode[] = [];
        for (const folder of folders) {
            const node = nodeMap.get(folder.id);
            if (!node) continue;
            const parent = folder.parentId ? nodeMap.get(folder.parentId) : undefined;
            if (parent) {
                parent.children.push(node);
            } else {
                roots.push(node);
            }
        }

        const sortNodes = (nodes: FolderTreeNode[]) => {
            nodes.sort((a, b) => a.name.localeCompare(b.name));
            nodes.forEach(node => sortNodes(node.children));
        };
        sortNodes(roots);

        const flat: Array<{ folder: ConversationFolder; depth: number }> = [];
        const collect = (nodes: FolderTreeNode[], depth: number) => {
            for (const node of nodes) {
                flat.push({ folder: node, depth });
                collect(node.children, depth + 1);
            }
        };
        collect(roots, 0);

        return { folderTree: roots, flatFolderTree: flat };
    }, [folders]);

    const conversationsByFolderId = useMemo(() => {
        const groups = new Map<string, ConversationSummary[]>();
        for (const conv of conversations) {
            if (!conv.folderId) continue;
            const group = groups.get(conv.folderId) ?? [];
            group.push(conv);
            groups.set(conv.folderId, group);
        }
        return groups;
    }, [conversations]);

    useEffect(() => {
        const currentFolderId = conversations.find(conv => conv.id === currentConversationId)?.folderId;
        if (!currentFolderId) return;

        const parentById = new Map(folders.map(folder => [folder.id, folder.parentId]));
        const idsToExpand: string[] = [];
        let folderId: string | null | undefined = currentFolderId;
        while (folderId) {
            idsToExpand.push(folderId);
            folderId = parentById.get(folderId);
        }
        if (idsToExpand.length === 0) return;

        setExpandedFolders(prev => {
            if (idsToExpand.every(id => prev.has(id))) return prev;
            const next = new Set(prev);
            idsToExpand.forEach(id => next.add(id));
            return next;
        });
    }, [conversations, currentConversationId, folders]);

    const pinnedConversations = conversations.filter(conv => conv.isPinned);
    const recentConversations = conversations.filter(conv => !conv.folderId && !conv.isPinned);

    // Split conversations into visible (first 5) and hidden (rest)
    // Always include the current conversation so it appears in the sidebar
    const topConversations = recentConversations.slice(0, MAX_VISIBLE_CHATS);
    const currentInTop = !currentConversationId || topConversations.some(c => c.id === currentConversationId);
    const currentConv = !currentInTop ? recentConversations.find(c => c.id === currentConversationId) : undefined;
    const visibleConversations = currentConv
        ? [...topConversations.slice(0, MAX_VISIBLE_CHATS - 1), currentConv]
        : topConversations;
    const hasMoreChats = recentConversations.length > MAX_VISIBLE_CHATS;
    const hiddenChatsCount = recentConversations.length - visibleConversations.length;

    const toggleConversationMenu = (id: string, e: React.MouseEvent, context: 'sidebar' | 'modal') => {
        e.stopPropagation();
        setShowCopySubmenu(false);
        setShowMoveSubmenu(false);
        if (openConversationMenuId === id && openMenuContext === context) {
            setOpenConversationMenuId(null);
            setOpenMenuContext(null);
        } else {
            setOpenConversationMenuId(id);
            setOpenMenuContext(context);
            setOpenFolderMenuId(null);
        }
    };

    const toggleFolderMenu = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        setOpenConversationMenuId(null);
        setOpenMenuContext(null);
        setShowCopySubmenu(false);
        setShowMoveSubmenu(false);
        setOpenFolderMenuId(prev => prev === id ? null : id);
    };

    const handleConversationKeyDown = (id: string, e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelectConversation(id);
        }
    };

    const handleSelectConversation = (id: string) => {
        onSelectConversation(id);
        setOpenConversationMenuId(null);
        setOpenMenuContext(null);
    };

    const handleModalSelectConversation = (id: string) => {
        // Pass search query as highlight term if full-text search matched in message content
        const term = searchQuery.trim();
        const conv = (searchResults ?? conversations).find(c => c.id === id);
        const hasMessageMatch = conv?.matchSnippet;
        onSelectConversation(id, hasMessageMatch ? term : undefined);
        setShowAllChatsModal(false);
        setSearchQuery('');
        setSelectedIndex(0);
        setSearchResults(null);
        setIsSearching(false);
    };

    // Close modal helper
    const closeModal = () => {
        setShowAllChatsModal(false);
        setSearchQuery('');
        setSelectedIndex(0);
        setSearchResults(null);
        setIsSearching(false);
        setRenamingConversationId(null);
    };

    // Handle keyboard navigation in modal
    const handleModalKeyDown = (e: React.KeyboardEvent) => {
        switch (e.key) {
            case 'Escape':
                e.preventDefault();
                e.stopPropagation();
                closeModal();
                break;
            case 'ArrowDown':
                if (filteredConversations.length === 0) return;
                e.preventDefault();
                setSelectedIndex(prev =>
                    prev < filteredConversations.length - 1 ? prev + 1 : prev
                );
                break;
            case 'ArrowUp':
                if (filteredConversations.length === 0) return;
                e.preventDefault();
                setSelectedIndex(prev => (prev > 0 ? prev - 1 : prev));
                break;
            case 'Enter':
                if (filteredConversations.length === 0) return;
                e.preventDefault();
                const selectedConv = filteredConversations[selectedIndex];
                if (selectedConv) {
                    handleModalSelectConversation(selectedConv.id);
                }
                break;
        }
    };

    const startRename = (conv: ConversationSummary) => {
        setRenamingConversationId(conv.id);
        setRenameValue(conv.title);
        setOpenConversationMenuId(null);
        setOpenMenuContext(null);
    };

    // Focus the rename input after it mounts
    useEffect(() => {
        if (renamingConversationId) {
            // Use rAF to wait for the DOM to settle after React commit
            requestAnimationFrame(() => renameInputRef.current?.focus());
        }
    }, [renamingConversationId]);

    const finishRename = () => {
        setRenamingConversationId(null);
        // Return focus to the modal search input if it exists
        requestAnimationFrame(() => searchInputRef.current?.focus());
    };

    const submitRename = async (id: string) => {
        // Guard against double-submit (Enter triggers onBlur when input unmounts)
        if (!renamingConversationId) return;
        const trimmed = renameValue.trim();
        if (!trimmed) {
            finishRename();
            return;
        }
        // Skip API call if title unchanged
        const conv = conversations.find(c => c.id === id);
        if (conv && conv.title === trimmed) {
            finishRename();
            return;
        }
        const ok = await onRenameConversation(id, trimmed);
        if (ok) finishRename();
    };

    const cancelRename = () => {
        finishRename();
    };

    const toggleFolderExpanded = (folderId: string) => {
        setExpandedFolders(prev => {
            const next = new Set(prev);
            if (next.has(folderId)) {
                next.delete(folderId);
            } else {
                next.add(folderId);
            }
            return next;
        });
    };

    const promptForFolderName = async (parentId: string | null = null) => {
        const label = parentId
            ? t('folders.subfolderNamePrompt', 'Subfolder name')
            : t('folders.folderNamePrompt', 'Folder name');
        const name = window.prompt(label);
        const trimmed = name?.trim();
        if (!trimmed) return;

        if (parentId) {
            setExpandedFolders(prev => new Set(prev).add(parentId));
        }
        await onCreateFolder(trimmed.slice(0, 100), parentId);
    };

    const promptForFolderRename = async (folder: ConversationFolder) => {
        const name = window.prompt(t('folders.renameFolderPrompt', 'Rename folder'), folder.name);
        const trimmed = name?.trim();
        if (!trimmed || trimmed === folder.name) return;
        await onRenameFolder(folder.id, trimmed.slice(0, 100));
    };

    const handleDeleteFolder = async (folder: ConversationFolder) => {
        if (!window.confirm(t('folders.deleteFolderConfirm', 'Delete this folder? Subfolders will be deleted and chats will become unfiled.'))) {
            return;
        }
        await onDeleteFolder(folder.id);
    };

    const moveConversation = async (conversationId: string, folderId: string | null) => {
        setOpenConversationMenuId(null);
        setOpenMenuContext(null);
        setShowMoveSubmenu(false);
        if (folderId) {
            const parentById = new Map(folders.map(folder => [folder.id, folder.parentId]));
            const idsToExpand: string[] = [];
            let nextFolderId: string | null | undefined = folderId;
            while (nextFolderId) {
                idsToExpand.push(nextFolderId);
                nextFolderId = parentById.get(nextFolderId);
            }
            setExpandedFolders(prev => {
                const next = new Set(prev);
                idsToExpand.forEach(id => next.add(id));
                return next;
            });
        }
        await onMoveConversationToFolder(conversationId, folderId);
    };

    // Render a conversation item (reused in both sidebar and modal)
    const renderConversationItem = (
        conv: ConversationSummary,
        inModal = false,
        index?: number,
        className = '',
        style?: React.CSSProperties,
    ) => {
        const liveState = conversationStates.get(conv.id);
        const isActive = liveState?.isProcessing ?? conv.isActive ?? false;
        const hasPendingConfirmation = (pendingConfirmations.get(conv.id)?.length ?? 0) > 0;
        const isCompleted = liveState?.isCompleted ?? false;
        const isStopped = liveState ? !liveState.isProcessing && liveState.isStopped : false;
        // For completed/stopped tasks, show the final response instead of intermediate reasoning
        const assistantMsg = liveState?.messages.findLast(m => m.role === 'assistant');
        const latestReasoning = (isCompleted || isStopped) && assistantMsg?.content
            ? assistantMsg.content
            : (liveState?.latestReasoning ?? conv.latestReasoning);
        const isSelected = inModal && index === selectedIndex;

        return (
            <div
                key={conv.id}
                className={`conversation-item ${currentConversationId === conv.id ? 'active' : ''} ${isActive ? 'has-active-task' : ''} ${isSelected ? 'keyboard-selected' : ''} ${className}`}
                style={style}
                onClick={() => inModal ? handleModalSelectConversation(conv.id) : handleSelectConversation(conv.id)}
                onMouseEnter={() => inModal && index !== undefined && setSelectedIndex(index)}
                onKeyDown={(e) => handleConversationKeyDown(conv.id, e)}
                role="button"
                tabIndex={inModal ? -1 : 0}
                aria-label={t('sidebar.openConversation', { title: conv.title })}
                aria-selected={isSelected}
            >
                {/* Activity indicator */}
                {isActive && !hasPendingConfirmation ? (
                    <Loader2 size={16} className="conversation-icon running" />
                ) : hasPendingConfirmation ? (
                    <AlertCircle size={16} className="conversation-icon needs-attention" />
                ) : isCompleted ? (
                    <CheckCircle size={16} className="conversation-icon completed" />
                ) : conv.isAutomation ? (
                    <Clock size={16} className="conversation-icon" />
                ) : (
                    <MessageSquare size={16} className="conversation-icon" />
                )}

                <div className="conversation-info">
                    {renamingConversationId === conv.id ? (
                        <input
                            ref={renameInputRef}
                            className="conversation-rename-input"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                                e.stopPropagation();
                                if (e.key === 'Enter') submitRename(conv.id);
                                if (e.key === 'Escape') cancelRename();
                            }}
                            onBlur={() => submitRename(conv.id)}
                            onClick={(e) => e.stopPropagation()}
                        />
                    ) : (
                        <>
                            <span className="conversation-title">{conv.title}</span>
                            {/* Match snippet from full-text search */}
                            {conv.matchSnippet ? (
                                <span className="conversation-match-snippet">{conv.matchSnippet}</span>
                            ) : (isActive || isCompleted || hasPendingConfirmation) && latestReasoning ? (
                                <span className="conversation-subtitle">
                                    {(() => {
                                        const firstLine = latestReasoning.split('\n')[0] ?? '';
                                        return firstLine.length > 60
                                            ? firstLine.slice(0, 60) + '...'
                                            : firstLine;
                                    })()}
                                </span>
                            ) : null}
                        </>
                    )}
                </div>

                <div className="conversation-menu-container">
                    <button
                        className="menu-btn"
                        onClick={(e) => toggleConversationMenu(conv.id, e, inModal ? 'modal' : 'sidebar')}
                        aria-label={t('sidebar.conversationActions')}
                    >
                        <MoreVertical size={16} />
                    </button>

                    {openConversationMenuId === conv.id && openMenuContext === (inModal ? 'modal' : 'sidebar') && (
                        <div className="conversation-menu" role="menu">
                            <button
                                className="conversation-menu-item"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    startRename(conv);
                                }}
                                role="menuitem"
                            >
                                <Pencil size={14} />
                                <span>{t('common.rename')}</span>
                            </button>

                            <button
                                title={conv.isPinned ? t('sidebar.unpinFromHome') : t('sidebar.pinToHome')}
                                className="conversation-menu-item"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setOpenConversationMenuId(null);
                                    setOpenMenuContext(null);
                                    onPinConversation(conv.id, !conv.isPinned);
                                }}
                                role="menuitem"
                            >
                                {conv.isPinned ? <PinOff size={14} /> : <Pin size={14} />}
                                <span>{conv.isPinned ? t('sidebar.unpin') : t('sidebar.pin')}</span>
                            </button>

                            <div className={`conversation-menu-submenu-container ${showCopySubmenu ? 'open' : ''}`}>
                                <button
                                    className="conversation-menu-item"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setShowMoveSubmenu(false);
                                        setShowCopySubmenu(prev => !prev);
                                    }}
                                    role="menuitem"
                                >
                                    <Copy size={14} />
                                    <span>{t('sidebar.copy')}</span>
                                    <ChevronRight size={12} className="submenu-arrow" />
                                </button>
                                <div className="conversation-submenu" role="menu">
                                    <button
                                        className="conversation-menu-item"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setOpenConversationMenuId(null);
                                            setOpenMenuContext(null);
                                            onCopyConversationLink(conv.id);
                                        }}
                                        role="menuitem"
                                    >
                                        <Link size={14} />
                                        <span>{t('sidebar.copyLink')}</span>
                                    </button>
                                    <button
                                        className="conversation-menu-item"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setOpenConversationMenuId(null);
                                            setOpenMenuContext(null);
                                            onCopyConversationChat(conv.id);
                                        }}
                                        disabled={copyingConversationId === conv.id}
                                        role="menuitem"
                                    >
                                        {copyingConversationId === conv.id ? (
                                            <Loader2 size={14} className="spinning" />
                                        ) : (
                                            <MessageSquare size={14} />
                                        )}
                                        <span>{t('sidebar.copyMessages')}</span>
                                    </button>
                                    <button
                                        className="conversation-menu-item"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setOpenConversationMenuId(null);
                                            setOpenMenuContext(null);
                                            onCopyConversationRaw(conv.id);
                                        }}
                                        disabled={copyingConversationId === conv.id}
                                        role="menuitem"
                                    >
                                        {copyingConversationId === conv.id ? (
                                            <Loader2 size={14} className="spinning" />
                                        ) : (
                                            <FileText size={14} />
                                        )}
                                        <span>{t('sidebar.copyTrace')}</span>
                                    </button>
                                </div>
                            </div>

                            <div className={`conversation-menu-submenu-container ${showMoveSubmenu ? 'open' : ''}`}>
                                <button
                                    className="conversation-menu-item"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setShowCopySubmenu(false);
                                        setShowMoveSubmenu(prev => !prev);
                                    }}
                                    role="menuitem"
                                >
                                    <FolderPlus size={14} />
                                    <span>{t('folders.moveToFolder', 'Move to folder')}</span>
                                    <ChevronRight size={12} className="submenu-arrow" />
                                </button>
                                <div className="conversation-submenu folder-move-submenu" role="menu">
                                    <button
                                        className="conversation-menu-item"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            void moveConversation(conv.id, null);
                                        }}
                                        role="menuitem"
                                    >
                                        <Folder size={14} />
                                        <span>{t('folders.noFolder', 'No folder')}</span>
                                    </button>
                                    {flatFolderTree.map(({ folder, depth }) => (
                                        <button
                                            key={folder.id}
                                            className="conversation-menu-item"
                                            style={{ paddingLeft: 24 + Math.min(depth, 6) * 12 }}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                void moveConversation(conv.id, folder.id);
                                            }}
                                            role="menuitem"
                                        >
                                            <Folder size={14} />
                                            <span>{folder.name}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <button
                                className="conversation-menu-item danger"
                                onClick={(e) => {
                                    setOpenConversationMenuId(null);
                                    setOpenMenuContext(null);
                                    onDeleteConversation(conv.id, e);
                                }}
                                role="menuitem"
                            >
                                <Trash2 size={14} />
                                <span>{t('common.delete')}</span>
                            </button>
                        </div>
                    )}
                </div>
            </div>
        );
    };

    const renderFolderNode = (folder: FolderTreeNode, depth = 0): React.ReactNode => {
        const isExpanded = expandedFolders.has(folder.id);
        const folderConversations = conversationsByFolderId.get(folder.id) ?? [];
        const indent = Math.min(depth, 6) * 12;

        return (
            <div className="folder-tree-node" key={folder.id}>
                <div
                    className="folder-row"
                    style={{ paddingLeft: 8 + indent }}
                    onClick={() => toggleFolderExpanded(folder.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            toggleFolderExpanded(folder.id);
                        }
                    }}
                    aria-label={t('folders.openFolder', { name: folder.name, defaultValue: 'Open folder: {{name}}' })}
                    aria-expanded={isExpanded}
                >
                    {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    {isExpanded ? <FolderOpen size={15} /> : <Folder size={15} />}
                    <span className="folder-name">{folder.name}</span>

                    <div className="folder-menu-container">
                        <button
                            className="menu-btn folder-menu-btn"
                            onClick={(e) => toggleFolderMenu(folder.id, e)}
                            aria-label={t('folders.folderActions', 'Folder actions')}
                        >
                            <MoreVertical size={15} />
                        </button>
                        {openFolderMenuId === folder.id && (
                            <div className="conversation-menu folder-menu" role="menu">
                                <button
                                    className="conversation-menu-item"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setOpenFolderMenuId(null);
                                        void promptForFolderName(folder.id);
                                    }}
                                    role="menuitem"
                                >
                                    <FolderPlus size={14} />
                                    <span>{t('folders.newSubfolder', 'New subfolder')}</span>
                                </button>
                                <button
                                    className="conversation-menu-item"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setOpenFolderMenuId(null);
                                        void promptForFolderRename(folder);
                                    }}
                                    role="menuitem"
                                >
                                    <Pencil size={14} />
                                    <span>{t('common.rename')}</span>
                                </button>
                                <button
                                    className="conversation-menu-item danger"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setOpenFolderMenuId(null);
                                        void handleDeleteFolder(folder);
                                    }}
                                    role="menuitem"
                                >
                                    <Trash2 size={14} />
                                    <span>{t('folders.deleteFolder', 'Delete folder')}</span>
                                </button>
                            </div>
                        )}
                    </div>
                </div>

                {isExpanded && (
                    <div className="folder-children">
                        {folder.children.map(child => renderFolderNode(child, depth + 1))}
                        {folderConversations.map(conv => renderConversationItem(
                            conv,
                            false,
                            undefined,
                            'folder-conversation-item',
                            { paddingLeft: 20 + Math.min(depth + 1, 6) * 12 },
                        ))}
                    </div>
                )}
            </div>
        );
    };

    // Collapsed rail buttons are icon-only, so their label moves to tooltip + accessible name
    const iconOnly = (label: string) => (isOpen ? {} : { title: label, 'aria-label': label });
    const toggleLabel = isOpen ? t('sidebar.collapseSidebar') : t('sidebar.expandSidebar');

    return (
        <>
            {/* Mobile backdrop overlay */}
            {isOpen && (
                <div
                    className="sidebar-backdrop"
                    onClick={onClose}
                    aria-hidden="true"
                />
            )}
            <aside className={`sidebar ${isOpen ? 'open' : 'collapsed'}`}>
                <div className="sidebar-header">
                    <div className="sidebar-header-row">
                        <Logo onClick={onGoHome} />
                        <button
                            className="sidebar-collapse-btn"
                            onClick={isOpen ? onClose : onExpand}
                            title={toggleLabel}
                            aria-label={toggleLabel}
                            aria-expanded={isOpen}
                        >
                            {isOpen ? <PanelLeftClose size={20} /> : <PanelLeft size={20} />}
                        </button>
                        <button
                            className="sidebar-close-btn"
                            onClick={onClose}
                            aria-label={t('sidebar.closeSidebar')}
                        >
                            <X size={20} />
                        </button>
                    </div>
                </div>

                <div className="sidebar-nav">
                    <button className="sidebar-nav-btn new-chat-btn" onClick={onNewChat} {...iconOnly(t('sidebar.newChat'))}>
                        <Plus size={16} />
                        <span>{t('sidebar.newChat')}</span>
                    </button>

                    {/* The conversation list is hidden in the rail, so surface the all-chats modal here instead */}
                    {!isOpen && (
                        <button
                            className="sidebar-nav-btn"
                            onClick={() => setShowAllChatsModal(true)}
                            {...iconOnly(t('sidebar.allChats'))}
                        >
                            <Search size={16} />
                            <span>{t('sidebar.allChats')}</span>
                        </button>
                    )}
                    <button
                        className={`sidebar-nav-btn ${currentPage === 'skills' ? 'active' : ''}`}
                        onClick={onGoToSkills}
                        {...iconOnly(t('sidebar.skills'))}
                    >
                        <ScrollText size={16} />
                        <span>{t('sidebar.skills')}</span>
                    </button>
                    <button
                        className={`sidebar-nav-btn ${currentPage === 'automations' ? 'active' : ''}`}
                        onClick={onGoToAutomations}
                        {...iconOnly(t('sidebar.routines'))}
                    >
                        <Clock size={16} />
                        <span>{t('sidebar.routines')}</span>
                    </button>
                    <button
                        className={`sidebar-nav-btn ${currentPage === 'mcp-tools' ? 'active' : ''}`}
                        onClick={onGoToMcpTools}
                        {...iconOnly(t('sidebar.tools'))}
                    >
                        <Hammer size={16} />
                        <span>{t('sidebar.tools')}</span>
                    </button>
                    <button
                        className={`sidebar-nav-btn ${currentPage === 'settings' ? 'active' : ''}`}
                        onClick={onGoToSettings}
                        {...iconOnly(t('sidebar.settings'))}
                    >
                        <Settings size={16} />
                        <span>{t('sidebar.settings')}</span>
                    </button>
                </div>

                <div className="conversations-list">
                    {pinnedConversations.length > 0 && (
                        <div className="conversation-section">
                            <div className="conversation-section-title">{t('sidebar.pinned', 'Pinned')}</div>
                            {pinnedConversations.map(conv => renderConversationItem(conv))}
                        </div>
                    )}

                    <div className="sidebar-folder-section">
                        <div className="conversation-section-header">
                            <span className="conversation-section-title">{t('folders.title', 'Folders')}</span>
                            <button
                                className="section-icon-btn"
                                onClick={() => void promptForFolderName(null)}
                                aria-label={t('folders.newFolder', 'New folder')}
                                title={t('folders.newFolder', 'New folder')}
                            >
                                <FolderPlus size={14} />
                            </button>
                        </div>
                        {folderTree.length > 0 && (
                            <div className="folder-tree">
                                {folderTree.map(folder => renderFolderNode(folder))}
                            </div>
                        )}
                    </div>

                    {visibleConversations.map(conv => renderConversationItem(conv))}

                    {hasMoreChats && (
                        <button
                            className="see-more-btn"
                            onClick={() => setShowAllChatsModal(true)}
                        >
                            <span>{t('sidebar.seeMore', { count: hiddenChatsCount })}</span>
                            <ChevronRight size={14} />
                        </button>
                    )}

                    {conversations.length === 0 && (
                        <div className="no-conversations">{t('sidebar.noConversations')}</div>
                    )}
                </div>

                {/* Billing Alert Banner - too wide for the rail, so collapse it to a nudge that expands the sidebar */}
                {billingAlerts && billingAlerts.length > 0 && platformFrontendUrl && onDismissAllBillingAlerts && (
                    <div className="sidebar-billing-section">
                        {isOpen ? (
                            <BillingAlertBanner
                                alerts={billingAlerts}
                                platformFrontendUrl={platformFrontendUrl}
                                onDismissAll={onDismissAllBillingAlerts}
                            />
                        ) : (
                            <button
                                className="sidebar-nav-btn billing-alert-rail-btn"
                                onClick={onExpand}
                                {...iconOnly(t('sidebar.billingAlert'))}
                            >
                                <AlertCircle size={16} />
                                <span>{t('sidebar.billingAlert')}</span>
                            </button>
                        )}
                    </div>
                )}

                {/* User Profile Section */}
                {authStatus && (authStatus.authenticated || authStatus.anonMode) && (
                    <div className="sidebar-user-section">
                        <div className="user-profile-container">
                            <button
                                className="user-profile-btn"
                                onClick={() => setShowUserMenu(prev => !prev)}
                                aria-label={t('sidebar.userMenu')}
                                title={isOpen ? undefined : (authStatus.anonMode ? t('sidebar.anonymousMode') : displayName || authStatus.user?.email)}
                            >
                                <div className="user-avatar">
                                    {authStatus.anonMode ? (
                                        <Shield size={18} />
                                    ) : authStatus.user?.profilePictureUrl ? (
                                        <img
                                            src={authStatus.user.profilePictureUrl}
                                            alt=""
                                            className="user-avatar-img"
                                            referrerPolicy="no-referrer"
                                        />
                                    ) : gravatarUrl && !gravatarFailed ? (
                                        <img
                                            src={gravatarUrl}
                                            alt=""
                                            className="user-avatar-img"
                                            onError={() => setGravatarFailed(true)}
                                        />
                                    ) : (
                                        <span className="user-avatar-initial">{userInitial}</span>
                                    )}
                                </div>
                                <div className="user-info">
                                    <span className="user-name">
                                        {authStatus.anonMode
                                            ? t('sidebar.anonymousMode')
                                            : displayName || authStatus.user?.email || t('sidebar.user')}
                                    </span>
                                    {!authStatus.anonMode && authStatus.user?.email && displayName && (
                                        <span className="user-email">{authStatus.user.email}</span>
                                    )}
                                </div>
                            </button>

                            {showUserMenu && (
                                <div className="user-menu" role="menu">
                                    {/* Theme Toggle */}
                                    <div className="user-menu-theme">
                                        <span className="user-menu-label">{t('sidebar.theme')}</span>
                                        <div className="theme-toggle-group">
                                            <button
                                                className={`theme-toggle-btn ${theme === 'light' ? 'active' : ''}`}
                                                onClick={() => setTheme('light')}
                                                aria-label={t('sidebar.lightTheme')}
                                                title={t('sidebar.themeLight')}
                                            >
                                                <Sun size={14} />
                                            </button>
                                            <button
                                                className={`theme-toggle-btn ${theme === 'dark' ? 'active' : ''}`}
                                                onClick={() => setTheme('dark')}
                                                aria-label={t('sidebar.darkTheme')}
                                                title={t('sidebar.themeDark')}
                                            >
                                                <Moon size={14} />
                                            </button>
                                            <button
                                                className={`theme-toggle-btn ${theme === 'system' ? 'active' : ''}`}
                                                onClick={() => setTheme('system')}
                                                aria-label={t('sidebar.systemTheme')}
                                                title={t('sidebar.themeSystem')}
                                            >
                                                <Monitor size={14} />
                                            </button>
                                        </div>
                                    </div>
                                    {authStatus.version && (
                                        <button
                                            className="user-menu-item"
                                            onClick={async () => {
                                                setShowUserMenu(false);
                                                try {
                                                    const res = await apiFetch('/api/changelog');
                                                    if (res.ok) {
                                                        const data = await res.json();
                                                        setChangelogNotes(data.notes);
                                                    }
                                                } catch { /* ignore */ }
                                                setShowChangelog(true);
                                            }}
                                            role="menuitem"
                                        >
                                            <Gift size={14} />
                                            <span>{t('sidebar.whatsNew')}</span>
                                            <span className="user-menu-version-badge">v{authStatus.version}</span>
                                        </button>
                                    )}
                                    {!authStatus.anonMode && (
                                        <button
                                            className="user-menu-item danger"
                                            onClick={() => {
                                                setShowUserMenu(false);
                                                onLogout?.();
                                            }}
                                            role="menuitem"
                                        >
                                            <LogOut size={14} />
                                            <span>{t('sidebar.signOut')}</span>
                                        </button>
                                    )}
                                    {authStatus.anonMode && (
                                        <div className="user-menu-info">
                                            <span>{t('sidebar.usingLocalApiKeys')}</span>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </aside>

            {/* All Chats Modal */}
            {showAllChatsModal && (
                <div
                    className="chat-modal-overlay"
                    onClick={closeModal}
                    onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                            e.preventDefault();
                            e.stopPropagation();
                            closeModal();
                        }
                    }}
                >
                    <div
                        className="chat-modal"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="chat-modal-header">
                            <h2>{t('sidebar.allChats')}</h2>
                            <button
                                className="chat-modal-close"
                                onClick={closeModal}
                                aria-label={t('common.close')}
                            >
                                <X size={18} />
                            </button>
                        </div>

                        <div className="chat-modal-search">
                            <Search size={16} className="search-icon" />
                            <input
                                ref={searchInputRef}
                                type="text"
                                placeholder={t('sidebar.searchChats')}
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                onKeyDown={handleModalKeyDown}
                                autoFocus
                            />
                            {isSearching && <Loader2 size={14} className="search-spinner spinning" />}
                            {searchQuery && !isSearching && (
                                <button
                                    className="search-clear"
                                    onClick={() => { setSearchQuery(''); setSearchResults(null); }}
                                    aria-label={t('sidebar.clearSearch')}
                                >
                                    <X size={14} />
                                </button>
                            )}
                        </div>

                        <div className="chat-modal-list" ref={listRef} role="listbox">
                            {filteredConversations.length > 0 ? (
                                filteredConversations.map((conv, index) => renderConversationItem(conv, true, index))
                            ) : (
                                <div className="no-conversations">
                                    {searchQuery ? t('sidebar.noChatsMatch') : t('sidebar.noConversations')}
                                </div>
                            )}
                        </div>

                        <div className="chat-modal-footer">
                            <span className="chat-count">
                                {t('sidebar.chatCount', { count: filteredConversations.length })}
                                {searchQuery && searchResults ? ` ${t('sidebar.found')}` : searchQuery ? ` ${t('sidebar.matching', { query: searchQuery })}` : ''}
                            </span>
                            <span className="keyboard-hint">
                                <kbd>↑</kbd><kbd>↓</kbd> {t('sidebar.keyboardHintNavigate')} · <kbd>Enter</kbd> {t('sidebar.keyboardHintOpen')} · <kbd>{MOD_KEY}O</kbd> {t('sidebar.keyboardHintToggle')} · <kbd>Esc</kbd> {t('sidebar.keyboardHintClose')}
                            </span>
                        </div>
                    </div>
                </div>
            )}

            {/* What's New Modal */}
            {showChangelog && (
                <div
                    className="chat-modal-overlay"
                    onClick={() => { setShowChangelog(false); setChangelogNotes(null); }}
                >
                    <div
                        className="chat-modal changelog-modal"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="chat-modal-header">
                            <h2>{t('sidebar.whatsNewVersion', { version: authStatus?.version })}</h2>
                            <button
                                className="chat-modal-close"
                                onClick={() => { setShowChangelog(false); setChangelogNotes(null); }}
                                aria-label={t('common.close')}
                            >
                                <X size={18} />
                            </button>
                        </div>
                        <div className="changelog-content">
                            {changelogNotes ? (
                                <ReactMarkdown>{changelogNotes}</ReactMarkdown>
                            ) : (
                                <p className="no-conversations">{t('sidebar.noReleaseNotes')}</p>
                            )}
                        </div>
                        <div className="changelog-footer">
                            <a
                                href="https://github.com/khoj-ai/pipali/releases"
                                onClick={(e) => { e.preventDefault(); openInBrowser("https://github.com/khoj-ai/pipali/releases"); }}
                            >
                                {t('sidebar.previousReleaseNotes')}
                            </a>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
