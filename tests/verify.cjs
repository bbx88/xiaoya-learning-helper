const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setup } = require('./fixture.cjs');

test('switching tabs recovers from the actual platform hidden-page pause', async () => {
    const env = await setup();
    await env.start();
    assert.equal(env.video.paused, false);
    env.hide();
    await env.timers();
    await env.tick();
    assert.equal(env.video.paused, false, 'A playing video must resume after the platform pauses it on visibilitychange');
    env.dom.window.close();
});

test('manually paused videos remain paused when hidden', async () => {
    const env = await setup();
    await env.start();
    env.video.pause();
    env.hide();
    await env.timers(); await env.tick();
    assert.equal(env.video.paused, true);
    env.dom.window.close();
});

test('background option can be disabled and stop cancels scheduled recovery', async () => {
    const env = await setup();
    await env.start();
    const option = env.ui.querySelector('[data-background]');
    assert.ok(option);
    option.checked = false; option.dispatchEvent(new env.win.Event('change'));
    env.hide(); await env.timers(); await env.tick();
    assert.equal(env.video.paused, true);
    env.ui.querySelector('[data-stop]').click();
    assert.equal(env.video.paused, true);
    env.dom.window.close();
});

test('UI removes the independent playback tab and keeps progress and collapse', async () => {
    const env = await setup();
    await env.start(); await env.tick();
    assert.equal(env.ui.querySelector('[data-independent]'), null);
    assert.ok(env.ui.querySelector('[data-refresh]'));
    assert.equal(env.ui.querySelector('[data-progress]').value, 20);
    const collapse = env.ui.querySelector('[data-collapse]');
    const launcher = env.ui.querySelector('[data-launcher]');
    collapse.click(); assert.equal(launcher.getAttribute('aria-expanded'), 'false');
    launcher.click(); assert.equal(launcher.getAttribute('aria-expanded'), 'true');
    env.dom.window.close();
});

test('stop cancels the pending next-video timer', async () => {
    const env = await setup();
    await env.start(); env.end();
    assert.equal([...env.timeouts.values()].filter(t => t.delay === 5000).length, 1);
    env.ui.querySelector('[data-stop]').click();
    assert.equal([...env.timeouts.values()].filter(t => t.delay === 5000).length, 0);
    env.dom.window.close();
});

test('inactivity dialog is confirmed before background playback resumes', async () => {
    const env = await setup();
    await env.start();
    const dialog = env.win.document.createElement('div');
    dialog.className = 'ant-modal';
    dialog.innerHTML = '<p>长时间未操作，已停止记录学习时长</p><button>继续学习</button>';
    let clicked = false;
    dialog.querySelector('button').onclick = () => { clicked = true; dialog.remove(); };
    env.win.document.body.appendChild(dialog);
    env.hide(); await env.timers();
    assert.equal(env.video.paused, true, 'Do not resume under a dialog');
    await env.tick();
    assert.equal(clicked, true);
    assert.equal(env.video.paused, true, 'Wait for the dialog to close');
    await env.tick();
    assert.equal(env.video.paused, false);
    env.dom.window.close();
});

test('blocked background autoplay has bounded retries', async () => {
    const env = await setup();
    await env.start();
    env.rejectPlay();
    let now = Date.now();
    env.win.Date.now = () => now;
    env.hide(); await env.timers();
    for (let i = 0; i < 10; i++) { now += 4000; await env.tick(); }
    assert.equal(env.playCount(), 4, 'One initial play and at most three background retries');
    assert.match(env.ui.querySelector('[data-status]').textContent, /手动点击/);
    env.dom.window.close();
});

test('leaving the video route stops playback', async () => {
    const env = await setup();
    await env.start();
    env.win.history.replaceState({}, '', '/app/jx-web/mycourse/100/task');
    await env.tick();
    assert.equal(env.video.paused, true);
    assert.equal(env.ui.querySelector('[data-stop]').disabled, true);
    env.dom.window.close();
});

test('completion uses server task status and watched duration, never the playback position', () => {
    const { completionState, completionLabel, nextVideo } = require('../xiaoya-video.user.js');
    const task = { id: '301', task_id: 't1' };
    const awaiting = completionState(task, { finished: false, watchRecord: { duration: 600, watched_duration: 600 } });
    assert.equal(awaiting.complete, false);
    assert.equal(completionLabel(awaiting), '待提交');
    assert.equal(completionState(task, { finished: true }).complete, true);
    assert.equal(completionState(task, {}).complete, null);
    assert.equal(completionState({}, { duration: 600, watched_duration: 0, played: 600 }).complete, false);
    assert.equal(completionState({}, { duration: 600, watched_duration: 600 }).complete, true);
    assert.equal(completionState({}, { duration: 0, watched_duration: 600 }).complete, null);
    const nodes = [{ id: '301' }, { id: '302' }, { id: '303' }];
    const states = new Map([['302', { complete: true }], ['303', { complete: null }]]);
    assert.equal(nextVideo(nodes, '301', states, true).id, '303');
    assert.equal(nextVideo(nodes, '301', states, false).id, '302');
});

test('queue loads while stopped, shows completion badges, and only reads platform data', async () => {
    const env = await setup({
        resources: [
            { id: '301', parent_id: '200', type: 9, name: '1.mp4', task_id: 't1' },
            { id: '302', parent_id: '200', type: 9, name: '2.mp4', quote_id: 'q2' }
        ],
        taskStates: { '301': { finished: true } },
        watchStates: { q2: { duration: 600, watched_duration: 120 } }
    });
    await env.open();
    assert.equal(env.playCount(), 0);
    assert.equal(env.ui.querySelector('[data-completion-for="301"]').textContent, '已完成');
    assert.match(env.ui.querySelector('[data-completion-for="302"]').textContent, /已看/);
    assert.match(env.ui.querySelector('[data-summary]').textContent, /已完成 1 \/ 2/);
    assert.ok(env.requests.some(request => request.url.pathname.includes('studentFinishInfo/v2')));
    assert.ok(env.requests.every(request => request.method === 'GET'));
    env.dom.window.close();
});

