const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('../.tools/node_modules/jsdom');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'xiaoya-video.user.js'), 'utf8');
function appliesToPage(url) {
    const target = new URL(url);
    return [...source.matchAll(/^\/\/\s*@match\s+(\S+)/gm)].some(([, pattern]) => {
        const rule = new URL(pattern);
        const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pathPattern = new RegExp(`^${rule.pathname.split('*').map(escape).join('.*')}$`);
        return target.protocol === rule.protocol && target.hostname === rule.hostname && pathPattern.test(target.pathname);
    });
}
const platform = fs.readFileSync(path.join(__dirname, 'platform-visibility.js'), 'utf8');
assert.ok(platform.includes('function stopMediaWhenHidden()'), 'Use the captured platform visibility handler');

async function setup(options = {}) {
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', error => { if (!error.message.includes('navigation')) console.error(error); });
    const dom = new JSDOM('<div class="group-resource-body"><div class="group-resource-content"><div class="ali_player_wrapper"><video></video></div></div></div>', {
        url: options.url || 'https://whut.ai-augmented.com/app/jx-web/mycourse/100/resource/200/301', runScripts: 'outside-only', virtualConsole
    });
    const win = dom.window;
    let hidden = false, paused = true, ended = false, interval;
    let rejectPlay = false, playCount = 0, readyState = options.readyState ?? 4, currentSrc = options.currentSrc || '';
    let now = options.now ?? Date.now();
    win.Date.now = () => now;
    const timeouts = new Map();
    let timerId = 0;
    Object.defineProperty(win.document, 'hidden', { get: () => hidden });
    Object.defineProperty(win.document, 'visibilityState', { get: () => hidden ? 'hidden' : 'visible' });
    win.document.hasFocus = () => !hidden;
    win.HTMLElement.prototype.getClientRects = function () { return this.isConnected && !this.hidden ? [{}] : []; };
    const video = win.document.querySelector('video');
    let currentTime = options.currentTime ?? 120;
    let duration = options.duration ?? 600, seekFailures = options.seekFailures ?? 0;
    Object.defineProperties(video, {
        paused: { get: () => paused }, ended: { get: () => ended },
        readyState: { get: () => readyState }, duration: { get: () => duration },
        currentSrc: { get: () => currentSrc },
        currentTime: { get: () => currentTime, set: value => {
            if (seekFailures > 0) { seekFailures--; throw new win.DOMException('Not seekable yet', 'InvalidStateError'); }
            currentTime = value; if (value === 0) ended = false;
        } }
    });
    video.play = async () => {
        playCount++;
        if (rejectPlay) throw new win.DOMException('User gesture required', 'NotAllowedError');
        paused = false;
        video.dispatchEvent(new win.Event('play'));
    };
    video.pause = () => {
        if (paused) return;
        paused = true;
        video.dispatchEvent(new win.Event('pause'));
    };
    win.setInterval = cb => { interval = cb; return ++timerId; };
    win.clearInterval = () => {};
    win.setTimeout = (cb, delay) => { const id = ++timerId; timeouts.set(id, { cb, delay }); return id; };
    win.clearTimeout = id => timeouts.delete(id);
    if ((options.cookie ?? 'prd-access-token=test-only') !== '') win.document.cookie = `${options.cookie ?? 'prd-access-token=test-only'}; Path=/`;
    if (options.saved) win.sessionStorage.setItem('xy-video-helper-v1', JSON.stringify(options.saved));
    for (const [key, value] of Object.entries(options.sessionStorage || {})) win.sessionStorage.setItem(key, value);
    for (const [key, value] of Object.entries(options.localStorage || {})) win.localStorage.setItem(key, value);
    const resources = options.resources || [
        { id: '301', parent_id: '200', type: 9, name: '1.mp4', sort_position: 1 },
        { id: '302', parent_id: '200', type: 9, name: '2.mp4', sort_position: 2 }
    ];
    const requests = [];
    win.fetch = async (input, init = {}) => {
        const url = new URL(input, win.location.origin);
        requests.push({ url, method: init.method || 'GET' });
        if (options.reply) {
            const result = await options.reply(url, init);
            if (result) return result;
        }
        if (options.failPath && url.pathname.includes(options.failPath)) return { ok: false, status: options.failStatus || 503 };
        const data = url.pathname.includes('/oauth2/info') ? { info: { id: options.userId || 'test-user' } }
            : url.pathname.includes('/group/queryGroup/') ? { id: url.pathname.split('/').pop(), name: options.courseNames?.[url.pathname.split('/').pop()] || '大学生劳动教育' }
            : url.pathname.includes('/ads/duration/user') ? { total_duration: options.minutes ?? 41 }
            : url.pathname.includes('queryCourseResources') ? resources
            : url.pathname.includes('studentFinishInfo') ? options.taskStates?.[url.searchParams.get('node_id')] || { finished: false }
            : options.watchStates?.[url.pathname.split('/').pop()] || {};
        return { ok: true, json: async () => ({ success: true, data }) };
    };
    win.eval(platform);
    win.eval('stopMediaWhenHidden()');
    if (appliesToPage(win.location.href)) win.eval(source);
    const host = win.document.getElementById('xy-video-helper');
    if (!host) return { dom, win, ui: null, requests };
    const ui = host.shadowRoot || host;
    const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
    const tick = async () => { interval(); await flush(); };
    const timers = async (maxDelay = 1500) => {
        for (const [id, timer] of [...timeouts]) if (timer.delay <= maxDelay) { timeouts.delete(id); timer.cb(); }
        await flush();
    };
    const open = async () => {
        const launcher = ui.querySelector('[data-launcher]');
        if (launcher?.getAttribute('aria-expanded') === 'false') launcher.click();
        await flush();
    };
    const start = async () => { await open(); ui.querySelector('[data-start]').click(); await flush(); await tick(); };
    const hide = () => { hidden = true; win.document.dispatchEvent(new win.Event('visibilitychange')); };
    return { dom, win, video, ui, start, open, hide, timers, tick, flush, timeouts, requests,
        advance: ms => { now += ms; },
        ready: (state = 4, event = 'loadeddata') => { readyState = state; video.dispatchEvent(new win.Event(event)); },
        source: value => { currentSrc = value; },
        duration: value => { duration = value; },
        playCount: () => playCount, rejectPlay: () => { rejectPlay = true; },
        end: () => { ended = true; video.dispatchEvent(new win.Event('ended')); } };
}


module.exports = { setup };
