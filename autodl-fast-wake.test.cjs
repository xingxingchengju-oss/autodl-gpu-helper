const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { shouldTakeOver, mount } = require('./autodl-gpu-helper.user.js');

// Reuse the existing fixture without registering or modifying its test suite.
const legacyPath = path.join(__dirname, 'autodl-helper.test.cjs');
const legacySource = fs.readFileSync(legacyPath, 'utf8');
const fixtureEnd = legacySource.indexOf('\ntest(');
assert.ok(fixtureEnd > 0, 'Existing fixture must precede its test cases');
const fixtureModule = { exports: {} };
new Function('require', 'module', `${legacySource.slice(0, fixtureEnd)}\nmodule.exports = { fixture, ID, OTHER, flush };`)(
    createRequire(legacyPath), fixtureModule);
const { fixture, ID, OTHER, flush } = fixtureModule.exports;

function setAvailable(env, available, id = ID) {
    env.findRow(id).querySelector('.gpuTips').textContent = available ? 'GPU充足' : '';
}

function trustedEvent(target, options = {}) {
    const eventPath = [];
    for (let node = target; node; node = node.parentNode) eventPath.push(node);
    return { isTrusted: true, type: 'pointerdown', target, composedPath: () => eventPath, ...options };
}

test('already-ready selected instance starts without an extra list refresh', async () => {
    const e = fixture(true);
    await e.start();
    await e.clock.advance(200);
    assert.equal(e.actions.boot, 1);
    assert.equal(e.actions.confirm, 1);
    assert.equal(e.actions.refresh, 0);
    e.cleanup();
});

test('a brief selected-target availability transition wakes the serialized loop', async () => {
    const e = fixture(false);
    await e.start();
    await e.clock.advance(100);
    assert.equal(e.state.state, '等待资源');
    const before = e.actions.refresh;
    setAvailable(e, true);
    await e.clock.advance(200);
    setAvailable(e, false);
    assert.equal(e.actions.confirm, 1);
    assert.equal(e.actions.boot, 1);
    assert.equal(e.actions.refresh, before);
    e.cleanup();
});

test('another instance becoming available cannot wake the selected target', async () => {
    const e = fixture(false);
    setAvailable(e, false, OTHER);
    await e.start();
    await e.clock.advance(100);
    const before = e.actions.refresh;
    setAvailable(e, true, OTHER);
    await e.clock.advance(1000);
    assert.equal(e.actions.boot, 0);
    assert.equal(e.actions.confirm, 0);
    assert.equal(e.actions.refresh, before);
    assert.equal(e.state.state, '等待资源');
    e.cleanup();
});

test('a capacity rejection consumes the same visible ready marker once', async () => {
    const e = fixture(true);
    e.onBoot = () => e.clock.setTimeout(() => e.dialog(e.shortageBody, true), 20);
    await e.start();
    await e.clock.advance(100);
    assert.equal(e.actions.boot, 1);
    assert.equal(e.actions.cancel, 1);
    for (let i = 0; i < 5; i++) {
        setAvailable(e, true);
        await e.clock.advance(100);
    }
    await e.clock.advance(3500);
    assert.equal(e.actions.boot, 1);
    assert.equal(e.actions.cancel, 1);
    await e.clock.advance(1200);
    assert.equal(e.actions.boot, 2);
    assert.equal(e.actions.cancel, 2);
    assert.equal(e.actions.confirm, 0);
    e.cleanup();
});

test('a new false-to-true transition after a capacity rejection can wake again', async () => {
    const e = fixture(true);
    e.onBoot = () => e.clock.setTimeout(() => e.dialog(e.shortageBody, true), 20);
    await e.start();
    await e.clock.advance(100);
    assert.equal(e.actions.boot, 1);
    setAvailable(e, false);
    await e.clock.advance(100);
    setAvailable(e, true);
    await e.clock.advance(200);
    assert.equal(e.actions.boot, 2);
    assert.equal(e.actions.cancel, 2);
    e.cleanup();
});

