// ==UserScript==
// @name         AutoDL GPU 抢卡助手
// @namespace    local.autodl.gpu-helper
// @version      1.1.0
// @description  选择 1～3 台实例，正常 GPU 开机、完整 ID 定位和人工接管
// @match        https://www.autodl.com/*
// @match        https://autodl.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// @license      MIT
// ==/UserScript==

/*
 * Page adapter checked against AutoDL's public frontend on 2026-11-11.
 * /assets/index.7d7f696b.js, components.27efcd29.js, utils.17fd6d7d.js
 * All server operations are performed by the site's own UI handlers.
 */
(function () {
    'use strict';

    const SESSION_KEY = 'autodl_gpu_helper_task_v1';
    const SETTINGS_KEY = 'autodl_gpu_helper_settings_v1';
    const LOCK_NAME = 'autodl_gpu_helper_single_task_v1';
    const PANEL_ID = 'autodl-gpu-helper';
    const CANCELLED = Symbol('cancelled');
    const INSTANCE_ID = /^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)+$/;
    const FORBIDDEN = /无卡|non_gpu|克隆|重置|释放|更换镜像|关机|续费|升降配置|转按量|转包年|拷贝|删除/iu;
    const compact = value => String(value || '').replace(/\s+/gu, '');
    const normalizeId = value => String(value || '').trim().replace(/[\u2010-\u2015\u2212]/gu, '-');
    const onListPage = location => location.pathname.replace(/\/$/u, '') === '/console/instance/list';

    class PageError extends Error {}
    class RetryError extends Error {
        constructor(message, kind = 'network') {
            super(message);
            this.kind = kind;
        }
    }

    function visible(element) {
        if (!element || !element.isConnected || !element.getClientRects().length) return false;
        const view = element.ownerDocument.defaultView;
        for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
            const style = view.getComputedStyle(node);
            if (node.hidden || node.getAttribute('aria-hidden') === 'true' || node.classList.contains('is-hidden') ||
                style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
        }
        return true;
    }

    function enabled(element) {
        return visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true' &&
            !element.classList.contains('is-disabled') && !element.classList.contains('is-loading');
    }

    function exactlyOne(elements, message) {
        if (elements.length !== 1) throw new PageError(message);
        return elements[0];
    }

    function feedbackKind(message) {
        if (/余额不足|余额不够|充值|实名认证|认证后|登录|登陆|账号|账户|权限|到期|下架|维护|验证码/u.test(message)) return 'fatal';
        if (/(?:GPU|显卡|空闲卡).{0,18}(?:不足|不够|占用|无可用)|(?:没有|暂无|无).{0,8}(?:可用|空闲).{0,8}(?:GPU|显卡)|资源不足/iu.test(message)) return 'capacity';
        if (/429|限流|频繁|请求过多|稍后重试|网络|超时|断网|Network\s*Error|timeout|502|503|504/iu.test(message)) return 'network';
        return 'fatal';
    }

    function shouldTakeOver(event, host) {
        if (!event.isTrusted) return false;
        if (event.type === 'keydown' && event.key === 'Escape') return true;
        if (event.composedPath().includes(host)) return false;
        if (event.type === 'keydown') {
            if (!['Enter', ' '].includes(event.key)) return false;
        }
        const target = event.target;
        if (!target || typeof target.closest !== 'function') return false;
        const refresh = target.closest('.data-list-common .content-header button.refresh-btn');
        if (refresh && visible(refresh)) return false;
        return Boolean(target.closest('button, a[href], input, select, textarea, [role="button"], [role="menuitem"], ' +
            '[contenteditable="true"], .startNoGpu, .el-pagination, .el-table__column-filter-trigger'));
    }

    class AutoDLPage {
        constructor(window) {
            this.window = window;
            this.document = window.document;
            this.seenFeedback = new WeakMap();
        }

        table() {
            if (!onListPage(this.window.location)) throw new PageError('请回到 AutoDL 容器实例列表，核对登录状态');
            return exactlyOne([...this.document.querySelectorAll('.el-table.instance-table')].filter(visible),
                '实例表格结构不匹配，请检查登录状态或页面是否改版');
        }

        columns(table) {
            const keys = {};
            for (const header of table.querySelectorAll('.el-table__header-wrapper th')) {
                if (!visible(header)) continue;
                const label = compact(header.querySelector('.cell')?.textContent);
                const key = [...header.classList].find(name => /^el-table_\d+_column_\d+(?:_\d+)*$/u.test(name));
                if (!key || !['实例ID/名称', '状态', '规格详情', '操作'].includes(label)) continue;
                if (keys[label]) throw new PageError('表头重复，无法验证实例列关联');
                keys[label] = key;
            }
            if (Object.keys(keys).length !== 4) throw new PageError('实例表头已变化，自动化已暂停');
            return keys;
        }

        cell(row, key) {
            return exactlyOne([...row.children].filter(node => node.tagName === 'TD' && node.classList.contains(key)),
                '实例行与表头关联不匹配');
        }

        rowId(row, columns) {
            const cell = this.cell(row, columns['实例ID/名称']);
            const nodes = [...cell.querySelectorAll('div')].filter(node =>
                node.style.cursor === 'pointer' && node.children.length === 0 &&
                INSTANCE_ID.test(normalizeId(node.textContent)));
            return normalizeId(exactlyOne(nodes, '无法在实例 ID 列中识别唯一完整 ID').textContent);
        }

        rows(table) {
            return [...table.querySelectorAll('tr.el-table__row')].filter(row => visible(row) && row.closest('.el-table') === table);
        }

        isFixedCopy(row) {
            return Boolean(row.closest('.el-table__fixed-body-wrapper'));
        }

        list() {
            const table = this.table();
            const columns = this.columns(table);
            const rows = this.rows(table).filter(row => !this.isFixedCopy(row));
            const ids = new Set();
            return rows.map(row => {
                const id = this.rowId(row, columns);
                if (ids.has(id)) throw new PageError('当前页出现重复实例 ID，自动化已暂停');
                ids.add(id);
                const nameCell = this.cell(row, columns['实例ID/名称']);
                const region = nameCell.querySelector('.region, .tide')?.textContent.trim() || id;
                const gpuNode = [...this.cell(row, columns['规格详情']).querySelectorAll('div')]
                    .find(node => node.children.length === 0 && /\*[1-9]\d*卡/u.test(compact(node.textContent)));
                const gpu = gpuNode?.textContent.trim() || '';
                return { id, label: `${region} · ${gpu} · ${id}` };
            });
        }

        readTarget(id) {
            const table = this.table();
            const columns = this.columns(table);
            const rows = this.rows(table);
            const main = rows.filter(row => !this.isFixedCopy(row) && this.rowId(row, columns) === id);
            const row = exactlyOne(main, '当前页缺少目标实例或存在重复 ID，请核对分页、筛选和页面结构');
            const copies = rows.filter(candidate => this.isFixedCopy(candidate));
            const linkedCopies = [];
            for (const copy of copies) {
                // A visible legacy fixed-column fragment needs an explicit identity.
                const key = normalizeId(copy.getAttribute('data-row-key'));
                if (!key) throw new PageError('固定列表格副本缺少完整实例 ID 关联');
                if (key === id) linkedCopies.push(copy);
            }
            const stateCell = this.cell(row, columns['状态']);
            const status = compact(exactlyOne([...stateCell.querySelectorAll('.status > span')].filter(visible),
                '实例状态结构不匹配').textContent);
            if (/无卡|non_gpu/iu.test(stateCell.textContent)) throw new PageError('目标处于无卡模式，请人工接管');
            if (/开机异常|意外宕机|迁移失败/u.test(stateCell.textContent)) throw new PageError('目标实例报告异常，请先核对实例详情');
            if (!['已关机', '开机中', '运行中'].includes(status)) throw new PageError(`当前状态需要人工处理（${status || '无法识别'}）`);
            const detail = compact(this.cell(row, columns['规格详情']).textContent);
            if (!/\*[1-9]\d*卡/u.test(detail)) throw new PageError('无法验证目标实例的 GPU 配置');
            const chargeLabels = ['按量计费', '包年包月', '包日', '包周', '包月', '包年'];
            const chargeNode = exactlyOne([...row.querySelectorAll('.chargeType > span')]
                .filter(node => visible(node) && chargeLabels.includes(compact(node.textContent))), '无法验证目标实例的付费方式');
            const chargeType = compact(chargeNode.textContent);
            const gpuTips = stateCell.querySelector('.gpuTips');
            const availability = gpuTips ? compact(gpuTips.textContent) === 'GPU充足' : null;
            return { id, table, row, columns, linkedCopies, status, availability, chargeType,
                fingerprint: `${id}|${detail}|${chargeType}` };
        }

        bootButton(snapshot) {
            const candidates = [snapshot.row, ...snapshot.linkedCopies];
            for (const row of candidates) {
                const cell = this.cell(row, snapshot.columns['操作']);
                const buttons = [...cell.querySelectorAll('button')].filter(button => visible(button) && compact(button.textContent) === '开机');
                if (buttons.length > 1) throw new PageError('目标行的开机按钮不唯一');
                if (buttons.length === 1) return buttons[0];
            }
            throw new PageError('目标行缺少正常 GPU 开机按钮');
        }

        refreshButton() {
            this.table();
            const button = exactlyOne([...this.document.querySelectorAll('.data-list-common .content-header button.refresh-btn')].filter(visible),
                '列表刷新控件不匹配');
            if (!enabled(button)) throw new RetryError('列表刷新按钮暂时不可用');
            return button;
        }

        isLoading() {
            return [...this.document.querySelectorAll('.instance-table, .instance-table .table-box, .table-box')]
                .some(node => visible(node) && node.classList.contains('is-loading'));
        }

        dialogs() {
            return [...this.document.querySelectorAll('.el-message-box, .el-dialog, [role="dialog"]')]
                .filter(visible).filter(node => !node.querySelector('.el-message-box, .el-dialog, [role="dialog"]'));
        }

        dialogAction(dialog, snapshot) {
            if (!dialog.matches('.el-message-box')) throw new PageError('出现未识别的对话框，请人工接管');
            const title = compact(dialog.querySelector('.el-message-box__title')?.textContent);
            const body = compact(dialog.querySelector('.el-message-box__message')?.textContent);
            const buttons = [...dialog.querySelectorAll('.el-message-box__btns button')].filter(visible);
            const message = title + body;

            // The site's GPU-shortage message contains links to alternative operations.
            // Its sole messageCancel button only dismisses this failure message.
            const shortage = /^该主机空闲GPU不足实例GPU需求数量：[1-9]\d*卡主机GPU空闲数量：\d+卡您可以：1\.[(（]推荐[)）]克隆实例2\.无卡模式开机3\.等待GPU释放提示：按量计费实例在关机后会释放GPU给其他用户租用，如果想一直占有GPU，可选择变更计费方式为包年包月$/u;
            if (!title && shortage.test(body) && buttons.length === 1 &&
                buttons[0].classList.contains('messageCancel') && compact(buttons[0].textContent) === '我知道了') {
                return { kind: 'capacity', button: buttons[0], signature: message };
            }
            if (FORBIDDEN.test(message)) throw new PageError('弹窗涉及白名单外的操作，已暂停并交由人工处理');
            const payg = /^确认开机吗？实例将按[￥¥](?:0|[1-9]\d*)\.\d{2}\/时整点扣费$/u;
            const allowed = snapshot.chargeType === '按量计费' ? payg.test(body) : body === '确认开机吗？';
            if (title || !allowed || buttons.length !== 2 ||
                buttons.filter(button => compact(button.textContent) === '取消').length !== 1) {
                throw new PageError('开机确认内容与白名单不匹配，请人工核验');
            }
            const button = exactlyOne(buttons.filter(item => compact(item.textContent) === '确定' &&
                item.classList.contains('el-button--primary')), '正常开机确认按钮不匹配');
            return { kind: 'gpu', button, signature: message };
        }

        primeFeedback() {
            for (const node of this.document.querySelectorAll('.el-notification, .el-message')) {
                this.seenFeedback.set(node, compact(node.textContent));
            }
        }

        takeFeedback() {
            for (const node of this.document.querySelectorAll('.el-notification, .el-message')) {
                if (!visible(node)) continue;
                const text = compact(node.textContent);
                if (this.seenFeedback.get(node) === text) continue;
                this.seenFeedback.set(node, text);
                const error = node.matches('.el-message--error, .el-message--warning') ||
                    node.querySelector('.el-notification__icon.el-icon-error, .el-notification__icon.el-icon-warning') ||
                    /错误|失败|不足|超时|频繁|Network\s*Error|timeout/iu.test(text);
                if (error) return { text, kind: feedbackKind(text) };
            }
            return null;
        }
    }

    class Grabber {
        constructor(page, options = {}) {
            this.page = page;
            this.window = page.window;
            this.session = options.session || this.window.sessionStorage;
            this.locks = options.locks || this.window.navigator.locks;
            this.update = options.update || (() => {});
            this.notify = options.notify || (() => {});
            this.clock = options.clock || this.window;
            this.now = options.now || (() => Date.now());
            this.timing = { poll: 100, refresh: 15000, dialog: 15000, uncertain: 120000, ...options.timing };
            this.generation = 0;
            this.run = null;
            this.unresolvedDialog = false;
            this.model = { active: false, state: '待开始', detail: '选择实例后开始', attempts: 0, nextAt: 0, targets: [], log: [] };
        }

        show(state, detail) {
            if (this.run) this.model.targets = this.run.targets.map(target => ({
                id: target.id, state: target.state, attempts: target.attempts, done: target.done
            }));
            this.model.state = state;
            this.model.detail = detail;
            this.update({ ...this.model });
        }

        log(message) {
            const time = new Date(this.now()).toLocaleTimeString('zh-CN', { hour12: false });
            this.model.log = [...this.model.log.slice(-49), `${time} ${message}`];
            this.update({ ...this.model });
        }

        guard(run) {
            if (this.run !== run || run.generation !== this.generation || run.abort.signal.aborted) throw CANCELLED;
            if (!onListPage(this.window.location)) throw new PageError('已离开实例列表或登录已失效');
        }

        delay(ms, run, wakeSignal = null) {
            this.guard(run);
            return new Promise((resolve, reject) => {
                const signal = run.abort.signal;
                const cleanup = () => {
                    this.clock.clearTimeout(timer);
                    signal.removeEventListener('abort', cancel);
                    wakeSignal?.removeEventListener('abort', complete);
                };
                const cancel = () => { cleanup(); reject(CANCELLED); };
                const complete = () => {
                    cleanup();
                    try { this.guard(run); resolve(); } catch (error) { reject(error); }
                };
                const timer = this.clock.setTimeout(complete, ms);
                signal.addEventListener('abort', cancel, { once: true });
                wakeSignal?.addEventListener('abort', complete, { once: true });
                if (wakeSignal?.aborted) complete();
            });
        }

        save(run) {
            this.guard(run);
            this.session.setItem(SESSION_KEY, JSON.stringify({ version: 2, active: true,
                id: run.current.id, phase: run.current.phase, submittedAt: run.current.submittedAt,
                sawStarting: run.current.sawStarting, ids: run.targets.map(target => target.id),
                targets: run.targets, seconds: run.seconds, attempts: this.model.attempts,
                feedbackId: run.feedbackTarget?.id || null }));
        }

        readSaved() {
            try {
                const saved = JSON.parse(this.session.getItem(SESSION_KEY) || 'null');
                return [1, 2].includes(saved?.version) && saved.active === true ? saved : null;
            } catch { return null; }
        }

        readTargets(run) {
            this.guard(run);
            return run.targets.filter(target => !target.done).map(target => this.page.readTarget(target.id));
        }

        clearSaved() {
            try { this.session.removeItem(SESSION_KEY); } catch { /* Starting requires writable session storage. */ }
        }

        deactivate(run) {
            if (this.run !== run) return;
            this.generation += 1;
            this.run = null;
            this.model.active = false;
            this.model.nextAt = 0;
            this.clearSaved();
            run.abort.abort();
        }

        stop(reason = '已停止，人工接管') {
            const run = this.run;
            if (!run) return;
            this.unresolvedDialog = this.unresolvedDialog || run.current.phase === 'opening';
            this.deactivate(run);
            // Sample each selected instance exactly once after revoking all automation.
            const results = run.targets.map(target => {
                let result;
                try {
                    const snapshot = this.page.readTarget(target.id);
                    const uncertain = target.submittedAt && snapshot.status === '已关机' ? '，最近提交结果待确认' : '';
                    result = `${snapshot.status}${uncertain}`;
                } catch (error) { result = `结果待确认（${error.message}）`; }
                target.state = result;
                return `${target.id} · ${result}`;
            });
            this.model.targets = run.targets.map(target => ({ ...target }));
            const result = results.join(' | ');
            const time = new Date(this.now()).toLocaleTimeString('zh-CN', { hour12: false });
            const pending = this.unresolvedDialog ? '。再次自动化前请刷新页面，以结束旧开机检查的弹窗回调' : '';
            this.show('已停止', `${reason}。页面快照 ${time} · ${result}${pending}`);
            this.log(`停止后的单次读取 · ${result}`);
        }

        pause(run, message) {
            if (this.run !== run) return;
            this.unresolvedDialog = this.unresolvedDialog || run.current.phase === 'opening';
            this.deactivate(run);
            this.show('已暂停', message);
            this.log(message);
        }

        feedback(run) {
            this.guard(run);
            const feedback = this.page.takeFeedback();
            if (!feedback) return;
            if (feedback.kind === 'fatal') throw new PageError(feedback.text);
            if (feedback.kind === 'capacity') {
                const target = run.feedbackTarget;
                if (!target) throw new PageError(`无法关联实例的缺卡反馈，请人工核对（${feedback.text}）`);
                target.submittedAt = 0;
                target.sawStarting = false;
                target.phase = 'waiting';
                target.state = '等待资源';
                this.save(run);
            }
            throw new RetryError(feedback.text, feedback.kind);
        }

        async waitFor(predicate, timeout, run) {
            const deadline = this.now() + timeout;
            while (true) {
                this.guard(run);
                this.feedback(run);
                const result = predicate();
                if (result) return result;
                if (this.now() >= deadline) return null;
                await this.delay(this.timing.poll, run);
            }
        }

        async refresh(run) {
            this.guard(run);
            if (this.page.dialogs().length) throw new PageError('页面存在弹窗，请处理后重新开始');
            if (this.page.isLoading()) {
                const ready = await this.waitFor(() => !this.page.isLoading(), this.timing.refresh, run);
                if (!ready) throw new RetryError('列表加载超时，等待后重新检查');
            }
            this.readTargets(run);
            let sawLoading = false;
            const observer = new this.window.MutationObserver(records => {
                // Observe the loading transition even when a very fast request finishes between polls.
                for (const record of records) {
                    if (record.type === 'attributes' && record.attributeName === 'class' &&
                        record.target.matches('.table-box')) {
                        if ((record.oldValue || '').split(/\s/u).includes('is-loading') ||
                            record.target.classList.contains('is-loading')) sawLoading = true;
                    }
                }
            });
            observer.observe(this.page.document.body, { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
            try {
                const button = this.page.refreshButton();
                this.guard(run);
                button.click();
                const refreshed = await this.waitFor(() => {
                    if (this.page.dialogs().length) throw new PageError('刷新时出现弹窗，请人工接管');
                    const loading = this.page.isLoading();
                    sawLoading = sawLoading || loading;
                    return sawLoading && !loading;
                }, this.timing.refresh, run);
                if (!refreshed) throw new RetryError('未观察到列表刷新完成，等待后重试');
            } finally { observer.disconnect(); }
            this.guard(run);
            return this.readTargets(run);
        }

        readyToBoot(snapshot) {
            return snapshot.status === '已关机' && snapshot.availability === true && enabled(this.page.bootButton(snapshot));
        }

        async waitInterval(run, milliseconds, allowReadyWake = false) {
            this.model.nextAt = this.now() + milliseconds;
            let readySnapshot = null;
            let observationError = null;
            let observer = null;
            const wake = new this.window.AbortController();
            const inspect = () => {
                // A queued mutation after stop must not perform another state sample.
                if (this.run !== run || run.abort.signal.aborted || run.generation !== this.generation) return;
                if (readySnapshot || observationError) return;
                try {
                    this.guard(run);
                    if (this.page.isLoading()) return;
                    if (this.page.dialogs().length) throw new PageError('出现新的弹窗，请人工接管');
                    const snapshots = this.readTargets(run);
                    const pending = run.targets.some(target => !target.done && (target.submittedAt || target.sawStarting));
                    for (const snapshot of snapshots) {
                        const target = run.targets.find(item => item.id === snapshot.id);
                        const ready = this.readyToBoot(snapshot);
                        if (!pending && ready && !target.lastReady) {
                            target.nextAttemptAt = 0;
                            readySnapshot = snapshots;
                        }
                        if (snapshot.status === '运行中') readySnapshot = snapshots;
                        target.lastReady = ready;
                    }
                } catch (error) { observationError = error; }
                if (readySnapshot || observationError) wake.abort();
            };
            try {
                if (allowReadyWake) {
                    const table = this.page.table();
                    observer = new this.window.MutationObserver(inspect);
                    observer.observe(table.closest('.data-list-common') || table, {
                        subtree: true, childList: true, characterData: true, attributes: true,
                        attributeFilter: ['class', 'disabled', 'aria-disabled', 'style', 'hidden']
                    });
                    inspect();
                }
                while (this.now() < this.model.nextAt && !readySnapshot && !observationError) {
                    this.guard(run);
                    this.feedback(run);
                    if (this.page.dialogs().length) throw new PageError('出现新的弹窗，请人工接管');
                    this.update({ ...this.model });
                    await this.delay(Math.min(1000, this.model.nextAt - this.now()), run, wake.signal);
                }
                this.guard(run);
                if (observationError) throw observationError;
                return readySnapshot;
            } finally {
                observer?.disconnect();
                if (this.run === run) this.model.nextAt = 0;
            }
        }

        async attempt(run, initial) {
            this.guard(run);
            if (this.page.dialogs().length) throw new PageError('开机前存在弹窗，请人工处理');
            const current = this.page.readTarget(run.current.id);
            if (current.fingerprint !== initial.fingerprint || current.status !== '已关机') return;
            const button = this.page.bootButton(current);
            if (!enabled(button)) {
                this.show('等待资源', '正常 GPU 开机按钮暂时不可用');
                return;
            }
            run.current.phase = 'opening';
            run.current.state = '准备开机';
            run.current.attempts += 1;
            run.feedbackTarget = run.current;
            this.model.attempts += 1;
            this.save(run);
            this.show('准备开机', `${run.current.id} · 正在等待本站开机检查与确认框`);
            this.log(`第 ${this.model.attempts} 次正常 GPU 开机检查 · ${run.current.id}`);
            this.guard(run);
            button.click();
            const dialog = await this.waitFor(() => {
                const dialogs = this.page.dialogs();
                if (!dialogs.length) return null;
                return exactlyOne(dialogs, '出现多个弹窗，无法关联本次开机');
            }, this.timing.dialog, run);
            if (!dialog) throw new PageError('开机检查结果未确认，请核对页面后重新开始');
            const action = this.page.dialogAction(dialog, current);
            // Yield once so a queued human stop takes effect before confirmation.
            await this.delay(0, run);
            this.guard(run);
            const latest = this.page.readTarget(run.current.id);
            if (latest.fingerprint !== current.fingerprint || latest.status !== '已关机') {
                throw new PageError('确认前实例信息或状态发生变化，请人工核验');
            }
            if (exactlyOne(this.page.dialogs(), '确认前弹窗集合发生变化') !== dialog) {
                throw new PageError('确认框已被替换，请人工核验');
            }
            const checked = this.page.dialogAction(dialog, latest);
            if (checked.kind !== action.kind || checked.signature !== action.signature || checked.button !== action.button || !enabled(checked.button)) {
                throw new PageError('确认内容或按钮发生变化，请人工核验');
            }
            if (action.kind === 'capacity') {
                this.guard(run);
                action.button.click();
                const closed = await this.waitFor(() => !visible(dialog), this.timing.dialog, run);
                if (!closed) throw new PageError('缺卡提示未关闭，请人工处理');
                run.current.phase = 'waiting';
                this.save(run);
                throw new RetryError('本次检查仍缺卡，已关闭缺卡提示并继续等待', 'capacity');
            }
            // Write intent before the click so a reload cannot silently lose an in-flight submission.
            run.current.submittedAt = this.now();
            run.current.phase = 'submitted';
            run.current.state = '等待启动';
            this.save(run);
            this.guard(run);
            action.button.click();
            this.guard(run);
            this.log(`第 ${this.model.attempts} 次正常 GPU 开机确认已提交 · ${run.current.id}`);
            this.show('等待启动', '开机结果待确认，正在核对实际状态');
            const closed = await this.waitFor(() => !visible(dialog), this.timing.dialog, run);
            if (!closed) throw new PageError('已提交确认，弹窗仍未关闭。请人工核对结果');
        }

        async loop(run) {
            let interval = 0;
            let failures = 0;
            let allowReadyWake = false;
            while (true) {
                try {
                    let snapshots = interval ? await this.waitInterval(run, interval, allowReadyWake) : null;
                    this.guard(run);
                    this.feedback(run);
                    if (!interval && !this.page.isLoading() && !this.page.dialogs().length) {
                        const current = this.readTargets(run);
                        if (current.some(snapshot => this.readyToBoot(snapshot) || snapshot.status === '运行中')) snapshots = current;
                    }
                    if (snapshots) this.log('检测到目标状态变化，立即核对实例');
                    this.show('检查状态', `正在核对 ${run.targets.length} 台实例`);
                    snapshots = snapshots || await this.refresh(run);
                    this.guard(run);
                    for (const snapshot of snapshots) {
                        const target = run.targets.find(item => item.id === snapshot.id);
                        target.lastReady = this.readyToBoot(snapshot);
                        if (snapshot.status === '运行中') {
                            target.done = true;
                            target.phase = 'done';
                            target.state = '运行中（已完成）';
                            if (run.feedbackTarget === target) run.feedbackTarget = null;
                            this.save(run);
                            this.log(`已验证正常 GPU 运行状态 · ${target.id}`);
                            this.guard(run);
                            this.notify(target.id);
                        } else if (snapshot.status === '开机中') {
                            target.sawStarting = true;
                            target.phase = 'starting';
                            target.state = '开机中';
                        } else if (target.sawStarting) {
                            throw new PageError(`${target.id} 开机后返回关机状态，请核对失败原因`);
                        } else if (target.submittedAt) {
                            if (this.now() - target.submittedAt >= this.timing.uncertain) {
                                throw new PageError(`${target.id} 已提交的开机结果仍待确认，请人工核对实例状态`);
                            }
                            target.state = '等待启动';
                        } else {
                            target.phase = 'waiting';
                            target.state = snapshot.availability === false ? '等待资源' : '等待开机';
                        }
                    }
                    this.save(run);
                    this.show('等待资源', '等待目标主机释放 GPU');
                    if (run.targets.every(target => target.done)) {
                        this.deactivate(run);
                        this.show('抢卡成功', `所选 ${run.targets.length} 台实例均已进入运行中`);
                        return;
                    }
                    // One unresolved boot request owns the shared page feedback and dialog.
                    // Other instances remain queued until its result has been reconciled.
                    const pending = run.targets.find(target => !target.done && (target.submittedAt || target.sawStarting));
                    if (pending) {
                        run.current = pending;
                        this.show('等待启动', `${pending.id} · 正在核对启动结果`);
                    } else {
                        for (const snapshot of snapshots) {
                            const target = run.targets.find(item => item.id === snapshot.id);
                            if (target.done || snapshot.availability === false || this.now() < target.nextAttemptAt) continue;
                            this.guard(run);
                            this.feedback(run);
                            run.current = target;
                            target.nextAttemptAt = this.now() + run.seconds * 1000;
                            try {
                                await this.attempt(run, snapshot);
                            } catch (error) {
                                if (!(error instanceof RetryError) || error.kind !== 'capacity') throw error;
                                target.phase = 'waiting';
                                target.state = '等待资源';
                                this.save(run);
                                this.log(`${target.id} · ${error.message}`);
                            }
                            if (target.submittedAt) break;
                        }
                        this.show(run.current.submittedAt ? '等待启动' : '等待资源',
                            run.current.submittedAt ? `${run.current.id} · 正在核对启动结果` : '等待目标主机释放 GPU');
                    }
                    this.save(run);
                    allowReadyWake = true;
                    failures = 0;
                    interval = run.seconds * 1000;
                } catch (error) {
                    if (error === CANCELLED) return;
                    if (this.run !== run) return;
                    if (!(error instanceof RetryError)) throw error;
                    if (error.kind !== 'capacity' && run.current.phase === 'opening') {
                        throw new PageError('开机检查异常，弹窗归属尚待确认。请刷新页面后重新开始');
                    }
                    if (error.kind === 'capacity') {
                        failures = 0;
                        allowReadyWake = true;
                        interval = run.seconds * 1000;
                        this.show('等待资源', error.message);
                    } else {
                        allowReadyWake = false;
                        failures += 1;
                        interval = Math.max(run.seconds * 1000, Math.min(120000, run.seconds * 1000 * 2 ** Math.min(failures, 7)));
                        this.show('等待重试', `${error.message}，${interval / 1000} 秒后检查`);
                    }
                    this.log(error.message);
                }
            }
        }

        async start(config, saved = null) {
            if (this.run) return;
            if (this.unresolvedDialog) {
                this.show('已暂停', '前次开机检查的弹窗归属尚未解除，请刷新页面后重新开始');
                return;
            }
            const ids = (Array.isArray(config.ids) ? config.ids : [config.id]).map(normalizeId);
            const seconds = Number(config.seconds);
            if (ids.length < 1 || ids.length > 3 || new Set(ids).size !== ids.length ||
                ids.some(id => !INSTANCE_ID.test(id)) || !Number.isFinite(seconds) || seconds < 5 || seconds * 1000 > 2147483647) {
                this.show('待开始', '请选择 1～3 个不同的完整实例 ID，并将检查间隔设置为至少 5 秒');
                return;
            }
            if (!this.locks?.request) {
                this.show('已暂停', '此环境缺少 Web Locks，请使用最新版 Chrome 的 HTTPS 页面');
                return;
            }
            const previous = saved?.targets || (saved ? [{ ...saved, id: saved.id || ids[0] }] : []);
            const targets = ids.map(id => {
                const old = previous.find(target => target.id === id);
                return { id, phase: old?.phase || 'checking', submittedAt: Number(old?.submittedAt) || 0,
                    sawStarting: Boolean(old?.sawStarting), lastReady: false, done: Boolean(old?.done),
                    attempts: Number(old?.attempts) || 0, nextAttemptAt: Number(old?.nextAttemptAt) || 0,
                    state: old?.done ? '运行中（已完成）' : '等待检查' };
            });
            const run = { targets, current: targets[0], seconds,
                generation: ++this.generation, abort: new this.window.AbortController(),
                feedbackTarget: targets.find(target => target.id === saved?.feedbackId || target.submittedAt || target.sawStarting) || null };
            this.run = run;
            this.model.active = true;
            this.model.attempts = Number(saved?.attempts) || 0;
            this.model.nextAt = 0;
            this.show('准备开始', '正在取得当前浏览器的独占执行锁');
            try {
                await this.locks.request(LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, async lock => {
                    this.guard(run);
                    if (!lock) throw new PageError('另一个标签页正在抢卡，请先停止那里的任务');
                    this.page.primeFeedback();
                    const ready = await this.waitFor(() => {
                        const table = this.page.document.querySelector('.el-table.instance-table');
                        return table && !this.page.isLoading() && this.page.rows(table).length;
                    }, this.timing.refresh, run);
                    if (!ready) throw new PageError('实例列表加载超时，请核对登录、筛选与分页后重新开始');
                    for (const target of run.targets) {
                        const snapshot = this.page.readTarget(target.id);
                        if (target.done && snapshot.status !== '运行中') {
                            throw new PageError(`${target.id} 的已完成状态发生变化，请人工核对后重新开始`);
                        }
                    }
                    this.save(run);
                    this.log(`${saved ? '恢复' : '开始'}任务 · ${ids.join('、')} · ${seconds} 秒间隔`);
                    await this.loop(run);
                });
            } catch (error) {
                if (error !== CANCELLED) this.pause(run, error.message || '发生异常，请人工核对页面');
            }
        }

        suspendForNavigation() {
            const run = this.run;
            if (!run) return;
            // Preserve the task for the same tab's reload. Only local waits are cancelled.
            try { this.save(run); } catch { this.clearSaved(); }
            this.generation += 1;
            this.run = null;
            this.model.active = false;
            this.model.nextAt = 0;
            this.unresolvedDialog = this.unresolvedDialog || run.current.phase === 'opening';
            run.abort.abort();
            this.show('已暂停', '页面已离开，同标签页刷新后会重新核对任务');
        }
    }

    function mount(window) {
        if (window.document.getElementById(PANEL_ID)) return null;
        const document = window.document;
        const host = document.createElement('div');
        host.id = PANEL_ID;
        document.body.appendChild(host);
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
            <style>
                :host { all: initial; position: fixed; right: 20px; bottom: 24px; z-index: 2147483647; }
                * { box-sizing: border-box; }
                section { width: 360px; max-width: calc(100vw - 24px); max-height: calc(100vh - 48px); overflow-y: auto; padding: 18px; background: #fff;
                    border: 1px solid #dce3f0; border-radius: 14px; box-shadow: 0 12px 40px #172b4d26;
                    font: 13px/1.6 system-ui, 'PingFang SC', sans-serif; color: #26344d; }
                header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
                h2 { font-size: 15px; margin: 0; flex: 1; }
                label { display: block; margin-top: 8px; color: #52617b; }
                input, select, button { font: inherit; border: 1px solid #cdd6e6; border-radius: 7px; }
                input, select { width: 100%; padding: 8px; color: #26344d; background: #fff; }
                button { padding: 7px 10px; cursor: pointer; background: #fff; color: #304b84; }
                button:disabled { opacity: .5; cursor: default; }
                button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid #4161ef; outline-offset: 2px; }
                #start { background: #385bee; color: white; border-color: #385bee; flex: 1; }
                #stop { color: #b02a35; border-color: #e5bdc2; flex: 1; }
                .actions, .row { display: flex; gap: 8px; align-items: center; margin-top: 12px; }
                .row label { margin: 0; flex: 1; } .row input { width: 88px; }
                #status { margin: 14px 0 0; padding: 10px; background: #f1f5ff; border-radius: 8px; overflow-wrap: anywhere; }
                #state { font-weight: 650; } #detail { color: #516079; margin-top: 3px; }
                #targets-state { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; margin-top: 8px; }
                .actions { position: sticky; bottom: 0; background: #fff; padding: 6px 0; }
                #stats, .hint { color: #6c7890; font-size: 12px; margin-top: 8px; }
                details { margin-top: 10px; } summary { cursor: pointer; }
                #log { max-height: 140px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; }
                section.collapsed .body { display: none; } section.collapsed { width: 270px; }
            </style>
            <section aria-label="AutoDL GPU 抢卡助手">
                <header><h2>AutoDL GPU 抢卡助手 v1.1.0</h2><button id="collapse" aria-label="收起面板">收起</button></header>
                <div class="body">
                    <label for="count">要抢几台实例</label><select id="count"><option value="1">1 台</option><option value="2">2 台</option><option value="3">3 台</option></select>
                    <label for="instances">实例 1</label><select id="instances"><option value="">选择实例</option></select>
                    <label for="target">完整实例 ID</label><input id="target" autocomplete="off" spellcheck="false" placeholder="粘贴完整实例 ID">
                    <div id="slot2" hidden><label for="instances2">实例 2</label><select id="instances2"><option value="">选择实例</option></select>
                    <label for="target2">完整实例 ID</label><input id="target2" autocomplete="off" spellcheck="false" placeholder="粘贴完整实例 ID"></div>
                    <div id="slot3" hidden><label for="instances3">实例 3</label><select id="instances3"><option value="">选择实例</option></select>
                    <label for="target3">完整实例 ID</label><input id="target3" autocomplete="off" spellcheck="false" placeholder="粘贴完整实例 ID"></div>
                    <div class="row"><label for="interval">检查间隔（秒）</label><input id="interval" type="number" min="5" step="1" value="10"><button id="read">读取列表</button></div>
                    <div class="hint">开始后依次开机所选实例，每台成功后继续剩余实例，开机后按 AutoDL 规则计费。</div>
                </div>
                <div class="actions"><button id="start">开始抢卡</button><button id="stop" disabled>停止 / 接管</button></div>
                <div id="status" role="status" aria-live="polite"><div id="state">待开始</div><div id="detail">正在读取页面</div></div>
                <div id="stats"></div><div id="targets-state" aria-live="polite"></div>
                <div class="body"><details><summary>最近记录</summary><div id="log"></div></details></div>
            </section>`;
        const get = id => shadow.getElementById(id);
        const page = new AutoDLPage(window);
        const slots = ['', '2', '3'];
        function showSlots() {
            for (const index of [2, 3]) get(`slot${index}`).hidden = index > Number(get('count').value);
        }
        function setSelection(config) {
            const ids = config.ids || [config.id || ''];
            get('count').value = String(Math.min(3, Math.max(1, ids.length)));
            slots.forEach((suffix, index) => {
                const id = normalizeId(ids[index]);
                get(`target${suffix}`).value = id;
                get(`instances${suffix}`).value = id;
            });
            showSlots();
        }
        let initializationTimer = null;
        const render = model => {
            if (['已停止', '已暂停', '抢卡成功'].includes(model.state)) {
                window.clearTimeout(initializationTimer);
                initializationTimer = null;
            }
            get('state').textContent = model.state;
            get('detail').textContent = model.detail;
            get('targets-state').textContent = (model.targets || []).map(target =>
                `${target.id} · ${target.state} · 尝试 ${target.attempts} 次`).join('\n');
            get('stats').textContent = `完成 ${(model.targets || []).filter(target => target.done).length}/${(model.targets || []).length || Number(get('count').value)} 台 · 尝试 ${model.attempts} 次${model.nextAt ? ` · ${Math.max(0, Math.ceil((model.nextAt - Date.now()) / 1000))} 秒后检查` : ''}`;
            get('log').textContent = model.log.join('\n');
            for (const id of ['count', 'instances', 'target', 'instances2', 'target2', 'instances3', 'target3', 'interval', 'read', 'start']) get(id).disabled = model.active;
            get('stop').disabled = !model.active;
        };
        const grabber = new Grabber(page, { update: render, notify: id => {
            if (window.Notification?.permission === 'granted') {
                try { new window.Notification('AutoDL GPU 已运行', { body: `实例 ${id} 已进入运行中`, tag: `autodl-${id}` }); } catch { /* Panel remains the primary result. */ }
            }
        } });
        try {
            const settings = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || 'null');
            if (settings) {
                setSelection(settings);
                get('interval').value = Number(settings.seconds) >= 5 ? settings.seconds : 10;
            }
        } catch { /* Use defaults if old settings are invalid. */ }
        function readList() {
            const list = page.list();
            for (const suffix of slots) {
                const select = get(`instances${suffix}`);
                select.replaceChildren(new window.Option('选择实例', ''));
                for (const instance of list) select.appendChild(new window.Option(instance.label, instance.id));
                select.value = get(`target${suffix}`).value;
            }
        }
        get('read').addEventListener('click', () => {
            try { readList(); grabber.show('待开始', '当前页实例已读取'); }
            catch (error) { grabber.show('待开始', error.message); }
        });
        get('count').addEventListener('change', () => {
            showSlots();
            grabber.model.targets = [];
            grabber.model.attempts = 0;
            grabber.show('待开始', `请选择 ${get('count').value} 台实例并核对完整 ID`);
        });
        for (const suffix of slots) {
            get(`instances${suffix}`).addEventListener('change', () => {
                get(`target${suffix}`).value = get(`instances${suffix}`).value;
            });
        }
        get('start').addEventListener('click', () => {
            const ids = slots.slice(0, Number(get('count').value)).map(suffix => normalizeId(get(`target${suffix}`).value));
            const config = { ids, seconds: Number(get('interval').value) };
            setSelection(config);
            try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(config)); } catch { /* Task state is stored separately. */ }
            if (window.Notification?.permission === 'default') window.Notification.requestPermission().catch(() => {});
            void grabber.start(config);
        });
        get('stop').addEventListener('click', () => grabber.stop());
        get('collapse').addEventListener('click', () => {
            const collapsed = shadow.querySelector('section').classList.toggle('collapsed');
            get('collapse').textContent = collapsed ? '展开' : '收起';
            get('collapse').setAttribute('aria-label', collapsed ? '展开面板' : '收起面板');
        });
        const manualTakeover = event => {
            if (!grabber.run || !shouldTakeOver(event, host)) return;
            grabber.stop('检测到页面上的人工操作，自动化已停止');
        };
        document.addEventListener('pointerdown', manualTakeover, true);
        document.addEventListener('keydown', manualTakeover, true);
        window.addEventListener('pagehide', () => grabber.suspendForNavigation());
        const navigation = window.performance.getEntriesByType?.('navigation')[0];
        const saved = navigation?.type === 'reload' ? grabber.readSaved() : null;
        if (!saved) grabber.clearSaved();
        const readyUntil = Date.now() + 15000;
        function ready() {
            if (!onListPage(window.location)) return;
            try {
                readList();
                if (get('instances').options.length === 1 && Date.now() < readyUntil) {
                    initializationTimer = window.setTimeout(ready, 300);
                } else if (!grabber.model.active) grabber.show('待开始', '选择目标实例并开始抢卡');
            } catch (error) {
                if (Date.now() < readyUntil && !document.querySelector('.el-table.instance-table')) {
                    initializationTimer = window.setTimeout(ready, 300);
                } else {
                    if (!grabber.model.active) grabber.show('已暂停', error.message);
                }
            }
        }
        ready();
        if (saved) {
            setSelection(saved);
            get('interval').value = saved.seconds;
            void grabber.start(saved, saved);
        }
        return { grabber, host, shadow };
    }

    // CommonJS exports allow the shipped file itself to be exercised in DOM tests.
    if (typeof module === 'object' && module.exports) {
        module.exports = { AutoDLPage, Grabber, PageError, RetryError, visible, enabled, feedbackKind,
            normalizeId, shouldTakeOver, mount, SESSION_KEY, SETTINGS_KEY, LOCK_NAME };
    } else {
        let mounted = false;
        const tryMount = () => {
            if (!mounted && onListPage(window.location) && document.body) {
                mounted = true;
                mount(window);
            }
        };
        tryMount();
        if (!mounted) {
            const observer = new MutationObserver(() => {
                tryMount();
                if (mounted) observer.disconnect();
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
        }
    }
})();