test('clicking a queue button targets its page and cancels pending automatic navigation', async () => {
    const env = await setup();
    await env.start(); env.end();
    const link = env.ui.querySelector('[data-node="302"]');
    assert.equal(link.tagName, 'BUTTON');
    assert.equal(link.dataset.node, '302');
    link.addEventListener('click', event => event.preventDefault());
    link.click();
    assert.equal([...env.timeouts.values()].filter(timer => timer.delay === 5000).length, 0);
    assert.equal(env.video.paused, true);
    assert.equal(JSON.parse(env.win.sessionStorage.getItem('xy-video-helper-v1')).running, true);
    assert.equal(JSON.parse(env.win.sessionStorage.getItem('xy-video-helper-v1')).navigation.node, '302');
    env.dom.window.close();
});

test('refresh detects a server-side completion change, ending alone does not complete a task', async () => {
    const taskStates = { '301': { finished: false, watchRecord: { duration: 600, watched_duration: 600 } } };
    const env = await setup({ resources: [{ id: '301', parent_id: '200', type: 9, name: '1.mp4', task_id: 't1' }], taskStates });
    await env.start();
    assert.equal(env.ui.querySelector('[data-completion-for="301"]').textContent, '待提交');
    env.end();
    assert.equal(env.ui.querySelector('[data-completion]').textContent, '待提交');
    taskStates['301'] = { finished: true };
    env.ui.querySelector('[data-refresh]').click(); await env.flush();
    assert.equal(env.ui.querySelector('[data-completion-for="301"]').textContent, '已完成');
    assert.equal(env.ui.querySelector('[data-queue-policy]').value, 'unfinished');
    env.dom.window.close();
});

test('failed completion checks remain unknown instead of becoming completed', async () => {
    const env = await setup({
        resources: [{ id: '301', parent_id: '200', type: 9, name: '1.mp4', task_id: 't1' }],
        failPath: 'studentFinishInfo'
    });
    await env.start();
    assert.equal(env.ui.querySelector('[data-completion-for="301"]').textContent, '检测失败');
    assert.match(env.ui.querySelector('[data-summary]').textContent, /已完成 0 \/ 1/);
    assert.equal(env.video.paused, false);
    env.dom.window.close();
});

test('playing shows two pause bars and the same button pauses and resumes', async () => {
    const env = await setup();
    await env.start();
    const action = env.ui.querySelector('[data-start]');
    const icon = env.ui.querySelector('[data-action-icon]');
    assert.equal(action.disabled, false);
    assert.equal(icon.dataset.icon, 'pause');
    assert.equal(icon.querySelectorAll('rect').length, 2);
    assert.equal(env.ui.querySelector('[data-action-label]').textContent, '暂停学习');
    action.click(); await env.flush();
    assert.equal(env.video.paused, true);
    assert.equal(icon.dataset.icon, 'play');
    action.click(); await env.flush();
    assert.equal(env.video.paused, false);
    assert.equal(icon.dataset.icon, 'pause');
    env.dom.window.close();
});

test('manual navigation stays jumping across ticks instead of displaying resume', async () => {
    const env = await setup();
    await env.start();
    const link = env.ui.querySelector('[data-node="302"]');
    link.addEventListener('click', event => event.preventDefault());
    link.click();
    await env.tick(); await env.tick();
    assert.equal(env.ui.querySelector('[data-state]').textContent, '跳转中');
    assert.equal(env.ui.querySelector('[data-action-label]').textContent, '跳转中');
    assert.equal(env.ui.querySelector('[data-start]').disabled, true);
    assert.equal(env.playCount(), 1, 'Do not rebind or replay the outgoing video');
    assert.match(env.ui.querySelector('[data-status]').textContent, /跳转中/);
    env.dom.window.close();
});

test('a persisted navigation remains jumping until its new player starts', async () => {
    const env = await setup({ readyState: 0, saved: {
        course: '100', running: true,
        navigation: { course: '100', node: '301', fromNode: '300', name: '1.mp4', startedAt: Date.now() }
    } });
    await env.flush(); await env.tick();
    assert.equal(env.ui.querySelector('[data-action-label]').textContent, '跳转中');
    env.ready(); await env.flush();
    assert.equal(env.ui.querySelector('[data-state]').textContent, '播放中');
    assert.equal(env.ui.querySelector('[data-action-icon]').dataset.icon, 'pause');
    assert.equal(JSON.parse(env.win.sessionStorage.getItem('xy-video-helper-v1')).navigation, null);
    env.dom.window.close();
});

test('loading and next-video delay have their own disabled action labels', async () => {
    const env = await setup({ readyState: 0 });
    await env.start();
    assert.equal(env.ui.querySelector('[data-action-label]').textContent, '加载中');
    assert.equal(env.ui.querySelector('[data-start]').disabled, true);
    env.ready(); await env.flush();
    env.end();
    assert.equal(env.ui.querySelector('[data-action-label]').textContent, '即将切换');
    env.dom.window.close();
});

