const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { mount, SETTINGS_KEY } = require('./autodl-gpu-helper.user.js');
const legacyPath = path.join(__dirname, 'autodl-helper.test.cjs');
const legacySource = fs.readFileSync(legacyPath, 'utf8');
const fixtureModule = { exports: {} };
new Function('require', 'module', `${legacySource.slice(0, legacySource.indexOf('\ntest('))}\nmodule.exports = { fixture, ID, OTHER, flush, row };`)(createRequire(legacyPath), fixtureModule);
const { fixture, ID, OTHER, flush, row } = fixtureModule.exports;
const THIRD = 'thirdhost1-11223344';

function multi(available = false) {
    const e = fixture(available);
    const tbody = e.document.querySelector('tbody');
    tbody.insertAdjacentHTML('beforeend', row(THIRD, available));
    e.bootOrder = [];
    e.confirmOrder = [];
    e.notified = [];
    e.setStatus = (id, status) => { e.findRow(id).querySelector('.status > span').textContent = status; };
    e.available = (id, value) => { e.findRow(id).querySelector('.gpuTips').textContent = value ? 'GPU充足' : ''; };
    for (const id of [ID, OTHER, THIRD]) {
        e.available(id, available);
        const old = e.findRow(id);
        const replacement = old.cloneNode(true);
        old.replaceWith(replacement);
        replacement.querySelector('td:last-child button').addEventListener('click', () => {
            e.activeId = id;
            e.actions.boot++;
            e.bootOrder.push(id);
            if (e.onBootId) e.onBootId(id);
            else e.clock.setTimeout(() => e.dialog(), 20);
        });
    }
    e.onConfirm = () => {
        const id = e.activeId;
        e.confirmOrder.push(id);
        e.afterConfirm?.(id);
    };
    e.grabber.notify = id => { e.notified.push(id); };
    e.begin = async (ids = [ID, OTHER, THIRD], saved = null) => {
        void e.grabber.start({ ids, seconds: 5 }, saved);
        await flush();
    };
    return e;
}

test('three targets boot serially and each notifies once before all-complete', async () => {
    const e = multi(true);
    await e.begin(); await e.clock.advance(100);
    assert.deepEqual(e.bootOrder, [ID]);
    assert.deepEqual(e.confirmOrder, [ID]);
    e.setStatus(ID, '开机中'); await e.clock.advance(5200);
    assert.deepEqual(e.bootOrder, [ID]);
    e.setStatus(ID, '运行中'); await e.clock.advance(100);
    assert.deepEqual(e.notified, [ID]);
    assert.deepEqual(e.bootOrder, [ID, OTHER]);
    assert.equal(e.state.active, true);
    e.setStatus(OTHER, '运行中'); await e.clock.advance(100);
    assert.deepEqual(e.bootOrder, [ID, OTHER, THIRD]);
    e.setStatus(THIRD, '运行中'); await e.clock.advance(100);
    assert.equal(e.state.state, '抢卡成功');
    assert.deepEqual(e.notified, [ID, OTHER, THIRD]);
    assert.equal(e.state.targets.filter(t => t.done).length, 3);
    await e.clock.advance(20000);
    assert.equal(e.actions.boot, 3);
    assert.equal(e.notified.length, 3);
    e.cleanup();
});

test('a missing first GPU does not block a later available target', async () => {
    const e = multi(false);
    e.available(OTHER, true);
    await e.begin(); await e.clock.advance(100);
    assert.deepEqual(e.bootOrder, [OTHER]);
    e.setStatus(OTHER, '运行中'); await e.clock.advance(100);
    assert.equal(e.state.active, true);
    e.available(THIRD, true); await e.clock.advance(100);
    assert.deepEqual(e.bootOrder, [OTHER, THIRD]);
    e.cleanup();
});

test('capacity precheck failure advances to the next selected target', async () => {
    const e = multi(true);
    e.onBootId = id => e.clock.setTimeout(() => id === ID ? e.dialog(e.shortageBody, true) : e.dialog(), 20);
    await e.begin(); await e.clock.advance(150);
    assert.deepEqual(e.bootOrder, [ID, OTHER]);
    assert.deepEqual(e.confirmOrder, [OTHER]);
    assert.equal(e.actions.cancel, 1);
    e.cleanup();
});

