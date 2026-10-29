const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setup } = require('./fixture.cjs');

const resources = [
    { id: '301', type: 6, name: '课程介绍.pptx', task_id: '0', sort_position: 1 },
    { id: '302', type: 6, name: '阅读材料.pdf', sort_position: 2 },
    { id: '303', type: 6, name: '自主学习.pdf', task_id: 'reading-task', task_type: 1, sort_position: 3 },
    { id: '304', type: 9, name: '课程视频.mp4', quote_id: 'video-ref', sort_position: 4 }
];

test('plain documents display ordinary material without requesting a task completion endpoint', async () => {
    const env = await setup({ resources, taskStates: { '303': { finished: false } } });
    try {
        await env.open();
        assert.equal(env.ui.querySelector('[data-completion-for="301"]').textContent, '普通资料');
        assert.equal(env.ui.querySelector('[data-completion-for="302"]').textContent, '普通资料');
        const taskRequests = env.requests.filter(request => request.url.pathname.includes('studentFinishInfo'));
        assert.deepEqual(taskRequests.map(request => request.url.searchParams.get('node_id')), ['303']);
        assert.match(env.ui.querySelector('[data-summary]').textContent, /普通资料 2/);
        assert.equal(env.ui.querySelector('[data-queue-count]').textContent, '2 项');
    } finally { env.dom.window.close(); }
});

test('unfinished mode skips plain material and all mode can study it', async () => {
    const env = await setup({ resources });
    try {
        await env.start();
        assert.equal(JSON.parse(env.win.sessionStorage.getItem('xy-video-helper-v1')).navigation.node, '303');
        env.ui.querySelector('[data-stop]').click();
        const scope = env.ui.querySelector('[data-queue-policy]'); scope.value = 'all'; scope.dispatchEvent(new env.win.Event('change')); await env.flush();
        await env.start();
        assert.equal(env.ui.querySelector('[data-state]').textContent, '阅读中');
        assert.equal(env.ui.querySelector('[data-completion]').textContent, '普通资料');
    } finally { env.dom.window.close(); }
});

test('plain-only courses are not misreported as completed or failed', async () => {
    const env = await setup({ resources: resources.slice(0, 2), failPath: 'studentFinishInfo' });
    try {
        await env.open();
        assert.equal(env.ui.querySelector('[data-queue-count]').textContent, '0 项');
        assert.doesNotMatch(env.ui.querySelector('[data-title]').textContent, /恭喜你/);
        assert.doesNotMatch(env.ui.querySelector('[data-summary]').textContent, /待确认|检测失败/);
        assert.equal(env.ui.querySelector('[data-start]').disabled, true);
    } finally { env.dom.window.close(); }
});

test('real task failures remain distinct from ordinary resources', async () => {
    const env = await setup({ resources, failPath: 'studentFinishInfo' });
    try {
        await env.open();
        assert.equal(env.ui.querySelector('[data-completion-for="301"]').textContent, '普通资料');
        assert.equal(env.ui.querySelector('[data-completion-for="303"]').textContent, '检测失败');
    } finally { env.dom.window.close(); }
});

test('material choices have only video and other, without a separate PPT category', async () => {
    const env = await setup({ resources });
    try {
        await env.open();
        assert.deepEqual([...env.ui.querySelectorAll('[data-resource-kind]')].map(node => node.dataset.resourceKind), ['videos', 'other']);
        assert.ok([...env.ui.querySelectorAll('.kind')].every(node => ['视频', '其他资料'].includes(node.textContent)));
    } finally { env.dom.window.close(); }
});

test('task metadata without an identifier is shown as incomplete information without a bogus API request', async () => {
    const env = await setup({ resources: [{ id: '301', type: 6, task_type: 1, name: '任务.pdf' }] });
    try {
        await env.open();
        assert.equal(env.ui.querySelector('[data-completion-for="301"]').textContent, '任务信息待确认');
        assert.equal(env.requests.filter(request => request.url.pathname.includes('studentFinishInfo')).length, 0);
        assert.equal(env.ui.querySelector('[data-queue-count]').textContent, '1 项');
    } finally { env.dom.window.close(); }
});