test('next then previous resumes a revisited video which becomes ready after the player was bound', async () => {
    const env = await setup({ currentSrc: 'https://media.test/301.mp4' });
    await env.start();
    env.ui.querySelector('[data-step="next"]').click();
    env.win.history.replaceState({}, '', '/app/jx-web/mycourse/100/resource/200/302');
    env.source('https://media.test/302.mp4');
    await env.tick();
    assert.equal(env.ui.querySelector('[data-state]').textContent, '播放中');
    env.ui.querySelector('[data-step="previous"]').click();
    env.win.history.replaceState({}, '', '/app/jx-web/mycourse/100/resource/200/301');
    env.source('https://media.test/301.mp4');
    env.ready(0, 'emptied'); await env.tick();
    // Resume/seek can reach canplay after binding without another loadeddata event.
    env.ready(3, 'canplay'); await env.flush(); await env.tick();
    assert.equal(env.video.paused, false, 'Returning to the earlier video must resume after it becomes playable');
    assert.equal(env.ui.querySelector('[data-state]').textContent, '播放中');
    assert.equal(JSON.parse(env.win.sessionStorage.getItem('xy-video-helper-v1')).navigation, null);
    env.dom.window.close();
});

test('a navigation can request playback after metadata rather than waiting for buffered frames', async () => {
    const env = await setup({ readyState: 1, saved: {
        course: '100', running: true,
        navigation: { course: '100', node: '301', fromNode: '302', name: '1.mp4', startedAt: Date.now() }
    } });
    await env.flush(); await env.tick();
    assert.ok(env.playCount() > 0, 'Playback should request data when only metadata is preloaded');
    assert.equal(JSON.parse(env.win.sessionStorage.getItem('xy-video-helper-v1')).navigation, null);
    env.dom.window.close();
});

test('a bound player which misses readiness events is recovered on the next navigation tick', async () => {
    const env = await setup({ readyState: 0, saved: {
        course: '100', running: true,
        navigation: { course: '100', node: '301', fromNode: '302', name: '1.mp4', startedAt: Date.now() }
    } });
    await env.flush(); await env.tick();
    assert.equal(env.playCount(), 0);
    env.ready(3, 'durationchange'); await env.flush();
    assert.equal(env.playCount(), 0, 'No registered readiness event has fired');
    await env.tick();
    assert.equal(env.video.paused, false);
    assert.equal(JSON.parse(env.win.sessionStorage.getItem('xy-video-helper-v1')).navigation, null);
    env.dom.window.close();
});

test('readiness and seek events do not resume a manually paused video after navigation finished', async () => {
    const env = await setup(); await env.start();
    env.video.pause();
    const count = env.playCount();
    for (const event of ['loadedmetadata', 'loadeddata', 'canplay', 'seeked']) env.ready(4, event);
    await env.flush(); await env.tick();
    assert.equal(env.playCount(), count);
    assert.equal(env.video.paused, true);
    env.dom.window.close();
});

test('floating launcher replaces the extra queue heading and dragging does not toggle it', async () => {
    const env = await setup();
    const launcher = env.ui.querySelector('[data-launcher]');
    assert.equal(launcher.getAttribute('aria-expanded'), 'false');
    await env.open();
    assert.equal(env.ui.querySelector('.shell').hidden, false);
    assert.equal(env.ui.querySelector('[data-queue]'), null);
    assert.equal(env.ui.textContent.includes('视频队列'), false);
    launcher.dispatchEvent(new env.win.MouseEvent('pointerdown', { button: 0, clientX: 100, clientY: 100 }));
    launcher.dispatchEvent(new env.win.MouseEvent('pointermove', { clientX: 130, clientY: 130 }));
    launcher.dispatchEvent(new env.win.MouseEvent('pointerup', { clientX: 130, clientY: 130 }));
    launcher.click();
    assert.equal(launcher.getAttribute('aria-expanded'), 'true');
    launcher.click();
    assert.equal(launcher.getAttribute('aria-expanded'), 'false');
    env.dom.window.close();
});

test('ordinary PPT, self-study PDF and tagged materials join the ordered list while unrelated documents stay out', () => {
    const { buildQueue } = require('../xiaoya-video.user.js');
    const nodes = [
        { id: 'f', type: 1, parent_id: 'root', name: 'chapter' },
        { id: 'v', type: 9, parent_id: 'f', name: '1.mp4' },
        { id: 'p', type: 6, task_type: 1, parent_id: 'f', name: '2.pptx' },
        { id: 'pdf', type: 6, task: { task_type: '1' }, parent_id: 'f', name: '3.pdf' },
        { id: 'note', type: 2, tag: '自主观看', parent_id: 'f', name: '4' },
        { id: 'other', type: 6, parent_id: 'f', name: '5.pptx' },
        { id: 'assignment', type: 7, task_type: 2, parent_id: 'f', name: '6' },
        { id: 'ordinary-pdf', type: 6, parent_id: 'f', name: '7.pdf' }
    ];
    assert.deepEqual(buildQueue(nodes).map(node => node.id), ['v', 'p', 'pdf', 'note', 'other', 'ordinary-pdf']);
});

test('entering the course scores page fetches tasks and historical time before opening the panel', async () => {
    const env = await setup({ url: 'https://whut.ai-augmented.com/app/jx-web/mycourse/100/scores' });
    await env.flush();
    assert.equal(env.ui.querySelector('[data-launcher]').getAttribute('aria-expanded'), 'false');
    assert.ok(env.requests.some(request => request.url.pathname.includes('queryCourseResources')));
    assert.equal(env.ui.querySelectorAll('[data-node]').length, 2);
    assert.equal(env.ui.querySelector('[data-history]').textContent, '41 分钟');
    assert.match(env.ui.querySelector('[data-history-note]').textContent, /次日更新/);
    assert.equal(env.playCount(), 0);
    assert.equal(env.ui.querySelector('[data-elapsed]').textContent, '00:00');
    const request = env.requests.find(item => item.url.pathname.includes('/ads/duration/user'));
    assert.equal(request.url.searchParams.get('client_type'), '3');
    assert.equal(request.url.searchParams.get('user_id'), 'test-user');
    env.dom.window.close();
});

