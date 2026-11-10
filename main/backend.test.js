const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createReadyPromise } = require('./backend');

test('resolves the actual port from the child message', async () => {
  const child = new EventEmitter();
  const ready = createReadyPromise(child, 1000);
  child.emit('message', { type: 'ready', port: 41234 });
  assert.deepStrictEqual(await ready, { port: 41234 });
});

test('rejects on timeout', async () => {
  const child = new EventEmitter();
  await assert.rejects(createReadyPromise(child, 10), /SERVER_START_TIMEOUT/);
});
