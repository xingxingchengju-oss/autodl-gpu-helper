const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { AutoDLPage, Grabber, SESSION_KEY, mount } = require('./autodl-gpu-helper.user.js');

const ID = 'abcdefghij-12345678';
const OTHER = 'qwertyuiop-87654321';
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

class Clock {
    time = 1000000;
    sequence = 0;
    timers = new Map();
    setTimeout = (callback, ms) => {
        const id = ++this.sequence;
        this.timers.set(id, { at: this.time + ms, callback });
        return id;
    };
    clearTimeout = id => this.timers.delete(id);
    async advance(ms) {
        const end = this.time + ms;
        await flush();
        for (let count = 0; count < 10000; count++) {
            const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
            if (!next || next[1].at > end) { this.time = end; await flush(); return; }
            this.time = next[1].at;
            this.timers.delete(next[0]);
            next[1].callback();
            await flush();
        }
        throw new Error('Timer runaway');
    }
}

function row(id = ID, available = true) {
    return `<tr class="el-table__row">
        <td class="el-table_1_column_1"><div class="cell"><div class="region">地区 / 主机</div><div style="cursor:pointer">${id}</div><span>同名实例</span></div></td>
        <td class="el-table_1_column_2"><div class="cell"><div class="status"><span>已关机</span></div><div class="gpuTips">${available ? 'GPU充足' : ''}</div></div></td>
        <td class="el-table_1_column_3"><div class="cell"><div>RTX 4090 * 1卡</div><button>查看详情</button></div></div></td>
        <td class="el-table_1_column_4"><div class="cell"><div class="chargeType"><span>按量计费</span></div></div></td>
        <td class="el-table_1_column_5"><div class="cell"><button class="el-button">开机</button><button>更多</button></div></td>
    </tr>`;
}

function fixture(available = true, sharedLocks) {
    const dom = new JSDOM(`<body><div class="data-list-common"><div class="content-header"><button class="refresh-btn">刷新</button></div>
        <div class="table-box"><div class="el-table instance-table">
        <div class="el-table__header-wrapper"><table><thead><tr>
        ${['实例ID / 名称', '状态', '规格详情', '付费方式', '操作'].map((label, i) => `<th class="el-table_1_column_${i + 1}"><div class="cell">${label}</div></th>`).join('')}
        </tr></thead></table></div><div class="el-table__body-wrapper"><table><tbody>${row(ID, available)}${row(OTHER)}</tbody></table></div>
        </div></div></div></body>`, { url: 'https://www.autodl.com/console/instance/list', pretendToBeVisual: true });
    const { window } = dom;
    window.HTMLElement.prototype.getClientRects = function () { return this.isConnected ? [{ width: 100, height: 30 }] : []; };
    const clock = new Clock();
    const page = new AutoDLPage(window);
    const actions = { refresh: 0, boot: 0, confirm: 0, cancel: 0, reads: 0, notifications: 0 };
    const originalRead = page.readTarget.bind(page);
    page.readTarget = id => { actions.reads++; return originalRead(id); };
    const document = window.document;
    const findRow = id => [...document.querySelectorAll('tr.el-table__row')].find(node => node.querySelector('[style="cursor:pointer"]')?.textContent === id);
    const status = value => { findRow(ID).querySelector('.status > span').textContent = value; };
    const error = text => {
        const node = document.createElement('div');
        node.className = 'el-notification';
        node.textContent = `错误 ${text}`;
        document.body.append(node);
        clock.setTimeout(() => node.remove(), 1000);
    };
    const normalBody = '确认开机吗？实例将按￥1.23/时整点扣费';
    const shortageBody = '该主机空闲GPU不足实例GPU需求数量：1卡主机GPU空闲数量：0卡您可以：1.(推荐)克隆实例2.无卡模式开机3.等待GPU释放提示：按量计费实例在关机后会释放GPU给其他用户租用，如果想一直占有GPU，可选择变更计费方式为包年包月';
    function dialog(body = normalBody, shortage = false) {
        const element = document.createElement('div');
        element.className = 'el-message-box';
        element.innerHTML = `<div class="el-message-box__title"></div><div class="el-message-box__message"></div><div class="el-message-box__btns">${shortage ? '<button class="messageCancel">我知道了</button>' : '<button>取消</button><button class="el-button--primary">确定</button>'}</div>`;
        element.querySelector('.el-message-box__message').textContent = body;
        document.body.append(element);
        element.querySelector('.messageCancel')?.addEventListener('click', () => { actions.cancel++; element.remove(); });
        element.querySelector('.el-button--primary')?.addEventListener('click', () => {
            actions.confirm++;
            element.remove();
            env.onConfirm?.();
        });
        return element;
    }
    let held = false;
    const locks = sharedLocks || { request: async (name, options, callback) => {
        if (held) return callback(null);
        held = true;
        try { return await callback({ name }); } finally { held = false; }
    } };
    let state;
    const grabber = new Grabber(page, { clock, locks, now: () => clock.time,
        update: model => { state = model; }, notify: () => actions.notifications++,
        timing: { poll: 10, refresh: 300, dialog: 300, uncertain: 60000 } });
    const env = { dom, window, document, clock, page, grabber, actions, findRow, status, error, dialog, normalBody, shortageBody,
        get state() { return state; },
        async start(saved) { void grabber.start({ id: ID, seconds: 5 }, saved); await flush(); },
        cleanup() { grabber.stop(); window.close(); } };
    document.querySelector('.refresh-btn').addEventListener('click', () => {
        actions.refresh++;
        if (env.noRefresh) return;
        const box = document.querySelector('.table-box');
        box.classList.add('is-loading');
        clock.setTimeout(() => { env.onRefresh?.(); box.classList.remove('is-loading'); }, 20);
    });
    for (const targetRow of document.querySelectorAll('tr.el-table__row')) {
        targetRow.querySelector('td:last-child button').addEventListener('click', () => {
            actions.boot++;
            if (env.onBoot) env.onBoot();
            else clock.setTimeout(() => dialog(), 20);
        });
    }
    return env;
}

