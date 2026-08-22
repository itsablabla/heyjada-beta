// Toast notification for confirmation requests from background tasks

import { useState } from 'react';
import { ChevronDown, ChevronUp, X, Bot, Clock, Send, MessageCircleQuestion } from 'lucide-react';
import type { PendingConfirmation } from '../../types/confirmation';
import { DiffView } from '../tool-views/DiffView';
import { shortenHomePath, cleanOperationType } from '../../utils/formatting';
import {
    formatTimeRemaining,
    formatArgValue,
    getApprovalButtonClass,
    getOperationTypePillClass,
    getQuestionText,
    getRiskBadgeClass,
    getVisibleToolArgs,
    hasExpandableContent,
} from './utils';
import { useTranslation } from 'react-i18next';

interface ConfirmationToastProps {
    confirmation: PendingConfirmation;
    onRespond: (key: string, optionId: string, guidance?: string) => void;
    onDismiss: (key: string) => void;
    onNavigateToConversation?: (conversationId: string) => void;
    onNavigateToAutomations?: () => void;
}

export function ConfirmationToast({
    confirmation,
    onRespond,
    onDismiss,
    onNavigateToConversation,
    onNavigateToAutomations,
}: ConfirmationToastProps) {
    const { t } = useTranslation();
    const [isExpanded, setIsExpanded] = useState(false);
    const [guidanceText, setGuidanceText] = useState('');

    const { request, source, expiresAt, key } = confirmation;
    const isAutomation = source.type === 'automation';
    const isAgentQuestion = request.operation === 'ask_user';

    // Get structured command info from context (for shell_command operations)
    const commandInfo = request.context?.commandInfo;
    const displayOpType = request.context?.operationType && !isAgentQuestion
        ? cleanOperationType(request.context.operationType)
        : null;
    const expandable = hasExpandableContent(request);
    const detailsId = `toast-confirmation-details-${request.requestId}`;
    const questionText = getQuestionText(request);
    const riskLevel = request.context?.riskLevel;
    const visibleToolArgs = getVisibleToolArgs(request);

    // Use all standard options - guidance is now sent independently via the input area
    const displayOptions = request.options;

    const handleSendGuidance = () => {
        if (guidanceText.trim()) {
            onRespond(key, 'guidance', guidanceText.trim());
        }
    };

    const handleNavigate = () => {
        if (source.type === 'chat' && onNavigateToConversation) {
            onNavigateToConversation(source.conversationId);
        } else if (source.type === 'automation') {
            // Navigate to automation's conversation if available, otherwise to automations page
            if (source.conversationId && onNavigateToConversation) {
                onNavigateToConversation(source.conversationId);
            } else if (onNavigateToAutomations) {
                onNavigateToAutomations();
            }
        }
    };

    const isClickable = (source.type === 'chat' && !!onNavigateToConversation) ||
                        (source.type === 'automation' && (!!onNavigateToAutomations || (!!source.conversationId && !!onNavigateToConversation)));

    return (
        <div className={`confirmation-toast ${isAutomation ? 'confirmation-toast--automation' : ''} ${isAgentQuestion ? 'confirmation-toast--question' : ''}`}>
            <div className="toast-header">
                <div className="toast-info">
                    {/* Source indicator - clickable to navigate */}
                    {isAutomation ? (
                        <span
                            className={`toast-conversation automation-source ${isClickable ? 'toast-conversation-clickable' : ''}`}
                            onClick={isClickable ? handleNavigate : undefined}
                            role={isClickable ? 'button' : undefined}
                            tabIndex={isClickable ? 0 : undefined}
                            onKeyDown={isClickable ? (e) => { if (e.key === 'Enter') handleNavigate(); } : undefined}
                        >
                            <Bot size={12} />
                            {source.automationName}
                        </span>
                    ) : (
                        <span
                            className={`toast-conversation ${isClickable ? 'toast-conversation-clickable' : ''}`}
                            onClick={isClickable ? handleNavigate : undefined}
                            role={isClickable ? 'button' : undefined}
                            tabIndex={isClickable ? 0 : undefined}
                            onKeyDown={isClickable ? (e) => { if (e.key === 'Enter') handleNavigate(); } : undefined}
                        >
                            {source.conversationTitle}
                        </span>
                    )}

                    <div className="toast-title-row">
                        <span className={`toast-title ${isAgentQuestion ? 'agent-question-title' : ''}`}>
                            {isAgentQuestion && <MessageCircleQuestion size={12} className="question-icon" />}
                            {questionText}
                        </span>
                        {riskLevel && (
                            <span className={getRiskBadgeClass(riskLevel)}>
                                {t(`confirmation.risk.${riskLevel}`, { defaultValue: riskLevel })}
                            </span>
                        )}
                    </div>
                </div>

                <div className="toast-controls">
                    {/* Expiry timer for automations */}
                    {expiresAt && (
                        <span className="toast-expiry" title="Time until confirmation expires">
                            <Clock size={12} />
                            {formatTimeRemaining(expiresAt)}
                        </span>
                    )}

                    {/* Expand button */}
                    {expandable && (
                        <button
                            className="toast-expand-btn"
                            onClick={() => setIsExpanded(!isExpanded)}
                            aria-expanded={isExpanded}
                            aria-controls={detailsId}
                            title={isExpanded
                                ? t('confirmation.hideDetails', { defaultValue: 'Hide details' })
                                : t('confirmation.showDetails', { defaultValue: 'Show details' })}
                        >
                            {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                            <span>
                                {isExpanded
                                    ? t('confirmation.hideDetails', { defaultValue: 'Hide details' })
                                    : t('confirmation.showDetails', { defaultValue: 'Show details' })}
                            </span>
                        </button>
                    )}

                    {/* Dismiss button */}
                    <button
                        className="toast-close-btn"
                        onClick={() => onDismiss(key)}
                        title={t('common.dismiss')}
                    >
                        <X size={14} />
                    </button>
                </div>
            </div>

            {/* Expandable content */}
            {isExpanded && (
                <div className="toast-body" id={detailsId}>
                    {request.message && (
                        <div className="toast-message">{request.message}</div>
                    )}

                    <div className="confirmation-detail-row">
                        <span className="confirmation-detail-label">{t('confirmation.operation', { defaultValue: 'Operation' })}</span>
                        <code className="confirmation-operation-code">{request.operation}</code>
                        {displayOpType && (
                            <span className={getOperationTypePillClass(displayOpType)}>
                                {displayOpType}
                            </span>
                        )}
                    </div>

                    {/* Command display */}
                    {commandInfo && (
                        <div className="toast-command-section">
                            {commandInfo.reason && (
                                <div className="toast-reason-content">{commandInfo.reason}</div>
                            )}
                            {commandInfo.command && (
                                <>
                                    <div className="toast-command-header">
                                        <span className="toast-command-label">{t('confirmation.command')}</span>
                                        {commandInfo.workdir && (
                                            <code className="toast-workdir">
                                                {t('confirmation.in')} {shortenHomePath(commandInfo.workdir)}
                                            </code>
                                        )}
                                    </div>
                                    <pre className="toast-command-code">
                                        <code>{commandInfo.command}</code>
                                    </pre>
                                </>
                            )}
                        </div>
                    )}

                    {visibleToolArgs.length > 0 && (
                        <div className="confirmation-detail-section">
                            <span className="confirmation-detail-label">{t('confirmation.toolArgs', { defaultValue: 'Tool arguments' })}</span>
                            <div className="mcp-args-list">
                                {visibleToolArgs.map(([key, value]) => (
                                    <div key={key} className="mcp-arg-row">
                                        <span className="mcp-arg-key">{key}</span>
                                        <span className="mcp-arg-separator">:</span>
                                        {formatArgValue(value)}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Diff view */}
                    {request.diff && <DiffView diff={request.diff} />}

                    {request.context?.affectedFiles && request.context.affectedFiles.length > 0 && (
                        <div className="confirmation-files">
                            <span className="files-label">{t('confirmation.affectedFiles')}</span>
                            <ul className="files-list">
                                {request.context.affectedFiles.map((file, idx) => (
                                    <li key={idx} className="file-item">{file}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            )}

            {/* Action buttons */}
            <div className="toast-actions">
                {displayOptions.map((option) => (
                    <button
                        key={option.id}
                        className={getApprovalButtonClass(option, request.options, 'toast-btn')}
                        onClick={() => onRespond(key, option.id)}
                        title={option.description}
                    >
                        {t(`confirmation.options.${option.id}`, { defaultValue: option.label })}
                    </button>
                ))}
            </div>

            {/* Independent guidance input */}
            <div className="toast-guidance-section">
                <div className="toast-guidance-input-row">
                    <input
                        type="text"
                        className="toast-guidance-input"
                        placeholder={isAgentQuestion ? t('confirmation.guidancePlaceholderQuestion') : t('confirmation.guidancePlaceholderDefault')}
                        value={guidanceText}
                        onChange={(e) => setGuidanceText(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && guidanceText.trim()) {
                                handleSendGuidance();
                            }
                        }}
                    />
                    <button
                        className="toast-btn toast-guidance-send"
                        onClick={handleSendGuidance}
                        disabled={!guidanceText.trim()}
                        title={t('confirmation.sendGuidance')}
                    >
                        <Send size={14} />
                    </button>
                </div>
            </div>
        </div>
    );
}
