// Individual message component

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Trash2, Paperclip, Clock } from 'lucide-react';
import type { Message } from '../../types';
import { ThoughtsSection } from '../thoughts/ThoughtsSection';
import { StreamingIndicator } from './StreamingIndicator';
import { ExternalLink } from '../ExternalLink';
import { safeMarkdownUrlTransform, localImageSrc, normalizeLatexDelimiters } from '../../utils/markdown';
import { getApiBaseUrl } from '../../utils/api';
import { BillingMessage } from '../billing';
import { AuthErrorMessage } from '../auth';
import { RunErrorMessage } from './RunErrorMessage';

interface MessageItemProps {
    message: Message;
    platformFrontendUrl?: string;
    onDelete?: (messageId: string, role: 'user' | 'assistant') => void;
    onBillingContinue?: (messageId: string) => void;
    onBillingDismiss?: (messageId: string) => void;
    onAuthSignIn?: (messageId: string) => void;
    onAuthDismiss?: (messageId: string) => void;
    onRunErrorDismiss?: (messageId: string) => void;
    isActiveRun?: boolean;
}

export function MessageItem({ message, platformFrontendUrl, onDelete, onBillingContinue, onBillingDismiss, onAuthSignIn, onAuthDismiss, onRunErrorDismiss, isActiveRun = false }: MessageItemProps) {
    const { t } = useTranslation();
    const isUser = message.role === 'user';
    const isStreaming = message.isStreaming || isActiveRun;
    const [isHovered, setIsHovered] = useState(false);

    const canDelete = onDelete && !isStreaming;

    // Render billing message if present
    if (message.billingInfo && platformFrontendUrl) {
        return (
            <div className="message assistant-message">
                <BillingMessage
                    code={message.billingInfo.code}
                    message={message.billingInfo.message}
                    platformFrontendUrl={platformFrontendUrl}
                    onContinue={onBillingContinue ? () => onBillingContinue(message.id) : undefined}
                    onDismiss={onBillingDismiss ? () => onBillingDismiss(message.id) : undefined}
                />
            </div>
        );
    }

    // Render auth error message if present
    if (message.authInfo) {
        return (
            <div className="message assistant-message">
                <AuthErrorMessage
                    onSignIn={() => onAuthSignIn?.(message.id)}
                    onDismiss={onAuthDismiss ? () => onAuthDismiss(message.id) : undefined}
                />
            </div>
        );
    }

    if (message.runErrorInfo) {
        return (
            <div className="message assistant-message">
                <RunErrorMessage
                    message={message.runErrorInfo.message}
                    onDismiss={onRunErrorDismiss ? () => onRunErrorDismiss(message.id) : undefined}
                />
            </div>
        );
    }

    return (
        <div
            className={`message ${isUser ? 'user-message' : 'assistant-message'}`}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
        >
            {isHovered && canDelete && (
                <div className="message-actions">
                    <button
                        className="message-action-btn"
                        onClick={() => onDelete(message.id, message.role)}
                        title={t('messages.deleteMessage')}
                    >
                        <Trash2 size={14} />
                    </button>
                </div>
            )}

            {/* Thoughts / Reasoning */}
            {message.thoughts && message.thoughts.length > 0 && (
                <ThoughtsSection thoughts={message.thoughts} isStreaming={isStreaming} />
            )}

            {/* Message Content */}
            {message.content ? (
                <div className="message-content">
                    <ReactMarkdown
                        remarkPlugins={[[remarkGfm, { singleTilde: false }], [remarkMath, { singleDollarTextMath: false }]]}
                        rehypePlugins={[[rehypeKatex, { output: 'mathml' }]]}
                        urlTransform={safeMarkdownUrlTransform}
                        components={{
                            a: ExternalLink,
                            img: ({ src, alt }) => {
                                const resolvedSrc = localImageSrc(src, getApiBaseUrl());
                                return resolvedSrc
                                    ? <img src={resolvedSrc} alt={alt || ''} className="message-inline-image" />
                                    : null;
                            },
                        }}
                    >
                        {normalizeLatexDelimiters(message.content)}
                    </ReactMarkdown>
                </div>
            ) : isStreaming ? (
                <StreamingIndicator />
            ) : null}

            {/* Attached files indicator */}
            {message.attachedFiles && message.attachedFiles.length > 0 && (
                <div className="message-attachments">
                    <Paperclip size={12} />
                    <span>{message.attachedFiles.join(', ')}</span>
                </div>
            )}

            {/* Queued indicator: shown on user messages waiting behind an in-flight run. */}
            {isUser && message.isQueued && (
                <div className="message-queued">
                    <Clock size={11} />
                    <span>{t('messages.queued')}</span>
                </div>
            )}
        </div>
    );
}
