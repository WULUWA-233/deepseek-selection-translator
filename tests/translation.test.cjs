const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const tick = () => new Promise(resolve => setImmediate(resolve));
const source = name => fs.readFileSync(path.join(__dirname, '../extension', name), 'utf8');

function content() {
  const dom = new JSDOM('<p>English text</p>', { runScripts: 'outside-only', url: 'https://example.test' });
  const w = dom.window, requests = [];
  let root;
  const attach = w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow = function (options) { root = attach.call(this, options); return root; };
  w.chrome = { runtime: { sendMessage(message) {
    if (message.type === 'DSIT_CANCEL') return Promise.resolve({ ok: true });
    return new Promise((resolve, reject) => requests.push({ message, resolve, reject }));
  } } };
  w.requestAnimationFrame = callback => callback();
  // Expose lexical helpers only in this transformed test copy; shipping code has no test bridge.
  w.eval(source('content.js').replace(/\}\)\(\);\s*$/, `window.testAPI = {
    select(text) { selectedText = text; selectionRect = {left:20,right:120,top:30,bottom:50}; showIcon(selectionRect); },
    translateSelection, closePanel
  }; })();`));
  return { dom, w, requests, root };
}

function background(fetchImpl, initialSession = {}) {
  let listener;
  const settings = { apiKey: 'test-only-placeholder', model: 'deepseek-flash', targetLanguage: '简体中文' };
  const session = initialSession, timers = new Map();
  let timerId = 0, calls = 0, access;
  const chrome = {
    runtime: { id: 'test-extension', getURL: value => 'chrome-extension://test-extension/' + value,
      onInstalled: { addListener() {} }, onMessage: { addListener(fn) { listener = fn; } } },
    storage: {
      local: { setAccessLevel(value) { access = value; return Promise.resolve(); }, get: async () => settings, set: async () => {} },
      session: { get: async () => session, set: async value => Object.assign(session, value) },
    },
  };
  vm.runInNewContext(source('background.js'), { chrome, AbortController, DOMException,
    fetch: (...args) => { calls++; return fetchImpl(...args); },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  const sender = { id: 'test-extension', url: 'https://example.test', tab: { id: 1 }, frameId: 0 };
  return { timers, session, get calls() { return calls; }, get access() { return access; },
    send(message, from = sender) { return new Promise(resolve => listener(message, from, resolve)); } };
}

test('untrusted selection and synthetic clicks cannot call the paid API; shadow stays closed', () => {
  const { dom, w, requests, root } = content();
  w.document.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true }));
  w.testAPI.select('English');
  root.querySelector('#icon').click();
  assert.equal(requests.length, 0);
  assert.equal(w.document.querySelector('#dsit-selection-translator-host').shadowRoot, null);
  dom.window.close();
});

test('an old failure cannot overwrite a newer translation', async () => {
  const { dom, w, root, requests } = content();
  w.testAPI.select('old');
  const first = w.testAPI.translateSelection({ isTrusted: true });
  w.testAPI.select('new');
  const second = w.testAPI.translateSelection({ isTrusted: true });
  requests[1].resolve({ ok: true, translation: '<script>literal text</script>' });
  await second;
  requests[0].reject(new Error('old failure'));
  await first;
  assert.equal(root.querySelector('#result').textContent, '<script>literal text</script>');
  assert.equal(root.querySelector('#result script'), null);
  dom.window.close();
});

test('deadline covers a stalled response body and clears its timer', async () => {
  const bg = background(async () => ({ ok: true, json: () => new Promise(() => {}) }));
  const result = bg.send({ type: 'DSIT_TRANSLATE_TEXT', text: 'hello', requestId: 'body-timeout' });
  await tick();
  assert.equal(bg.timers.size, 1);
  for (const callback of bg.timers.values()) callback();
  assert.equal((await result).ok, false);
  assert.equal(bg.timers.size, 0);
  assert.equal(bg.access.accessLevel, 'TRUSTED_CONTEXTS');
});

test('cancellation during asynchronous admission prevents a hanging request', async () => {
  const bg = background(async () => new Promise(() => {}));
  const request = bg.send({ type: 'DSIT_TRANSLATE_TEXT', text: 'hello', requestId: 'cancel-me' });
  const cancelled = bg.send({ type: 'DSIT_CANCEL', requestId: 'cancel-me' });
  assert.equal((await cancelled).ok, true);
  assert.equal((await request).ok, false);
});

test('page cannot invoke settings test, bad origins are rejected, and errors do not leak server bodies', async () => {
  const bg = background(async () => ({ ok: false, status: 401, text: async () => 'private secret' }));
  assert.equal((await bg.send({ type: 'DSIT_TEST_API', requestId: 'test' })).ok, false);
  assert.equal((await bg.send({ type: 'DSIT_TRANSLATE_TEXT', text: 'x', requestId: 'bad' }, { id: 'foreign' })).ok, false);
  const result = await bg.send({ type: 'DSIT_TRANSLATE_TEXT', text: 'hello', requestId: 'good' });
  assert.match(result.error, /401/);
  assert.ok(!result.error.includes('private'));
  assert.equal(bg.calls, 1);
});

test('minute budget is enforced and stored across worker instances', async () => {
  const bg = background(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '你好' } }] }) }));
  for (let i = 0; i < 10; i++) assert.equal((await bg.send({ type: 'DSIT_TRANSLATE_TEXT', text: 'hi', requestId: 'request-' + i })).ok, true);
  const result = await bg.send({ type: 'DSIT_TRANSLATE_TEXT', text: 'hi', requestId: 'excess' });
  assert.equal(result.ok, false);
  assert.equal(bg.calls, 10);
  assert.equal(bg.session.requestTimes.length, 10);
  const restarted = background(async () => { throw new Error('should not fetch'); }, bg.session);
  assert.equal((await restarted.send({ type: 'DSIT_TRANSLATE_TEXT', text: 'hi', requestId: 'after-restart' })).ok, false);
  assert.equal(restarted.calls, 0);
});
