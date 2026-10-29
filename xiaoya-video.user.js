// ==UserScript==
// @name         小雅视频连播助手
// @namespace    local.xiaoya.video
// @version      1.0.0
// @description  视频与课程资料连续学习，自选全部或未完成队列，记住播放进度，按课程缓存今日学习时长。
// @author       波波侠
// @license      MIT
// @icon         data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDY0IDY0Ij4KICA8cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSIxNiIgZmlsbD0iIzM0NzhmNiIvPgogIDxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDggNikgc2NhbGUoMikiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+CiAgICA8cGF0aCBkPSJNMTIgNi41QzkuNiA0LjcgNi44IDQuMyAzLjUgNXYxNGMzLjMtLjcgNi4xLS4zIDguNSAxLjUgMi40LTEuOCA1LjItMi4yIDguNS0xLjVWNWMtMy4zLS43LTYuMS0uMy04LjUgMS41Wm0wIDB2MTQiIHN0cm9rZS13aWR0aD0iMS43Ii8+CiAgICA8cGF0aCBkPSJNNi41IDloMm0tMiAzaDJtNy0zaDJtLTIgM2gyIiBzdHJva2Utd2lkdGg9IjEuNCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+CiAgPC9nPgo8L3N2Zz4K
// @homepageURL  https://scriptcat.org/zh-CN/script-show-page/8791
// @supportURL   https://github.com/bbx88/xiaoya-learning-helper/issues
// @match        https://whut.ai-augmented.com/*
// @match        https://infra.ai-augmented.com/app/auth/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    const VERSION = '1.0.0';
    const collator = new Intl.Collator('zh-CN', { numeric: true });
    const isVideo = node => Number(node.type) === 9 ||
        /^video\//i.test(node.mimetype || '') ||
        /\.(mp4|webm|m4v|mov|mkv|avi|flv|m3u8)$/i.test(node.name || '');
    const isSelfStudy = node => Number(node.task_type ?? node.task?.task_type ?? node.property?.task_type) === 1 ||
        [node.tag, node.task_label, node.task?._taskTypeText].some(label => label === '自主观看');
    const isPresentation = node => /\.pptx?$/i.test(node.name || '') ||
        /^application\/(?:vnd\.ms-powerpoint|vnd\.openxmlformats-officedocument\.presentationml\.(?:presentation|slideshow|template))$/i.test((node.mimetype || '').split(';')[0].trim());
    const isStudyResource = node => Number(node.type) !== 1 && (isVideo(node) || isSelfStudy(node) || isPresentation(node) || Number(node.type) === 6);
    const resourceKind = node => isVideo(node) ? '视频' : '其他资料';
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
        const resourceKinds = { videos: value?.resourceKinds?.videos !== false,
            other: value?.resourceKinds && Object.hasOwn(value.resourceKinds, 'presentations')
                ? value.resourceKinds.presentations !== false || value.resourceKinds.other !== false : value?.resourceKinds?.other !== false };
        if (!Object.values(resourceKinds).some(Boolean)) for (const kind of Object.keys(resourceKinds)) resourceKinds[kind] = true;
        const queuePolicy = value?.queuePolicy === 'all' ? 'all' : 'unfinished';
        return { mode: value?.mode === 'single' ? 'single' : 'continuous', resourceKinds, queuePolicy,
            documentMinutes: validMinutes(value?.documentMinutes) ? Number(value.documentMinutes) : 2,
            skipCompleted: queuePolicy === 'unfinished', resourceMinutes };
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
    function taskIdentifier(node) {
        return [node.task_id, node.task?.task_id, node.task?.id].find(value => {
            if (value == null) return false;
            const id = String(value).trim();
            return id !== '' && !/^(null|undefined)$/i.test(id) && (!/^[+-]?\d+$/.test(id) || Number(id) > 0);
        });
    }
    function completionState(node, data = {}) {
        const hasTask = taskIdentifier(node) != null;
        const finished = data.finished === true || data.finished === 1 || data.finished === '1' || data.finished === 'true'
            ? true : data.finished === false || data.finished === 0 || data.finished === '0' || data.finished === 'false' ? false : null;
        const record = data.watchRecord || (!hasTask ? data : null);
        const duration = Number(record?.duration), watched = Number(record?.watched_duration);
        const percent = Number.isFinite(duration) && duration > 0 && Number.isFinite(watched) && watched >= 0
            ? Math.min(100, Math.ceil(watched / (duration * 0.95) * 100)) : null;
        const taskType = Number(node.task_type ?? node.task?.task_type ?? node.property?.task_type);
        const kind = hasTask ? 'task' : isVideo(node) || record && (Object.hasOwn(record, 'duration') || Object.hasOwn(record, 'watched_duration'))
            ? 'watch' : taskType > 0 || isSelfStudy(node) ? 'taskInfo' : 'none';
        return { complete: hasTask ? finished : kind === 'watch' && percent != null ? percent >= 100 : null,
            percent: kind === 'none' ? null : percent, hasTask, kind, error: false, checkedAt: 0 };
    }
    function completionLabel(state) {
        if (!state) return '待检测';
        if (state.kind === 'none') return '普通资料';
        if (state.kind === 'taskInfo') return '任务信息待确认';
        if (state.error) return '检测失败';
        if (state.complete === true) return '已完成';
        if (state.hasTask && state.complete === false && state.percent === 100) return '待提交';
        if (state.percent > 0) return `已看 ${state.percent}%`;
        return state.complete === false ? '未完成' : state.kind === 'watch' ? '观看记录待确认' : '待检测';
    }
    function resourcePath(course, node) {
        const parent = node.parent_id == null || node.parent_id === '' ? '_' : String(node.parent_id);
        return `/app/jx-web/mycourse/${encodeURIComponent(course)}/resource/${encodeURIComponent(parent)}/${encodeURIComponent(String(node.id))}`;
    }
    function nextVideo(nodes, currentId, states, skipCompleted) {
        const index = nodes.findIndex(node => String(node.id) === currentId);
        return index < 0 ? null : nodes.slice(index + 1).find(node =>
            !skipCompleted || states.get(String(node.id))?.kind !== 'none' && states.get(String(node.id))?.complete !== true) || null;
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
    let skipCompleted = saved.skipCompleted !== false;
    let collapsed = loginSurface ? false : saved.collapsed !== false;
    let position = preferences.position || saved.position || null;
    let userPaused = saved.userPaused === true;
    let navigation = saved.navigation && Date.now() - saved.navigation.startedAt < 30000 ? saved.navigation : null;
    let outgoingVideo = null, outgoingSource = '';
    let courseResources = [], queue = [], queueCourse = '', routeKey = '', generation = 0;
    let video = null, endedListener = null, readyListener = null, pauseListener = null, playListener = null, progressListener = null;
    let videoProgress = null, playbackMemory = { resources: {} };
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
    const studySessionKey = 'xy-learning-session-v1';
    let studySession = null, studySample = null;
    try {
        const value = JSON.parse(sessionStorage.getItem(studySessionKey) || 'null');
        if (value && typeof value.account === 'string' && typeof value.course === 'string' &&
            Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0 && typeof value.open === 'boolean') studySession = value;
    } catch { /* 新建本次学习统计 */ }
    const studyWriter = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const dailyWrites = new Map();
    const studyDateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
    let dailyCache = { prefix: '', total: 0, at: -Infinity };
    function studyDay(time) { return studyDateFormat.format(new Date(time)); }
    function dailyPrefix(account, course, time = Date.now()) {
        return `xy-learning-daily-v1:${encodeURIComponent(account)}:${course}:${studyDay(time)}:`;
    }
    function saveStudySession() {
        if (studySession) try { sessionStorage.setItem(studySessionKey, JSON.stringify(studySession)); } catch { /* 本页继续显示 */ }
    }
    function beginStudySession(course) {
        if (!studySession?.open || studySession.account !== auth.id || studySession.course !== course) {
            studySession = { account: auth.id, course, elapsedMs: 0, open: true };
            studySample = null;
            saveStudySession();
        }
    }
    function addDailyStudy(milliseconds, end) {
        let cursor = end - milliseconds;
        while (cursor < end) {
            const nextDay = Date.parse(`${studyDay(cursor)}T00:00:00+08:00`) + 86400000;
            const boundary = Math.min(nextDay, end);
            const key = dailyPrefix(studySession.account, studySession.course, cursor) + studyWriter;
            const total = (dailyWrites.get(key) || 0) + boundary - cursor;
            dailyWrites.set(key, total);
            try { localStorage.setItem(key, JSON.stringify({ elapsedMs: total })); } catch { /* 暂时保留本页累计 */ }
            cursor = boundary;
        }
        dailyCache.at = -Infinity;
    }
    function todayStudyMs() {
        const course = route()?.course;
        if (auth.state !== 'ready' || !course) return 0;
        const prefix = dailyPrefix(auth.id, course), now = Date.now();
        if (dailyCache.prefix === prefix && now - dailyCache.at < 1000) return dailyCache.total;
        let total = 0;
        const seen = new Set();
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (!key?.startsWith(prefix)) continue;
                let value = null;
                try { value = JSON.parse(localStorage.getItem(key) || 'null'); } catch { /* 忽略损坏记录 */ }
                const amount = Number.isFinite(value?.elapsedMs) && value.elapsedMs >= 0 ? value.elapsedMs : 0;
                total += Math.max(amount, dailyWrites.get(key) || 0);
                seen.add(key);
            }
        } catch { /* 使用本页内存记录 */ }
        for (const [key, amount] of dailyWrites) if (key.startsWith(prefix) && !seen.has(key)) total += amount;
        dailyCache = { prefix, total, at: now };
        return total;
    }
    function updateStudyClock() {
        const current = route();
        if (auth.state !== 'ready' || !current || activeCourse !== current.course) { studySample = null; return; }
        if (running) beginStudySession(current.course);
        if (!studySession?.open || studySession.account !== auth.id || studySession.course !== current.course) { studySample = null; return; }
        const now = Date.now(), node = currentNode();
        let sample = null, elapsed = 0;
        if (node && isVideo(node) && video && progressMatches() && !navigation) {
            sample = { kind: 'video', video, node: current.node, source: video.currentSrc || '', at: now,
                position: video.currentTime, rate: video.playbackRate > 0 ? video.playbackRate : 1,
                active: running && !video.paused && !video.ended && !video.error && !video.seeking && video.readyState >= 3 && !hasOpenDialog() };
            if (studySample?.kind === 'video' && studySample.video === sample.video && studySample.node === sample.node &&
                studySample.source === sample.source && studySample.active) {
                elapsed = Math.min(Math.max(0, now - studySample.at), Math.max(0, sample.position - studySample.position) / studySample.rate * 1000);
            }
        } else if (documentClock && documentClock.course === current.course && documentClock.node === current.node) {
            sample = { kind: 'document', clock: documentClock, position: documentClock.elapsedMs };
            if (studySample?.kind === 'document' && studySample.clock === documentClock) elapsed = Math.max(0, sample.position - studySample.position);
        }
        studySample = sample;
        if (Number.isFinite(elapsed) && elapsed > 0) {
            studySession.elapsedMs += elapsed;
            addDailyStudy(elapsed, now);
            saveStudySession();
        }
    }
    function formatStudyTime(milliseconds) {
        const total = Math.floor(milliseconds / 1000);
        return `${String(Math.floor(total / 3600)).padStart(2, '0')}:${String(Math.floor(total / 60) % 60).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    }
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
    const userDefaultsKey = () => auth.id != null ? `xy-learning-defaults-v1:${encodeURIComponent(String(auth.id))}` : null;
    function saveUserDocumentMinutes(minutes) {
        const key = userDefaultsKey();
        if (key && validMinutes(minutes)) try { localStorage.setItem(key, JSON.stringify({ documentMinutes: Number(minutes) })); }
        catch { /* 本页默认时间仍有效 */ }
    }
    function readUserDocumentMinutes(legacyMinutes) {
        try {
            const value = JSON.parse(localStorage.getItem(userDefaultsKey()) || 'null');
            if (validMinutes(value?.documentMinutes)) return Number(value.documentMinutes);
        } catch { /* 尝试迁移当前课程的旧默认值 */ }
        if (validMinutes(legacyMinutes)) {
            saveUserDocumentMinutes(legacyMinutes);
            return Number(legacyMinutes);
        }
        return 2;
    }
    function loadSettings(course) {
        let cached = {};
        try { cached = JSON.parse(localStorage.getItem(settingsKey(course)) || '{}'); }
        catch { /* 使用默认课程设置 */ }
        settings = normalizeSettings(cached);
        settings.documentMinutes = readUserDocumentMinutes(cached?.documentMinutes);
        skipCompleted = settings.skipCompleted;
        syncSettingsInputs();
    }
    function saveSettings() {
        settings.queuePolicy = settings.skipCompleted ? 'unfinished' : 'all';
        const key = settingsKey(route()?.course);
        const courseSettings = { ...settings };
        delete courseSettings.documentMinutes;
        if (key) try { localStorage.setItem(key, JSON.stringify(courseSettings)); } catch { /* 本页设置仍有效 */ }
        persist();
    }
    function targetDocumentMs(node = currentNode()) {
        return (settings.resourceMinutes[String(node?.id)] ?? settings.documentMinutes) * 60000;
    }
    function selectedResource(node) {
        return settings.resourceKinds[isVideo(node) ? 'videos' : 'other'];
    }
    function playbackQueue() {
        return settings.mode === 'continuous' && skipCompleted ? queue.filter(node => completions.get(String(node.id))?.kind !== 'none' && completions.get(String(node.id))?.complete !== true) : queue;
    }
    function allSelectedCompleted() {
        return auth.state === 'ready' && courseInfo.state === 'ready' && !loading && !completionBusy &&
            settings.mode === 'continuous' && skipCompleted && queue.some(node => completions.get(String(node.id))?.kind !== 'none') && playbackQueue().length === 0;
    }
    function reconcilePlaybackQueue() {
        if (!running || auth.state !== 'ready' || courseInfo.state !== 'ready' || settings.mode !== 'continuous' || !skipCompleted || navigation || loading || completionBusy) return;
        const current = currentNode();
        if (!current || playbackQueue().some(node => String(node.id) === String(current.id))) return;
        const target = nextVideo(queue, String(current.id), completions, true) || playbackQueue()[0];
        if (!target) { stop('所选学习队列已全部完成。'); return; }
        const course = route()?.course;
        if (!course) return;
        beginNavigation(target, course);
        location.assign(resourcePath(course, target));
    }
    const playbackKey = (course, account = auth.id) => account != null && course
        ? `xy-learning-playback-v1:${encodeURIComponent(String(account))}:${course}` : null;
    function readPlaybackMemory(course, account = auth.id) {
        const empty = { version: 1, course, lastNode: null, resources: {} };
        try {
            const key = playbackKey(course, account);
            const value = key && JSON.parse(localStorage.getItem(key) || 'null');
            if (value?.version !== 1 || value.course !== course || !value.resources || typeof value.resources !== 'object') return empty;
            const entries = Object.entries(value.resources).filter(([, record]) => record &&
                Number.isFinite(record.position) && record.position >= 0 &&
                Number.isFinite(record.duration) && record.duration > 0 &&
                typeof record.ended === 'boolean' && Number.isFinite(record.updatedAt))
                .sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 200);
            const resources = Object.fromEntries(entries);
            return { ...empty, lastNode: Object.hasOwn(resources, value.lastNode) ? value.lastNode : null, resources };
        } catch { return empty; }
    }
    function resumeResource() {
        const previous = queue.find(node => String(node.id) === playbackMemory.lastNode);
        if (!previous) return null;
        const record = playbackMemory.resources[String(previous.id)];
        if (!record) return null;
        if (record.ended || skipCompleted && completions.get(String(previous.id))?.complete === true) {
            return settings.mode === 'continuous' ? nextVideo(queue, String(previous.id), completions, skipCompleted) : null;
        }
        return previous;
    }
    function progressMatches() {
        const current = route(), context = videoProgress;
        return context && video && auth.state === 'ready' && auth.id === context.account && tokenScope() === context.scope &&
            current?.course === context.course && current.node === context.node && (video.currentSrc || '') === context.source;
    }
    function restorePlaybackPosition() {
        const context = videoProgress;
        if (!progressMatches()) return false;
        if (context.restored) return true;
        if (video.readyState < 1) return false;
        const record = playbackMemory.resources[context.node];
        if (record && !record.ended) {
            // Some players only discover their duration after play() starts loading frames.
            if (!Number.isFinite(video.duration) || video.duration <= 0) return true;
            const target = Math.min(record.position, Math.max(0, video.duration - 1));
            context.restoring = true;
            try {
                video.currentTime = target;
                if (Math.abs(video.currentTime - target) > 1) return false;
                context.restoreSeek = target;
            } catch { return false; }
            finally { context.restoring = false; }
        }
        context.restored = true;
        return true;
    }
    function savePlaybackPosition(force = false) {
        const context = videoProgress;
        if (!context || context.restoring) return;
        // Keep the last sample tied to the bound account/resource, even if a SPA has already changed its URL or player source.
        if (progressMatches() && context.restored && context.started && video.readyState >= 1 &&
            Number.isFinite(video.currentTime) && video.currentTime >= 0 && Number.isFinite(video.duration) && video.duration > 0) {
            const position = Math.min(video.currentTime, video.duration);
            if (!context.sample || context.sample.position !== position || context.sample.duration !== video.duration || context.sample.ended !== video.ended) {
                context.sample = { position, duration: video.duration, ended: video.ended, updatedAt: Date.now() };
                context.dirty = true;
            }
        }
        if (!context.dirty || !force && Date.now() - context.lastWriteAt < 5000) return;
        try {
            const memory = readPlaybackMemory(context.course, context.account);
            if (memory.resources[context.node]?.updatedAt > context.sample.updatedAt) { context.dirty = false; return; }
            memory.resources[context.node] = context.sample;
            if (!memory.lastNode || memory.resources[memory.lastNode].updatedAt <= context.sample.updatedAt) memory.lastNode = context.node;
            localStorage.setItem(playbackKey(context.course, context.account), JSON.stringify(memory));
            context.lastWriteAt = Date.now();
            context.dirty = false;
            if (auth.id === context.account && route()?.course === context.course) playbackMemory = memory;
        } catch { /* 浏览器禁止存储或空间不足时仍可播放 */ }
    }
    const cacheKey = course => cacheScope ? `xy-learning-cache-v7:${cacheScope}:${course}` : null;
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
                queue: courseResources, completions: [...completions], courseInfo: courseInfo.name ? courseInfo : previous?.courseInfo || null,
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
        :host{--ink:#20304a;--muted:#65748c;--blue:#3478f6;--blue-dark:#2563d8;--soft:#f2f6fd;--line:#e3eaf5;font:15px/1.6 "Microsoft YaHei UI","PingFang SC",sans-serif;color:var(--ink)}
        *{box-sizing:border-box}button,a,input,select{font:inherit}button{cursor:pointer;border:0}button:disabled{cursor:default;opacity:.45}button,a{touch-action:manipulation;-webkit-tap-highlight-color:transparent}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #9cbeff;outline-offset:2px}svg{width:18px;height:18px;display:block;flex:none}[hidden]{display:none!important}
        .launcher{position:absolute;inset:0;width:48px;height:48px;display:grid;place-items:center;padding:0;border-radius:50%;background:var(--blue);color:#fff;box-shadow:0 4px 16px #2463cc26;border:1px solid #ffffff80;cursor:grab;touch-action:none}.launcher:active{cursor:grabbing}.launcher>span{pointer-events:none}.launcher svg{width:23px;height:23px}.launcher .signal{position:absolute;right:1px;bottom:1px;width:10px;height:10px;border-radius:50%;background:#a5b2c8;border:2px solid #fff}.launcher[data-mode="playing"] .signal,.launcher[data-mode="reading"] .signal{background:#9fc7ff}.launcher[data-mode="jumping"] .signal,.launcher[data-mode="loading"] .signal{background:#f0ca77}
        .shell{position:absolute;width:min(380px,calc(100vw - 24px));max-height:calc(100vh - 24px);max-height:calc(100dvh - 24px);display:block;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#cad8ed transparent;font:15px/1.6 "Microsoft YaHei UI","PingFang SC",sans-serif;color:var(--ink);background:#fff;border:1px solid #dce6f5;border-radius:12px;box-shadow:0 8px 32px #243f731c}
        .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}.icon-button{display:grid;place-items:center;background:transparent;color:var(--muted);border-radius:5px;width:24px;height:24px;padding:3px}.icon-button:hover{background:var(--soft)}.config-row select{max-width:210px;min-width:0;border:1px solid var(--line);border-radius:5px;background:#fff;color:var(--ink);padding:6px;font-size:14px}.panel-scroll-controls{display:flex;flex:none}.panel-scroll-controls .icon-button{width:20px}.panel-scroll-controls [data-panel-scroll="down"] svg{transform:rotate(180deg)}
        .course{padding:14px 16px 8px;display:flex;align-items:center;gap:8px;cursor:grab;touch-action:none;user-select:none}.course:active{cursor:grabbing}.course-controls{display:flex;align-items:center;flex:none;gap:2px}.course strong{flex:1;min-width:0}.course small{display:block;font-size:12px;color:var(--muted);margin-bottom:3px}.course strong{font-size:19px;font-weight:600;display:block;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .tabs{display:flex;padding:0 16px;gap:26px;border-bottom:1px solid var(--line);flex:none}.tab{position:relative;background:transparent;color:var(--muted);font-size:14px;padding:8px 3px 10px;min-width:36px}.tab[aria-selected="true"]{color:var(--blue-dark);font-weight:600}.tab[aria-selected="true"]:after{content:"";position:absolute;bottom:-1px;left:0;right:0;height:2px;background:var(--blue);border-radius:2px}.tab-count{font-size:12px;font-weight:400;margin-left:5px;color:var(--muted)}
        .body{padding:0 16px}.view{padding:14px 0}.notice{font-size:14px;color:var(--muted);padding:10px 0 0;line-height:1.6;overflow-wrap:anywhere}.notice[data-tone="warning"]{color:#95652b}.notice[data-tone="error"]{color:#a94730}
        .task{background:var(--soft);border-radius:8px;padding:12px}.track-top{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:14px;color:var(--muted);margin-bottom:9px}.track-number{font-variant-numeric:tabular-nums}.task-meta{display:flex;align-items:center;gap:9px;font-size:12px;margin-bottom:7px}.task-kind{color:#5271a4}.task .completion{border-left:1px solid #ccd9ef;padding-left:9px}.title{font-size:17px;font-weight:600;line-height:1.6;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}.time{display:flex;align-items:baseline;gap:4px;margin-top:12px;font-size:14px;color:var(--muted);font-variant-numeric:tabular-nums}.time:after{content:"";flex:1}.progress-percent{order:1;font-size:12px}progress{display:block;appearance:none;-webkit-appearance:none;width:100%;height:5px;border:0;border-radius:3px;overflow:hidden;background:#dfe8f6;margin:7px 0 0}progress::-webkit-progress-bar{background:#dfe8f6}progress::-webkit-progress-value{background:var(--blue);border-radius:3px}progress::-moz-progress-bar{background:var(--blue)}
        .actions{display:grid;grid-template-columns:minmax(0,1fr) 86px;gap:9px;margin-top:12px}.primary,.stop{display:flex;align-items:center;justify-content:center;gap:7px;min-height:40px;padding:8px 10px;border-radius:7px;font-size:14px}.primary{background:var(--blue);color:#fff;font-weight:600;min-width:0}.primary:hover:not(:disabled){background:var(--blue-dark)}.action-icon{display:grid;place-items:center}.action-icon svg{width:19px;height:19px}.stop{background:#f1f4f9;color:#53627b;border:1px solid #e4eaf3}.stop:hover:not(:disabled){background:#e8eef8}.stop svg{width:15px;height:15px}
        .task-nav{display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--line);margin-top:12px;padding-top:4px}.task-step{display:flex;align-items:center;gap:3px;color:var(--blue-dark);font-size:14px;text-decoration:none;border-radius:5px;padding:7px 2px}.task-step svg{width:14px;height:14px}.task-step:hover:not([aria-disabled="true"]){background:var(--soft)}.task-step[aria-disabled="true"]{color:#9eabc0;cursor:default}.spinner{animation:xy-spin 1s linear infinite}@keyframes xy-spin{to{transform:rotate(360deg)}}
        .next{margin-top:4px;padding:9px 11px;background:#f6f8fd;border-radius:7px;display:flex;align-items:center;gap:10px;min-width:0}.next-label{font-size:12px;color:var(--muted);white-space:nowrap}.next-link{font-size:14px;color:#405b86;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}.next-link:hover:not([aria-disabled="true"]){text-decoration:underline}.next-link[aria-disabled="true"]{color:var(--muted)}.history{display:flex;align-items:center;gap:6px;padding-top:12px;margin-top:12px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}.history strong{font-size:15px;color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums}.history small{font-size:12px;margin-left:auto;white-space:nowrap}.history[data-error="true"] strong{color:#a94730}.history[data-error="true"]{flex-wrap:wrap}.history[data-error="true"] small{white-space:normal}
        .footer{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 16px;padding:10px 0 12px;border-top:1px solid var(--line);flex:none}.study-mode{font-size:12px;color:var(--muted)}.settings-entry{display:flex;align-items:center;gap:5px;background:transparent;color:var(--blue-dark);font-size:14px;padding:2px;border-radius:4px}.settings-entry svg{width:14px;height:14px}.settings-entry:hover{background:var(--soft)}.settings-top{display:flex;align-items:center;gap:10px;margin:0 0 15px}.settings-top h2{font-size:15px;font-weight:600;margin:0}.settings-back{display:flex;align-items:center;gap:2px;padding:4px 2px;background:transparent;color:var(--blue-dark);font-size:14px;border-radius:4px}.settings-back svg{width:14px;height:14px}
        .list-tools{display:flex;align-items:center;gap:7px}.search{width:100%;min-width:0;border:1px solid var(--line);border-radius:7px;background:#f8faff;padding:7px 10px;font-size:14px;color:var(--ink)}.search::placeholder{color:var(--muted)}.refresh{display:grid;place-items:center;background:transparent;color:#5e7daf;padding:6px;border-radius:5px;flex:none}.refresh:hover{background:var(--soft)}.refresh svg{width:15px;height:15px}.filters{display:flex;gap:5px;margin-top:10px}.filter{font-size:12px;padding:4px 9px;border-radius:5px;background:transparent;color:var(--muted)}.filter[aria-pressed="true"]{background:#eaf1ff;color:var(--blue-dark)}.list-meta{display:flex;justify-content:space-between;align-items:center;margin:10px 0 6px;font-size:12px;color:var(--muted)}.text-button{background:transparent;color:var(--blue-dark);font-size:12px;padding:2px 0}.text-button:disabled{color:var(--muted)}
        .queue{padding:0;margin:0 -5px;list-style:none}.queue-link{display:flex;align-items:center;gap:7px;padding:10px 6px;border-radius:6px;font-size:14px;color:#536987;text-decoration:none}.queue-link:hover{background:#f5f8fe}.queue li.current .queue-link{background:#eaf2ff;color:#265eb8;box-shadow:inset 2px 0 0 var(--blue)}.queue .num{width:20px;flex:none;font-size:12px;font-variant-numeric:tabular-nums;text-align:center;color:var(--muted)}.queue .name{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.queue .current .name{font-weight:600}.queue .num svg{width:13px;height:13px;margin:auto;color:var(--blue-dark)}.queue-empty{padding:28px 8px;text-align:center;font-size:14px;color:var(--muted)}.kind{font-size:12px;line-height:1.4;background:#f0f4fa;border-radius:3px;padding:1px 3px;flex:none;color:var(--muted)}.completion{font-size:12px;font-weight:400;color:var(--muted);white-space:nowrap}.completion.done{color:#446ba6}.queue .completion.done{font-size:0;min-width:13px;text-align:center}.queue .completion.done:before{content:"✓";font-size:14px}.cache-note{font-size:12px;color:var(--muted);padding-top:10px;text-align:right}
        .settings-heading{font-size:12px;color:var(--muted);margin:0 0 7px}.mode-switch{display:flex;gap:3px;padding:3px;background:#f0f4fb;border-radius:7px}.mode-switch button{flex:1;padding:7px 4px;border-radius:5px;font-size:14px;background:transparent;color:var(--muted)}.mode-switch button[aria-pressed="true"]{background:#fff;color:var(--blue-dark);box-shadow:0 1px 3px #203b6512}.options{display:grid;gap:12px;padding:0 0 14px}.option{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:14px;cursor:pointer}.option input{appearance:none;-webkit-appearance:none;width:28px;height:16px;background:#d3ddec;border-radius:10px;position:relative;margin:0;cursor:pointer;flex:none}.option input:before{content:"";position:absolute;width:10px;height:10px;top:3px;left:3px;border-radius:50%;background:#fff;transition:transform .15s}.option input:checked{background:var(--blue)}.option input:checked:before{transform:translateX(12px)}.option input:disabled{opacity:.4;cursor:default}
        .configuration{border-top:1px solid var(--line);padding:12px 0 0;font-size:14px}.configuration h3{font-size:14px;font-weight:600;margin:0 0 10px}.config-row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px}.config-row input{width:66px;padding:5px 7px;border:1px solid #d9e3f2;border-radius:6px;color:var(--ink);background:#fff;font-size:14px}.config-row input:disabled{background:#f3f6fb;color:var(--muted)}.config-note{font-size:12px;color:var(--muted);margin:9px 0 0;line-height:1.7}.config-error{font-size:12px;color:#ac4d32;margin:7px 0 0}.config-error:empty{display:none}.configuration .text-button{margin-top:5px}
        .empty-state{text-align:center;padding:16px 6px 20px}.empty-symbol{width:35px;height:35px;display:grid;place-items:center;border-radius:8px;background:#edf3ff;color:var(--blue);margin:0 auto 12px}.empty-state strong{font-size:16px}.empty-state p{font-size:14px;color:var(--muted);margin:6px 0 0}.empty-refresh{display:inline-block;margin-top:12px;background:#edf3ff;color:var(--blue-dark);padding:6px 12px;border-radius:7px;font-size:14px}
        .task-step,.next-link,.queue-link{background:transparent;border:0;text-align:left}.queue-link{width:100%}.next-link{padding:0}.task-step:disabled,.next-link:disabled{opacity:1}.footer-info{display:flex;align-items:center;gap:8px}.build{font-size:12px;color:var(--muted)}
        .settings-section{padding:13px 0;border-top:1px solid var(--line)}.settings-section h3{font-size:14px;font-weight:600;margin:0 0 9px}.settings-section h3 small{font-size:12px;font-weight:400;color:var(--muted);margin-left:7px}.minute-input{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:12px}.minute-input input{width:65px}.item-override{border-left:2px solid #b9d0fa;margin-top:12px;padding:1px 0 0 10px}.item-name{font-size:12px;color:#536987;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;margin-bottom:5px}.item-override .config-row{margin-top:5px}.settings-section .options{padding:0;gap:13px}
        .learning-mode{margin:0 0 13px}.learning-mode .mode-switch button{font-size:14px}.learning-mode .settings-title{font-size:15px;margin:0 0 4px;font-weight:600}.footer{justify-content:flex-end;border:0;padding:4px 0 8px}.settings-section[data-single="true"] .item-override{border:0;margin:0;padding:0}
        .neighbors{display:grid;gap:7px;margin-top:12px}.neighbor{display:flex;align-items:center;gap:9px;width:100%;min-height:37px;padding:9px 11px;background:#f2f6fd;border:0;border-radius:7px;text-align:left;color:#405b86}.neighbor:hover:not(:disabled){background:#e6efff}.neighbor-label{font-size:12px;color:var(--muted);white-space:nowrap;flex:none}.neighbor-name{font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}.neighbor:disabled{opacity:1;cursor:default;background:#f8f9fc;color:#8a97ac}
        @media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}@media(max-width:380px){.course{padding-left:12px;padding-right:12px;gap:4px}.shell{width:calc(100vw - 24px)}.history{flex-wrap:wrap}.history small{white-space:normal}.tabs{gap:22px}}

        .queue-picker{padding:0 0 14px}.queue-resource-row{display:flex;align-items:center;justify-content:space-between;gap:8px}.resource-choices{display:flex;flex-wrap:wrap;gap:6px}.resource-choice{display:flex;align-items:center;gap:5px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;font-size:14px;cursor:pointer}.resource-choice:has(input:checked){background:#edf4ff;border-color:#a9c9ff;color:var(--blue-dark)}.resource-choice input{width:15px;height:15px;accent-color:var(--blue);margin:0}.queue-count{font-size:14px;white-space:nowrap;font-variant-numeric:tabular-nums}.queue-picker .config-row{margin-top:8px}.task.completed{text-align:center;padding:26px 12px}.task.completed .track-top{justify-content:center}.task.completed .title{color:var(--blue-dark);font-size:20px;display:block}
        .study-times{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px;font-size:14px;color:var(--muted)}.study-times>div{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:4px}.study-times strong{font-size:15px;color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums}
    </style>
    <button class="launcher" data-launcher aria-label="展开学习助手" aria-expanded="false" aria-controls="xy-helper-panel" title="点击展开；拖动移动"><span data-launcher-icon data-icon="assistant">${icons.assistant}</span><i class="signal" aria-hidden="true"></i></button>
    <div class="shell" id="xy-helper-panel" data-running="false" role="region" aria-label="学习助手面板" tabindex="0">
        <span class="sr-only" data-state role="status" aria-live="polite">未开始</span>
        <div class="course" data-course-header data-drag title="拖动课程名称可移动面板"><strong data-course-name>正在确认登录状态…</strong><div class="course-controls"><div class="panel-scroll-controls" role="group" aria-label="面板滚动"><button type="button" class="icon-button" data-panel-scroll="up" aria-label="向上滚动面板" title="向上滚动">${icons.expand}</button><button type="button" class="icon-button" data-panel-scroll="down" aria-label="向下滚动面板" title="向下滚动">${icons.expand}</button></div><button class="icon-button" data-collapse aria-label="收起面板" aria-expanded="true">${icons.collapse}</button></div></div>
        <nav class="tabs" data-tabs role="tablist" aria-label="助手页面"><button class="tab" id="xy-tab-learning" data-tab="learning" role="tab" aria-selected="true" aria-controls="xy-view-learning">学习</button><button class="tab" id="xy-tab-list" data-tab="list" role="tab" aria-selected="false" aria-controls="xy-view-list" title="查看本课程全部学习任务">全部<span class="tab-count" data-list-total></span></button><button class="tab" id="xy-tab-settings" data-tab="settings" role="tab" aria-selected="false" aria-controls="xy-view-settings">设置</button></nav>
        <div class="body">
            <div class="notice" data-status role="status" aria-live="polite"></div>
            <section class="view" data-view="learning" id="xy-view-learning" role="tabpanel" aria-labelledby="xy-tab-learning">
                <div class="empty-state" data-empty-state hidden><div class="empty-symbol" aria-hidden="true">${icons.play}</div><strong data-empty-title>请先登录</strong><p data-empty-description>登录完成后，助手会自动识别课程。</p><button class="empty-refresh" data-empty-retry>重新检测</button></div>
                <div data-study-content>
                    <div class="learning-mode"><div class="mode-switch" role="group" aria-label="学习模式"><button data-learning-mode="single" aria-pressed="false">单项学习</button><button data-learning-mode="continuous" aria-pressed="true">连续学习</button></div></div>
                    <section class="queue-picker" data-queue-picker role="group" aria-label="播放队列选择">
                        <div class="queue-resource-row"><div class="resource-choices"><label class="resource-choice"><input type="checkbox" data-resource-kind="videos" aria-label="学习视频"><span>视频</span></label><label class="resource-choice"><input type="checkbox" data-resource-kind="other" aria-label="学习其他资料"><span>其他资料</span></label></div><span class="queue-count" data-queue-count aria-label="可播放队列数量" aria-live="polite">0 项</span></div>
                        <div data-continuous-settings><label class="config-row"><span>学习范围</span><select data-queue-policy aria-label="连续学习队列范围"><option value="all">全部</option><option value="unfinished" selected>未完成</option></select></label></div><p class="config-error" data-queue-error role="status"></p>
                    </section>
                    <div class="task"><div class="track-top"><span data-task-heading>当前任务</span><span class="track-number" data-index>— / —</span></div>
                    <div class="task-meta" data-task-meta><span class="task-kind" data-kind>视频</span><span class="completion" data-completion>待检测</span></div>
                    <div class="title" data-title>准备好，开始这一节</div>
                    <div data-timeline><div class="time"><span data-elapsed>00:00</span><span>/</span><span data-duration>00:00</span><span class="progress-percent" data-percent>0%</span></div><progress data-progress max="100" value="0" aria-label="当前任务进度"></progress></div>
                    </div>
                    <div class="actions" role="group" aria-label="当前资源学习控制"><button class="primary" data-start><span class="action-icon" data-action-icon>${icons.play}</span><span data-action-label>开始学习</span></button><button class="stop" data-stop aria-label="停止本次学习" title="停止本次学习">${icons.stop}<span>停止</span></button></div>
                    <div class="study-times" aria-label="本地学习时长"><div><span>本次学习时长</span><strong data-session-duration>00:00:00</strong></div><div><span>今日学习时长</span><strong data-today-duration>00:00:00</strong></div></div>
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
                <h2 class="settings-title">学习设置</h2>


                <section class="settings-section configuration" data-configuration aria-labelledby="xy-duration-heading"><h3 id="xy-duration-heading">非视频停留时间</h3><label class="config-row" data-default-settings><span>全局默认停留</span><span class="minute-input"><input data-default-minutes type="number" min="2" max="1440" step="1" value="2" aria-label="当前用户全局非视频默认停留时间，分钟"><span>分钟</span></span></label><div class="item-override" data-item-settings hidden><div class="item-name" data-item-name></div><label class="config-row"><span>本项停留</span><span class="minute-input"><input data-resource-minutes type="number" min="2" max="1440" step="1" placeholder="默认" aria-label="当前非视频任务单独停留时间，分钟"><span>分钟</span></span></label><button class="text-button" data-reset-resource>恢复全局默认</button></div><p class="config-error" data-config-error role="status"></p></section>
                <section class="settings-section" aria-labelledby="xy-playback-heading"><h3 id="xy-playback-heading">播放偏好</h3><div class="options"><label class="option"><span>静音播放</span><input type="checkbox" data-mute aria-label="静音播放"></label><label class="option"><span>后台继续</span><input type="checkbox" data-background aria-label="切换标签页后继续学习"></label></div></section>

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
    const queuePolicyInput = find('[data-queue-policy]');
    const startButton = find('[data-start]');
    const stopButton = find('[data-stop]');
    const collapseButton = find('[data-collapse]');
    muteInput.checked = muted;
    backgroundInput.checked = background;
    queuePolicyInput.value = skipCompleted ? 'unfinished' : 'all';
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
        if (allSelectedCompleted()) return 'completed';
        if (!loading && !completionBusy && settings.mode === 'continuous' && skipCompleted && queue.length && !playbackQueue().length) return 'noPending';
        if (navigation) return 'jumping';
        const node = currentNode();
        if (sessionEnded) return 'ended';
        if (!node && settings.mode === 'single' && !loading && !resumeResource()) return 'selectResource';
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
        updateStudyClock();
        const studyCourse = route()?.course;
        find('[data-session-duration]').textContent = formatStudyTime(studySession?.account === auth.id && studySession.course === studyCourse ? studySession.elapsedMs : 0);
        find('[data-today-duration]').textContent = formatStudyTime(todayStudyMs());
        const current = route();
        const index = queue.findIndex(node => String(node.id) === current?.node);
        const node = queue[index];
        const resume = !current?.node ? resumeResource() : null;
        const displayNode = node || resume;
        const remembered = resume && playbackMemory.resources[String(resume.id)];
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
        find('[data-title]').textContent = navigation?.name || displayNode?.name || (confirmed ? '请选择学习资料' : auth.state === 'signedOut' ? '请先登录' : '请选择课程');
        find('[data-kind]').textContent = displayNode ? !isVideo(displayNode) ? `${resourceKind(displayNode)} · 停留 ${targetDocumentMs(displayNode) / 60000} 分钟` : '视频' : '待选择';
        const displayIndex = displayNode ? queue.indexOf(displayNode) : -1;
        find('[data-index]').textContent = displayIndex >= 0 ? `${String(displayIndex + 1).padStart(2, '0')} / ${String(queue.length).padStart(2, '0')}` : '— / —';
        const elapsed = timed ? (documentClock?.elapsedMs || 0) / 1000 : node ? video?.currentTime : remembered && !remembered.ended ? remembered.position : 0;
        const duration = timed ? targetDocumentMs(node) / 1000 : node ? video?.duration : resume && !isVideo(resume) ? targetDocumentMs(resume) / 1000 : remembered?.duration;
        find('[data-elapsed]').textContent = formatTime(elapsed);
        find('[data-duration]').textContent = formatTime(duration);
        find('[data-progress]').value = Number.isFinite(duration) && duration > 0 ? Math.min(100, Math.max(0, elapsed / duration * 100)) : 0;
        find('[data-percent]').textContent = `${Math.floor(find('[data-progress]').value)}%`;
        find('[data-timeline]').hidden = !displayNode;
        const completed = allSelectedCompleted();
        find('[data-queue-count]').textContent = `${playbackQueue().length} 项`;
        find('.task').classList.toggle('completed', completed);
        find('[data-task-heading]').textContent = completed ? '学习完成' : completions.get(String(displayNode?.id))?.kind === 'none' ? '当前资料' : '当前任务';
        find('[data-index]').hidden = completed;
        find('[data-task-meta]').hidden = completed;
        if (completed) {
            find('[data-title]').textContent = '恭喜你，已经学完啦！';
            find('[data-timeline]').hidden = true;
        }
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
        const tracked = queue.filter(node => completions.get(String(node.id))?.kind !== 'none');
        const ordinary = queue.length - tracked.length;
        const done = tracked.filter(node => completions.get(String(node.id))?.complete === true).length;
        const unknown = tracked.filter(node => completions.get(String(node.id))?.complete == null).length;
        find('[data-summary]').textContent = queue.length ? [tracked.length ? `已完成 ${done} / ${tracked.length}${unknown ? ` · ${unknown} 项待确认` : ''}` : '',
            ordinary ? `普通资料 ${ordinary} 项` : ''].filter(Boolean).join(' · ') + (completionBusy ? ' · 检测中' : '') : '完成状态以平台记录为准';
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
        states.completed = ['全部完成', '已全部学完', 'play'];
        states.noPending = ['无未完成任务', '无未完成任务', 'play'];
        const [stateText, defaultActionText, icon] = states[mode];
        const actionText = mode === 'stopped' && resume ? '继续上次学习' : defaultActionText;
        shell.dataset.mode = mode;
        launcher.dataset.mode = mode;
        if (find('[data-state]').textContent !== stateText) find('[data-state]').textContent = stateText;
        startButton.disabled = ['noPending', 'completed', 'jumping', 'loading', 'next', 'authChecking', 'signedOut', 'authError', 'selectCourse', 'courseLoading', 'courseError', 'selectResource'].includes(mode) || settings.mode === 'continuous' && skipCompleted && completionBusy;
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
        find('[data-reset-resource]').textContent = `使用全局默认（${settings.documentMinutes} 分钟）`;
        muteInput.closest('.option').hidden = continuous ? !hasVideo : !node || timed;
        queuePolicyInput.disabled = configDisabled || settings.mode === 'single';
        for (const input of ui.querySelectorAll('[data-resource-kind]')) input.disabled = configDisabled;
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
        if (activeTab !== name) shell.scrollTop = 0;
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
        queuePolicyInput.value = settings.skipCompleted ? 'unfinished' : 'all';
        for (const input of ui.querySelectorAll('[data-resource-kind]')) input.checked = settings.resourceKinds[input.dataset.resourceKind];
    }
    function clampPosition(x, y) {
        return { x: Math.max(12, Math.min(x, Math.max(12, innerWidth - 60))),
            y: Math.max(12, Math.min(y, Math.max(12, innerHeight - 60))) };
    }
    let minimumPanelHeight = 480;
    function place() {
        if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
            position = { x: innerWidth - 72, y: innerHeight * 0.12 };
        }
        position = clampPosition(position.x, position.y);
        Object.assign(panel.style, { left: `${position.x}px`, top: `${position.y}px`, right: 'auto', bottom: 'auto' });
        const bounds = shell.getBoundingClientRect();
        const width = bounds.width || Math.min(380, Math.max(0, innerWidth - 24));
        const actions = find('.actions').getBoundingClientRect();
        if (!collapsed && activeTab === 'learning' && actions.bottom + shell.scrollTop > bounds.top) {
            minimumPanelHeight = Math.ceil(actions.bottom - bounds.top + shell.scrollTop + 12);
        }
        const available = Math.max(48, innerHeight - 24);
        const minimum = Math.min(minimumPanelHeight, available);
        const preferredX = position.x < innerWidth / 2 ? position.x + 60 : position.x - width - 12;
        const x = Math.max(12, Math.min(preferredX, innerWidth - width - 12));
        const y = Math.max(12, Math.min(position.y, innerHeight - minimum - 12));
        shell.style.left = `${x - position.x}px`;
        shell.style.top = `${y - position.y}px`;
        shell.style.minHeight = `${minimum}px`;
        shell.style.maxHeight = `${Math.max(minimum, innerHeight - y - 12)}px`;
    }
    for (const button of ui.querySelectorAll('[data-panel-scroll]')) {
        button.onclick = () => {
            shell.scrollBy({ top: (button.dataset.panelScroll === 'up' ? -1 : 1) * Math.max(100, shell.clientHeight * 0.7),
                behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        };
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
        panelSizeObserver.observe(find('.task'));
        panelSizeObserver.observe(find('[data-queue-picker]'));
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
    function handleFilePreviewConfirmation(node) {
        const normalize = text => String(text || '').replace(/\s/g, '');
        const scope = document.querySelector('.group-resource-body');
        const confirmation = scope && [...scope.querySelectorAll('.ant-result')].find(element => visible(element) &&
            normalize(element.querySelector('.ant-result-title')?.textContent) === '文件预览确认' &&
            /^是否确认打开文件[：:]/.test(normalize(element.querySelector('.ant-result-subtitle')?.textContent)));
        if (!confirmation) {
            documentClock.previewConfirmation = null;
            return false;
        }
        documentClock.ready = false;
        updateDocumentClock(false);
        if (nextTimer || advancing) {
            generation++;
            clearTimeout(nextTimer);
            nextTimer = null;
            advancing = false;
        }
        const filename = normalize(confirmation.querySelector('.ant-result-subtitle').textContent).replace(/^是否确认打开文件[：:]/, '');
        if (node.name && filename !== normalize(node.name)) {
            report('正在等待当前资料的预览确认页…');
            return true;
        }
        const button = [...confirmation.querySelectorAll('.ant-result-extra button')].find(element =>
            /^(确定|确认)$/.test(normalize(element.textContent)) && visible(element));
        if (!running) { finishNavigation(); return true; }
        if (hasOpenDialog()) return true;
        if (!button) { report('未找到文件预览确认按钮，请手动确认。'); return true; }
        if (button.disabled || button.getAttribute('aria-disabled') === 'true' || button.classList.contains('ant-btn-loading')) return true;
        const retry = documentClock.previewConfirmation ||= { attempts: 0, lastAt: -Infinity };
        if (Date.now() - retry.lastAt < 3000) return true;
        if (retry.attempts >= 3) {
            stop('文件预览确认失败，请手动确认后继续学习。');
            return true;
        }
        retry.attempts++;
        retry.lastAt = Date.now();
        button.click();
        report('已确认打开文件，正在等待预览加载…');
        return true;
    }
    function processDocument() {
        const current = route(), node = currentNode();
        if (!node || isVideo(node)) return;
        if (!documentClock || documentClock.node !== current.node || documentClock.course !== current.course) {
            documentClock = { course: current.course, node: current.node, elapsedMs: 0, lastAt: null, ready: false };
        }
        if (handleFilePreviewConfirmation(node)) { updateView(); return; }
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
            savePlaybackPosition(true);
            video.removeEventListener('ended', endedListener);
            for (const event of ['loadedmetadata', 'loadeddata', 'canplay', 'seeked']) video.removeEventListener(event, readyListener);
            video.removeEventListener('pause', pauseListener);
            video.removeEventListener('play', playListener);
            video.removeEventListener('timeupdate', progressListener);
        }
        video = null;
        videoProgress = null;
        playPending = false;
        waitingForVideoReady = false;
        backgroundIntent = false;
        clearTimeout(backgroundTimer);
        backgroundTimer = null;
    }
    function stop(message = '已停止', paused = false, ended = false) {
        updateDocumentClock(running);
        updateStudyClock();
        if (studySession && !paused) { studySession.open = false; saveStudySession(); }
        studySample = null;
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
        updateStudyClock();
        studySample = null;
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
            return (queueFilter === 'all' || (queueFilter === 'completed' ? done : !done && completions.get(String(node.id))?.kind !== 'none')) &&
                (!term || String(node.name || node.id).normalize('NFKC').toLocaleLowerCase().includes(term));
        });
    }
    function showQueue() {
        const previousScroll = shell.scrollTop;
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
        shell.scrollTop = previousScroll;
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
            badge.title = state?.kind === 'none' ? '普通资料没有完成任务，不需要检测完成状态' : state?.kind === 'taskInfo' ? '存在任务信息，但缺少有效任务标识，暂不查询完成接口' : state?.error ? '状态读取失败，点击“刷新状态”重试' : state?.hasTask
                ? '任务完成状态以平台返回的 finished 字段为准'
                : '根据平台已记录的观看时长计算';
        }
        updateView();
    }
    function resetCourseContext(course) {
        updateDocumentClock(running);
        documentClock = null;
        if (video && !video.paused) video.pause();
        if (video && (route()?.course !== videoProgress?.course || route()?.node !== videoProgress?.node)) {
            outgoingVideo = video; outgoingSource = videoProgress?.source || video.currentSrc || '';
        }
        detachVideo();
        generation++;
        courseEpoch++;
        completionEpoch++;
        observedCourse = course;
        courseResources = [];
        queue = [];
        queueSearch = '';
        queueFilter = 'all';
        find('[data-search]').value = '';
        for (const filter of ui.querySelectorAll('[data-filter]')) filter.setAttribute('aria-pressed', String(filter.dataset.filter === 'all'));
        shell.scrollTop = 0;
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
        playbackMemory = auth.state === 'ready' && course ? readPlaybackMemory(course) : { resources: {} };
        if (course && auth.state === 'ready') loadSettings(course);
        else { settings = normalizeSettings(); skipCompleted = settings.skipCompleted; syncSettingsInputs(); }
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
                const task = taskIdentifier(node);
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
                const state = { ...completionState(node), complete: null, percent: previous?.percent ?? null, error: true, checkedAt: Date.now() };
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
            if (epoch === completionEpoch) { completionBusy = false; reconcilePlaybackQueue(); updateCompletionBadges(); }
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
        courseResources = nodes;
        queue = nodes.filter(selectedResource);
        queueCourse = course;
        completionEpoch++;
        completionBusy = false;
        completions.clear();
        const states = new Map(cachedStates);
        for (const node of courseResources) {
            const id = String(node.id), cached = states.get(id);
            const initial = completionState(node, taskIdentifier(node) != null ? node : node.watchRecord || node);
            completions.set(id, cached && cached.kind === initial.kind && Date.now() - cached.checkedAt < STATUS_TTL ? cached : initial);
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
        if (!restorePlaybackPosition()) { waitingForVideoReady = true; return; }
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
            report(document.hidden ? '后台播放中' : '播放中');
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
        if (document.hidden) savePlaybackPosition(true);
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
        const endingMessage = completions.get(nodeId)?.kind === 'none' ? '本次资料浏览已结束。' : '当前项已结束，正在确认平台记录。';
        report(settings.mode === 'single' ? endingMessage
            : next ? delay ? `视频结束，5 秒后切换：${next.name}` : `计划停留已结束，正在切换：${next.name}` : endingMessage);
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
                    stop(state?.kind === 'none' ? '本次资料浏览已结束。' : state?.complete === true ? '本次学习已结束，平台记录已完成。'
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
        if (found && found === outgoingVideo && (found.currentSrc || '') === outgoingSource) return;
        if (found === video && (!found || videoProgress?.source === (found.currentSrc || ''))) {
            if (found) { restorePlaybackPosition(); savePlaybackPosition(); }
            // A cached/seeked player can become ready without another loadeddata event.
            if (running && (navigation || waitingForVideoReady) && !resumeAfterDialog && !hasOpenDialog()) playCurrent();
            return;
        }
        detachVideo();
        if (!found) return;
        video = found;
        outgoingVideo = null;
        outgoingSource = '';
        const current = route();
        videoProgress = { course: current.course, node: current.node, account: auth.id, scope: cacheScope,
            source: found.currentSrc || '', restored: false, restoring: false, started: !found.paused, sample: null, lastWriteAt: 0 };
        endedListener = () => { savePlaybackPosition(true); scheduleNext(found); };
        readyListener = event => {
            if (video !== found || videoProgress?.restoring || found.readyState < 1 || !restorePlaybackPosition()) return;
            if (event.type === 'seeked') {
                if (videoProgress.restoreSeek == null || Math.abs(found.currentTime - videoProgress.restoreSeek) > 1) {
                    videoProgress.started = true;
                    savePlaybackPosition(true);
                }
                videoProgress.restoreSeek = null;
            }
            if (!running) { finishNavigation(); updateView(); }
            else if ((navigation || waitingForVideoReady) && !resumeAfterDialog && !hasOpenDialog()) playCurrent();
            updateView();
        };
        pauseListener = () => {
            savePlaybackPosition(true);
            if (running && background && backgroundIntent && document.hidden) {
                queueBackgroundRecovery();
            } else if (!document.hidden) {
                backgroundIntent = false;
                if (running && !found.ended && !resumeAfterDialog) report('视频已暂停，点击“继续学习”即可继续。');
            }
            updateView();
        };
        playListener = () => {
            restorePlaybackPosition();
            videoProgress.started = true;
            savePlaybackPosition();
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
        progressListener = () => savePlaybackPosition();
        found.addEventListener('timeupdate', progressListener);
        restorePlaybackPosition();
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
            if (video) { outgoingVideo = video; outgoingSource = videoProgress?.source || video.currentSrc || ''; }
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
        if (currentNode() && isVideo(currentNode()) && courseInfo.state === 'ready') bindVideo();
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
        if (settings.mode === 'single' && !currentNode() && !resumeResource()) { report('请先从列表选择一项学习资料。'); return; }
        if (sessionEnded) {
            if (documentClock) { documentClock.elapsedMs = 0; documentClock.lastAt = null; }
            if (video) video.currentTime = 0;
        }
        sessionEnded = false;
        resourceFailure = '';
        activeCourse = current.course;
        beginStudySession(current.course);
        if (documentClock) documentClock.previewConfirmation = null;
        running = true;
        userPaused = false;
        persist();
        if (!currentNode() || settings.mode === 'continuous' && skipCompleted && !playbackQueue().some(node => String(node.id) === current.node)) {
            const target = (!current.node ? resumeResource() : null) || playbackQueue()[0];
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
    find('[data-search]').oninput = event => { queueSearch = event.target.value; shell.scrollTop = 0; showQueue(); };
    for (const filter of ui.querySelectorAll('[data-filter]')) {
        filter.onclick = () => {
            queueFilter = filter.dataset.filter;
            for (const item of ui.querySelectorAll('[data-filter]')) item.setAttribute('aria-pressed', String(item === filter));
            shell.scrollTop = 0;
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
    function changeSettings(change, rebuildQueue = false) {
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
        if (rebuildQueue) {
            applyQueue(courseResources, queueCourse, [...completions]);
            if (running && !currentNode()) stop('当前资料已移出学习队列，请选择其他资料后继续。');
            writeCache();
        }
        syncSettingsInputs();
        find('[data-config-error]').textContent = '';
        reconcilePlaybackQueue();
        if (running) {
            const node = currentNode();
            if (node && !isVideo(node)) processDocument();
            else if (video?.ended) scheduleNext(video);
        } else report('学习设置已保存。');
        updateView();
        place();
    }
    for (const button of ui.querySelectorAll('[data-learning-mode]')) {
        button.onclick = () => changeSettings(() => { settings.mode = button.dataset.learningMode; });
    }
    find('[data-default-minutes]').onchange = event => {
        if (!validMinutes(event.target.value)) { find('[data-config-error]').textContent = '请输入 2 至 1440 的整数分钟数。'; return; }
        changeSettings(() => {
            settings.documentMinutes = Number(event.target.value);
            saveUserDocumentMinutes(settings.documentMinutes);
        });
    };
    find('[data-resource-minutes]').onchange = event => {
        const node = currentNode();
        if (!node || isVideo(node)) return;
        const value = event.target.value;
        if (value !== '' && !validMinutes(value)) { find('[data-config-error]').textContent = '请输入 2 至 1440 的整数分钟数，留空使用全局默认。'; return; }
        changeSettings(() => {
            if (value === '') delete settings.resourceMinutes[String(node.id)];
            else settings.resourceMinutes[String(node.id)] = Number(value);
        });
    };
    find('[data-reset-resource]').onclick = () => {
        const node = currentNode();
        if (node) changeSettings(() => { delete settings.resourceMinutes[String(node.id)]; });
    };
    queuePolicyInput.onchange = () => changeSettings(() => { settings.skipCompleted = queuePolicyInput.value === 'unfinished'; });
    for (const input of ui.querySelectorAll('[data-resource-kind]')) {
        input.onchange = () => {
            const kinds = { ...settings.resourceKinds, [input.dataset.resourceKind]: input.checked };
            if (!Object.values(kinds).some(Boolean)) {
                input.checked = true;
                find('[data-queue-error]').textContent = '至少选择一种学习资料类型。';
                return;
            }
            find('[data-queue-error]').textContent = '';
            changeSettings(() => { settings.resourceKinds = kinds; }, true);
        };
    }
    muteInput.onchange = () => { muted = muteInput.checked; persist(); if (video) video.muted = muted; };
    backgroundInput.onchange = () => {
        background = backgroundInput.checked;
        backgroundIntent = background && running && !!video && !video.paused && document.hidden;
        backgroundAttempts = 0;
        lastBackgroundAttempt = 0;
        if (!background) { clearTimeout(backgroundTimer); backgroundTimer = null; }
        persist();
    };
    window.addEventListener('storage', event => {
        if (auth.state !== 'ready' || event.key !== userDefaultsKey() || event.storageArea !== localStorage) return;
        let minutes;
        try { minutes = event.newValue == null ? 2 : JSON.parse(event.newValue)?.documentMinutes; }
        catch { return; }
        if (!validMinutes(minutes)) return;
        updateDocumentClock(running && !hasOpenDialog());
        settings.documentMinutes = Number(minutes);
        syncSettingsInputs();
        if (running && currentNode() && !isVideo(currentNode())) processDocument();
        updateView();
        place();
    });
    report(running ? '正在加载学习资料…' : '进入课程后自动检测，点击主按钮开始学习。');
    window.addEventListener('pagehide', () => {
        updateDocumentClock(running);
        updateStudyClock();
        saveStudySession();
        studySample = null;
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
