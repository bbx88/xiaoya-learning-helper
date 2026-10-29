const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setup } = require('./fixture.cjs');

const resources = [301, 302, 303, 304, 305].map((id, index) => ({ id: String(id), parent_id: '200',
    type: 9, task_id: `task-${id}`, name: `${index + 1}.mp4`, sort_position: index }));
const taskStates = { '301': { finished: false }, '302': { finished: true }, '303': { finished: false },
    '304': { finished: true }, '305': { finished: false } };
const url = 'https://whut.ai-augmented.com/app/jx-web/mycourse/100/resource/200/303';
const step = (env, direction) => env.ui.querySelector(`[data-step="${direction}"]`);
const navigation = env => JSON.parse(env.win.sessionStorage.getItem('xy-video-helper-v1')).navigation;
async function policy(env, value) {
    const input = env.ui.querySelector('[data-queue-policy]'); input.value = value;
    input.dispatchEvent(new env.win.Event('change')); await env.flush();
}

test('unfinished neighbors show and open pending resources instead of completed directory neighbors', async () => {
    for (const [direction, id, name] of [['previous', '301', '1.mp4'], ['next', '305', '5.mp4']]) {
        const env = await setup({ resources, taskStates, url });
        try {
            await env.open();
            assert.equal(step(env, direction).querySelector('[data-step-name]').textContent, name);
            assert.equal(step(env, direction).dataset.targetNode, id);
            step(env, direction).click();
            assert.equal(navigation(env)?.node, id);
        } finally { env.dom.window.close(); }
    }
});

test('changing scope updates both neighbor labels immediately and single mode follows the full selected directory', async () => {
    const env = await setup({ resources, taskStates, url });
    try {
        await env.open(); await policy(env, 'all');
        assert.equal(step(env, 'previous').dataset.targetNode, '302');
        assert.equal(step(env, 'next').dataset.targetNode, '304');
        await policy(env, 'unfinished');
        assert.equal(step(env, 'previous').dataset.targetNode, '301');
        assert.equal(step(env, 'next').dataset.targetNode, '305');
        env.ui.querySelector('[data-learning-mode="single"]').click(); await env.flush();
        assert.equal(step(env, 'previous').dataset.targetNode, '302');
        assert.equal(step(env, 'next').dataset.targetNode, '304');
    } finally { env.dom.window.close(); }
});

test('a completed current resource remains an anchor for finding pending resources on both sides', async () => {
    const env = await setup({ resources, taskStates, url: url.replace('/303', '/302') });
    try {
        await env.open();
        assert.equal(step(env, 'previous').dataset.targetNode, '301');
        assert.equal(step(env, 'next').dataset.targetNode, '303');
    } finally { env.dom.window.close(); }
});

test('course overview offers the first eligible pending resource', async () => {
    const env = await setup({ resources, taskStates: { ...taskStates, '301': { finished: true } },
        url: 'https://whut.ai-augmented.com/app/jx-web/mycourse/100/scores' });
    try {
        await env.open();
        assert.equal(step(env, 'previous').disabled, true);
        assert.equal(step(env, 'next').dataset.targetNode, '303');
        assert.equal(step(env, 'next').querySelector('[data-step-label]').textContent, '第一项');
        step(env, 'next').click(); assert.equal(navigation(env)?.node, '303');
    } finally { env.dom.window.close(); }
});

test('pending queue boundaries disable completed neighbors and remove their navigation targets', async () => {
    const env = await setup({ resources, taskStates: { ...taskStates, '301': { finished: true }, '305': { finished: true } }, url });
    try {
        await env.open();
        for (const direction of ['previous', 'next']) {
            const control = step(env, direction);
            assert.equal(control.disabled, true); assert.equal(control.dataset.targetNode, undefined);
            control.click(); assert.equal(navigation(env), null);
        }
    } finally { env.dom.window.close(); }
});

test('refreshing completion states changes neighbors without changing course or scope', async () => {
    const states = structuredClone(taskStates);
    const env = await setup({ resources, taskStates: states, url });
    try {
        await env.open(); assert.equal(step(env, 'next').dataset.targetNode, '305');
        states['305'].finished = true; states['302'].finished = false;
        env.ui.querySelector('[data-refresh]').click(); await env.flush();
        assert.equal(step(env, 'previous').dataset.targetNode, '302');
        assert.equal(step(env, 'next').disabled, true);
    } finally { env.dom.window.close(); }
});

test('neighbor navigation follows resource categories and ignores list search and display filters', async () => {
    const items = resources.map(node => node.id === '302' ? { ...node, type: 6, task_id: undefined, name: '普通资料.pdf' }
        : node.id === '305' ? { ...node, type: 6, task_type: 1, name: '待完成资料.pdf' } : node);
    const env = await setup({ resources: items, taskStates, url });
    try {
        await env.open();
        env.ui.querySelector('[data-search]').value = '找不到';
        env.ui.querySelector('[data-search]').dispatchEvent(new env.win.Event('input'));
        env.ui.querySelector('[data-filter="completed"]').click(); await env.flush();
        assert.equal(step(env, 'previous').dataset.targetNode, '301');
        assert.equal(step(env, 'next').dataset.targetNode, '305');
        const other = env.ui.querySelector('[data-resource-kind="other"]');
        other.checked = false; other.dispatchEvent(new env.win.Event('change')); await env.flush();
        assert.equal(step(env, 'next').disabled, true);
        await policy(env, 'all'); assert.equal(step(env, 'next').dataset.targetNode, '304');
    } finally { env.dom.window.close(); }
});

test('stepping within the pending queue preserves running and paused learning intent', async () => {
    for (const paused of [false, true]) {
        const env = await setup({ resources, taskStates, url });
        try {
            await env.start();
            if (paused) { env.ui.querySelector('[data-start]').click(); await env.flush(); }
            step(env, 'next').click();
            const saved = JSON.parse(env.win.sessionStorage.getItem('xy-video-helper-v1'));
            assert.equal(saved.navigation?.node, '305'); assert.equal(saved.running, !paused);
        } finally { env.dom.window.close(); }
    }
});