test('PPT waits two minutes, clicks the platform completion control, then advances without changing historical time', async () => {
    const taskStates = { '301': { finished: false } };
    const env = await setup({ taskStates, resources: [
        { id: '301', parent_id: '200', type: 6, task_type: 1, task_id: 'ppt-task', name: '1.pptx' },
        { id: '302', parent_id: '200', type: 9, name: '2.mp4' }
    ] });
    env.win.document.body.insertAdjacentHTML('afterbegin', '<div class="group-resource-header"><div class="header-file">1.pptx</div><div class="ta_icon_btn"><i class="xy_btn_task_normal"></i>点我完成任务</div></div>');
    env.win.document.querySelector('.ta_icon_btn').onclick = () => { taskStates['301'].finished = true; };
    await env.start();
    assert.equal(env.ui.querySelector('[data-state]').textContent, '阅读中');
    assert.equal(env.ui.querySelector('[data-duration]').textContent, '02:00');
    env.advance(119000); await env.tick();
    assert.equal(env.ui.querySelector('[data-elapsed]').textContent, '01:59');
    assert.equal([...env.timeouts.values()].some(timer => timer.delay === 0), false);
    env.advance(1000); await env.tick(); await env.timers();
    assert.equal(env.ui.querySelector('[data-state]').textContent, '跳转中');
    assert.equal(JSON.parse(env.win.sessionStorage.getItem('xy-video-helper-v1')).navigation.node, '302');
    assert.equal(env.ui.querySelector('[data-completion-for="301"]').textContent, '已完成');
    assert.equal(env.ui.querySelector('[data-history]').textContent, '41 分钟');
    assert.equal(env.playCount(), 0);
    env.dom.window.close();
});

test('pausing PPT and inactivity dialogs freeze the dwell timer', async () => {
    const env = await setup({ resources: [
        { id: '301', parent_id: '200', type: 6, task_type: 1, task_id: 'ppt-task', name: '1.pptx' }
    ] });
    await env.start();
    env.advance(30000); await env.tick();
    env.ui.querySelector('[data-start]').click();
    env.advance(60000); await env.tick();
    assert.equal(env.ui.querySelector('[data-elapsed]').textContent, '00:30');
    env.ui.querySelector('[data-start]').click(); await env.flush();
    env.advance(30000); await env.tick();
    assert.equal(env.ui.querySelector('[data-elapsed]').textContent, '01:00');
    const dialog = env.win.document.createElement('div');
    dialog.className = 'ant-modal';
    dialog.innerHTML = '<p>长时间未操作</p><button>继续学习</button>';
    env.win.document.body.appendChild(dialog);
    await env.tick(); env.advance(60000); await env.tick();
    assert.equal(env.ui.querySelector('[data-elapsed]').textContent, '01:00');
    dialog.remove(); await env.tick(); env.advance(30000); await env.tick();
    assert.equal(env.ui.querySelector('[data-elapsed]').textContent, '01:30');
    env.dom.window.close();
});

test('fresh cache survives reload and manual refresh replaces it', async () => {
    const first = await setup(); await first.flush();
    const stored = Object.fromEntries(Array.from({ length: first.win.localStorage.length }, (_, index) => {
        const key = first.win.localStorage.key(index); return [key, first.win.localStorage.getItem(key)];
    }));
    assert.equal(Object.keys(stored).length, 1);
    first.dom.window.close();
    const env = await setup({ localStorage: stored, minutes: 55 }); await env.flush();
    assert.equal(env.requests.some(request => request.url.pathname.includes('queryCourseResources')), false);
    assert.equal(env.requests.some(request => request.url.pathname.includes('/ads/duration/user')), false);
    assert.equal(env.ui.querySelector('[data-history]').textContent, '41 分钟');
    env.ui.querySelector('[data-refresh]').click(); await env.flush();
    assert.ok(env.requests.some(request => request.url.pathname.includes('queryCourseResources')));
    assert.equal(env.ui.querySelector('[data-history]').textContent, '55 分钟');
    env.dom.window.close();
    const other = await setup({ localStorage: stored, cookie: 'prd-access-token=other-account' }); await other.flush();
    assert.ok(other.requests.some(request => request.url.pathname.includes('queryCourseResources')));
    other.dom.window.close();
});

test('login and course selection have distinct empty states without fetching course data', async () => {
    const guest = await setup({ cookie: '' }); await guest.flush();
    assert.equal(guest.ui.querySelector('[data-course-name]').textContent, '请先登录');
    assert.equal(guest.ui.querySelector('[data-start]').disabled, true);
    assert.equal(guest.requests.length, 0);
    guest.dom.window.close();
    const home = await setup({ url: 'https://whut.ai-augmented.com/app/jx-web/mycourse' }); await home.flush();
    assert.equal(home.ui.querySelector('[data-course-name]').textContent, '请选择课程');
    assert.equal(home.ui.querySelector('[data-start]').disabled, true);
    assert.equal(home.requests.filter(request => request.url.pathname.includes('queryCourseResources')).length, 0);
    home.dom.window.close();
});

test('network authentication failures are not presented as logged out, and course access failure is distinct', async () => {
    const network = await setup({ failPath: '/oauth2/info' }); await network.flush();
    assert.equal(network.ui.querySelector('[data-state]').textContent, '连接失败');
    assert.match(network.ui.querySelector('[data-status]').textContent, /无法确认登录状态/);
    assert.equal(network.ui.querySelector('[data-start]').disabled, true);
    network.dom.window.close();
    const forbidden = await setup({ failPath: '/group/queryGroup/', failStatus: 403 }); await forbidden.flush();
    assert.match(forbidden.ui.querySelector('[data-status]').textContent, /无权/);
    assert.equal(forbidden.ui.querySelector('[data-state]').textContent, '课程不可用');
    forbidden.dom.window.close();
});