test('ready GPU with a disabled boot button waits until the button becomes enabled', async () => {
    const e = fixture(true);
    const button = e.findRow(ID).querySelector('td:last-child button');
    button.disabled = true;
    await e.start();
    await e.clock.advance(100);
    const before = e.actions.refresh;
    assert.equal(e.actions.boot, 0);
    button.disabled = false;
    await e.clock.advance(200);
    assert.equal(e.actions.confirm, 1);
    assert.equal(e.actions.refresh, before);
    e.cleanup();
});

test('availability during 429 backoff does not bypass the waiting deadline', async () => {
    const e = fixture(false);
    e.onRefresh = () => e.error('请求过于频繁 429');
    await e.start();
    await e.clock.advance(100);
    assert.equal(e.state.state, '等待重试');
    const deadline = e.state.nextAt;
    const before = e.actions.refresh;
    setAvailable(e, true);
    await e.clock.advance(1000);
    assert.equal(e.actions.boot, 0);
    assert.equal(e.actions.confirm, 0);
    assert.equal(e.actions.refresh, before);
    assert.equal(e.state.nextAt, deadline);
    e.onRefresh = null;
    await e.clock.advance(deadline - e.clock.time + 300);
    assert.equal(e.actions.confirm, 1);
    e.cleanup();
});

test('429 feedback arriving with readiness is handled before any boot click', async () => {
    const e = fixture(false);
    await e.start();
    await e.clock.advance(100);
    const before = e.actions.refresh;
    e.error('请求过于频繁 429');
    setAvailable(e, true);
    await e.clock.advance(100);
    assert.equal(e.actions.boot, 0);
    assert.equal(e.actions.confirm, 0);
    assert.equal(e.actions.refresh, before);
    assert.equal(e.state.state, '等待重试');
    const deadline = e.state.nextAt;
    await e.clock.advance(deadline - e.clock.time - 1);
    assert.equal(e.actions.boot, 0);
    assert.equal(e.actions.refresh, before);
    await e.clock.advance(301);
    assert.equal(e.actions.boot, 1);
    assert.equal(e.actions.confirm, 1);
    e.cleanup();
});

test('an unresolved resumed submission never submits again on a ready transition', async () => {
    const e = fixture(false);
    await e.start({ phase: 'submitted', submittedAt: e.clock.time - 100, attempts: 1 });
    await e.clock.advance(100);
    setAvailable(e, true);
    await e.clock.advance(6000);
    assert.equal(e.actions.boot, 0);
    assert.equal(e.actions.confirm, 0);
    assert.equal(e.state.state, '等待启动');
    e.cleanup();
});

test('stop discards a queued availability mutation and samples exactly once', async () => {
    const e = fixture(false);
    await e.start();
    await e.clock.advance(100);
    setAvailable(e, true);
    const reads = e.actions.reads;
    e.grabber.stop();
    assert.equal(e.actions.reads, reads + 1);
    const stopped = { ...e.actions };
    await e.clock.advance(20000);
    assert.deepEqual(e.actions, stopped);
    assert.equal(e.state.state, '已停止');
    e.cleanup();
});

test('reordering before a ready transition still resolves the full selected ID', async () => {
    const e = fixture(false);
    await e.start();
    await e.clock.advance(100);
    e.findRow(ID).parentElement.append(e.findRow(ID));
    setAvailable(e, true);
    await e.clock.advance(200);
    assert.equal(e.actions.confirm, 1);
    assert.equal(e.actions.boot, 1);
    e.cleanup();
});

test('table replacement before readiness reacquires the current target row', async () => {
    const e = fixture(false);
    await e.start();
    await e.clock.advance(100);
    const table = e.document.querySelector('.el-table.instance-table');
    const replacement = table.cloneNode(true);
    const target = [...replacement.querySelectorAll('tr.el-table__row')].find(row => row.textContent.includes(ID));
    target.querySelector('.gpuTips').textContent = 'GPU充足';
    target.querySelector('td:last-child button').addEventListener('click', () => {
        e.actions.boot++;
        e.clock.setTimeout(() => e.dialog(), 20);
    });
    table.replaceWith(replacement);
    await e.clock.advance(200);
    assert.equal(e.actions.boot, 1);
    assert.equal(e.actions.confirm, 1);
    e.cleanup();
});