test('full ID, sorting and names resolve the same target', () => {
    const e = fixture();
    assert.equal(e.page.list().length, 2);
    e.findRow(ID).parentElement.append(e.findRow(ID));
    assert.equal(e.page.readTarget(ID).id, ID);
    assert.throws(() => e.page.readTarget(ID.slice(0, -1)), /缺少目标/);
    e.findRow(OTHER).querySelector('span').textContent = ID;
    assert.equal(e.page.readTarget(ID).id, ID);
    e.cleanup();
});

test('hidden rows are excluded, visible duplicates pause', () => {
    const e = fixture();
    const copy = e.findRow(ID).cloneNode(true);
    e.findRow(ID).parentElement.append(copy);
    copy.hidden = true;
    assert.equal(e.page.readTarget(ID).id, ID);
    copy.hidden = false;
    assert.throws(() => e.page.readTarget(ID), /重复 ID/);
    assert.throws(() => e.page.list(), /重复实例 ID/);
    e.cleanup();
});

test('pagination, changed headers and unlinked fixed copies fail closed', () => {
    const e = fixture();
    const target = e.findRow(ID);
    target.remove();
    assert.throws(() => e.page.readTarget(ID), /缺少目标/);
    e.document.querySelector('tbody').append(target);
    const header = e.document.querySelector('th .cell');
    header.textContent = '新实例列';
    assert.throws(() => e.page.readTarget(ID), /表头/);
    header.textContent = '实例ID /名称';
    const wrapper = e.document.createElement('div');
    wrapper.className = 'el-table__fixed-body-wrapper';
    wrapper.innerHTML = `<table><tbody>${row(ID)}</tbody></table>`;
    e.document.querySelector('.el-table').append(wrapper);
    assert.throws(() => e.page.readTarget(ID), /副本缺少/);
    wrapper.querySelector('tr').setAttribute('data-row-key', ID);
    assert.equal(e.page.readTarget(ID).linkedCopies.length, 1);
    e.cleanup();
});

test('strict normal-GPU dialog and verified shortage cancellation', () => {
    const e = fixture();
    const snapshot = e.page.readTarget(ID);
    let box = e.dialog();
    assert.equal(e.page.dialogAction(box, snapshot).kind, 'gpu');
    box.remove();
    box = e.dialog(e.shortageBody, true);
    assert.equal(e.page.dialogAction(box, snapshot).kind, 'capacity');
    box.querySelector('button').textContent = '确定';
    assert.throws(() => e.page.dialogAction(box, snapshot), /白名单/);
    e.cleanup();
});

