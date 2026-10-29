const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setup } = require('./fixture.cjs');

const resources = [
    { id: '301', parent_id: '200', type: 6, name: '自主观看课件.pdf', task_type: 1, task_id: 'reading-task', sort_position: 1 },
    { id: '302', parent_id: '200', type: 9, name: '下一项.mp4', sort_position: 2 }
];
const navigation = env => JSON.parse(env.win.sessionStorage.getItem('xy-video-helper-v1')).navigation;
const running = env => JSON.parse(env.win.sessionStorage.getItem('xy-video-helper-v1')).running;
function taskButton(env, name = resources[0].name) {
    const header = env.win.document.createElement('div');
    header.className = 'group-resource-header';
    const file = env.win.document.createElement('div'); file.className = 'header-file'; file.textContent = name; file.title = name;
    const button = env.win.document.createElement('div'); button.className = 'ta_icon_btn top';
    button.innerHTML = '<div class="btn_content"><i class="xy_btn_task_normal"></i>点我完成任务</div>';
    header.append(file, button); env.win.document.body.prepend(header);
    return button;
}
async function finishDwell(env) { env.advance(120000); await env.tick(); await env.timers(); }

test('self-study document clicks completion after two minutes before navigating', async () => {
    const taskStates = { '301': { finished: false } };
    const env = await setup({ resources, taskStates });
    try {
        const button = taskButton(env);
        let clicks = 0;
        button.onclick = () => { clicks++; taskStates['301'].finished = true; };
        await env.start(); env.advance(119000); await env.tick(); await env.timers();
        assert.equal(clicks, 0);
        assert.equal(JSON.parse(env.win.sessionStorage.getItem('xy-video-helper-v1')).navigation, null);
        env.advance(1000); await env.tick(); await env.timers();
        assert.equal(clicks, 1, 'Completing the dwell time must click the platform task button');
        await env.tick(); await env.timers();
        assert.equal(JSON.parse(env.win.sessionStorage.getItem('xy-video-helper-v1')).navigation?.node, '302');
        assert.ok(env.requests.every(request => request.method === 'GET'), 'The helper clicks the page button instead of sending its own completion request');
    } finally { env.dom.window.close(); }
});

test('a submitted self-study task waits for server confirmation without clicking repeatedly', async () => {
    const states = { '301': { finished: false } };
    const env = await setup({ resources, taskStates: states });
    try {
        let clicks = 0; taskButton(env).onclick = () => { clicks++; };
        await env.start(); await finishDwell(env);
        assert.equal(clicks, 1); assert.equal(navigation(env), null);
        env.advance(2000); await env.tick(); await env.timers();
        assert.equal(clicks, 1); assert.equal(navigation(env), null);
        states['301'].finished = true; env.advance(2000); await env.tick(); await env.timers();
        assert.equal(navigation(env)?.node, '302'); assert.equal(clicks, 1);
    } finally { env.dom.window.close(); }
});

test('single study completes the task before ending and never navigates', async () => {
    const states = { '301': { finished: false } };
    const env = await setup({ resources, taskStates: states });
    try {
        let clicks = 0; taskButton(env).onclick = () => { clicks++; states['301'].finished = true; };
        await env.open(); env.ui.querySelector('[data-learning-mode="single"]').click();
        await env.start(); await finishDwell(env);
        assert.equal(clicks, 1); assert.equal(navigation(env), null); assert.equal(running(env), false);
        assert.match(env.ui.querySelector('[data-status]').textContent, /平台记录已完成/);
    } finally { env.dom.window.close(); }
});

test('missing or stale task controls stop rather than skip the unfinished task', async () => {
    for (const stale of [false, true]) {
        const env = await setup({ resources });
        try {
            let clicks = 0;
            if (stale) taskButton(env, '其他文件.pdf').onclick = () => { clicks++; };
            await env.start(); await finishDwell(env);
            assert.equal(clicks, 0); assert.equal(navigation(env), null); assert.equal(running(env), false);
            assert.match(env.ui.querySelector('[data-status]').textContent, /未找到.*手动完成/);
        } finally { env.dom.window.close(); }
    }
});

test('disabled platform completion controls are waited for and clicked only after enabling', async () => {
    const states = { '301': { finished: false } };
    const env = await setup({ resources, taskStates: states });
    try {
        const button = taskButton(env); button.classList.add('disable');
        let clicks = 0; button.onclick = () => { clicks++; states['301'].finished = true; };
        await env.start(); await finishDwell(env);
        assert.equal(clicks, 0); assert.equal(navigation(env), null);
        button.classList.remove('disable'); env.advance(2000); await env.tick(); await env.timers();
        assert.equal(clicks, 1); assert.equal(navigation(env)?.node, '302');
    } finally { env.dom.window.close(); }
});

test('unconfirmed submission times out without skipping or retrying a potentially completed task', async () => {
    const env = await setup({ resources });
    try {
        let clicks = 0; taskButton(env).onclick = () => { clicks++; };
        await env.start(); await finishDwell(env);
        env.advance(30000); await env.tick(); await env.timers();
        assert.equal(clicks, 1); assert.equal(navigation(env), null); assert.equal(running(env), false);
        assert.match(env.ui.querySelector('[data-status]').textContent, /平台尚未确认成功/);
    } finally { env.dom.window.close(); }
});

