/**
 * User-Agent header for outbound platform requests.
 */

import { version } from '../../../package.json';

const userAgent = `HeyJada/${version} (${process.platform})`;

export function getClientHeaders(): Record<string, string> {
    return { 'User-Agent': userAgent };
}
