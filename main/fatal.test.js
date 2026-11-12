'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createFatalReporter, redact } = require('./fatal');

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'morphi-fatal-'));
}

test('writes one timestamped line per report', (t) => {
    const dir = tempDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const logPath = path.join(dir, 'nested', 'crash.log');
    const seen = [];
    const report = createFatalReporter({ logPath, onReport: (kind, detail) => seen.push([kind, detail]) });

    report('unhandledRejection', new Error('backend died'));
    report('uncaughtException', 'not an Error');

    // One entry per report; a stack trace continues on indented lines, so every entry still starts with
    // its own timestamp.
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    const entries = lines.filter((line) => line.startsWith('['));
    assert.equal(entries.length, 2);
    assert.match(entries[0], /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] unhandledRejection: Error: backend died/);
    assert.match(entries[1], /uncaughtException: not an Error$/);
    // Stack frames keep going, indented, under the entry that owns them.
    assert.ok(lines.slice(1).some((line) => /^\s+at /.test(line)), 'stack frames should be indented');
    assert.equal(seen.length, 2);
});

test('strips credentials before they reach the file', (t) => {
    const dir = tempDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const logPath = path.join(dir, 'crash.log');
    const report = createFatalReporter({ logPath });

    // The shapes that actually leak: a provider key in an error message, and headers echoed by a fetch
    // failure. Both are redacted, and the header name survives so the line still says what broke.
    report('uncaughtException', new Error('401 for key sk-live-abcdef123456 and AIzaSyABCDEFGHIJKLMNOPQRSTUV'));
    report('uncaughtException', new Error('fetch failed: Authorization: Bearer abc.def.ghi'));

    const contents = fs.readFileSync(logPath, 'utf8');
    assert.ok(!contents.includes('sk-live-abcdef123456'), 'provider key leaked');
    assert.ok(!contents.includes('AIzaSyABCDEFGHIJKLMNOPQRSTUV'), 'google key leaked');
    assert.ok(!contents.includes('abc.def.ghi'), 'bearer token leaked');
    assert.match(contents, /Authorization: Bearer \*\*\*/i);
});

test('redacts bare long hex blobs and keeps short hex readable', () => {
    assert.equal(redact('commit 4f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d'), 'commit ***');
    // A git short hash, an id and a version are not credentials.
    assert.equal(redact('id 4f2a9c1d v1.1.0'), 'id 4f2a9c1d v1.1.0');
});

test('caps a huge or cyclic payload instead of filling the disk', (t) => {
    const dir = tempDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const logPath = path.join(dir, 'crash.log');
    const report = createFatalReporter({ logPath, maxLength: 50 });

    const huge = { pad: 'x'.repeat(10_000) };
    const written = report('unhandledRejection', huge);
    assert.ok(written.length <= 52, `detail should be capped, got ${written.length}`);

    const cyclic = {};
    cyclic.self = cyclic;
    // JSON.stringify throws on this; the reporter must still produce something readable.
    const described = report('unhandledRejection', cyclic);
    assert.ok(described.length > 0);
    assert.equal(fs.readFileSync(logPath, 'utf8').trim().split('\n').length, 2);
});

test('never throws when the log cannot be written', () => {
    // A directory in place of the file is the realistic failure (permissions, a full disk).
    const dir = tempDir();
    const logPath = path.join(dir, 'crash.log');
    fs.mkdirSync(logPath);
    const report = createFatalReporter({ logPath, onReport: () => { throw new Error('dialog failed'); } });
    assert.doesNotThrow(() => report('uncaughtException', new Error('boom')));
    fs.rmSync(dir, { recursive: true, force: true });
});