test('ordinary files and tasks of other types do not auto-click completion', async () => {
    for (const task_type of [0, 2]) {
        const env = await setup({ resources: [{ ...resources[0], task_type, task_label: task_type ? '自主观看' : undefined,
            task_id: task_type ? 'manual-task' : undefined }, resources[1]],
            localStorage: { 'xy-learning-settings-v1:test-user:100': JSON.stringify({ queuePolicy: 'all' }) } });
        try {
            let clicks = 0; taskButton(env).onclick = () => { clicks++; };
            await env.start(); await finishDwell(env);
            assert.equal(clicks, 0); assert.equal(navigation(env)?.node, '302');
        } finally { env.dom.window.close(); }
    }
});

test('an already completed task in all mode advances without clicking again', async () => {
    const env = await setup({ resources, taskStates: { '301': { finished: true } },
        localStorage: { 'xy-learning-settings-v1:test-user:100': JSON.stringify({ queuePolicy: 'all' }) } });
    try {
        let clicks = 0; taskButton(env).onclick = () => { clicks++; };
        await env.start(); await finishDwell(env);
        assert.equal(clicks, 0); assert.equal(navigation(env)?.node, '302');
    } finally { env.dom.window.close(); }
});

test('platform minimum reading time is respected when longer than the user default', async () => {
    const states = { '301': { finished: false } };
    const env = await setup({ resources: [{ ...resources[0], watch_min_minutes: 3 }, resources[1]], taskStates: states });
    try {
        let clicks = 0; taskButton(env).onclick = () => { clicks++; states['301'].finished = true; };
        await env.start(); await finishDwell(env);
        assert.equal(clicks, 0); assert.equal(navigation(env), null);
        assert.equal(env.ui.querySelector('[data-duration]').textContent, '03:00');
        env.advance(60000); await env.tick(); await env.timers();
        assert.equal(clicks, 1); assert.equal(navigation(env)?.node, '302');
    } finally { env.dom.window.close(); }
});

test('platform rejection dialogs keep the current task and are not automatically confirmed', async () => {
    const env = await setup({ resources });
    try {
        let acknowledgements = 0;
        taskButton(env).onclick = () => {
            const dialog = env.win.document.createElement('div'); dialog.className = 'ant-modal';
            dialog.innerHTML = '<div class="finish_task_info">连续观看时间未达要求</div><button>我知道了</button>';
            dialog.querySelector('button').onclick = () => { acknowledgements++; }; env.win.document.body.append(dialog);
        };
        await env.start(); await finishDwell(env);
        assert.equal(navigation(env), null); assert.equal(running(env), false); assert.equal(acknowledgements, 0);
        assert.match(env.ui.querySelector('[data-status]').textContent, /平台提示任务尚未完成/);
    } finally { env.dom.window.close(); }
});

test('stopping during the completion response cancels navigation when the response arrives', async () => {
    let clicked = false, respond;
    const env = await setup({ resources, reply: url => {
        if (clicked && url.pathname.includes('studentFinishInfo')) return new Promise(resolve => { respond = resolve; });
    } });
    try {
        taskButton(env).onclick = () => { clicked = true; };
        await env.start(); await finishDwell(env);
        assert.equal(typeof respond, 'function'); assert.equal(navigation(env), null);
        env.ui.querySelector('[data-stop]').click();
        respond({ ok: true, json: async () => ({ success: true, data: { finished: true } }) });
        await env.flush(); await env.tick(); await env.timers();
        assert.equal(running(env), false); assert.equal(navigation(env), null);
    } finally { env.dom.window.close(); }
});

test('paused dwell time cannot trigger task completion and resuming finishes the remaining time', async () => {
    const states = { '301': { finished: false } };
    const env = await setup({ resources, taskStates: states });
    try {
        let clicks = 0; taskButton(env).onclick = () => { clicks++; states['301'].finished = true; };
        await env.start(); env.advance(60000); await env.tick();
        env.ui.querySelector('[data-start]').click(); env.advance(120000); await env.tick(); await env.timers();
        assert.equal(clicks, 0); assert.equal(navigation(env), null);
        await env.start(); env.advance(60000); await env.tick(); await env.timers();
        assert.equal(clicks, 1); assert.equal(navigation(env)?.node, '302');
    } finally { env.dom.window.close(); }
});

test('preview becoming busy before the queued completion callback prevents submission', async () => {
    const states = { '301': { finished: false } };
    const env = await setup({ resources, taskStates: states });
    try {
        let clicks = 0; taskButton(env).onclick = () => { clicks++; states['301'].finished = true; };
        await env.start(); env.advance(120000); await env.tick();
        const body = env.win.document.querySelector('.group-resource-content'); body.innerHTML = '<div aria-busy="true">加载中</div>';
        await env.timers(); assert.equal(clicks, 0); assert.equal(navigation(env), null);
        body.innerHTML = '<div>课件已就绪</div>'; await env.tick(); await env.timers();
        assert.equal(clicks, 1); assert.equal(navigation(env)?.node, '302');
    } finally { env.dom.window.close(); }
});