test('failed persistent ready marker is not retried when another target wakes', async () => {
    const e = multi(false);
    e.available(ID, true);
    e.onBootId = id => e.clock.setTimeout(() => id === ID ? e.dialog(e.shortageBody, true) : e.dialog(), 20);
    await e.begin(); await e.clock.advance(100);
    e.available(OTHER, true); await e.clock.advance(100);
    assert.deepEqual(e.bootOrder, [ID, OTHER]);
    e.cleanup();
});

test('unselected third instance never boots even when ready', async () => {
    const e = multi(false);
    await e.begin([ID, OTHER]); await e.clock.advance(100);
    e.available(THIRD, true); await e.clock.advance(6000);
    assert.equal(e.actions.boot, 0);
    e.cleanup();
});

for (const ids of [[], [ID, ID], [ID, OTHER, THIRD, 'fourth-1234'], [ID, '']]) {
    test(`invalid target selection produces no action ${JSON.stringify(ids)}`, async () => {
        const e = multi(true);
        await e.begin(ids); await e.clock.advance(100);
        assert.equal(e.actions.boot, 0);
        assert.equal(e.actions.refresh, 0);
        assert.equal(e.state.active, false);
        e.cleanup();
    });
}

test('all selected IDs are validated before the first boot', async () => {
    const e = multi(true);
    e.findRow(THIRD).remove();
    await e.begin(); await e.clock.advance(100);
    assert.equal(e.state.state, '已暂停');
    assert.equal(e.actions.boot, 0);
    e.cleanup();
});

for (const stage of ['waiting', 'opening', 'submitted']) {
    test(`stop in multi-target ${stage} samples each target exactly once and cancels all actions`, async () => {
        const e = multi(stage !== 'waiting');
        if (stage === 'opening') e.onBootId = () => e.clock.setTimeout(() => e.dialog(), 100);
        await e.begin(); await e.clock.advance(stage === 'opening' ? 5 : 100);
        const reads = e.actions.reads;
        e.grabber.stop();
        assert.equal(e.actions.reads, reads + 3);
        const stopped = { ...e.actions };
        await e.clock.advance(20000);
        assert.deepEqual(e.actions, stopped);
        assert.equal(e.notified.length, 0);
        assert.match(e.state.detail, new RegExp(THIRD));
        e.cleanup();
    });
}

test('queued multi-target ready mutation is invalidated by stop', async () => {
    const e = multi();
    await e.begin(); await e.clock.advance(100);
    e.available(THIRD, true);
    const reads = e.actions.reads;
    e.grabber.stop();
    await e.clock.advance(20000);
    assert.equal(e.actions.reads, reads + 3);
    assert.equal(e.actions.boot, 0);
    e.cleanup();
});

test('multi-target restore retains completed and uncertain targets without duplicate requests', async () => {
    const e = multi(true);
    await e.begin(); await e.clock.advance(100);
    e.setStatus(ID, '运行中'); await e.clock.advance(100);
    assert.deepEqual(e.confirmOrder, [ID, OTHER]);
    e.grabber.suspendForNavigation(); await flush();
    const saved = e.grabber.readSaved();
    assert.equal(saved.targets[0].done, true);
    assert.ok(saved.targets[1].submittedAt);
    await e.begin(saved.ids, saved); await e.clock.advance(5200);
    assert.deepEqual(e.confirmOrder, [ID, OTHER]);
    assert.deepEqual(e.notified, [ID]);
    e.setStatus(OTHER, '运行中'); await e.clock.advance(100);
    assert.deepEqual(e.confirmOrder, [ID, OTHER, THIRD]);
    e.cleanup();
});

test('restore detects a completed instance whose status changed', async () => {
    const e = multi(true);
    const saved = { version: 2, targets: [{ id: ID, done: true }], ids: [ID, OTHER], seconds: 5 };
    await e.begin(saved.ids, saved); await e.clock.advance(100);
    assert.equal(e.state.state, '已暂停');
    assert.equal(e.actions.boot, 0);
    e.cleanup();
});