test('duplicate target IDs appearing before readiness pause without a click', async () => {
    const e = fixture(false);
    await e.start();
    await e.clock.advance(100);
    const original = e.findRow(ID);
    original.parentElement.append(original.cloneNode(true));
    setAvailable(e, true);
    await e.clock.advance(200);
    assert.equal(e.actions.boot, 0);
    assert.equal(e.actions.confirm, 0);
    assert.equal(e.state.state, '已暂停');
    e.cleanup();
});

test('an availability update during native loading waits for loading to finish', async () => {
    const e = fixture(false);
    await e.start();
    await e.clock.advance(100);
    const box = e.document.querySelector('.table-box');
    box.classList.add('is-loading');
    setAvailable(e, true);
    await e.clock.advance(200);
    assert.equal(e.actions.boot, 0);
    box.classList.remove('is-loading');
    await e.clock.advance(200);
    assert.equal(e.actions.confirm, 1);
    e.cleanup();
});

test('takeover distinguishes passive clicks and verified refresh from operation controls', () => {
    assert.equal(typeof shouldTakeOver, 'function');
    const e = fixture(false);
    const host = e.document.createElement('div');
    e.document.body.append(host);
    const refresh = e.document.querySelector('.content-header button.refresh-btn');
    refresh.innerHTML = '<span>刷新</span>';
    assert.equal(shouldTakeOver(trustedEvent(e.document.body), host), false);
    assert.equal(shouldTakeOver(trustedEvent(refresh), host), false);
    assert.equal(shouldTakeOver(trustedEvent(refresh.querySelector('span')), host), false);
    assert.equal(shouldTakeOver(trustedEvent(e.findRow(ID).querySelector('td:last-child button')), host), true);
    assert.equal(shouldTakeOver(trustedEvent(e.dialog().querySelector('.el-button--primary')), host), true);
    const spoof = e.document.createElement('button');
    spoof.className = 'refresh-btn';
    e.document.body.append(spoof);
    assert.equal(shouldTakeOver(trustedEvent(spoof), host), true);
    assert.equal(shouldTakeOver(trustedEvent(host), host), false);
    assert.equal(shouldTakeOver(trustedEvent(host, { type: 'keydown', key: 'Escape' }), host), true);
    assert.equal(shouldTakeOver(trustedEvent(spoof, { isTrusted: false }), host), false);
    e.cleanup();
});

test('mounted manual refresh and blank click preserve active monitoring', async () => {
    const e = fixture(false);
    const handlers = {};
    const add = e.document.addEventListener.bind(e.document);
    e.document.addEventListener = (name, callback, options) => {
        handlers[name] = callback;
        return add(name, callback, options);
    };
    const app = mount(e.window);
    app.grabber.locks = e.grabber.locks;
    app.grabber.clock = e.clock;
    app.grabber.now = () => e.clock.time;
    app.shadow.getElementById('target').value = ID;
    app.shadow.getElementById('interval').value = '5';
    app.shadow.getElementById('start').click();
    await e.clock.advance(300);
    handlers.pointerdown(trustedEvent(e.document.body));
    assert.equal(app.grabber.model.active, true);
    const refresh = e.document.querySelector('.content-header button.refresh-btn');
    handlers.pointerdown(trustedEvent(refresh));
    assert.equal(app.grabber.model.active, true);
    e.onRefresh = () => setAvailable(e, true);
    const before = e.actions.refresh;
    refresh.click();
    await e.clock.advance(300);
    assert.equal(e.actions.confirm, 1);
    assert.equal(e.actions.refresh, before + 1);
    handlers.pointerdown(trustedEvent(e.findRow(ID).querySelector('td:last-child button:last-child')));
    assert.equal(app.grabber.model.state, '已停止');
    assert.equal(app.grabber.model.active, false);
    app.grabber.stop();
    e.cleanup();
});
