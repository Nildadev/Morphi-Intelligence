'use strict';
// Process-level failure reporting for the Electron main process.
//
// In a packaged app there is no console and no crash reporter, so an unhandled rejection (a backend
// restart, a keyring call, an IPC handler returning a rejected promise) produced nothing at all: no
// message, no log, no window. This writes one line to `crash.log` beside the database and lets the
// caller decide whether a dialog is possible yet.
const fs = require('node:fs');
const path = require('node:path');

/** Anything shaped like a credential is replaced before it reaches the log file. */
const SECRET_PATTERNS = [
    // Provider keys: OpenAI/Anthropic-style `sk-`, Google `AIza`, and long hex blobs.
    [/sk-[A-Za-z0-9_-]{8,}/g, '***'],
    [/AIza[0-9A-Za-z_-]{20,}/g, '***'],
    [/(?<![0-9a-z])[0-9a-f]{32,}(?![0-9a-z])/gi, '***'],
    // `Bearer` first: matching the header name alone would mask the scheme and leave the token behind.
    [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***'],
    // Any other header copied into an error message by a failed fetch. The scheme word is skipped so the
    // line still reads `Authorization: Bearer ***` instead of hiding what kind of credential it was.
    [/((?:authorization|x-morphi-token|token)["']?\s*[:=]\s*["']?)(?!(?:bearer|basic|token)\b)[^\s,"'}]+/gi, '$1***'],
];

function redact(text) {
    return SECRET_PATTERNS.reduce((line, [pattern, replacement]) => line.replace(pattern, replacement), text);
}

function describe(error) {
    if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
    if (typeof error === 'string') return error;
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

/**
 * @param {object} options
 * @param {string} options.logPath absolute path of the append-only log file
 * @param {(kind: string, detail: string) => void} [options.onReport] called after the write (the dialog)
 * @param {number} [options.maxLength] cap per entry, so a cyclic object cannot fill the disk
 */
function createFatalReporter({ logPath, onReport = () => {}, maxLength = 4000 }) {
    return function report(kind, error) {
        const raw = describe(error);
        const detail = redact(raw.length > maxLength ? `${raw.slice(0, maxLength)}…` : raw);
        const line = `[${new Date().toISOString()}] ${kind}: ${detail}\n`;
        try {
            fs.mkdirSync(path.dirname(logPath), { recursive: true });
            fs.appendFileSync(logPath, line);
        } catch {
            // A log that cannot be written must never mask the failure being reported.
        }
        try {
            onReport(kind, detail);
        } catch {
            // Same: the notification is best effort.
        }
        return detail;
    };
}

module.exports = { createFatalReporter, redact };