test('switching course replaces the name, clears the old progress and loads that course settings', async () => {
    const env = await setup({ courseNames: { '100': '劳动教育', '101': '编译原理' } });
    await env.start();
    assert.equal(env.ui.querySelector('[data-course-name]').textContent, '劳动教育');
    env.ui.querySelector('[data-learning-mode="single"]').click();
    env.win.history.replaceState({}, '', '/app/jx-web/mycourse/101/scores');
    await env.tick();
    assert.equal(env.ui.querySelector('[data-course-name]').textContent, '编译原理');
    assert.equal(env.ui.querySelector('[data-elapsed]').textContent, '00:00');
    assert.equal(env.ui.querySelector('[data-title]').textContent, '请选择学习资料');
    assert.equal(env.ui.querySelector('[data-learning-mode="continuous"]').getAttribute('aria-pressed'), 'true');
    env.win.history.replaceState({}, '', '/app/jx-web/mycourse/100/scores'); await env.tick();
    assert.equal(env.ui.querySelector('[data-learning-mode="single"]').getAttribute('aria-pressed'), 'true');
    assert.equal(env.ui.querySelector('[data-start]').disabled, false);
    assert.equal(env.ui.querySelector('[data-action-label]').textContent, '继续上次学习');
    env.dom.window.close();
});

test('single-resource video ends without navigation and can be explicitly restarted', async () => {
    const env = await setup(); await env.open();
    env.ui.querySelector('[data-learning-mode="single"]').click();
    await env.start(); env.end(); await env.timers(5000);
    assert.equal(env.ui.querySelector('[data-state]').textContent, '本次已结束');
    assert.equal(env.ui.querySelector('[data-action-label]').textContent, '重新开始');
    assert.equal(JSON.parse(env.win.sessionStorage.getItem('xy-video-helper-v1')).navigation, null);
    assert.match(env.ui.querySelector('[data-status]').textContent, /待确认/);
    env.ui.querySelector('[data-start]').click(); await env.flush();
    assert.equal(env.video.currentTime, 0);
    assert.equal(env.video.paused, false);
    assert.equal(env.ui.querySelector('[data-state]').textContent, '播放中');
    env.dom.window.close();
});

test('single-resource PPT ends at its planned duration without moving to the next task', async () => {
    const taskStates = { '301': { finished: false } };
    const env = await setup({ taskStates, resources: [
        { id: '301', parent_id: '200', type: 6, task_type: 1, task_id: 'ppt-task', name: '1.pptx' },
        { id: '302', parent_id: '200', type: 9, name: '2.mp4' }
    ] });
    env.win.document.body.insertAdjacentHTML('afterbegin', '<div class="group-resource-header"><div class="header-file">1.pptx</div><div class="ta_icon_btn"><i class="xy_btn_task_normal"></i>点我完成任务</div></div>');
    env.win.document.querySelector('.ta_icon_btn').onclick = () => { taskStates['301'].finished = true; };
    await env.open(); env.ui.querySelector('[data-learning-mode="single"]').click(); await env.start();
    env.advance(120000); await env.tick(); await env.timers();
    assert.equal(env.ui.querySelector('[data-state]').textContent, '本次已结束');
    assert.equal(JSON.parse(env.win.sessionStorage.getItem('xy-video-helper-v1')).navigation, null);
    assert.equal(env.ui.querySelector('[data-completion-for="301"]').textContent, '已完成');
    env.dom.window.close();
});

test('user default and course resource overrides are saved separately and changes retain accrued dwell time', async () => {
    const resources = [{ id: '301', parent_id: '200', type: 6, task_type: 1, task_id: 'ppt-task', name: '1.pptx' }];
    const env = await setup({ resources }); await env.start();
    env.advance(30000); await env.tick();
    const defaultInput = env.ui.querySelector('[data-default-minutes]');
    defaultInput.value = '5'; defaultInput.dispatchEvent(new env.win.Event('change'));
    assert.equal(env.ui.querySelector('[data-elapsed]').textContent, '00:30');
    assert.equal(env.ui.querySelector('[data-duration]').textContent, '05:00');
    const itemInput = env.ui.querySelector('[data-resource-minutes]');
    itemInput.value = '3'; itemInput.dispatchEvent(new env.win.Event('change'));
    assert.equal(env.ui.querySelector('[data-duration]').textContent, '03:00');
    let saved = JSON.parse(env.win.localStorage.getItem('xy-learning-settings-v1:test-user:100'));
    assert.equal(saved.documentMinutes, undefined);
    assert.equal(JSON.parse(env.win.localStorage.getItem('xy-learning-defaults-v1:test-user')).documentMinutes, 5);
    assert.equal(saved.resourceMinutes['301'], 3);
    defaultInput.value = '1'; defaultInput.dispatchEvent(new env.win.Event('change'));
    assert.match(env.ui.querySelector('[data-config-error]').textContent, /2 至 1440/);
    assert.equal(env.ui.querySelector('[data-duration]').textContent, '03:00');
    env.ui.querySelector('[data-reset-resource]').click();
    saved = JSON.parse(env.win.localStorage.getItem('xy-learning-settings-v1:test-user:100'));
    assert.equal(saved.resourceMinutes['301'], undefined);
    assert.equal(env.ui.querySelector('[data-duration]').textContent, '05:00');
    const stored = Object.fromEntries(Array.from({ length: env.win.localStorage.length }, (_, index) => {
        const key = env.win.localStorage.key(index); return [key, env.win.localStorage.getItem(key)];
    }));
    env.dom.window.close();
    const reload = await setup({ resources, localStorage: stored }); await reload.start();
    assert.equal(reload.ui.querySelector('[data-duration]').textContent, '05:00');
    reload.dom.window.close();
    const other = await setup({ resources, localStorage: stored, userId: 'different-user' }); await other.start();
    assert.equal(other.ui.querySelector('[data-duration]').textContent, '02:00');
    other.dom.window.close();
});