test('unknown feedback after an opening failure cannot be assigned to the next instance', async () => {
    const e = multi(true);
    e.onBootId = () => e.error('Network Error');
    await e.begin(); await e.clock.advance(20000);
    assert.equal(e.state.state, '已暂停');
    assert.deepEqual(e.bootOrder, [ID]);
    assert.equal(e.actions.confirm, 0);
    e.cleanup();
});

test('multi-target rate limit overrides readiness across all instances', async () => {
    const e = multi();
    e.onRefresh = () => e.error('429 请求过多');
    await e.begin(); await e.clock.advance(100);
    const deadline = e.state.nextAt;
    e.available(THIRD, true); await e.clock.advance(1000);
    assert.equal(e.actions.boot, 0);
    e.onRefresh = null;
    await e.clock.advance(deadline - e.clock.time + 100);
    assert.deepEqual(e.bootOrder, [THIRD]);
    e.cleanup();
});

test('UI count and selectors start exactly the selected three instances', async () => {
    const e = multi();
    const app = mount(e.window);
    app.grabber.clock = e.clock;
    app.grabber.now = () => e.clock.time;
    app.grabber.locks = e.grabber.locks;
    const get = id => app.shadow.getElementById(id);
    get('count').value = '3'; get('count').dispatchEvent(new e.window.Event('change'));
    assert.equal(get('slot2').hidden, false);
    assert.equal(get('slot3').hidden, false);
    for (const [suffix, id] of [['', ID], ['2', OTHER], ['3', THIRD]]) {
        get('instances' + suffix).value = id;
        get('instances' + suffix).dispatchEvent(new e.window.Event('change'));
        assert.equal(get('target' + suffix).value, id);
    }
    get('start').click(); await flush(); await e.clock.advance(100);
    assert.deepEqual(app.grabber.run.targets.map(t => t.id), [ID, OTHER, THIRD]);
    assert.equal(get('count').disabled, true);
    assert.match(get('stats').textContent, /0\/3/);
    get('stop').click(); await flush();
    assert.equal(app.grabber.run, null);
    assert.deepEqual(JSON.parse(e.window.localStorage.getItem(SETTINGS_KEY)).ids, [ID, OTHER, THIRD]);
    e.cleanup();
});

test('legacy single-instance settings and current multi settings both populate the UI', () => {
    for (const settings of [{ id: ID, seconds: 10 }, { ids: [ID, OTHER, THIRD], seconds: 5 }]) {
        const e = multi();
        e.window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        const app = mount(e.window);
        assert.equal(app.shadow.getElementById('target').value, ID);
        assert.equal(app.shadow.getElementById('count').value, settings.ids ? '3' : '1');
        if (settings.ids) assert.equal(app.shadow.getElementById('target3').value, THIRD);
        e.cleanup();
    }
});

test('legacy version-one task resumes without resubmitting its in-flight request', async () => {
    const e = multi(true);
    const { SESSION_KEY } = require('./autodl-gpu-helper.user.js');
    e.window.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ version: 1, active: true,
        id: ID, seconds: 5, phase: 'submitted', submittedAt: e.clock.time - 100,
        attempts: 1, sawStarting: false }));
    const saved = e.grabber.readSaved();
    void e.grabber.start(saved, saved);
    await flush(); await e.clock.advance(5500);
    assert.equal(e.actions.boot, 0);
    assert.equal(e.state.state, '等待启动');
    e.setStatus(ID, '运行中'); await e.clock.advance(100);
    assert.equal(e.state.state, '抢卡成功');
    assert.deepEqual(e.notified, [ID]);
    e.cleanup();
});

test('three already-running targets complete without booting any instance', async () => {
    const e = multi(true);
    for (const id of [ID, OTHER, THIRD]) e.setStatus(id, '运行中');
    await e.begin(); await e.clock.advance(100);
    assert.equal(e.actions.boot, 0);
    assert.equal(e.actions.confirm, 0);
    assert.deepEqual(e.notified, [ID, OTHER, THIRD]);
    assert.equal(e.state.state, '抢卡成功');
    e.cleanup();
});
