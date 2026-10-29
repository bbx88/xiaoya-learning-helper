const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setup } = require('./fixture.cjs');

const resources = [
    { id: '301', parent_id: '200', type: 9, task_id: 'a', name: '1.mp4', sort_position: 1 },
    { id: '302', parent_id: '200', type: 6, name: '2.pptx', sort_position: 2 },
    { id: '303', parent_id: '200', type: 9, task_id: 'b', name: '3.mp4', sort_position: 3 },
    { id: '304', parent_id: '200', type: 6, task_type: 1, name: '4.pdf', sort_position: 4 }
];
const taskStates = { '301': { finished: true }, '303': { finished: false } };
async function policy(env, value) {
    const input = env.ui.querySelector('[data-queue-policy]');
    assert.ok(input, 'The user must be able to choose all or unfinished resources');
    input.value = value; input.dispatchEvent(new env.win.Event('change')); await env.flush();
}
async function kind(env, name, checked) {
    const input = env.ui.querySelector(`[data-resource-kind="${name}"]`);
    assert.ok(input, `The ${name} resource category must be selectable`);
    input.checked = checked; input.dispatchEvent(new env.win.Event('change')); await env.flush();
}

test('unfinished is the default and skips an already completed current video when starting', async () => {
    const env = await setup({ resources, taskStates });
    try {
        await env.open();
        assert.equal(env.ui.querySelector('[data-queue-policy]').value, 'unfinished');
        assert.deepEqual([...env.ui.querySelector('[data-queue-policy]').options].map(option => option.textContent), ['全部', '未完成']);
        await env.start();
        assert.equal(JSON.parse(env.win.sessionStorage.getItem('xy-video-helper-v1')).navigation.node, '303');
        assert.equal(env.playCount(), 0);
    } finally { env.dom.window.close(); }
});

test('all-resources policy permits replaying completed videos', async () => {
    const env = await setup({ resources, taskStates });
    try {
        await env.open(); await policy(env, 'all'); await env.start();
        assert.equal(env.video.paused, false);
        assert.equal(JSON.parse(env.win.sessionStorage.getItem('xy-video-helper-v1')).navigation, null);
        const saved = Object.fromEntries(Object.entries(env.win.localStorage));
        const reopened = await setup({ resources, taskStates, localStorage: saved });
        try { await reopened.open(); assert.equal(reopened.ui.querySelector('[data-queue-policy]').value, 'all'); }
        finally { reopened.dom.window.close(); }
    } finally { env.dom.window.close(); }
});

test('resource choices build a video-only queue and can restore other material without refetching', async () => {
    const env = await setup({ resources, taskStates });
    try {
        await env.open(); await kind(env, 'other', false);
        assert.deepEqual([...env.ui.querySelectorAll('[data-node]')].map(node => node.dataset.node), ['301', '303']);
        await policy(env, 'unfinished'); await env.start();
        assert.equal(JSON.parse(env.win.sessionStorage.getItem('xy-video-helper-v1')).navigation.node, '303');
        env.ui.querySelector('[data-stop]').click();
        const count = env.requests.filter(request => request.url.pathname.includes('queryCourseResources')).length;
        await kind(env, 'other', true);
        assert.deepEqual([...env.ui.querySelectorAll('[data-node]')].map(node => node.dataset.node), ['301', '302', '303', '304']);
        assert.equal(env.requests.filter(request => request.url.pathname.includes('queryCourseResources')).length, count);
    } finally { env.dom.window.close(); }
});

test('queue choices survive reload and cached resource data retains deselected PPT', async () => {
    const first = await setup({ resources, taskStates });
    await first.open(); await kind(first, 'other', false); await policy(first, 'unfinished');
    const saved = Object.fromEntries(Object.entries(first.win.localStorage)); first.dom.window.close();
    const env = await setup({ resources, taskStates, localStorage: saved });
    try {
        await env.open();
        assert.equal(env.ui.querySelector('[data-queue-policy]').value, 'unfinished');
        assert.equal(env.ui.querySelector('[data-resource-kind="other"]').checked, false);
        assert.equal(env.ui.querySelectorAll('[data-node="302"]').length, 0);
        await kind(env, 'other', true);
        assert.ok(env.ui.querySelector('[data-node="302"]'));
    } finally { env.dom.window.close(); }
});

test('the final enabled resource category cannot be deselected', async () => {
    const env = await setup({ resources, taskStates });
    try {
        await env.open(); await kind(env, 'other', false); await kind(env, 'videos', false);
        assert.equal(env.ui.querySelector('[data-resource-kind="videos"]').checked, true);
        assert.match(env.ui.querySelector('[data-queue-error]').textContent, /至少选择/);
        assert.equal(env.ui.querySelectorAll('[data-node]').length, 2);
    } finally { env.dom.window.close(); }
});

test('excluding the currently playing resource stops it and keeps selected resources available', async () => {
    const env = await setup({ resources, taskStates });
    try {
        await env.open(); await policy(env, 'all'); await env.start(); await kind(env, 'videos', false);
        assert.equal(env.video.paused, true);
        assert.deepEqual([...env.ui.querySelectorAll('[data-node]')].map(node => node.dataset.node), ['302', '304']);
    } finally { env.dom.window.close(); }
});