test('missing or failed document preview never accrues dwell time', async () => {
    const env = await setup({ resources: [{ id: '301', parent_id: '200', type: 6, task_type: 1, name: '1.pptx' }] });
    env.win.document.querySelector('.group-resource-content').remove();
    await env.start(); env.advance(300000); await env.tick();
    assert.equal(env.ui.querySelector('[data-elapsed]').textContent, '00:00');
    assert.equal(env.ui.querySelector('[data-state]').textContent, '加载中');
    const content = env.win.document.createElement('div');
    content.className = 'group-resource-content';
    content.innerHTML = '<div class="ant-result-error">预览失败</div>';
    env.win.document.querySelector('.group-resource-body').appendChild(content); await env.tick();
    assert.match(env.ui.querySelector('[data-status]').textContent, /预览失败/);
    assert.equal(env.ui.querySelector('[data-stop]').disabled, true);
    env.dom.window.close();
});

test('removing the login cookie clears the active course and pauses playback', async () => {
    const env = await setup(); await env.start();
    env.win.document.cookie = 'prd-access-token=; Max-Age=0; Path=/'; await env.tick();
    assert.equal(env.video.paused, true);
    assert.equal(env.ui.querySelector('[data-course-name]').textContent, '请先登录');
    assert.equal(env.ui.querySelectorAll('[data-node]').length, 0);
    assert.equal(env.ui.querySelector('[data-history]').textContent, '—');
    assert.equal(env.ui.querySelector('[data-elapsed]').textContent, '00:00');
    env.dom.window.close();
});

test('the real SSO login origin injects and expands the login prompt without course requests', async () => {
    const env = await setup({
        url: 'https://infra.ai-augmented.com/app/auth/oauth2/login?response_type=code&client_id=xy_client_whut',
        saved: { collapsed: true, running: true, course: '100' }
    });
    assert.ok(env.ui, 'The user script must actually match the separate SSO login origin');
    await env.flush();
    assert.equal(env.ui.querySelector('.shell').hidden, false);
    assert.equal(env.ui.querySelector('[data-course-name]').textContent, '请先登录');
    assert.equal(env.ui.querySelector('[data-start]').disabled, true);
    assert.equal(env.requests.length, 0, 'SSO page must not use course-host API routes or stale cookies');
    env.dom.window.close();
});

test('the university homepage before course selection can show the logged-out prompt', async () => {
    const env = await setup({ url: 'https://whut.ai-augmented.com/', cookie: '' });
    assert.ok(env.ui, 'The homepage must match the script too');
    await env.flush();
    assert.equal(env.ui.querySelector('[data-course-name]').textContent, '请先登录');
    assert.equal(env.ui.querySelector('.shell').hidden, false);
    env.dom.window.close();
});

test('three top tabs keep settings accessible while the learning mode switch stays on the homepage', async () => {
    const env = await setup(); await env.start();
    assert.equal(env.ui.querySelector('[data-view="learning"]').hidden, false);
    assert.equal(env.ui.querySelector('[data-view="list"]').hidden, true);
    assert.equal(env.ui.querySelector('[data-view="settings"]').hidden, true);
    assert.equal(env.ui.querySelector('[data-status]').hidden, true, 'Routine playback advice should not occupy a large banner');
    assert.equal(env.ui.querySelectorAll('[data-tab]').length, 3);
    assert.equal(env.ui.querySelector('[data-open-settings]'), null);
    assert.equal(env.ui.querySelector('[data-view="settings"] [data-learning-mode]'), null);
    assert.ok(env.ui.querySelector('[data-tab="list"]').textContent.startsWith('全部'));
    env.ui.querySelector('[data-tab="settings"]').click();
    assert.equal(env.ui.querySelector('[data-view="settings"]').hidden, false);
    assert.equal(env.ui.querySelector('[data-view="learning"]').hidden, true);
    assert.equal(env.video.paused, false);
    assert.equal(env.ui.querySelector('[data-percent]').textContent, '20%');
    assert.equal(env.ui.querySelector('[data-tabs]').hidden, false);
    assert.equal(env.ui.querySelector('[data-tab="settings"]').getAttribute('aria-selected'), 'true');
    env.ui.querySelector('[data-tab="learning"]').click();
    assert.equal(env.ui.querySelector('[data-view="learning"]').hidden, false);
    assert.equal(env.ui.querySelector('[data-tabs]').hidden, false);
    assert.equal(env.ui.querySelectorAll('[data-view="learning"] [data-learning-mode]').length, 2);
    env.dom.window.close();
});

test('search and completion filters affect only the displayed materials and retain course numbering', async () => {
    const env = await setup({ resources: [
        { id: '301', parent_id: '200', type: 9, task_id: 'a', name: '1.绪论.mp4', sort_position: 1 },
        { id: '302', parent_id: '200', type: 6, task_type: 1, task_id: 'b', name: '绪论.pptx', sort_position: 2 },
        { id: '303', parent_id: '200', type: 9, task_id: 'c', name: '劳动.mp4', sort_position: 3 }
    ], taskStates: { '301': { finished: false }, '302': { finished: true }, '303': { finished: false } } });
    await env.start(); env.ui.querySelector('[data-tab="list"]').click();
    const nextBeforeSearch = env.ui.querySelector('[data-next-link]').dataset.targetNode;
    assert.equal(nextBeforeSearch, '303', 'Pending queue navigation skips the completed PPT before any list filtering');
    const search = env.ui.querySelector('[data-search]');
    search.value = '绪论'; search.dispatchEvent(new env.win.Event('input'));
    assert.equal(env.ui.querySelectorAll('[data-list] [data-node]').length, 2);
    env.ui.querySelector('[data-filter="completed"]').click();
    assert.equal(env.ui.querySelectorAll('[data-list] [data-node]').length, 1);
    assert.equal(env.ui.querySelector('[data-list] [data-node]').dataset.node, '302');
    assert.equal(env.ui.querySelector('[data-list] .num').textContent, '02');
    assert.equal(env.video.paused, false);
    assert.equal(env.ui.querySelector('[data-next-link]').dataset.targetNode, nextBeforeSearch);
    env.dom.window.close();
});