for (const body of ['确认无卡模式开机吗？', '克隆实例', '重置系统', '释放实例', '更换镜像', '确认关机吗？', '确认开机吗？', '确认开机吗？实例将按￥1.23/时整点扣费附加条款']) {
    test(`dialog rejected: ${body}`, () => {
        const e = fixture();
        assert.throws(() => e.page.dialogAction(e.dialog(body), e.page.readTarget(ID)));
        assert.equal(e.actions.confirm, 0);
        e.cleanup();
    });
}

test('success requires observed running, starting remains pending', async () => {
    const e = fixture();
    e.onConfirm = () => e.status('开机中');
    await e.start(); await e.clock.advance(100);
    assert.equal(e.actions.confirm, 1);
    assert.equal(e.actions.notifications, 0);
    await e.clock.advance(5200);
    assert.equal(e.state.state, '等待启动');
    e.status('运行中');
    await e.clock.advance(5200);
    assert.equal(e.state.state, '抢卡成功');
    assert.equal(e.actions.confirm, 1);
    assert.equal(e.actions.notifications, 1);
    const count = e.actions.refresh;
    await e.clock.advance(20000);
    assert.equal(e.actions.refresh, count);
    e.cleanup();
});

test('capacity waits and starts when resources appear', async () => {
    const e = fixture(false);
    await e.start(); await e.clock.advance(5100);
    assert.equal(e.actions.boot, 0);
    assert.equal(e.state.state, '等待资源');
    e.findRow(ID).querySelector('.gpuTips').textContent = 'GPU充足';
    await e.clock.advance(5200);
    assert.equal(e.actions.confirm, 1);
    e.cleanup();
});

test('missing GPU label still uses the normal boot path', async () => {
    const e = fixture();
    e.findRow(ID).querySelector('.gpuTips').remove();
    await e.start(); await e.clock.advance(100);
    assert.equal(e.actions.confirm, 1);
    e.cleanup();
});

test('capacity race dismisses only the exact failure notice then retries', async () => {
    const e = fixture();
    e.onBoot = () => e.clock.setTimeout(() => e.dialog(e.shortageBody, true), 20);
    await e.start(); await e.clock.advance(5200);
    assert.equal(e.actions.cancel, 2);
    assert.equal(e.actions.confirm, 0);
    e.cleanup();
});

test('server rejects a submitted attempt with a capacity error then retries', async () => {
    const e = fixture();
    e.onConfirm = () => e.clock.setTimeout(() => e.error('GPU空闲数量不足'), 20);
    await e.start(); await e.clock.advance(6500);
    assert.equal(e.actions.confirm, 2);
    assert.equal(e.actions.notifications, 0);
    e.cleanup();
});

test('fatal balance and unknown errors pause', async () => {
    for (const message of ['余额不足，请充值', '发生未知错误']) {
        const e = fixture();
        e.onConfirm = () => e.error(message);
        await e.start(); await e.clock.advance(100);
        assert.equal(e.state.state, '已暂停');
        assert.equal(e.actions.notifications, 0);
        await e.clock.advance(20000);
        assert.equal(e.actions.confirm, 1);
        e.cleanup();
    }
});

test('normal dialogs already present before start are never confirmed', async () => {
    const e = fixture(); e.dialog();
    await e.start(); await e.clock.advance(5000);
    assert.equal(e.state.state, '已暂停');
    assert.equal(e.actions.confirm, 0);
    assert.equal(e.actions.refresh, 0);
    e.cleanup();
});

test('stop while waiting samples exactly once and cancels all subsequent actions', async () => {
    const e = fixture(false);
    await e.start(); await e.clock.advance(100);
    const before = { ...e.actions };
    e.grabber.stop();
    assert.equal(e.actions.reads, before.reads + 1);
    const stopped = { ...e.actions };
    await e.clock.advance(60000);
    assert.deepEqual(e.actions, stopped);
    assert.equal(e.state.state, '已停止');
    assert.equal(e.window.sessionStorage.getItem(SESSION_KEY), null);
    e.grabber.stop();
    assert.equal(e.actions.reads, stopped.reads);
    e.cleanup();
});

