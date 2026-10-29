// ==UserScript==
// @name         小雅视频连播助手
// @namespace    local.xiaoya.video
// @version      0.10.1
// @description  视频与自主观看资料连续学习，显示历史学习时长，自动缓存课程列表。
// @match        https://whut.ai-augmented.com/*
// @match        https://infra.ai-augmented.com/app/auth/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    const VERSION = '0.10.1';
    const collator = new Intl.Collator('zh-CN', { numeric: true });
    const isVideo = node => Number(node.type) === 9 ||
        /^video\//i.test(node.mimetype || '') ||
        /\.(mp4|webm|m4v|mov|mkv|avi|flv|m3u8)$/i.test(node.name || '');
    const isSelfStudy = node => Number(node.task_type ?? node.task?.task_type ?? node.property?.task_type) === 1 ||
        [node.tag, node.task_label, node.task?._taskTypeText].some(label => label === '自主观看');
    const isStudyResource = node => Number(node.type) !== 1 && (isVideo(node) || isSelfStudy(node));
    const resourceKind = node => isVideo(node) ? '视频' : /\.pptx?$/i.test(node.name || '') ? 'PPT' : '资料';
    const DOCUMENT_MS = 120000, QUEUE_TTL = 10 * 60000, STATUS_TTL = 30000, HISTORY_TTL = 15 * 60000;
    function validMinutes(value) {
        const number = Number(value);
        return Number.isInteger(number) && number >= 2 && number <= 1440;
    }
    function normalizeSettings(value = {}) {
        const resourceMinutes = {};
        for (const [id, minutes] of Object.entries(value?.resourceMinutes || {})) {
            if (validMinutes(minutes)) resourceMinutes[id] = Number(minutes);
        }
        return { mode: value?.mode === 'single' ? 'single' : 'continuous',
            documentMinutes: validMinutes(value?.documentMinutes) ? Number(value.documentMinutes) : 2,
            skipCompleted: value?.skipCompleted === true, resourceMinutes };
    }

    // 接口返回平铺目录。优先使用平台 sort_position，缺失时按名称自然排序。
    function compareNodes(a, b) {
        if (a.sort_position != null && b.sort_position != null &&
            Number.isFinite(Number(a.sort_position)) && Number.isFinite(Number(b.sort_position))) {
            const order = Number(a.sort_position) - Number(b.sort_position);
            if (order) return order;
        }
        return collator.compare(a.name || '', b.name || '');
    }
    function buildQueue(resources) {
        const nodes = resources.filter(node => node && node.id != null && Number(node.del) !== 2);
        const ids = new Set(nodes.map(node => String(node.id)));
        const children = new Map();
        for (const node of nodes) {
            const parent = String(node.parent_id ?? '');
            if (!children.has(parent)) children.set(parent, []);
            children.get(parent).push(node);
        }
        for (const siblings of children.values()) {
            siblings.sort(compareNodes);
        }
        const queue = [], seen = new Set();
        function visit(node) {
            const id = String(node.id);
            if (seen.has(id)) return;
            seen.add(id);
            if (isStudyResource(node)) queue.push(node);
            for (const child of children.get(id) || []) visit(child);
        }
        nodes.filter(node => !ids.has(String(node.parent_id ?? '')))
            .sort(compareNodes).forEach(visit);
        return queue;
    }
    function completionState(node, data = {}) {
        const hasTask = !!(node.task_id || node.task?.task_id);
        const finished = data.finished === true || data.finished === 1 || data.finished === '1' || data.finished === 'true'
            ? true : data.finished === false || data.finished === 0 || data.finished === '0' || data.finished === 'false' ? false : null;
        const record = data.watchRecord || (!hasTask ? data : null);
        const duration = Number(record?.duration), watched = Number(record?.watched_duration);
        const percent = Number.isFinite(duration) && duration > 0 && Number.isFinite(watched) && watched >= 0
            ? Math.min(100, Math.ceil(watched / (duration * 0.95) * 100)) : null;
        return { complete: hasTask ? finished : percent == null ? null : percent >= 100,
            percent, hasTask, error: false, checkedAt: 0 };
    }
    function completionLabel(state) {
        if (!state) return '待检测';
        if (state.error) return '检测失败';
        if (state.complete === true) return '已完成';
        if (state.hasTask && state.complete === false && state.percent === 100) return '待提交';
        if (state.percent > 0) return `已看 ${state.percent}%`;
        return state.complete === false ? '未完成' : '待检测';
    }
    function resourcePath(course, node) {
        const parent = node.parent_id == null || node.parent_id === '' ? '_' : String(node.parent_id);
        return `/app/jx-web/mycourse/${encodeURIComponent(course)}/resource/${encodeURIComponent(parent)}/${encodeURIComponent(String(node.id))}`;
    }
    function nextVideo(nodes, currentId, states, skipCompleted) {
        const index = nodes.findIndex(node => String(node.id) === currentId);
        return index < 0 ? null : nodes.slice(index + 1).find(node =>
            !skipCompleted || states.get(String(node.id))?.complete !== true) || null;
    }

    // 允许在 Node 中检查目录处理逻辑，不执行浏览器代码。
    if (typeof module !== 'undefined' && module.exports && typeof window === 'undefined') {
        module.exports = { buildQueue, isVideo, isSelfStudy, isStudyResource, completionState, completionLabel, resourcePath, nextVideo, normalizeSettings };
        return;
    }
    if (window.top !== window.self || document.getElementById('xy-video-helper')) return;
    const loginSurface = location.hostname === 'infra.ai-augmented.com' && location.pathname.startsWith('/app/auth/');
    let loginNoticeShown = false;

    const storageKey = 'xy-video-helper-v1';
    let saved = {};
    try { saved = JSON.parse(sessionStorage.getItem(storageKey) || '{}'); } catch { /* 使用默认值 */ }
    let preferences = {};
    try { preferences = JSON.parse(localStorage.getItem('xy-learning-preferences-v1') || '{}'); } catch { /* 使用默认值 */ }
    let activeTab = !loginSurface && ['learning', 'list', 'settings'].includes(saved.activeTab) ? saved.activeTab : 'learning';
    let queueSearch = '', queueFilter = 'all';
    let activeCourse = saved.course || '';
    let running = saved.running === true;
    let muted = (preferences.muted ?? saved.muted) !== false;
    let background = (preferences.background ?? saved.background) !== false;
    let skipCompleted = saved.skipCompleted === true;
    let collapsed = loginSurface ? false : saved.collapsed !== false;
    let position = preferences.position || saved.position || null;
    let userPaused = saved.userPaused === true;
    let navigation = saved.navigation && Date.now() - saved.navigation.startedAt < 30000 ? saved.navigation : null;
    let outgoingVideo = null, outgoingSource = '';
    let queue = [], queueCourse = '', routeKey = '', generation = 0;
    let video = null, endedListener = null, readyListener = null, pauseListener = null, playListener = null;
    let nextTimer = null, loading = false, resumeAfterDialog = false;
    let lastDialogClick = 0;
    let backgroundIntent = false, backgroundTimer = null, backgroundAttempts = 0;
    let lastBackgroundAttempt = 0, playPending = false, waitingForVideoReady = false;
    const completions = new Map(), pendingChecks = new Map();
    let completionEpoch = 0, completionBusy = false, currentCheckAt = 0;
    let observedCourse = null, courseEpoch = 0, directoryCheckedAt = 0, cacheAt = 0;
    let documentClock = null, advancing = false;
    let history = { minutes: null, fetchedAt: 0, error: false }, historyBusy = false;
    let auth = { state: 'checking', id: null, message: '', checkedAt: 0 }, authBusy = false, authEpoch = 0;
    let courseInfo = { name: '', state: 'loading', fetchedAt: 0 }, courseInfoBusy = false;
    let settings = normalizeSettings(), sessionEnded = false, resourceFailure = '', directoryIssue = '';
    function tokenEntry() {
        if (loginSurface) return undefined;
        return document.cookie.split(';').map(item => item.trim()).find(item => item.split('=')[0].includes('prd-access-token'));
    }
    function tokenScope() {
        const token = tokenEntry();
        if (!token) return null;
        let hash = 2166136261;
        for (const char of token) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
        return (hash >>> 0).toString(16);
    }
    let cacheScope = tokenScope();
    const settingsKey = course => auth.id != null && course ? `xy-learning-settings-v1:${encodeURIComponent(String(auth.id))}:${course}` : null;
    function loadSettings(course) {
        try { settings = normalizeSettings(JSON.parse(localStorage.getItem(settingsKey(course)) || '{}')); }
        catch { settings = normalizeSettings(); }
        skipCompleted = settings.skipCompleted;
        syncSettingsInputs();
    }
    function saveSettings() {
        const key = settingsKey(route()?.course);
        if (key) try { localStorage.setItem(key, JSON.stringify(settings)); } catch { /* 本页设置仍有效 */ }
        persist();
    }
    function targetDocumentMs(node = currentNode()) {
        return (settings.resourceMinutes[String(node?.id)] ?? settings.documentMinutes) * 60000;
    }
    const cacheKey = course => cacheScope ? `xy-learning-cache-v5:${cacheScope}:${course}` : null;
    function readCache(course) {
        try {
            const key = cacheKey(course);
            if (!key) return null;
            const value = JSON.parse(localStorage.getItem(key) || 'null');
            return value?.version === 1 && value.course === course && Number.isFinite(value.cachedAt) &&
                Array.isArray(value.queue) && value.queue.every(node => node && node.id != null) &&
                (value.completions == null || Array.isArray(value.completions)) ? value : null;
        } catch { return null; }
    }
    function writeCache() {
        const key = cacheKey(queueCourse);
        if (!key || !queueCourse || !cacheAt) return;
        try {
            const previous = readCache(queueCourse);
            localStorage.setItem(key, JSON.stringify({ version: 1, course: queueCourse, cachedAt: cacheAt,
                queue, completions: [...completions], courseInfo: courseInfo.name ? courseInfo : previous?.courseInfo || null,
                history: history.minutes != null ? history : previous?.history || null }));
        } catch { /* 缓存不可用时仍可学习 */ }
    }

    const panel = document.createElement('section');
    panel.id = 'xy-video-helper';
    panel.style.cssText = 'all:initial;position:fixed;width:48px;height:48px;z-index:1100;color-scheme:light;';
    const ui = panel.attachShadow({ mode: 'open' });
    const icons = {
        assistant: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 6.5C9.6 4.7 6.8 4.3 3.5 5v14c3.3-.7 6.1-.3 8.5 1.5 2.4-1.8 5.2-2.2 8.5-1.5V5c-3.3-.7-6.1-.3-8.5 1.5Zm0 0v14" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M6.5 9h2m-2 3h2m7-3h2m-2 3h2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
        play: '<svg viewBox="0 0 24 24" fill="none"><path d="m9 6 9 6-9 6V6Z" fill="currentColor"/></svg>',
        pause: '<svg viewBox="0 0 24 24" fill="none"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg>',
        previous: '<svg viewBox="0 0 24 24" fill="none"><path d="m14 6-6 6 6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        next: '<svg viewBox="0 0 24 24" fill="none"><path d="m10 6 6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        settings: '<svg viewBox="0 0 24 24" fill="none"><path d="m9.5 3-.7 2.3-2 .9-2.2-.6-2.5 4.3 1.7 1.7v2.3l-1.7 1.7 2.5 4.3 2.2-.6 2 .9.7 2.3h5l.7-2.3 2-.9 2.2.6 2.5-4.3-1.7-1.7v-2.3l1.7-1.7-2.5-4.3-2.2.6-2-.9L14.5 3h-5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="12" cy="12.8" r="3" stroke="currentColor" stroke-width="1.5"/></svg>',
        loading: '<svg class="spinner" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="2" opacity=".25"/><path d="M12 4a8 8 0 0 1 8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
        stop: '<svg viewBox="0 0 24 24" fill="none"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>',
        collapse: '<svg viewBox="0 0 24 24" fill="none"><path d="M6 12h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
        expand: '<svg viewBox="0 0 24 24" fill="none"><path d="M7 14l5-5 5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        refresh: '<svg viewBox="0 0 24 24" fill="none"><path d="M19 9a7 7 0 1 0 0 6M19 4v5h-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    };
    ui.innerHTML = `<style>
        :host{--ink:#20304a;--muted:#65748c;--blue:#3478f6;--blue-dark:#2563d8;--soft:#f2f6fd;--line:#e3eaf5;font:13px/1.55 "Microsoft YaHei UI","PingFang SC",sans-serif;color:var(--ink)}
        *{box-sizing:border-box}button,a,input,select{font:inherit}button{cursor:pointer;border:0}button:disabled{cursor:default;opacity:.45}button,a{touch-action:manipulation;-webkit-tap-highlight-color:transparent}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #9cbeff;outline-offset:2px}svg{width:18px;height:18px;display:block;flex:none}[hidden]{display:none!important}
        .launcher{position:absolute;inset:0;width:48px;height:48px;display:grid;place-items:center;padding:0;border-radius:50%;background:var(--blue);color:#fff;box-shadow:0 4px 16px #2463cc26;border:1px solid #ffffff80;cursor:grab;touch-action:none}.launcher:active{cursor:grabbing}.launcher>span{pointer-events:none}.launcher svg{width:23px;height:23px}.launcher .signal{position:absolute;right:1px;bottom:1px;width:10px;height:10px;border-radius:50%;background:#a5b2c8;border:2px solid #fff}.launcher[data-mode="playing"] .signal,.launcher[data-mode="reading"] .signal{background:#9fc7ff}.launcher[data-mode="jumping"] .signal,.launcher[data-mode="loading"] .signal{background:#f0ca77}
        .shell{position:absolute;width:min(352px,calc(100vw - 24px));max-height:calc(100vh - 24px);max-height:calc(100dvh - 24px);display:flex;flex-direction:column;overflow:hidden;font:13px/1.55 "Microsoft YaHei UI","PingFang SC",sans-serif;color:var(--ink);background:#fff;border:1px solid #dce6f5;border-radius:12px;box-shadow:0 8px 32px #243f731c}
        .head{display:flex;align-items:center;gap:8px;padding:15px 16px 10px;cursor:grab;touch-action:none;user-select:none;flex:none}.head:active{cursor:grabbing}.mark{display:grid;place-items:center;width:24px;height:24px;color:var(--blue)}.mark svg{width:24px;height:24px}.head strong{font-size:14px;font-weight:650}.badge{display:flex;align-items:center;gap:5px;margin-left:auto;font-size:11px;color:var(--muted);white-space:nowrap}.dot{width:6px;height:6px;border-radius:50%;background:#a5b2c8}.shell[data-running="true"] .dot{background:var(--blue)}.shell[data-running="true"] .badge{color:var(--blue-dark)}.icon-button{display:grid;place-items:center;background:transparent;color:var(--muted);border-radius:5px;width:24px;height:24px;padding:3px}.icon-button:hover{background:var(--soft)}
        .course{padding:0 16px 12px;flex:none}.course small{display:block;font-size:10px;color:var(--muted);margin-bottom:3px}.course strong{font-size:16px;font-weight:600;display:block;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .tabs{display:flex;padding:0 16px;gap:26px;border-bottom:1px solid var(--line);flex:none}.tab{position:relative;background:transparent;color:var(--muted);font-size:12px;padding:8px 3px 10px;min-width:36px}.tab[aria-selected="true"]{color:var(--blue-dark);font-weight:600}.tab[aria-selected="true"]:after{content:"";position:absolute;bottom:-1px;left:0;right:0;height:2px;background:var(--blue);border-radius:2px}.tab-count{font-size:10px;font-weight:400;margin-left:5px;color:var(--muted)}
        .body{padding:0 16px;min-height:0;overflow:auto;scrollbar-width:thin;scrollbar-color:#cad8ed transparent}.view{padding:14px 0}.notice{font-size:11px;color:var(--muted);padding:10px 0 0;line-height:1.6;overflow-wrap:anywhere}.notice[data-tone="warning"]{color:#95652b}.notice[data-tone="error"]{color:#a94730}
        .task{background:var(--soft);border-radius:8px;padding:12px}.track-top{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;color:var(--muted);margin-bottom:9px}.track-number{font-variant-numeric:tabular-nums}.task-meta{display:flex;align-items:center;gap:9px;font-size:10px;margin-bottom:7px}.task-kind{color:#5271a4}.task .completion{border-left:1px solid #ccd9ef;padding-left:9px}.title{font-size:15px;font-weight:600;line-height:1.6;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}.time{display:flex;align-items:baseline;gap:4px;margin-top:12px;font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}.time:after{content:"";flex:1}.progress-percent{order:1;font-size:10px}progress{display:block;appearance:none;-webkit-appearance:none;width:100%;height:5px;border:0;border-radius:3px;overflow:hidden;background:#dfe8f6;margin:7px 0 0}progress::-webkit-progress-bar{background:#dfe8f6}progress::-webkit-progress-value{background:var(--blue);border-radius:3px}progress::-moz-progress-bar{background:var(--blue)}
        .actions{display:grid;grid-template-columns:minmax(0,1fr) 86px;gap:9px;margin-top:12px}.primary,.stop{display:flex;align-items:center;justify-content:center;gap:7px;min-height:40px;padding:8px 10px;border-radius:7px;font-size:12px}.primary{background:var(--blue);color:#fff;font-weight:600;min-width:0}.primary:hover:not(:disabled){background:var(--blue-dark)}.action-icon{display:grid;place-items:center}.action-icon svg{width:19px;height:19px}.stop{background:#f1f4f9;color:#53627b;border:1px solid #e4eaf3}.stop:hover:not(:disabled){background:#e8eef8}.stop svg{width:15px;height:15px}
        .task-nav{display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--line);margin-top:12px;padding-top:4px}.task-step{display:flex;align-items:center;gap:3px;color:var(--blue-dark);font-size:11px;text-decoration:none;border-radius:5px;padding:7px 2px}.task-step svg{width:14px;height:14px}.task-step:hover:not([aria-disabled="true"]){background:var(--soft)}.task-step[aria-disabled="true"]{color:#9eabc0;cursor:default}.spinner{animation:xy-spin 1s linear infinite}@keyframes xy-spin{to{transform:rotate(360deg)}}
        .next{margin-top:4px;padding:9px 11px;background:#f6f8fd;border-radius:7px;display:flex;align-items:center;gap:10px;min-width:0}.next-label{font-size:10px;color:var(--muted);white-space:nowrap}.next-link{font-size:11px;color:#405b86;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}.next-link:hover:not([aria-disabled="true"]){text-decoration:underline}.next-link[aria-disabled="true"]{color:var(--muted)}.history{display:flex;align-items:center;gap:6px;padding-top:12px;margin-top:12px;border-top:1px solid var(--line);font-size:10px;color:var(--muted)}.history strong{font-size:13px;color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums}.history small{font-size:9px;margin-left:auto;white-space:nowrap}.history[data-error="true"] strong{color:#a94730}.history[data-error="true"]{flex-wrap:wrap}.history[data-error="true"] small{white-space:normal}
        .footer{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 16px;padding:10px 0 12px;border-top:1px solid var(--line);flex:none}.study-mode{font-size:10px;color:var(--muted)}.settings-entry{display:flex;align-items:center;gap:5px;background:transparent;color:var(--blue-dark);font-size:11px;padding:2px;border-radius:4px}.settings-entry svg{width:14px;height:14px}.settings-entry:hover{background:var(--soft)}.settings-top{display:flex;align-items:center;gap:10px;margin:0 0 15px}.settings-top h2{font-size:13px;font-weight:600;margin:0}.settings-back{display:flex;align-items:center;gap:2px;padding:4px 2px;background:transparent;color:var(--blue-dark);font-size:11px;border-radius:4px}.settings-back svg{width:14px;height:14px}
        .list-tools{display:flex;align-items:center;gap:7px}.search{width:100%;min-width:0;border:1px solid var(--line);border-radius:7px;background:#f8faff;padding:7px 10px;font-size:11px;color:var(--ink)}.search::placeholder{color:var(--muted)}.refresh{display:grid;place-items:center;background:transparent;color:#5e7daf;padding:6px;border-radius:5px;flex:none}.refresh:hover{background:var(--soft)}.refresh svg{width:15px;height:15px}.filters{display:flex;gap:5px;margin-top:10px}.filter{font-size:10px;padding:4px 9px;border-radius:5px;background:transparent;color:var(--muted)}.filter[aria-pressed="true"]{background:#eaf1ff;color:var(--blue-dark)}.list-meta{display:flex;justify-content:space-between;align-items:center;margin:10px 0 6px;font-size:10px;color:var(--muted)}.text-button{background:transparent;color:var(--blue-dark);font-size:10px;padding:2px 0}.text-button:disabled{color:var(--muted)}
        .queue{padding:0;margin:0 -5px;list-style:none;max-height:min(310px,calc(100dvh - 310px));overflow:auto;scrollbar-width:thin;scrollbar-color:#cad8ed transparent}.queue-link{display:flex;align-items:center;gap:7px;padding:10px 6px;border-radius:6px;font-size:11px;color:#536987;text-decoration:none}.queue-link:hover{background:#f5f8fe}.queue li.current .queue-link{background:#eaf2ff;color:#265eb8;box-shadow:inset 2px 0 0 var(--blue)}.queue .num{width:20px;flex:none;font-size:10px;font-variant-numeric:tabular-nums;text-align:center;color:var(--muted)}.queue .name{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.queue .current .name{font-weight:600}.queue .num svg{width:13px;height:13px;margin:auto;color:var(--blue-dark)}.queue-empty{padding:28px 8px;text-align:center;font-size:11px;color:var(--muted)}.kind{font-size:9px;line-height:1.4;background:#f0f4fa;border-radius:3px;padding:1px 3px;flex:none;color:var(--muted)}.completion{font-size:10px;font-weight:400;color:var(--muted);white-space:nowrap}.completion.done{color:#446ba6}.queue .completion.done{font-size:0;min-width:13px;text-align:center}.queue .completion.done:before{content:"✓";font-size:12px}.cache-note{font-size:9px;color:var(--muted);padding-top:10px;text-align:right}
        .settings-heading{font-size:10px;color:var(--muted);margin:0 0 7px}.mode-switch{display:flex;gap:3px;padding:3px;background:#f0f4fb;border-radius:7px}.mode-switch button{flex:1;padding:7px 4px;border-radius:5px;font-size:11px;background:transparent;color:var(--muted)}.mode-switch button[aria-pressed="true"]{background:#fff;color:var(--blue-dark);box-shadow:0 1px 3px #203b6512}.mode-note{margin:7px 0 14px;font-size:10px;color:var(--muted)}.options{display:grid;gap:12px;padding:0 0 14px}.option{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;cursor:pointer}.option input{appearance:none;-webkit-appearance:none;width:28px;height:16px;background:#d3ddec;border-radius:10px;position:relative;margin:0;cursor:pointer;flex:none}.option input:before{content:"";position:absolute;width:10px;height:10px;top:3px;left:3px;border-radius:50%;background:#fff;transition:transform .15s}.option input:checked{background:var(--blue)}.option input:checked:before{transform:translateX(12px)}.option input:disabled{opacity:.4;cursor:default}
        .configuration{border-top:1px solid var(--line);padding:12px 0 0;font-size:11px}.configuration h3{font-size:11px;font-weight:600;margin:0 0 10px}.config-row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px}.config-row input{width:66px;padding:5px 7px;border:1px solid #d9e3f2;border-radius:6px;color:var(--ink);background:#fff;font-size:11px}.config-row input:disabled{background:#f3f6fb;color:var(--muted)}.config-note{font-size:10px;color:var(--muted);margin:9px 0 0;line-height:1.7}.config-error{font-size:10px;color:#ac4d32;margin:7px 0 0}.config-error:empty{display:none}.configuration .text-button{margin-top:5px}
        .empty-state{text-align:center;padding:16px 6px 20px}.empty-symbol{width:35px;height:35px;display:grid;place-items:center;border-radius:8px;background:#edf3ff;color:var(--blue);margin:0 auto 12px}.empty-state strong{font-size:14px}.empty-state p{font-size:11px;color:var(--muted);margin:6px 0 0}.empty-refresh{display:inline-block;margin-top:12px;background:#edf3ff;color:var(--blue-dark);padding:6px 12px;border-radius:7px;font-size:11px}
        .task-step,.next-link,.queue-link{background:transparent;border:0;text-align:left}.queue-link{width:100%}.next-link{padding:0}.task-step:disabled,.next-link:disabled{opacity:1}.footer-info{display:flex;align-items:center;gap:8px}.build{font-size:9px;color:var(--muted)}
        .settings-section{padding:13px 0;border-top:1px solid var(--line)}.settings-section h3{font-size:12px;font-weight:600;margin:0 0 9px}.settings-section h3 small{font-size:10px;font-weight:400;color:var(--muted);margin-left:7px}.setting-copy{display:flex;flex-direction:column;gap:2px}.setting-copy small{font-size:10px;color:var(--muted);font-weight:400}.duration-intro{font-size:10px;color:var(--muted);line-height:1.7;margin:0 0 12px}.minute-input{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:10px}.minute-input input{width:65px}.item-override{border-left:2px solid #b9d0fa;margin-top:12px;padding:1px 0 0 10px}.item-name{font-size:10px;color:#536987;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;margin-bottom:5px}.item-override .config-row{margin-top:5px}.settings-section .options{padding:0;gap:13px}.settings-save-note{border-top:1px solid var(--line);padding-top:10px;color:var(--muted);font-size:10px;line-height:1.7}.settings-save-note strong{font-weight:400;color:#42689f;display:block}
        .learning-mode{margin:0 0 13px}.learning-mode .mode-switch button{font-size:12px}.learning-mode .mode-note{line-height:1.7;margin:6px 1px 0}.settings-title{font-size:13px;margin:0 0 4px;font-weight:600}.settings-context{color:var(--muted);font-size:10px;line-height:1.7;margin:0 0 12px}.footer{justify-content:flex-end;border:0;padding:4px 0 8px}.settings-section[data-single="true"] .item-override{border:0;margin:0;padding:0}
        .neighbors{display:grid;gap:7px;margin-top:12px}.neighbor{display:flex;align-items:center;gap:9px;width:100%;min-height:37px;padding:9px 11px;background:#f2f6fd;border:0;border-radius:7px;text-align:left;color:#405b86}.neighbor:hover:not(:disabled){background:#e6efff}.neighbor-label{font-size:10px;color:var(--muted);white-space:nowrap;flex:none}.neighbor-name{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}.neighbor:disabled{opacity:1;cursor:default;background:#f8f9fc;color:#8a97ac}
        @media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}@media(max-width:380px){.shell{width:calc(100vw - 24px)}.history{flex-wrap:wrap}.history small{white-space:normal}.tabs{gap:22px}}
    </style>
    <button class="launcher" data-launcher aria-label="展开学习助手" aria-expanded="false" aria-controls="xy-helper-panel" title="点击展开；拖动移动"><span data-launcher-icon data-icon="assistant">${icons.assistant}</span><i class="signal" aria-hidden="true"></i></button>
    <div class="shell" id="xy-helper-panel" data-running="false">
        <header class="head" data-drag title="拖动可移动面板"><div class="mark" aria-hidden="true">${icons.assistant}</div><strong>学习助手</strong><span class="badge"><i class="dot"></i><span data-state>未开始</span></span><button class="icon-button" data-collapse aria-label="收起面板" aria-expanded="true">${icons.collapse}</button></header>
        <div class="course" data-course-header><small>当前课程</small><strong data-course-name>正在确认登录状态…</strong></div>
        <nav class="tabs" data-tabs role="tablist" aria-label="助手页面"><button class="tab" id="xy-tab-learning" data-tab="learning" role="tab" aria-selected="true" aria-controls="xy-view-learning">学习</button><button class="tab" id="xy-tab-list" data-tab="list" role="tab" aria-selected="false" aria-controls="xy-view-list" title="查看本课程全部学习任务">全部<span class="tab-count" data-list-total></span></button><button class="tab" id="xy-tab-settings" data-tab="settings" role="tab" aria-selected="false" aria-controls="xy-view-settings">设置</button></nav>
        <div class="body">
            <div class="notice" data-status role="status" aria-live="polite"></div>
            <section class="view" data-view="learning" id="xy-view-learning" role="tabpanel" aria-labelledby="xy-tab-learning">
                <div class="empty-state" data-empty-state hidden><div class="empty-symbol" aria-hidden="true">${icons.play}</div><strong data-empty-title>请先登录</strong><p data-empty-description>登录完成后，助手会自动识别课程。</p><button class="empty-refresh" data-empty-retry>重新检测</button></div>
                <div data-study-content>
                    <div class="learning-mode"><div class="mode-switch" role="group" aria-label="学习模式"><button data-learning-mode="single" aria-pressed="false">单项学习</button><button data-learning-mode="continuous" aria-pressed="true">连续学习</button></div><p class="mode-note" data-mode-note></p></div>
                    <div class="task"><div class="track-top"><span>当前任务</span><span class="track-number" data-index>— / —</span></div>
                    <div class="task-meta"><span class="task-kind" data-kind>视频</span><span class="completion" data-completion>待检测</span></div>
                    <div class="title" data-title>准备好，开始这一节</div>
                    <div data-timeline><div class="time"><span data-elapsed>00:00</span><span>/</span><span data-duration>00:00</span><span class="progress-percent" data-percent>0%</span></div><progress data-progress max="100" value="0" aria-label="当前任务进度"></progress></div>
                    </div>
                    <div class="actions" role="group" aria-label="当前资源学习控制"><button class="primary" data-start><span class="action-icon" data-action-icon>${icons.play}</span><span data-action-label>开始学习</span></button><button class="stop" data-stop aria-label="停止本次学习" title="停止本次学习">${icons.stop}<span>停止</span></button></div>
                    <nav class="neighbors" data-neighbors aria-label="切换学习任务"><button type="button" class="neighbor" data-step="previous" aria-disabled="true" disabled><span class="neighbor-label" data-step-label>上一项</span><span class="neighbor-name" data-step-name>已是第一项</span></button><button type="button" class="neighbor" data-step="next" data-next-link aria-disabled="true" disabled><span class="neighbor-label" data-step-label>下一项</span><span class="neighbor-name" data-step-name>已是最后一项</span></button></nav>
                    <div class="history"><span>已学习时长</span><strong data-history>—</strong><small data-history-note>历史统计 · 次日更新</small></div>
                </div>
            </section>
            <section class="view" data-view="list" id="xy-view-list" role="tabpanel" aria-labelledby="xy-tab-list" hidden>
                <div class="list-tools"><input class="search" data-search type="search" placeholder="搜索课程资料" aria-label="搜索课程资料"><button class="refresh" data-refresh title="重新检测课程和学习状态" aria-label="刷新完成状态">${icons.refresh}</button></div>
                <div class="filters" role="group" aria-label="筛选完成状态"><button class="filter" data-filter="all" aria-pressed="true">全部</button><button class="filter" data-filter="unfinished" aria-pressed="false">待完成</button><button class="filter" data-filter="completed" aria-pressed="false">已完成</button></div>
                <div class="list-meta"><span data-summary>完成状态以平台记录为准</span><button class="text-button" data-locate>定位当前</button></div>
                <ol class="queue" data-list aria-label="课程学习列表"></ol><div class="cache-note" data-cache></div>
            </section>
            <section class="view" data-view="settings" id="xy-view-settings" role="tabpanel" aria-labelledby="xy-tab-settings" hidden>
                <h2 class="settings-title">学习设置</h2><p class="settings-context" data-settings-context></p>
                <section class="settings-section" data-continuous-settings aria-labelledby="xy-continuous-heading"><h3 id="xy-continuous-heading">连续学习</h3><label class="option skip"><span>跳过已完成任务</span><input type="checkbox" data-skip aria-label="连续学习时跳过已完成任务"></label></section>
                <section class="settings-section configuration" data-configuration aria-labelledby="xy-duration-heading"><h3 id="xy-duration-heading">非视频停留时间</h3><p class="duration-intro" data-duration-intro></p><label class="config-row" data-default-settings><span>默认停留</span><span class="minute-input"><input data-default-minutes type="number" min="2" max="1440" step="1" value="2" aria-label="本课程非视频默认停留时间，分钟"><span>分钟</span></span></label><div class="item-override" data-item-settings hidden><div class="item-name" data-item-name></div><label class="config-row"><span>本项停留</span><span class="minute-input"><input data-resource-minutes type="number" min="2" max="1440" step="1" placeholder="默认" aria-label="当前非视频任务单独停留时间，分钟"><span>分钟</span></span></label><button class="text-button" data-reset-resource>恢复课程默认</button></div><p class="config-note" data-config-note></p><p class="config-error" data-config-error role="status"></p></section>
                <section class="settings-section" aria-labelledby="xy-playback-heading"><h3 id="xy-playback-heading">播放偏好<small>通用</small></h3><div class="options"><label class="option"><span>静音播放</span><input type="checkbox" data-mute aria-label="静音播放"></label><label class="option"><span class="setting-copy"><span>后台继续</span><small>切换标签页后继续学习</small></span><input type="checkbox" data-background aria-label="切换标签页后继续学习"></label></div></section>
                <div class="settings-save-note"><strong>修改后自动保存</strong><span data-settings-save-note></span></div>
            </section>
        </div>
        <footer class="footer" data-footer><span class="build" data-version>v${VERSION}</span></footer>
    </div>`;
    document.body.appendChild(panel);
    const find = selector => ui.querySelector(selector);
    const shell = find('.shell');
    const launcher = find('[data-launcher]');
    const status = find('[data-status]');
    const list = find('[data-list]');
    const muteInput = find('[data-mute]');
    const backgroundInput = find('[data-background]');
    const skipInput = find('[data-skip]');
    const startButton = find('[data-start]');
    const stopButton = find('[data-stop]');
    const collapseButton = find('[data-collapse]');
    muteInput.checked = muted;
    backgroundInput.checked = background;
    skipInput.checked = skipCompleted;
    function contextMessage() {
        if (auth.state === 'checking') return '正在确认登录状态…';
        if (auth.state === 'signedOut') return auth.message || '请先登录';
        if (auth.state === 'error') return '无法确认登录状态，请检查网络并点击刷新重试。';
        if (!route()) return '请选择课程';
        if (courseInfo.state === 'loading') return '正在读取课程信息…';
        if (courseInfo.state === 'forbidden') return '当前账号无权访问此课程。';
        if (courseInfo.state === 'error') return '课程信息读取失败，请点击刷新重试。';
        if (directoryIssue && !queue.length) return directoryIssue;
        if (!route()?.node) return loading ? '正在检测本课程的学习资料…' : settings.mode === 'single' ? '请选择学习资料' : '请选择学习资料，或点击“开始连续学习”。';
        return '';
    }
    function report(message) {
        status.textContent = contextMessage() || (navigation ? `跳转中：${navigation.name || '正在打开视频'}` : message);
        updateNotice();
    }
    function updateNotice() {
        const message = status.textContent || '';
        const attention = /失败|无权|过期|超时|待确认|手动点击|未找到|未确认/.test(message);
        status.hidden = !message || !attention && (['playing', 'reading', 'paused'].includes(viewMode()) || auth.state === 'signedOut' || !route());
        status.dataset.tone = /失败|无权|超时/.test(message) ? 'error' : attention ? 'warning' : 'info';
    }
    function persist() {
        try { sessionStorage.setItem(storageKey, JSON.stringify({ course: activeCourse, accountId: auth.id, running, userPaused, navigation, muted, background, skipCompleted, collapsed, position, activeTab })); } catch { /* 页面仍可使用 */ }
        try { localStorage.setItem('xy-learning-preferences-v1', JSON.stringify({ muted, background, position })); } catch { /* 本页偏好仍有效 */ }
    }
    function formatTime(seconds) {
        if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
        const whole = Math.floor(seconds), minutes = Math.floor(whole / 60);
        return `${String(minutes).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
    }
    function viewMode() {
        if (auth.state === 'checking') return 'authChecking';
        if (auth.state === 'signedOut') return 'signedOut';
        if (auth.state === 'error') return 'authError';
        if (!route()) return 'selectCourse';
        if (courseInfo.state === 'loading') return 'courseLoading';
        if (['error', 'forbidden'].includes(courseInfo.state)) return 'courseError';
        if (navigation) return 'jumping';
        const node = currentNode();
        if (sessionEnded) return 'ended';
        if (!node && settings.mode === 'single' && !loading) return 'selectResource';
        if (running && (nextTimer || advancing || video?.ended)) return 'next';
        if (loading && !queue.length) return 'loading';
        if (node && !isVideo(node)) {
            if (running) return documentClock?.ready ? 'reading' : 'loading';
            return userPaused ? 'paused' : 'stopped';
        }
        if (running && (!video || video.readyState < 2 || playPending)) return 'loading';
        if (video && !video.paused && !video.ended) return 'playing';
        if (running || userPaused) return 'paused';
        return 'stopped';
    }
    function setIcon(element, name) {
        if (element.dataset.icon === name) return;
        element.dataset.icon = name;
        element.innerHTML = icons[name];
    }
    function updateView() {
        const current = route();
        const index = queue.findIndex(node => String(node.id) === current?.node);
        const node = queue[index];
        const timed = !!node && !isVideo(node);
        const confirmed = auth.state === 'ready' && !!current;
        find('[data-course-name]').textContent = auth.state === 'checking' ? '正在确认登录状态…'
            : auth.state === 'signedOut' ? '请先登录' : auth.state === 'error' ? '登录状态未确认'
            : !current ? '请选择课程' : courseInfo.name || (courseInfo.state === 'loading' ? '正在读取课程…' : '课程信息读取失败');
        find('[data-course-name]').title = find('[data-course-name]').textContent;
        find('[data-course-header]').hidden = !confirmed;
        find('[data-tabs]').hidden = !confirmed;
        find('[data-footer]').hidden = !confirmed;
        find('[data-study-content]').hidden = !confirmed;
        find('[data-empty-state]').hidden = confirmed;
        if (!confirmed) {
            find('[data-empty-title]').textContent = auth.state === 'checking' ? '正在确认登录状态' : auth.state === 'signedOut' ? '请先登录' : auth.state === 'error' ? '连接暂时不可用' : '请选择课程';
            find('[data-empty-description]').textContent = auth.state === 'signedOut' ? '登录完成后，助手会自动识别课程。' : auth.state === 'error' ? '检查网络连接后，点击重新检测。' : auth.state === 'checking' ? '请稍候，正在连接学习平台。' : '进入课程后，自动检测视频和自主观看资料。';
            find('[data-empty-retry]').hidden = !['error', 'signedOut'].includes(auth.state);
            if (activeTab !== 'learning') setTab('learning', false);
        }
        find('[data-title]').textContent = navigation?.name || node?.name || (confirmed ? '请选择学习资料' : auth.state === 'signedOut' ? '请先登录' : '请选择课程');
        find('[data-kind]').textContent = node ? timed ? `${resourceKind(node)} · 停留 ${targetDocumentMs(node) / 60000} 分钟` : '视频' : '待选择';
        find('[data-index]').textContent = index >= 0 ? `${String(index + 1).padStart(2, '0')} / ${String(queue.length).padStart(2, '0')}` : '— / —';
        const elapsed = timed ? (documentClock?.elapsedMs || 0) / 1000 : video?.currentTime;
        const duration = timed ? targetDocumentMs(node) / 1000 : video?.duration;
        find('[data-elapsed]').textContent = formatTime(elapsed);
        find('[data-duration]').textContent = formatTime(duration);
        find('[data-progress]').value = Number.isFinite(duration) && duration > 0 ? Math.min(100, Math.max(0, elapsed / duration * 100)) : 0;
        find('[data-percent]').textContent = `${Math.floor(find('[data-progress]').value)}%`;
        find('[data-timeline]').hidden = !node;
        find('[data-list-total]').textContent = queue.length ? String(queue.length) : '';
        find('[data-history]').textContent = history.minutes == null ? history.error ? '读取失败' : '—' : `${Number(history.minutes.toFixed(1))} 分钟`;
        find('[data-history-note]').textContent = historyBusy ? '正在读取历史统计' : history.error ? '历史统计读取失败，可刷新重试' : '历史统计 · 次日更新';
        find('.history').dataset.error = String(history.error);
        find('[data-cache]').textContent = cacheAt ? `更新于 ${new Date(cacheAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : loading ? '正在检测课程资料…' : '';
        find('[data-cache]').title = '课程列表使用本地缓存；点击刷新可重新检测。学习时长为平台历史统计。';
        const state = completions.get(current?.node);
        find('[data-completion]').textContent = completionLabel(state);
        find('[data-completion]').classList.toggle('done', state?.complete === true);
        find('[data-refresh]').disabled = completionBusy || loading || historyBusy;
        const done = queue.filter(node => completions.get(String(node.id))?.complete === true).length;
        const unknown = queue.filter(node => completions.get(String(node.id))?.complete == null).length;
        find('[data-summary]').textContent = queue.length ? `已完成 ${done} / ${queue.length}${unknown ? ` · ${unknown} 项待确认` : ''}${completionBusy ? ' · 检测中' : ''}` : '完成状态以平台记录为准';
        shell.dataset.running = String(running);
        const mode = viewMode();
        const states = { jumping: ['跳转中', '跳转中', 'loading'], loading: ['加载中', '加载中', 'loading'],
            next: ['即将切换', '即将切换', 'loading'], playing: [document.hidden ? '后台播放' : '播放中', '暂停学习', 'pause'],
            reading: ['阅读中', '暂停学习', 'pause'], paused: ['已暂停', '继续学习', 'play'],
            stopped: ['已停止', settings.mode === 'single' ? '开始当前项' : '开始连续学习', 'play'], ended: ['本次已结束', '重新开始', 'play'],
            authChecking: ['确认登录', '确认登录中', 'loading'], signedOut: ['未登录', '请先登录', 'play'],
            authError: ['连接失败', '请刷新重试', 'play'], selectCourse: ['未选择课程', '请选择课程', 'play'],
            courseLoading: ['读取课程', '正在读取课程', 'loading'], courseError: ['课程不可用', '请刷新重试', 'play'],
            selectResource: ['未选择资料', '请选择学习资料', 'play'] };
        const [stateText, actionText, icon] = states[mode];
        shell.dataset.mode = mode;
        launcher.dataset.mode = mode;
        find('[data-state]').textContent = stateText;
        startButton.disabled = ['jumping', 'loading', 'next', 'authChecking', 'signedOut', 'authError', 'selectCourse', 'courseLoading', 'courseError', 'selectResource'].includes(mode);
        startButton.dataset.action = ['playing', 'reading'].includes(mode) ? 'pause' : 'play';
        startButton.setAttribute('aria-label', actionText);
        find('[data-action-label]').textContent = actionText;
        setIcon(find('[data-action-icon]'), icon);
        for (const currentIcon of list.querySelectorAll('[data-current-icon]')) setIcon(currentIcon, ['playing', 'reading'].includes(mode) ? 'pause' : 'play');
        launcher.title = `${stateText}；点击${collapsed ? '展开' : '收起'}；拖动移动`;
        if (navigation || contextMessage()) report('');
        updateNotice();
        stopButton.disabled = !running && !userPaused && !navigation;
        find('[data-refresh]').disabled = auth.state === 'checking' || authBusy || completionBusy || loading || historyBusy || courseInfoBusy;
        const configDisabled = !confirmed || courseInfo.state !== 'ready' || ['jumping', 'next'].includes(mode);
        for (const button of ui.querySelectorAll('[data-learning-mode]')) {
            button.disabled = configDisabled;
            button.setAttribute('aria-pressed', String(button.dataset.learningMode === settings.mode));
        }
        find('[data-default-minutes]').disabled = configDisabled;
        find('[data-resource-minutes]').disabled = configDisabled;
        find('[data-reset-resource]').disabled = configDisabled;
        const continuous = settings.mode === 'continuous';
        const hasNonVideo = queue.some(item => !isVideo(item));
        const hasVideo = queue.some(isVideo);
        find('[data-continuous-settings]').hidden = !continuous;
        find('[data-configuration]').hidden = continuous ? !hasNonVideo : !timed;
        find('[data-configuration]').dataset.single = String(!continuous);
        find('[data-default-settings]').hidden = !continuous;
        find('[data-item-settings]').hidden = !timed;
        find('[data-item-name]').textContent = timed ? `当前任务：${node.name || resourceKind(node)}` : '';
        find('[data-item-name]').title = find('[data-item-name]').textContent;
        find('[data-reset-resource]').textContent = `使用课程默认（${settings.documentMinutes} 分钟）`;
        find('[data-duration-intro]').textContent = continuous ? '用于本课程的 PPT、PDF 等自主观看任务。视频按自身时长播放。' : '仅设置当前非视频任务，课程默认时间不会被修改。';
        muteInput.closest('.option').hidden = continuous ? !hasVideo : !node || timed;
        skipInput.disabled = configDisabled || settings.mode === 'single';
        find('[data-config-note]').textContent = timed ? `本项${settings.resourceMinutes[String(node.id)] != null ? '单独设置' : '跟随默认'}：${targetDocumentMs(node) / 60000} 分钟。调整时保留已停留时间。`
            : '默认时间应用于本课程的非视频任务，打开任务后可单独调整。';
        find('[data-settings-context]').textContent = continuous ? '当前为连续学习，以下设置用于本课程的学习列表。'
            : !node ? '先在“全部”中选择一项，再显示对应的任务设置。' : `当前为单项学习，仅显示${timed ? '此非视频任务' : '此视频'}适用的选项。`;
        find('[data-settings-save-note]').textContent = continuous ? '课程学习选项按当前账号保存，播放偏好通用。'
            : timed ? '本项停留按任务保存，播放偏好通用。' : '播放偏好在各课程间通用。';
        find('[data-mode-note]').textContent = !node ? continuous ? '按课程顺序连续学习，可在“设置”中调整规则。' : '先在“全部”中选择一项，结束后停止。'
            : timed ? `本项停留 ${targetDocumentMs(node) / 60000} 分钟后${continuous ? '自动学习下一项。' : '停止本次学习。'}`
                : continuous ? '当前视频结束后，自动学习下一项。' : '只学当前视频，播放结束后停止。';
        find('[data-locate]').disabled = !node;
        const canNavigate = confirmed && courseInfo.state === 'ready' && !navigation;
        const next = index >= 0 ? queue[index + 1] : queue[0];
        find('[data-neighbors]').hidden = !confirmed || !queue.length;
        for (const step of ui.querySelectorAll('[data-step]')) {
            const previous = step.dataset.step === 'previous';
            const target = previous ? index > 0 ? queue[index - 1] : null : next;
            const label = previous ? '上一项' : index < 0 ? '第一项' : '下一项';
            const name = target ? target.name || String(target.id) : previous ? index < 0 ? '请先选择任务' : '已是第一项' : '已是最后一项';
            const enabled = canNavigate && !!target;
            step.disabled = !enabled;
            step.setAttribute('aria-disabled', String(!enabled));
            step.tabIndex = enabled ? 0 : -1;
            step.querySelector('[data-step-label]').textContent = label;
            step.querySelector('[data-step-name]').textContent = name;
            step.title = `${label}：${name}`;
            step.setAttribute('aria-label', step.title);
            if (enabled) step.dataset.targetNode = String(target.id);
            else delete step.dataset.targetNode;
        }
    }
    function setTab(name, save = true) {
        if (!['learning', 'list', 'settings'].includes(name)) return;
        activeTab = name;
        for (const tab of ui.querySelectorAll('[data-tab]')) {
            const selected = tab.dataset.tab === name;
            tab.setAttribute('aria-selected', String(selected));
            tab.tabIndex = selected ? 0 : -1;
        }
        for (const view of ui.querySelectorAll('[data-view]')) view.hidden = view.dataset.view !== name;
        const confirmed = auth.state === 'ready' && !!route();
        find('[data-tabs]').hidden = !confirmed;
        find('[data-footer]').hidden = !confirmed;
        if (save) persist();
        place();
    }
    function syncSettingsInputs() {
        find('[data-default-minutes]').value = String(settings.documentMinutes);
        const node = currentNode();
        find('[data-resource-minutes]').value = node && settings.resourceMinutes[String(node.id)] != null ? String(settings.resourceMinutes[String(node.id)]) : '';
        skipInput.checked = settings.skipCompleted;
    }
    function clampPosition(x, y) {
        return { x: Math.max(12, Math.min(x, Math.max(12, innerWidth - 60))),
            y: Math.max(12, Math.min(y, Math.max(12, innerHeight - 60))) };
    }
    function place() {
        if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
            position = { x: innerWidth - 72, y: innerHeight * 0.12 };
        }
        position = clampPosition(position.x, position.y);
        Object.assign(panel.style, { left: `${position.x}px`, top: `${position.y}px`, right: 'auto', bottom: 'auto' });
        const bounds = shell.getBoundingClientRect();
        const width = bounds.width || Math.min(352, Math.max(0, innerWidth - 24));
        const height = bounds.height || 480;
        const preferredX = position.x < innerWidth / 2 ? position.x + 60 : position.x - width - 12;
        const x = Math.max(12, Math.min(preferredX, innerWidth - width - 12));
        const y = Math.max(12, Math.min(position.y, innerHeight - height - 12));
        shell.style.left = `${x - position.x}px`;
        shell.style.top = `${y - position.y}px`;
    }
    function setCollapsed() {
        shell.hidden = collapsed;
        collapseButton.innerHTML = icons.collapse;
        collapseButton.setAttribute('aria-expanded', String(!collapsed));
        collapseButton.setAttribute('aria-label', collapsed ? '展开面板' : '收起面板');
        launcher.setAttribute('aria-expanded', String(!collapsed));
        launcher.setAttribute('aria-label', collapsed ? '展开学习助手' : '收起学习助手');
        place();
    }
    let drag = null, suppressLauncherClick = false;
    const dragHandle = find('[data-drag]');
    for (const handle of [launcher, dragHandle]) {
        handle.addEventListener('pointerdown', event => {
            if (event.button !== 0 || handle !== launcher && event.target.closest('button')) return;
            drag = { startX: event.clientX, startY: event.clientY, x: position.x, y: position.y, moved: false };
            suppressLauncherClick = false;
            handle.setPointerCapture?.(event.pointerId);
        });
        handle.addEventListener('pointermove', event => {
            if (!drag) return;
            const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
            if (Math.hypot(dx, dy) <= 5 && !drag.moved) return;
            drag.moved = true;
            position = clampPosition(drag.x + dx, drag.y + dy);
            place();
        });
        handle.addEventListener('pointerup', () => {
            if (!drag) return;
            suppressLauncherClick = handle === launcher && drag.moved;
            drag = null;
            persist();
        });
        handle.addEventListener('pointercancel', () => { drag = null; suppressLauncherClick = false; });
    }
    window.addEventListener('resize', place);
    if (typeof ResizeObserver === 'function') {
        const panelSizeObserver = new ResizeObserver(() => { if (!collapsed) place(); });
        panelSizeObserver.observe(shell);
    }
    setCollapsed();
    function route() {
        const course = location.pathname.match(/^\/app\/jx-web\/mycourse\/(\d+)(?:\/|$)/);
        if (!course) return null;
        const resource = location.pathname.match(/\/resource\/([^/]+)\/(\d+)\/?$/);
        return { course: course[1], folder: resource?.[1] || null, node: resource?.[2] || null };
    }
    function currentNode() {
        const current = route();
        return current?.course === queueCourse ? queue.find(node => String(node.id) === current.node) : null;
    }
    function updateDocumentClock(active) {
        if (!documentClock) return;
        const now = Date.now();
        if (active && documentClock.lastAt != null) {
            documentClock.elapsedMs += Math.max(0, now - documentClock.lastAt);
        }
        documentClock.lastAt = active ? now : null;
    }
    function processDocument() {
        const current = route(), node = currentNode();
        if (!node || isVideo(node)) return;
        if (!documentClock || documentClock.node !== current.node || documentClock.course !== current.course) {
            documentClock = { course: current.course, node: current.node, elapsedMs: 0, lastAt: null, ready: false };
        }
        const body = document.querySelector('.group-resource-body .group-resource-content');
        const failure = body && [...body.querySelectorAll('.ant-result-error, .resource-error, [data-preview-error="true"]')].find(visible);
        if (failure) {
            updateDocumentClock(false);
            resourceFailure = '资料预览失败，请在平台页面处理后重新开始。';
            stop(resourceFailure);
            return;
        }
        documentClock.ready = !!body && !body.querySelector('[aria-busy="true"], .ant-spin-spinning');
        const active = running && documentClock.ready && !navigation && !hasOpenDialog() && (background || !document.hidden);
        updateDocumentClock(active);
        if (active) {
            report(`正在阅读${resourceKind(node)}，停留 ${targetDocumentMs(node) / 60000} 分钟后${settings.mode === 'single' ? '结束本次学习' : '切换下一项'}。`);
            if (documentClock.elapsedMs >= targetDocumentMs(node)) scheduleResourceNext(current.node, null, 0);
        }
        if (navigation && documentClock.ready) finishNavigation();
        updateView();
    }
    function visible(element) {
        return element && element.isConnected && element.getClientRects().length > 0 &&
            getComputedStyle(element).visibility !== 'hidden';
    }
    function detachVideo() {
        if (video) {
            video.removeEventListener('ended', endedListener);
            for (const event of ['loadedmetadata', 'loadeddata', 'canplay', 'seeked']) video.removeEventListener(event, readyListener);
            video.removeEventListener('pause', pauseListener);
            video.removeEventListener('play', playListener);
        }
        video = null;
        playPending = false;
        waitingForVideoReady = false;
        backgroundIntent = false;
        clearTimeout(backgroundTimer);
        backgroundTimer = null;
    }
    function stop(message = '已停止', paused = false, ended = false) {
        updateDocumentClock(running);
        if (documentClock) documentClock.lastAt = null;
        running = false;
        userPaused = paused;
        sessionEnded = ended;
        navigation = null;
        outgoingVideo = null;
        generation++;
        loading = false;
        clearTimeout(nextTimer);
        nextTimer = null;
        advancing = false;
        clearTimeout(backgroundTimer);
        backgroundTimer = null;
        backgroundIntent = false;
        resumeAfterDialog = false;
        if (video && !video.paused) video.pause();
        persist();
        report(message);
        updateView();
    }
    function beginNavigation(node, course) {
        updateDocumentClock(running);
        if (documentClock) documentClock.lastAt = null;
        sessionEnded = false;
        resourceFailure = '';
        navigation = { course, node: String(node.id), name: node.name || '', fromNode: route()?.node, startedAt: Date.now() };
        outgoingVideo = video;
        outgoingSource = video?.currentSrc || '';
        generation++;
        loading = false;
        clearTimeout(nextTimer);
        nextTimer = null;
        advancing = false;
        backgroundIntent = false;
        if (video && !video.paused) video.pause();
        detachVideo();
        setTab('learning', false);
        persist();
        report('');
        updateView();
    }
    function finishNavigation() {
        if (!navigation) return;
        navigation = null;
        outgoingVideo = null;
        outgoingSource = '';
        persist();
        report(running ? '正在准备学习…' : '已打开资料，点击主按钮即可开始学习。');
    }
    function openResourceFromClick(event, node, course) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!node || event.button !== 0) return;
        if (route()?.course === course && route()?.node === String(node.id)) return;
        // Task controls are buttons: no native link default or modifier-key new-tab behavior.
        // Persist playback intent before explicitly navigating this browsing context.
        const destination = resourcePath(course, node);
        beginNavigation(node, course);
        location.assign(destination);
    }
    function filteredQueue() {
        const term = queueSearch.normalize('NFKC').trim().toLocaleLowerCase();
        return queue.filter(node => {
            const done = completions.get(String(node.id))?.complete === true;
            return (queueFilter === 'all' || (queueFilter === 'completed' ? done : !done)) &&
                (!term || String(node.name || node.id).normalize('NFKC').toLocaleLowerCase().includes(term));
        });
    }
    function showQueue() {
        const previousScroll = list.scrollTop;
        list.replaceChildren();
        const current = route()?.node;
        const nodes = filteredQueue();
        if (!nodes.length) {
            const empty = document.createElement('li');
            empty.className = 'queue-empty';
            empty.textContent = queue.length ? queueSearch ? '没有找到匹配的资料' : '当前筛选下没有资料' :
                auth.state !== 'ready' ? '登录后显示学习资料' : !route() ? '选择课程后自动检测学习资料'
                    : loading ? '正在读取课程…' : directoryIssue || '当前课程暂未检测到视频或自主观看资料';
            list.appendChild(empty);
        }
        for (const node of nodes) {
            const number = queue.indexOf(node);
            const item = document.createElement('li');
            const link = document.createElement('button');
            link.type = 'button';
            link.className = 'queue-link';
            link.dataset.node = String(node.id);
            const currentItem = String(node.id) === current;
            item.classList.toggle('current', currentItem);
            if (currentItem) link.setAttribute('aria-current', 'page');
            const numberLabel = document.createElement('span');
            numberLabel.className = 'num';
            if (currentItem) { numberLabel.dataset.currentIcon = ''; setIcon(numberLabel, ['playing', 'reading'].includes(viewMode()) ? 'pause' : 'play'); }
            else numberLabel.textContent = String(number + 1).padStart(2, '0');
            const title = document.createElement('span');
            title.className = 'name';
            title.textContent = node.name || node.id;
            title.title = title.textContent;
            const badge = document.createElement('span');
            badge.className = 'completion';
            badge.dataset.completionFor = String(node.id);
            const kind = document.createElement('span');
            kind.className = 'kind';
            kind.textContent = resourceKind(node);
            link.append(numberLabel, kind, title, badge);
            link.onclick = event => openResourceFromClick(event, node, queueCourse);
            item.appendChild(link);
            list.appendChild(item);
        }
        list.scrollTop = previousScroll;
        updateCompletionBadges(false);
        place();
    }
    function updateCompletionBadges(reconcile = true) {
        if (reconcile) {
            const expected = filteredQueue().map(node => String(node.id)).join(',');
            const rendered = [...list.querySelectorAll('[data-node]')].map(link => link.dataset.node).join(',');
            if (expected !== rendered) { showQueue(); return; }
        }
        for (const badge of list.querySelectorAll('[data-completion-for]')) {
            const state = completions.get(badge.dataset.completionFor);
            badge.textContent = completionLabel(state);
            badge.classList.toggle('done', state?.complete === true);
            badge.title = state?.error ? '状态读取失败，点击“刷新状态”重试' : state?.hasTask
                ? '任务完成状态以平台返回的 finished 字段为准'
                : '根据平台已记录的观看时长计算';
        }
        updateView();
    }
    function resetCourseContext(course) {
        updateDocumentClock(running);
        documentClock = null;
        if (video && !video.paused) video.pause();
        detachVideo();
        generation++;
        courseEpoch++;
        completionEpoch++;
        observedCourse = course;
        queue = [];
        queueSearch = '';
        queueFilter = 'all';
        find('[data-search]').value = '';
        for (const filter of ui.querySelectorAll('[data-filter]')) filter.setAttribute('aria-pressed', String(filter.dataset.filter === 'all'));
        list.scrollTop = 0;
        queueCourse = course || '';
        routeKey = '';
        cacheAt = 0;
        loading = false;
        completionBusy = false;
        historyBusy = false;
        courseInfoBusy = false;
        history = { minutes: null, fetchedAt: 0, error: false };
        courseInfo = { name: '', state: course ? 'loading' : 'none', fetchedAt: 0 };
        directoryCheckedAt = 0;
        currentCheckAt = 0;
        directoryIssue = '';
        resourceFailure = '';
        sessionEnded = false;
        userPaused = false;
        completions.clear();
        if (course && auth.state === 'ready') loadSettings(course);
        else { settings = normalizeSettings(); skipCompleted = false; syncSettingsInputs(); }
        showQueue();
    }
    function invalidateAuthentication(message = '登录已过期，请先登录') {
        authEpoch++;
        auth = { state: 'signedOut', id: null, message, checkedAt: Date.now() };
        authBusy = false;
        if (!loginNoticeShown) {
            loginNoticeShown = true;
            collapsed = false;
            setCollapsed();
        }
        stop(message);
        resetCourseContext(null);
        updateView();
    }
    async function verifyAuthentication(force = false) {
        if (loginSurface) { invalidateAuthentication('请先登录'); return; }
        if (authBusy) return;
        const scope = tokenScope();
        if (!scope) { invalidateAuthentication('请先登录'); cacheScope = null; return; }
        if (!force && auth.state === 'ready' && scope === cacheScope && Date.now() - auth.checkedAt < 5 * 60000) return;
        const epoch = ++authEpoch;
        authBusy = true;
        if (auth.state !== 'ready') auth = { state: 'checking', id: null, message: '', checkedAt: Date.now() };
        updateView();
        try {
            const account = await readApi('/api/jx-auth/oauth2/info');
            if (epoch !== authEpoch || scope !== tokenScope()) return;
            if (account?.info?.id == null) throw Object.assign(new Error('请先登录'), { status: 401 });
            cacheScope = scope;
            auth = { state: 'ready', id: String(account.info.id), message: '', checkedAt: Date.now() };
            if (saved.accountId && String(saved.accountId) !== auth.id) stop('账号已切换，请选择课程后重新开始。');
        } catch (error) {
            if (epoch !== authEpoch) return;
            if (error.status === 401) invalidateAuthentication('登录已过期，请先登录');
            else {
                auth = { state: 'error', id: null, message: error.message, checkedAt: Date.now() };
                stop('无法确认登录状态，请点击刷新重试。');
                resetCourseContext(null);
            }
        } finally {
            if (epoch === authEpoch) authBusy = false;
            if (auth.state === 'ready') tick();
            else updateView();
        }
    }
    async function loadCourseInfo(course, force = false) {
        if (courseInfoBusy) return;
        const epoch = courseEpoch;
        const cached = readCache(course)?.courseInfo;
        if (!force && cached?.name) {
            courseInfo = { ...cached, state: 'ready' };
            if (Date.now() - cached.fetchedAt < QUEUE_TTL) { updateView(); return; }
        }
        courseInfoBusy = true;
        try {
            const data = await readApi(`/api/jx-iresource/group/queryGroup/${encodeURIComponent(course)}`);
            if (epoch !== courseEpoch) return;
            const name = data?.name || data?.group?.name || data?.site_name;
            if (typeof name !== 'string' || !name.trim() || data?.id != null && String(data.id) !== course) throw new Error('课程信息格式异常');
            courseInfo = { name: name.trim(), state: 'ready', fetchedAt: Date.now() };
            writeCache();
        } catch (error) {
            if (epoch !== courseEpoch) return;
            if (error.status === 403) courseInfo = { name: '', state: 'forbidden', fetchedAt: 0 };
            else if (!courseInfo.name) courseInfo = { name: '', state: 'error', fetchedAt: 0 };
            if (running) stop('课程信息读取失败，本次学习已停止。');
        } finally {
            if (epoch === courseEpoch) { courseInfoBusy = false; updateView(); place(); }
        }
    }
    async function readApi(path) {
        const entry = tokenEntry();
        if (!entry) throw new Error('未找到登录状态，请先登录平台');
        const token = decodeURIComponent(entry.slice(entry.indexOf('=') + 1));
        const response = await fetch(path, {
            credentials: 'same-origin', headers: { authorization: `Bearer ${token}` }
        });
        if (!response.ok) {
            if (response.status === 401 && !path.includes('/oauth2/info')) invalidateAuthentication();
            throw Object.assign(new Error(`请求失败：HTTP ${response.status}`), { status: response.status });
        }
        const result = await response.json();
        if (!result.success) throw new Error(result.message || '平台未返回有效数据');
        return result.data;
    }
    function checkCompletion(node, force = false) {
        const id = String(node.id), course = queueCourse, epoch = completionEpoch;
        const key = `${epoch}/${id}`;
        if (pendingChecks.has(key)) return pendingChecks.get(key);
        const previous = completions.get(id);
        if (!force && previous?.checkedAt && Date.now() - previous.checkedAt < 30000) return Promise.resolve(previous);
        const pending = (async () => {
            await Promise.resolve();
            try {
                const task = node.task_id || node.task?.task_id;
                let state;
                if (task) {
                    const params = new URLSearchParams({ group_id: course, node_id: id, task_id: String(task) });
                    const data = await readApi(`/api/jx-iresource/resource/task/studentFinishInfo/v2?${params}`);
                    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('任务状态格式异常');
                    state = completionState(node, data);
                } else if (node.quote_id && isVideo(node)) {
                    const data = await readApi(`/api/jx-iresource/vod/duration/${encodeURIComponent(String(node.quote_id))}`);
                    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('观看记录格式异常');
                    state = completionState(node, Object.keys(data).length ? data : { duration: 1, watched_duration: 0 });
                } else {
                    state = completionState(node, node.watchRecord || node);
                }
                state.checkedAt = Date.now();
                if (epoch === completionEpoch && course === queueCourse) completions.set(id, state);
                return state;
            } catch {
                const state = { complete: null, percent: previous?.percent ?? null,
                    hasTask: !!(node.task_id || node.task?.task_id), error: true, checkedAt: Date.now() };
                if (epoch === completionEpoch && course === queueCourse) completions.set(id, state);
                return state;
            } finally {
                pendingChecks.delete(key);
                if (epoch === completionEpoch && course === queueCourse) { updateCompletionBadges(); writeCache(); }
            }
        })();
        pendingChecks.set(key, pending);
        return pending;
    }
    async function refreshCompletion(force = false) {
        if (completionBusy || !queue.length) return;
        completionBusy = true;
        const epoch = completionEpoch, nodes = [...queue];
        let cursor = 0;
        updateView();
        try {
            await Promise.all(Array.from({ length: Math.min(3, nodes.length) }, async () => {
                while (cursor < nodes.length && epoch === completionEpoch) await checkCompletion(nodes[cursor++], force);
            }));
        } finally {
            if (epoch === completionEpoch) { completionBusy = false; updateCompletionBadges(); }
        }
    }
    async function loadHistory(course, force = false) {
        if (historyBusy) return;
        const epoch = courseEpoch;
        const cached = readCache(course)?.history;
        if (!force && cached && Number.isFinite(cached.minutes)) {
            history = cached;
            if (Date.now() - cached.fetchedAt < HISTORY_TTL) { updateView(); return; }
        }
        historyBusy = true;
        updateView();
        try {
            const userId = auth.id;
            if (userId == null) throw new Error('无法读取当前账号');
            const params = new URLSearchParams({ group_id: course, user_id: String(userId), client_type: '3', unit: '1' });
            const data = await readApi(`/api/jx-stat/ads/duration/user?${params}`);
            if (data?.total_duration == null || !Number.isFinite(Number(data.total_duration)) || Number(data.total_duration) < 0) {
                throw new Error('历史统计格式异常');
            }
            if (epoch !== courseEpoch) return;
            history = { minutes: Number(data.total_duration), fetchedAt: Date.now(), error: false };
            writeCache();
        } catch {
            if (epoch === courseEpoch) history = { ...history, error: true };
        } finally {
            if (epoch === courseEpoch) { historyBusy = false; updateView(); }
        }
    }
    function applyQueue(nodes, course, cachedStates = []) {
        queue = nodes;
        queueCourse = course;
        completionEpoch++;
        completionBusy = false;
        completions.clear();
        const states = new Map(cachedStates);
        for (const node of queue) {
            const id = String(node.id), cached = states.get(id);
            completions.set(id, cached && Date.now() - cached.checkedAt < STATUS_TTL ? cached : completionState(node,
                node.task_id || node.task?.task_id ? node : node.watchRecord || node));
        }
        syncSettingsInputs();
        showQueue();
        refreshCompletion();
    }
    async function loadQueue(current, force = false) {
        if (loading) return;
        const version = courseEpoch;
        const cached = readCache(current.course);
        if (!force && cached) {
            cacheAt = cached.cachedAt;
            applyQueue(cached.queue.filter(isStudyResource), current.course, cached.completions || []);
            if (Date.now() - cached.cachedAt < QUEUE_TTL) {
                directoryCheckedAt = Date.now();
                return;
            }
        }
        loading = true;
        directoryIssue = '';
        directoryCheckedAt = Date.now();
        report('正在检测本课程的学习资料…');
        updateView();
        try {
            const resources = await readApi(`/api/jx-iresource/resource/queryCourseResources/v2?group_id=${current.course}`);
            if (!Array.isArray(resources)) throw new Error('目录接口格式不符合预期');
            if (version !== courseEpoch || route()?.course !== current.course) return;
            cacheAt = Date.now();
            applyQueue(buildQueue(resources), current.course);
            writeCache();
            report(running ? `已检测 ${queue.length} 项，正在准备学习…` : '在“全部”中选择任务，或点击主按钮从当前项开始学习。');
        } catch (error) {
            if (version === courseEpoch) {
                directoryIssue = error.status === 403 ? '当前账号无权读取课程资料。' : `列表读取失败：${error.message}，点击刷新重试。`;
                report(directoryIssue);
            }
        } finally {
            if (version === courseEpoch) { loading = false; updateView(); place(); }
        }
    }
    async function playCurrent() {
        const target = video;
        if (!running || !target || target.ended || target.error || playPending) return;
        // A metadata-only preload may need play() to request buffered frames.
        if (target.readyState < 1) { waitingForVideoReady = true; return; }
        waitingForVideoReady = false;
        const version = generation;
        playPending = true;
        updateView();
        target.muted = muted;
        try {
            await target.play();
            if (!running || video !== target || version !== generation) {
                if (!running || video !== target) target.pause();
                return;
            }
            finishNavigation();
            report(document.hidden ? '已在后台继续播放，可切换到其他标签页。'
                : settings.mode === 'single' ? '当前视频结束后，将结束本次学习。' : '视频结束后，将按课程目录自动播放下一节。');
        } catch (error) {
            if (running && video === target && version === generation) {
                finishNavigation();
                report(error.name === 'NotAllowedError' ? '浏览器限制了自动播放，请手动点击一次视频播放按钮'
                    : `播放失败：${error.message}，可手动播放后继续`);
            }
        } finally {
            if (video === target && version === generation) playPending = false;
            updateView();
        }
    }
    function hasOpenDialog() {
        return [...document.querySelectorAll('.ant-modal, [role="dialog"]')].some(visible);
    }
    function recoverBackground() {
        if (!running || !background || !backgroundIntent || !video?.paused || video.ended ||
            video.error || video.seeking || video.readyState < 2 || resumeAfterDialog || hasOpenDialog() ||
            backgroundAttempts >= 3 || Date.now() - lastBackgroundAttempt < 3000) return;
        backgroundAttempts++;
        lastBackgroundAttempt = Date.now();
        playCurrent();
    }
    function queueBackgroundRecovery() {
        if (backgroundTimer || !running || !background || !backgroundIntent) return;
        backgroundTimer = setTimeout(() => { backgroundTimer = null; recoverBackground(); }, 250);
    }
    // 在平台的普通 visibilitychange 监听器之前保留播放意图；不修改页面可见性。
    document.addEventListener('visibilitychange', () => {
        if (documentClock && !background) updateDocumentClock(false);
        clearTimeout(backgroundTimer);
        backgroundTimer = null;
        if (!running || !background || !video) return;
        if (document.hidden) {
            backgroundIntent = !video.paused && !video.ended;
            backgroundAttempts = 0;
            lastBackgroundAttempt = 0;
        }
        if (backgroundIntent) queueBackgroundRecovery();
        updateView();
    }, true);
    function scheduleNext(currentVideo) {
        const current = route();
        if (!current || video !== currentVideo || !currentVideo.ended) return;
        scheduleResourceNext(current.node, currentVideo, 5000);
    }
    function scheduleResourceNext(nodeId, currentVideo, delay) {
        const current = route();
        if (!running || !current || current.node !== nodeId || nextTimer || advancing) return;
        const index = queue.findIndex(node => String(node.id) === current.node);
        if (index < 0) { stop('无法在目录中定位当前资料，已停止'); return; }
        const next = nextVideo(queue, current.node, completions, skipCompleted);
        const finished = () => currentVideo ? video === currentVideo && currentVideo.ended
            : documentClock?.node === nodeId && documentClock.elapsedMs >= targetDocumentMs(queue[index]);
        report(settings.mode === 'single' ? '当前项已结束，正在确认平台记录。'
            : next ? delay ? `视频结束，5 秒后切换：${next.name}` : `计划停留已结束，正在切换：${next.name}` : '当前项已结束，正在确认平台记录。');
        const version = generation;
        nextTimer = setTimeout(async () => {
            nextTimer = null;
            if (!running || generation !== version || route()?.node !== current.node || !finished()) return;
            advancing = true;
            try {
                await checkCompletion(queue[index], true);
                if (!running || generation !== version || route()?.node !== current.node || !finished()) return;
                if (settings.mode === 'single') {
                    const state = completions.get(nodeId);
                    stop(state?.complete === true ? '本次学习已结束，平台记录已完成。'
                        : currentVideo ? '本次播放已结束，平台完成状态待确认。' : '计划停留已结束，平台完成状态待确认。', false, true);
                    return;
                }
                const target = nextVideo(queue, current.node, completions, skipCompleted);
                if (!target) { stop('本次学习已结束，后续没有需要继续学习的资料。', false, true); return; }
                beginNavigation(target, current.course);
                location.assign(resourcePath(current.course, target));
            } finally { if (generation === version) advancing = false; }
        }, delay);
        updateView();
    }
    function bindVideo() {
        const found = [...document.querySelectorAll('.group-resource-body .ali_player_wrapper video')].find(visible);
        if (navigation && found === outgoingVideo && (found?.currentSrc || '') === outgoingSource) return;
        if (found === video) {
            // A cached/seeked player can become ready without another loadeddata event.
            if (running && (navigation || waitingForVideoReady) && !resumeAfterDialog && !hasOpenDialog()) playCurrent();
            return;
        }
        detachVideo();
        if (!found) return;
        video = found;
        endedListener = () => scheduleNext(found);
        readyListener = () => {
            if (video !== found || found.readyState < 1) return;
            if (!running) { finishNavigation(); updateView(); }
            else if ((navigation || waitingForVideoReady) && !resumeAfterDialog && !hasOpenDialog()) playCurrent();
        };
        pauseListener = () => {
            if (running && background && backgroundIntent && document.hidden) {
                queueBackgroundRecovery();
            } else if (!document.hidden) {
                backgroundIntent = false;
                if (running && !found.ended && !resumeAfterDialog) report('视频已暂停，点击“继续学习”即可继续。');
            }
            updateView();
        };
        playListener = () => {
            waitingForVideoReady = false;
            finishNavigation();
            userPaused = false;
            if (running && background && document.hidden) backgroundIntent = true;
            updateView();
        };
        found.addEventListener('ended', endedListener);
        for (const event of ['loadedmetadata', 'loadeddata', 'canplay', 'seeked']) found.addEventListener(event, readyListener);
        found.addEventListener('pause', pauseListener);
        found.addEventListener('play', playListener);
        if (!running && found.readyState >= 2) finishNavigation();
        if (found.ended) scheduleNext(found);
        else playCurrent();
    }
    function handleContinueDialog() {
        const dialogs = [...document.querySelectorAll('.ant-modal, [role="dialog"]')].filter(visible);
        const dialog = dialogs.find(element => /长时间[\s\S]{0,40}(未操作|没有操作)/.test(element.textContent || ''));
        if (!dialog) {
            if (resumeAfterDialog) {
                resumeAfterDialog = false;
                playCurrent();
            }
            return false;
        }
        const button = [...dialog.querySelectorAll('button')].find(element =>
            element.textContent.replace(/\s/g, '') === '继续学习' && !element.disabled && visible(element));
        if (button && Date.now() - lastDialogClick > 3000) {
            lastDialogClick = Date.now();
            resumeAfterDialog = true;
            button.click();
            report('已点击“继续学习”，等待弹窗关闭后恢复播放…');
        } else if (!button) report('检测到未操作提示，但未找到“继续学习”按钮，请手动处理');
        return true;
    }
    function tick() {
        if (loginSurface) {
            if (auth.state !== 'signedOut' || running || navigation) invalidateAuthentication('请先登录');
            else updateView();
            return;
        }
        const scope = tokenScope();
        if (scope !== cacheScope) {
            authEpoch++;
            authBusy = false;
            stop('登录状态已变化，请重新确认。');
            resetCourseContext(null);
            cacheScope = scope;
            auth = { state: 'checking', id: null, message: '', checkedAt: 0 };
            verifyAuthentication(true);
            return;
        }
        if (auth.state !== 'ready') {
            if (auth.state === 'checking' && !authBusy) verifyAuthentication();
            updateView();
            return;
        }
        if (!authBusy && Date.now() - auth.checkedAt >= 5 * 60000) verifyAuthentication();
        const current = route();
        const course = current?.course || null;
        if (course !== observedCourse) {
            if (running && (!current || activeCourse !== course)) stop('已切换课程，连播停止。');
            resetCourseContext(course);
            if (current) { loadCourseInfo(course); loadQueue(current); loadHistory(course); }
        }
        updateView();
        if (navigation) {
            if (Date.now() - navigation.startedAt >= 30000) { stop('跳转等待超时，请刷新页面后重试。'); return; }
            if (current?.course === navigation.course && current.node === navigation.fromNode && current.node !== navigation.node) return;
            if (current?.course !== navigation.course || current.node !== navigation.node) finishNavigation();
            else if (loading && !queue.length) return;
        }
        const key = current ? `${current.course}/${current.node || ''}` : '';
        if (key !== routeKey) {
            updateDocumentClock(running);
            documentClock = null;
            routeKey = key;
            generation++;
            clearTimeout(nextTimer);
            nextTimer = null;
            advancing = false;
            resumeAfterDialog = false;
            sessionEnded = false;
            userPaused = false;
            resourceFailure = '';
            if (video && !video.paused) video.pause();
            detachVideo();
            syncSettingsInputs();
            showQueue();
        }
        if (current && !loading && Date.now() - directoryCheckedAt >= (queue.length ? QUEUE_TTL : 30000)) loadQueue(current);
        if (current?.node && queueCourse === current.course && Date.now() - currentCheckAt >= 30000) {
            currentCheckAt = Date.now();
            const node = queue.find(item => String(item.id) === current.node);
            if (node) checkCompletion(node);
        }
        if (!running) {
            if (navigation && currentNode()) {
                if (isVideo(currentNode())) bindVideo();
                else processDocument();
            }
            updateView();
            return;
        }
        if (courseInfo.state !== 'ready') return;
        if (!current?.node || current.course !== activeCourse) {
            stop('已离开当前学习资料页面，连播停止');
            return;
        }
        if (loading && !queue.length) return;
        const node = currentNode();
        if (!node) { stop('当前项不是视频或自主观看资料，请从列表选择。'); return; }
        if (handleContinueDialog()) { updateDocumentClock(false); return; }
        if (isVideo(node)) { bindVideo(); recoverBackground(); }
        else processDocument();
        updateView();
    }
    startButton.onclick = () => {
        if (startButton.disabled || auth.state !== 'ready' || courseInfo.state !== 'ready') return;
        if (['playing', 'reading'].includes(viewMode())) { stop('已暂停，点击继续学习。', true); return; }
        const current = route();
        if (!current) { report('请先进入课程'); return; }
        if (!queue.length) { report('暂未检测到可学习资料，可点击刷新重新检测。'); return; }
        if (settings.mode === 'single' && !currentNode()) { report('请先从列表选择一项学习资料。'); return; }
        if (sessionEnded) {
            if (documentClock) { documentClock.elapsedMs = 0; documentClock.lastAt = null; }
            if (video) video.currentTime = 0;
        }
        sessionEnded = false;
        resourceFailure = '';
        activeCourse = current.course;
        running = true;
        userPaused = false;
        persist();
        if (!currentNode()) {
            const target = queue.find(node => !skipCompleted || completions.get(String(node.id))?.complete !== true);
            if (!target) { stop('本课程列表中的资料均已完成。'); return; }
            beginNavigation(target, current.course);
            location.assign(resourcePath(current.course, target));
            return;
        }
        tick();
        if (video) playCurrent();
    };
    stopButton.onclick = () => stop();
    launcher.onclick = () => {
        if (suppressLauncherClick) { suppressLauncherClick = false; return; }
        collapsed = !collapsed;
        setCollapsed();
        persist();
        if (!collapsed) {
            const current = route();
            if (current && queueCourse !== current.course) loadQueue(current);
            else showQueue();
        }
        updateView();
    };
    collapseButton.onclick = () => { collapsed = !collapsed; setCollapsed(); persist(); };
    find('[data-refresh]').onclick = () => {
        if (auth.state !== 'ready' || tokenScope() !== cacheScope) { verifyAuthentication(true); return; }
        const current = route();
        if (!current) { report('请选择课程'); return; }
        loadCourseInfo(current.course, true);
        loadQueue(current, true);
        loadHistory(current.course, true);
    };
    find('[data-empty-retry]').onclick = () => find('[data-refresh]').click();
    for (const tab of ui.querySelectorAll('[data-tab]')) {
        tab.onclick = () => setTab(tab.dataset.tab);
        tab.onkeydown = event => {
            const tabs = [...ui.querySelectorAll('[data-tab]')];
            const index = tabs.indexOf(tab);
            const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
                : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
            if (next < 0) return;
            event.preventDefault();
            setTab(tabs[next].dataset.tab);
            tabs[next].focus();
        };
    }
    find('[data-search]').oninput = event => { queueSearch = event.target.value; list.scrollTop = 0; showQueue(); };
    for (const filter of ui.querySelectorAll('[data-filter]')) {
        filter.onclick = () => {
            queueFilter = filter.dataset.filter;
            for (const item of ui.querySelectorAll('[data-filter]')) item.setAttribute('aria-pressed', String(item === filter));
            list.scrollTop = 0;
            showQueue();
        };
    }
    find('[data-locate]').onclick = () => {
        queueSearch = '';
        queueFilter = 'all';
        find('[data-search]').value = '';
        for (const filter of ui.querySelectorAll('[data-filter]')) filter.setAttribute('aria-pressed', String(filter.dataset.filter === 'all'));
        showQueue();
        const current = list.querySelector('[aria-current="page"]');
        current?.scrollIntoView?.({ block: 'nearest', behavior: typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        current?.focus({ preventScroll: true });
    };
    for (const link of ui.querySelectorAll('[data-step]')) link.onclick = event => {
        const id = event.currentTarget.dataset.targetNode;
        const node = queue.find(item => String(item.id) === id);
        openResourceFromClick(event, node, queueCourse);
    };
    ui.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        collapsed = true;
        setCollapsed();
        persist();
        launcher.focus();
    });
    function changeSettings(change) {
        if (auth.state !== 'ready' || !route() || courseInfo.state !== 'ready') return;
        updateDocumentClock(running && !hasOpenDialog());
        if (nextTimer || advancing) {
            generation++;
            clearTimeout(nextTimer);
            nextTimer = null;
            advancing = false;
        }
        change();
        skipCompleted = settings.skipCompleted;
        saveSettings();
        syncSettingsInputs();
        find('[data-config-error]').textContent = '';
        if (running) {
            const node = currentNode();
            if (node && !isVideo(node)) processDocument();
            else if (video?.ended) scheduleNext(video);
        } else report('学习设置已保存到当前课程。');
        updateView();
        place();
    }
    for (const button of ui.querySelectorAll('[data-learning-mode]')) {
        button.onclick = () => changeSettings(() => { settings.mode = button.dataset.learningMode; });
    }
    find('[data-default-minutes]').onchange = event => {
        if (!validMinutes(event.target.value)) { find('[data-config-error]').textContent = '请输入 2 至 1440 的整数分钟数。'; return; }
        changeSettings(() => { settings.documentMinutes = Number(event.target.value); });
    };
    find('[data-resource-minutes]').onchange = event => {
        const node = currentNode();
        if (!node || isVideo(node)) return;
        const value = event.target.value;
        if (value !== '' && !validMinutes(value)) { find('[data-config-error]').textContent = '请输入 2 至 1440 的整数分钟数，留空使用课程默认。'; return; }
        changeSettings(() => {
            if (value === '') delete settings.resourceMinutes[String(node.id)];
            else settings.resourceMinutes[String(node.id)] = Number(value);
        });
    };
    find('[data-reset-resource]').onclick = () => {
        const node = currentNode();
        if (node) changeSettings(() => { delete settings.resourceMinutes[String(node.id)]; });
    };
    skipInput.onchange = () => changeSettings(() => { settings.skipCompleted = skipInput.checked; });
    muteInput.onchange = () => { muted = muteInput.checked; persist(); if (video) video.muted = muted; };
    backgroundInput.onchange = () => {
        background = backgroundInput.checked;
        backgroundIntent = background && running && !!video && !video.paused && document.hidden;
        backgroundAttempts = 0;
        lastBackgroundAttempt = 0;
        if (!background) { clearTimeout(backgroundTimer); backgroundTimer = null; }
        persist();
    };
    report(running ? '正在加载学习资料…' : '进入课程后自动检测，点击主按钮开始学习。');
    window.addEventListener('pagehide', () => {
        updateDocumentClock(running);
        if (documentClock) documentClock.lastAt = null;
        clearTimeout(nextTimer);
        clearTimeout(backgroundTimer);
        detachVideo();
    });
    window.addEventListener('pageshow', tick);
    setInterval(tick, 1000);
    setTab(activeTab, false);
    showQueue();
    tick();
})();