test('returning from top settings preserves the all-tasks filter, search, and playback state', async () => {
    const env = await setup(); await env.start();
    env.ui.querySelector('[data-tab="list"]').click();
    const search = env.ui.querySelector('[data-search]');
    search.value = '2.mp4'; search.dispatchEvent(new env.win.Event('input'));
    env.ui.querySelector('[data-filter="unfinished"]').click();
    env.ui.querySelector('[data-tab="settings"]').click();
    env.ui.querySelector('[data-tab="list"]').click();
    assert.equal(env.ui.querySelector('[data-view="list"]').hidden, false);
    assert.equal(env.ui.querySelector('[data-tab="list"]').getAttribute('aria-selected'), 'true');
    assert.equal(search.value, '2.mp4');
    assert.equal(env.ui.querySelector('[data-filter="unfinished"]').getAttribute('aria-pressed'), 'true');
    assert.equal(env.ui.querySelectorAll('[data-list] [data-node]').length, 1);
    assert.equal(env.video.paused, false);
    env.ui.querySelector('[data-tab="learning"]').click();
    env.ui.querySelector('[data-start]').click(); await env.flush();
    env.ui.querySelector('[data-tab="settings"]').click();
    env.ui.querySelector('[data-tab="learning"]').click();
    assert.equal(env.ui.querySelector('[data-action-label]').textContent, '继续学习');
    assert.equal(env.ui.querySelector('[data-status]').hidden, true);
    assert.equal(env.video.paused, true);
    env.dom.window.close();
});

test('single video hides continuous and nonvideo settings without clearing stored course choices', async () => {
    const env = await setup({ resources: [
        { id: '301', parent_id: '200', type: 9, name: '1.mp4' },
        { id: '302', parent_id: '200', type: 6, task_type: 1, name: '2.pptx' }
    ] });
    await env.open();
    const skip = env.ui.querySelector('[data-queue-policy]');
    skip.value = 'unfinished'; skip.dispatchEvent(new env.win.Event('change'));
    const minutes = env.ui.querySelector('[data-default-minutes]');
    minutes.value = '5'; minutes.dispatchEvent(new env.win.Event('change'));
    env.ui.querySelector('[data-learning-mode="single"]').click();
    assert.equal(env.ui.querySelector('[data-continuous-settings]').hidden, true);
    assert.equal(env.ui.querySelector('[data-configuration]').hidden, true);
    assert.equal(env.ui.querySelector('[data-mute]').closest('.option').hidden, false);
    env.ui.querySelector('[data-learning-mode="continuous"]').click();
    assert.equal(env.ui.querySelector('[data-continuous-settings]').hidden, false);
    assert.equal(env.ui.querySelector('[data-configuration]').hidden, false);
    assert.equal(env.ui.querySelector('[data-default-settings]').hidden, false);
    assert.equal(skip.value, 'unfinished');
    assert.equal(minutes.value, '5');
    env.dom.window.close();
});

test('single nonvideo shows only its override and continuous mode restores relevant course settings', async () => {
    const resources = [{ id: '301', parent_id: '200', type: 6, task_type: 1, name: '1.pptx' }];
    const env = await setup({ resources }); await env.open();
    env.ui.querySelector('[data-learning-mode="single"]').click();
    assert.equal(env.ui.querySelector('[data-continuous-settings]').hidden, true);
    assert.equal(env.ui.querySelector('[data-configuration]').hidden, false);
    assert.equal(env.ui.querySelector('[data-default-settings]').hidden, true);
    assert.equal(env.ui.querySelector('[data-item-settings]').hidden, false);
    assert.equal(env.ui.querySelector('[data-mute]').closest('.option').hidden, true);
    const item = env.ui.querySelector('[data-resource-minutes]');
    item.value = '3'; item.dispatchEvent(new env.win.Event('change'));
    env.ui.querySelector('[data-learning-mode="continuous"]').click();
    assert.equal(env.ui.querySelector('[data-continuous-settings]').hidden, false);
    assert.equal(env.ui.querySelector('[data-default-settings]').hidden, false);
    assert.equal(env.ui.querySelector('[data-mute]').closest('.option').hidden, true, 'A nonvideo-only course has no mute option');
    assert.equal(item.value, '3');
    env.dom.window.close();
});

test('locate current clears filters and scrolls to the current resource', async () => {
    const env = await setup(); await env.open();
    env.ui.querySelector('[data-tab="list"]').click();
    const search = env.ui.querySelector('[data-search]');
    search.value = 'missing'; search.dispatchEvent(new env.win.Event('input'));
    assert.equal(env.ui.querySelectorAll('[data-list] [data-node]').length, 0);
    let located = null;
    env.win.HTMLElement.prototype.scrollIntoView = function () { located = this.dataset.node; };
    env.ui.querySelector('[data-locate]').click();
    assert.equal(located, '301');
    assert.equal(search.value, '');
    assert.equal(env.ui.querySelectorAll('[data-list] [data-node]').length, 2);
    assert.equal(env.playCount(), 0);
    env.dom.window.close();
});

test('tab keyboard navigation and Escape preserve focus and do not change learning state', async () => {
    const env = await setup(); await env.start();
    env.ui.querySelector('[data-tab="learning"]').dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal(env.ui.querySelector('[data-tab="list"]').getAttribute('aria-selected'), 'true');
    assert.equal(env.ui.activeElement.dataset.tab, 'list');
    env.ui.activeElement.dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(env.ui.querySelector('.shell').hidden, true);
    assert.equal(env.video.paused, false);
    env.dom.window.close();
});