test('stop before a delayed dialog prevents confirmation', async () => {
    const e = fixture();
    e.onBoot = () => e.clock.setTimeout(() => e.dialog(), 200);
    await e.start(); await e.clock.advance(40);
    e.grabber.stop(); const stopped = { ...e.actions };
    await e.clock.advance(20000);
    assert.deepEqual(e.actions, stopped);
    assert.equal(e.actions.confirm, 0);
    e.cleanup();
});

test('stop between whitelist validation and confirmation invalidates queued callback', async () => {
    const e = fixture();
    const original = e.page.dialogAction.bind(e.page);
    e.page.dialogAction = (box, snapshot) => {
        const action = original(box, snapshot);
        e.clock.setTimeout(() => e.grabber.stop(), 0);
        return action;
    };
    await e.start(); await e.clock.advance(1000);
    assert.equal(e.actions.confirm, 0);
    assert.equal(e.state.state, '已停止');
    const stopped = { ...e.actions };
    await e.clock.advance(10000);
    assert.deepEqual(e.actions, stopped);
    e.cleanup();
});

test('stop after submission leaves the server-side simulated job running', async () => {
    const e = fixture();
    let serverFinished = false;
    e.onConfirm = () => e.clock.setTimeout(() => { serverFinished = true; e.status('运行中'); }, 1000);
    await e.start(); await e.clock.advance(100);
    e.grabber.stop(); const stopped = { ...e.actions };
    assert.match(e.state.detail, /待确认/);
    await e.clock.advance(60000);
    assert.equal(serverFinished, true);
    assert.deepEqual(e.actions, stopped);
    e.cleanup();
});

test('stop during refresh clears waits and samples once', async () => {
    const e = fixture(false);
    await e.start();
    const before = e.actions.reads;
    e.grabber.stop();
    assert.equal(e.actions.reads, before + 1);
    await e.clock.advance(10000);
    assert.equal(e.actions.reads, before + 1);
    assert.equal(e.actions.boot, 0);
    e.cleanup();
});

test('refresh timeouts back off and never act on stale data', async () => {
    const e = fixture(false); e.noRefresh = true;
    await e.start(); await e.clock.advance(500);
    assert.equal(e.state.state, '等待重试');
    assert.equal(e.actions.boot, 0);
    const deadline = e.state.nextAt;
    assert.equal(deadline - e.clock.time > 9000, true);
    e.noRefresh = false;
    e.onRefresh = () => { e.findRow(ID).querySelector('.gpuTips').textContent = 'GPU充足'; };
    await e.clock.advance(11000);
    assert.equal(e.actions.confirm, 1);
    e.cleanup();
});

test('uncertain submission gets reconciled without a duplicate boot', async () => {
    const e = fixture();
    e.onConfirm = () => e.clock.setTimeout(() => e.error('Network Error'), 20);
    await e.start(); await e.clock.advance(20000);
    assert.equal(e.actions.confirm, 1);
    e.status('运行中');
    await e.clock.advance(12000);
    assert.equal(e.state.state, '抢卡成功');
    e.cleanup();
});

test('same-tab resume preserves submitted intent and manual stop clears it', async () => {
    const e = fixture();
    await e.start(); await e.clock.advance(100);
    e.grabber.suspendForNavigation(); await flush();
    const saved = e.grabber.readSaved();
    assert.equal(saved.phase, 'submitted');
    assert.equal(saved.attempts, 1);
    await e.start(saved); await e.clock.advance(5200);
    assert.equal(e.actions.confirm, 1);
    e.grabber.stop();
    assert.equal(e.grabber.readSaved(), null);
    e.cleanup();
});

test('second tab cannot acquire the lock, and can start after release', async () => {
    let held = false;
    const locks = { request: async (name, options, callback) => {
        if (held) return callback(null);
        held = true;
        try { return await callback({ name }); } finally { held = false; }
    } };
    const a = fixture(false, locks); const b = fixture(false, locks);
    await a.start(); await a.clock.advance(100);
    await b.start(); await b.clock.advance(100);
    assert.match(b.state.detail, /另一个标签页/);
    assert.equal(b.actions.refresh, 0);
    a.grabber.stop(); await flush();
    await b.start(); await b.clock.advance(100);
    assert.equal(b.state.state, '等待资源');
    a.cleanup(); b.cleanup();
});