test('legacy queue settings adopt the new unfinished default on upgrade', async () => {
    const env = await setup({ localStorage: { 'xy-learning-settings-v1:test-user:100': JSON.stringify({ skipCompleted: false }) } });
    try { await env.open(); assert.equal(env.ui.querySelector('[data-queue-policy]').value, 'unfinished'); }
    finally { env.dom.window.close(); }
});

test('resource and completion choices are directly available on the learning homepage', async () => {
    const env = await setup({ resources, taskStates });
    try {
        await env.open();
        const home = env.ui.querySelector('[data-view="learning"]');
        assert.ok(home.querySelector('[data-queue-policy]'));
        assert.equal(home.querySelectorAll('[data-resource-kind]').length, 2);
        assert.equal(env.ui.querySelector('[data-view="settings"] [data-queue-policy]'), null);
        assert.equal(env.ui.querySelector('[data-view="settings"] [data-resource-kind]'), null);
    } finally { env.dom.window.close(); }
});

test('homepage queue count updates immediately when completion and resource choices change', async () => {
    const env = await setup({ resources, taskStates });
    try {
        await env.open();
        const count = env.ui.querySelector('[data-queue-count]');
        assert.ok(count);
        await policy(env, 'all');
        assert.equal(count.textContent, '4 项');
        await policy(env, 'unfinished');
        assert.equal(count.textContent, '2 项');
        await kind(env, 'other', false);
        assert.equal(count.textContent, '1 项');
        await policy(env, 'all');
        assert.equal(count.textContent, '2 项');
    } finally { env.dom.window.close(); }
});

test('switching to unfinished during playback immediately leaves a completed current item', async () => {
    const env = await setup({ resources, taskStates });
    try {
        await env.open(); await policy(env, 'all'); await env.start();
        assert.equal(env.video.paused, false);
        await policy(env, 'unfinished');
        assert.equal(env.video.paused, true);
        assert.equal(JSON.parse(env.win.sessionStorage.getItem('xy-video-helper-v1')).navigation.node, '303');
        assert.equal(env.ui.querySelector('[data-state]').textContent, '跳转中');
    } finally { env.dom.window.close(); }
});

test('switching to unfinished stops if all selected items are already complete', async () => {
    const env = await setup({ resources: [resources[0], resources[2]], taskStates: { '301': { finished: true }, '303': { finished: true } } });
    try {
        await env.open(); await policy(env, 'all'); await env.start(); await policy(env, 'unfinished');
        assert.equal(env.video.paused, true);
        assert.equal(JSON.parse(env.win.sessionStorage.getItem('xy-video-helper-v1')).running, false);
        assert.equal(env.ui.querySelector('[data-queue-count]').textContent, '0 项');
    } finally { env.dom.window.close(); }
});

test('unfinished mode replaces the task card with congratulations and all mode restores it', async () => {
    const env = await setup({ resources: [resources[0], resources[2]], taskStates: { '301': { finished: true }, '303': { finished: true } },
        localStorage: { 'xy-learning-settings-v1:test-user:100': JSON.stringify({ skipCompleted: true }) } });
    try {
        await env.open();
        assert.match(env.ui.querySelector('[data-title]').textContent, /恭喜你.*已经学完/);
        assert.equal(env.ui.querySelector('[data-timeline]').hidden, true);
        assert.equal(env.ui.querySelector('[data-start]').disabled, true);
        await policy(env, 'all');
        assert.equal(env.ui.querySelector('[data-title]').textContent, '1.mp4');
        assert.equal(env.ui.querySelector('[data-timeline]').hidden, false);
        assert.equal(env.ui.querySelector('[data-start]').disabled, false);
    } finally { env.dom.window.close(); }
});

test('unknown or failed completion checks never display congratulations', async () => {
    const env = await setup({ resources: [resources[0]], failPath: 'studentFinishInfo',
        localStorage: { 'xy-learning-settings-v1:test-user:100': JSON.stringify({ skipCompleted: true }) } });
    try {
        await env.open();
        assert.doesNotMatch(env.ui.querySelector('[data-title]').textContent, /恭喜你/);
        assert.equal(env.ui.querySelector('[data-queue-count]').textContent, '1 项');
    } finally { env.dom.window.close(); }
});

test('finishing the last pending item replaces the card after the server confirms completion', async () => {
    const states = { '301': { finished: false } };
    const env = await setup({ resources: [resources[0]], taskStates: states,
        localStorage: { 'xy-learning-settings-v1:test-user:100': JSON.stringify({ skipCompleted: true }) } });
    try {
        await env.start();
        assert.doesNotMatch(env.ui.querySelector('[data-title]').textContent, /恭喜你/);
        states['301'] = { finished: true }; env.end(); await env.timers(5000);
        assert.match(env.ui.querySelector('[data-title]').textContent, /恭喜你.*已经学完/);
        assert.equal(JSON.parse(env.win.sessionStorage.getItem('xy-video-helper-v1')).running, false);
    } finally { env.dom.window.close(); }
});