test('panel placement uses the rendered width on narrow viewports', async () => {
    const env = await setup(); await env.open();
    Object.defineProperty(env.win, 'innerWidth', { value: 380, configurable: true });
    const shell = env.ui.querySelector('.shell');
    shell.getBoundingClientRect = () => ({ width: 356, height: 420 });
    env.win.dispatchEvent(new env.win.Event('resize'));
    const host = env.win.document.getElementById('xy-video-helper');
    const left = parseFloat(host.style.left) + parseFloat(shell.style.left);
    assert.ok(left >= 12);
    assert.ok(left + 356 <= 368);
    env.dom.window.close();
});

test('expanded controls show pause while playing and play while paused; launcher keeps its assistant icon', async () => {
    const env = await setup(); await env.start();
    assert.equal(env.ui.querySelector('[data-action-icon]').dataset.icon, 'pause');
    assert.equal(env.ui.querySelector('[data-action-icon]').querySelectorAll('rect').length, 2);
    assert.equal(env.ui.querySelector('.head'), null);
    assert.ok(env.ui.querySelector('[data-course-header][data-drag]'));
    assert.equal(env.ui.querySelector('[data-launcher-icon]').dataset.icon, 'assistant');
    const launcherIcon = env.ui.querySelector('[data-launcher-icon]').innerHTML;
    env.ui.querySelector('[data-start]').click(); await env.flush();
    assert.equal(env.video.paused, true);
    assert.equal(env.ui.querySelector('[data-action-icon]').dataset.icon, 'play');
    env.ui.querySelector('[data-collapse]').click();
    assert.equal(env.ui.querySelector('[data-launcher-icon]').innerHTML, launcherIcon);
    env.dom.window.close();
});

test('manual next switches immediately and cancels an already scheduled automatic switch', async () => {
    const env = await setup(); await env.start(); env.end();
    assert.equal(env.ui.querySelector('[data-state]').textContent, '即将切换');
    const next = env.ui.querySelector('[data-step="next"]');
    assert.equal(next.getAttribute('aria-disabled'), 'false');
    next.addEventListener('click', event => event.preventDefault()); next.click();
    let saved = JSON.parse(env.win.sessionStorage.getItem('xy-video-helper-v1'));
    assert.equal(saved.navigation.node, '302');
    assert.equal(saved.running, true);
    assert.equal(env.ui.querySelector('[data-state]').textContent, '跳转中');
    assert.equal(env.ui.querySelector('[data-step="next"]').getAttribute('aria-disabled'), 'true');
    assert.equal(env.ui.querySelector('[data-launcher-icon]').dataset.icon, 'assistant');
    await env.timers(5000);
    saved = JSON.parse(env.win.sessionStorage.getItem('xy-video-helper-v1'));
    assert.equal(saved.navigation.node, '302');
    assert.equal(env.ui.querySelector('[data-state]').textContent, '跳转中');
    env.dom.window.close();
});

test('manual navigation works in single mode while paused and ignores automatic skip and list filters', async () => {
    const env = await setup({ resources: [
        { id: '301', parent_id: '200', type: 9, task_id: 'a', name: '1.mp4', sort_position: 1 },
        { id: '302', parent_id: '200', type: 6, task_type: 1, task_id: 'b', name: '2.pptx', sort_position: 2 },
        { id: '303', parent_id: '200', type: 9, task_id: 'c', name: '3.mp4', sort_position: 3 }
    ], taskStates: { '301': { finished: false }, '302': { finished: true }, '303': { finished: false } } });
    await env.start(); env.ui.querySelector('[data-start]').click(); await env.flush();
    const skip = env.ui.querySelector('[data-queue-policy]'); skip.value = 'unfinished'; skip.dispatchEvent(new env.win.Event('change'));
    env.ui.querySelector('[data-learning-mode="single"]').click();
    env.ui.querySelector('[data-filter="unfinished"]').click();
    const next = env.ui.querySelector('[data-step="next"]');
    assert.equal(next.dataset.targetNode, '302');
    assert.equal(env.ui.querySelector('[data-next-link]').dataset.targetNode, '302');
    next.addEventListener('click', event => event.preventDefault()); next.click();
    const saved = JSON.parse(env.win.sessionStorage.getItem('xy-video-helper-v1'));
    assert.equal(saved.navigation.node, '302');
    assert.equal(saved.running, false);
    assert.equal(env.ui.querySelector('[data-completion-for="301"]').textContent, '未完成');
    env.dom.window.close();
});

test('previous and next navigation respect course boundaries and support reviewing a completed item', async () => {
    const first = await setup(); await first.open();
    const previous = first.ui.querySelector('[data-step="previous"]');
    assert.equal(previous.getAttribute('aria-disabled'), 'true');
    assert.equal(previous.hasAttribute('href'), false);
    assert.equal(previous.tabIndex, -1);
    previous.click();
    assert.equal(JSON.parse(first.win.sessionStorage.getItem('xy-video-helper-v1')).navigation, null);
    first.dom.window.close();
    const last = await setup({ url: 'https://whut.ai-augmented.com/app/jx-web/mycourse/100/resource/200/302' });
    await last.open();
    const next = last.ui.querySelector('[data-step="next"]');
    assert.equal(next.getAttribute('aria-disabled'), 'true');
    assert.equal(next.hasAttribute('href'), false);
    const back = last.ui.querySelector('[data-step="previous"]');
    assert.equal(back.dataset.targetNode, '301');
    back.addEventListener('click', event => event.preventDefault()); back.click();
    assert.equal(JSON.parse(last.win.sessionStorage.getItem('xy-video-helper-v1')).navigation.node, '301');
    last.dom.window.close();
});