test('non-GPU running mode never reports success', async () => {
    const e = fixture();
    e.status('运行中');
    e.findRow(ID).querySelector('td:nth-child(2)').append('无卡模式');
    await e.start(); await e.clock.advance(100);
    assert.equal(e.state.state, '已暂停');
    assert.equal(e.actions.notifications, 0);
    e.cleanup();
});

test('normal UI entry point mounts one panel and populates instance choices', () => {
    const e = fixture();
    const app = mount(e.window);
    assert.equal(app.shadow.querySelectorAll('#instances option').length, 3);
    assert.equal(app.shadow.getElementById('interval').value, '10');
    assert.equal(mount(e.window), null);
    app.shadow.getElementById('instances').value = ID;
    app.shadow.getElementById('instances').dispatchEvent(new e.window.Event('change'));
    assert.equal(app.shadow.getElementById('target').value, ID);
    e.cleanup();
});

test('observed AutoDL slot wrappers, filter icons and balance hints are supported', () => {
    const e = fixture();
    for (const cell of e.document.querySelectorAll('td .cell')) {
        const wrapper = e.document.createElement('div');
        wrapper.style.cssText = 'display:inline-block;vertical-align:top';
        wrapper.append(...cell.childNodes);
        cell.append(wrapper);
    }
    e.document.querySelectorAll('th .cell')[1].innerHTML = '状态<span class="el-table__column-filter-trigger"><i class="el-icon-arrow-down"></i></span>';
    e.findRow(ID).querySelector('.chargeType').insertAdjacentHTML('beforeend', '<span><span>余额不足24小时</span></span>');
    e.status('运行中');
    assert.equal(e.page.readTarget(ID).status, '运行中');
    assert.equal(e.page.readTarget(ID).chargeType, '按量计费');
    assert.match(e.page.list()[0].label, /RTX 4090 \* 1卡/);
    assert.doesNotMatch(e.page.list()[0].label, /查看详情/);
    e.cleanup();
});

test('hidden confirmation button in real shortage dialog is ignored', () => {
    const e = fixture();
    const box = e.dialog(e.shortageBody, true);
    box.querySelector('.el-message-box__btns').insertAdjacentHTML('beforeend', '<button class="el-button--primary" style="display:none">确定</button>');
    assert.equal(e.page.dialogAction(box, e.page.readTarget(ID)).kind, 'capacity');
    e.cleanup();
});

test('changed dialog content between inspection and click pauses', async () => {
    const e = fixture();
    const original = e.page.dialogAction.bind(e.page);
    e.page.dialogAction = (box, snapshot) => {
        const action = original(box, snapshot);
        e.clock.setTimeout(() => { box.querySelector('.el-message-box__message').textContent = e.normalBody.replace('1.23', '9.99'); }, 0);
        return action;
    };
    await e.start(); await e.clock.advance(1000);
    assert.equal(e.state.state, '已暂停');
    assert.equal(e.actions.confirm, 0);
    e.cleanup();
});

test('row identity changing while opening a dialog pauses', async () => {
    const e = fixture();
    e.onBoot = () => e.clock.setTimeout(() => {
        e.findRow(ID).querySelector('[style="cursor:pointer"]').textContent = 'changed-id';
        e.dialog();
    }, 20);
    await e.start(); await e.clock.advance(1000);
    assert.equal(e.state.state, '已暂停');
    assert.equal(e.actions.confirm, 0);
    e.cleanup();
});

test('multiple dialogs after boot are never confirmed', async () => {
    const e = fixture();
    e.onBoot = () => e.clock.setTimeout(() => { e.dialog(); e.dialog(); }, 20);
    await e.start(); await e.clock.advance(1000);
    assert.equal(e.state.state, '已暂停');
    assert.equal(e.actions.confirm, 0);
    e.cleanup();
});

test('stopped unresolved opener cannot be attributed to a different new task', async () => {
    const e = fixture();
    e.onBoot = () => e.clock.setTimeout(() => e.dialog(), 100);
    await e.start(); await e.clock.advance(30);
    e.grabber.stop();
    void e.grabber.start({ id: OTHER, seconds: 5 });
    await e.clock.advance(1000);
    assert.equal(e.actions.confirm, 0);
    assert.match(e.state.detail, /刷新页面/);
    e.cleanup();
});

