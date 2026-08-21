// Individual message component

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, Paperclip, Clock } from 'lucide-react';
import type { Message } from '../../types';
import { ThoughtsSection } from '../thoughts/ThoughtsSection';
import { StreamingIndicator } from './StreamingIndicator';
import { ChatMarkdown } from '../ChatMarkdown';
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
            {!isUser && (
                <img
                    src="/brand/avatar.jpg"
                    alt=""
                    aria-hidden="true"
                    className="message-avatar"
                />
            )}
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
                    <ChatMarkdown>{message.content}</ChatMarkdown>
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
