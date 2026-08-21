// Streaming indicator with the Superjoy "thinking" orbs and animated dots

import React from 'react';

export function StreamingIndicator() {
    return (
        <div className="message-content streaming">
            <img
                src="/brand/state-thinking.jpg"
                alt=""
                aria-hidden="true"
                className="streaming-brand-state"
            />
            <span className="streaming-dot" />
            <span className="streaming-dot" />
            <span className="streaming-dot" />
        </div>
    );
}