test('stop during pending lock acquisition prevents all automation after grant', async () => {
    let callback;
    const e = fixture(true, { request: async (name, options, cb) => {
        callback = cb;
        await new Promise(resolve => { e.release = resolve; });
        return callback({ name });
    } });
    await e.start();
    e.grabber.stop(); const stopped = { ...e.actions };
    e.release(); await flush(); await e.clock.advance(1000);
    assert.deepEqual(e.actions, stopped);
    e.cleanup();
});

test('stop during initial page loading prevents a later resume', async () => {
    const e = fixture();
    e.document.querySelector('.table-box').classList.add('is-loading');
    await e.start(); await e.clock.advance(20);
    e.grabber.stop(); const stopped = { ...e.actions };
    e.document.querySelector('.table-box').classList.remove('is-loading');
    await e.clock.advance(10000);
    assert.deepEqual(e.actions, stopped);
    e.cleanup();
});

test('rate limits back off to 120 seconds and recover', async () => {
    const e = fixture(false);
    e.onRefresh = () => e.error('请求过于频繁 429');
    await e.start(); await e.clock.advance(20000);
    assert.equal(e.actions.boot, 0);
    assert.match(e.state.detail, /20 秒/);
    await e.clock.advance(300000);
    assert.match(e.state.detail, /120 秒/);
    e.onRefresh = () => { e.findRow(ID).querySelector('.gpuTips').textContent = 'GPU充足'; };
    await e.clock.advance(121000);
    assert.equal(e.actions.confirm, 1);
    e.cleanup();
});

test('running instance during resume completes without a boot submission', async () => {
    const e = fixture();
    e.status('运行中');
    await e.start({ phase: 'submitted', submittedAt: e.clock.time - 3000, attempts: 2 });
    await e.clock.advance(100);
    assert.equal(e.state.state, '抢卡成功');
    assert.equal(e.actions.boot, 0);
    e.cleanup();
});

test('missing Web Locks and unwritable task storage pause before clicking', async () => {
    const e = fixture();
    e.grabber.locks = {};
    await e.start();
    assert.match(e.state.detail, /Web Locks/);
    assert.equal(e.actions.refresh, 0);
    e.cleanup();
    const f = fixture();
    f.grabber.session = { setItem() { throw new Error('storage unavailable'); }, removeItem() {} };
    await f.start(); await f.clock.advance(100);
    assert.equal(f.state.state, '已暂停');
    assert.equal(f.actions.refresh, 0);
    f.cleanup();
});

test('navigation away from the list revokes automation', async () => {
    const e = fixture(false);
    await e.start(); await e.clock.advance(100);
    const refreshed = e.actions.refresh;
    e.window.history.pushState({}, '', '/login');
    await e.clock.advance(10000);
    assert.equal(e.state.state, '已暂停');
    assert.equal(e.actions.refresh, refreshed);
    assert.equal(e.actions.boot, 0);
    e.cleanup();
});

test('UI start and stop buttons drive the shipped controller end to end', async () => {
    const e = fixture();
    const app = mount(e.window);
    app.grabber.locks = e.grabber.locks;
    app.grabber.clock = e.clock;
    app.grabber.now = () => e.clock.time;
    app.shadow.getElementById('target').value = ID;
    app.shadow.getElementById('start').click();
    app.shadow.getElementById('start').click();
    await e.clock.advance(500);
    assert.equal(e.actions.confirm, 1);
    assert.equal(app.shadow.getElementById('stop').disabled, false);
    assert.equal(app.shadow.getElementById('start').disabled, true);
    app.shadow.getElementById('collapse').click();
    assert.equal(app.shadow.getElementById('stop').disabled, false);
    app.shadow.getElementById('stop').click();
    const stopped = { ...e.actions };
    await e.clock.advance(60000);
    assert.deepEqual(e.actions, stopped);
    assert.equal(app.shadow.getElementById('state').textContent, '已停止');
    assert.equal(app.shadow.getElementById('start').disabled, false);
    e.cleanup();
});
