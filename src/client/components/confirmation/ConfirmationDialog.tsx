// Confirmation Dialog Component
// Compact inline dialog for user confirmation of operations and agent questions.
// Renders above the chat input. The chat textarea doubles as guidance input.

import { useEffect, useState } from 'react';
import { MessageCircleQuestion } from 'lucide-react';
import type { ConfirmationRequest } from '../../types';
import { DiffView } from '../tool-views/DiffView';
import { shortenHomePath, cleanOperationType } from '../../utils/formatting';
import {
    getApprovalButtonClass,
    getOperationTypePillClass,
    getQuestionText,
    getRiskBadgeClass,
    getVisibleToolArgs,
    hasExpandableContent,
    formatArgValue,
} from './utils';

import { ALT_KEY } from '../../utils/platform';
import { useTranslation } from 'react-i18next';

interface ConfirmationDialogProps {
    request: ConfirmationRequest;
    onRespond: (optionId: string, guidance?: string) => void;
}

export function ConfirmationDialog({ request, onRespond }: ConfirmationDialogProps) {
    const { t } = useTranslation();
    const [showDetails, setShowDetails] = useState(false);
    const isAgentQuestion = request.operation === 'ask_user';

    // Handle keyboard shortcuts (Alt+1, Alt+2, etc. to select options)
    // Use e.code (physical key) since Option+number on Mac produces special characters in e.key
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!e.altKey) return;
            const match = e.code.match(/^Digit(\d)$/);
            if (!match?.[1]) return;
            const keyNum = parseInt(match[1]);
            if (keyNum >= 1 && keyNum <= request.options.length) {
                e.preventDefault();
                const option = request.options[keyNum - 1];
                if (option) onRespond(option.id);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [request.options, onRespond]);

    // Get structured command info from context
    const commandInfo = request.context?.commandInfo;

    const visibleToolArgs = getVisibleToolArgs(request);
    const hasDetails = hasExpandableContent(request);
    const detailsId = `confirmation-details-${request.requestId}`;
    const questionText = getQuestionText(request);
    const displayOpType = request.context?.operationType && !isAgentQuestion
        ? cleanOperationType(request.context.operationType)
        : null;
    const riskLevel = request.context?.riskLevel;

    return (
        <div className="confirmation-container">
            <div className={`confirmation-dialog ${isAgentQuestion ? 'agent-question' : ''}`}>
                {/* Header: question + risk badge, compact single row */}
                <div className="confirmation-header">
                    <h3 className={`confirmation-title ${isAgentQuestion ? 'agent-question-title' : ''}`}>
                        {isAgentQuestion && <MessageCircleQuestion size={14} className="question-icon" />}
                        {questionText}
                    </h3>
                    <div className="confirmation-badges">
                        {riskLevel && (
                            <span className={getRiskBadgeClass(riskLevel)}>
                                {t(`confirmation.risk.${riskLevel}`, { defaultValue: riskLevel })}
                            </span>
                        )}
                    </div>
                </div>

                {hasDetails && (
                    <div className="confirmation-details-toggle-row">
                        <button
                            type="button"
                            className="confirmation-details-toggle"
                            aria-expanded={showDetails}
                            aria-controls={detailsId}
                            onClick={() => setShowDetails(!showDetails)}
                        >
                            {showDetails
                                ? t('confirmation.hideDetails', { defaultValue: 'Hide details' })
                                : t('confirmation.showDetails', { defaultValue: 'Show details' })}
                        </button>
                    </div>
                )}

                {/* Details stay collapsed by default so raw command text, args, and diffs are hidden. */}
                {showDetails && hasDetails && (
                    <div className="confirmation-body confirmation-details" id={detailsId}>
                        {request.message && (
                            <div className="confirmation-message">
                                {request.message.split('\n').map((line, idx) => (
                                    <p key={idx}>{line || <br />}</p>
                                ))}
                            </div>
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

                        {commandInfo && (
                            <div className="command-confirmation">
                                {commandInfo.reason && (
                                    <div className="command-section">
                                        <div className="reason-content">{commandInfo.reason}</div>
                                    </div>
                                )}
                                {commandInfo.command && (
                                    <div className="command-section">
                                        <div className="command-section-header">
                                            <span className="command-section-label">{t('confirmation.command')}</span>
                                            {commandInfo.workdir && (
                                                <code className="workdir-pill" title={commandInfo.workdir}>
                                                    {t('confirmation.in')} {shortenHomePath(commandInfo.workdir)}
                                                </code>
                                            )}
                                        </div>
                                        <pre className="command-content">
                                            <code>{commandInfo.command}</code>
                                        </pre>
                                    </div>
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

                        {/* Diff view for edits/writes */}
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

                {/* Actions: compact button row */}
                <div className="confirmation-actions">
                    {request.options.map((option, index) => (
                        <button
                            key={option.id}
                            className={getApprovalButtonClass(option, request.options, 'confirmation-btn')}
                            onClick={() => onRespond(option.id)}
                            title={`${option.description || option.label} (${ALT_KEY}${index + 1})`}
                        >
                            <span className="btn-shortcut">{index + 1}</span>
                            {t(`confirmation.options.${option.id}`, { defaultValue: option.label })}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}
