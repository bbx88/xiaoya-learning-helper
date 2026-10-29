const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setup } = require('./fixture.cjs');

const resources = [
    { id: '301', parent_id: '200', type: 6, name: '第一章.ppt' },
    { id: '302', parent_id: '200', type: 9, name: '第二章.mp4' }
];
function confirmation(env, options = {}) {
    const body = env.win.document.querySelector('.group-resource-content');
    const result = env.win.document.createElement('div');
    result.className = 'ant-result ant-result-info';
    result.innerHTML = `<div class="ant-result-title">文件预览确认</div><div class="ant-result-subtitle">是否确认打开文件：${options.filename || '第一章.ppt'}</div><div class="ant-result-extra"><button ${options.disabled ? 'disabled' : ''}><span>确 定</span></button></div>`;
    body.replaceChildren(result);
    const button = result.querySelector('button');
    let clicks = 0;
    button.onclick = () => { clicks++; options.onClick?.(body, result); };
    return { body, result, button, clicks: () => clicks };
}

test('nonvideo study confirms the preview and starts dwell time only after loading completes', async () => {
    const env = await setup({ localStorage: { 'xy-learning-settings-v1:test-user:100': JSON.stringify({ queuePolicy: 'all' }) }, resources });
    try {
        await env.open();
        const gate = confirmation(env, { onClick: body => { body.innerHTML = '<div aria-busy="true">正在载入预览</div>'; } });
        await env.start();
        assert.equal(gate.clicks(), 1);
        env.advance(180000); await env.tick(); await env.timers();
        assert.equal(env.ui.querySelector('[data-elapsed]').textContent, '00:00');
        assert.equal(JSON.parse(env.win.sessionStorage.getItem('xy-video-helper-v1')).navigation, null);
        gate.body.innerHTML = '<iframe title="课件预览"></iframe>';
        await env.tick(); env.advance(60000); await env.tick();
        assert.equal(env.ui.querySelector('[data-elapsed]').textContent, '01:00');
        assert.ok(env.requests.every(request => request.method === 'GET'));
    } finally { env.dom.window.close(); }
});

test('a disabled preview confirmation does not count dwell time and is clicked after enabling', async () => {
    const env = await setup({ localStorage: { 'xy-learning-settings-v1:test-user:100': JSON.stringify({ queuePolicy: 'all' }) }, resources });
    try {
        await env.open();
        const gate = confirmation(env, { disabled: true });
        await env.start(); env.advance(180000); await env.tick(); await env.timers();
        assert.equal(gate.clicks(), 0);
        assert.equal(env.ui.querySelector('[data-elapsed]').textContent, '00:00');
        assert.equal(JSON.parse(env.win.sessionStorage.getItem('xy-video-helper-v1')).navigation, null);
        gate.button.disabled = false; await env.tick();
        assert.equal(gate.clicks(), 1);
    } finally { env.dom.window.close(); }
});

test('manual navigation while stopped waits for an explicit start before confirming preview', async () => {
    const env = await setup({ localStorage: { 'xy-learning-settings-v1:test-user:100': JSON.stringify({ queuePolicy: 'all' }) }, resources, saved: { course: '100', running: false,
        navigation: { course: '100', node: '301', fromNode: '302', name: '第一章.ppt', startedAt: Date.now() } } });
    try {
        const gate = confirmation(env);
        await env.open(); await env.tick();
        assert.equal(gate.clicks(), 0);
        await env.start();
        assert.equal(gate.clicks(), 1);
    } finally { env.dom.window.close(); }
});

test('confirmation clicks are throttled and stop after three unsuccessful attempts', async () => {
    const env = await setup({ localStorage: { 'xy-learning-settings-v1:test-user:100': JSON.stringify({ queuePolicy: 'all' }) }, resources });
    try {
        await env.open(); const gate = confirmation(env);
        await env.start(); await env.tick(); await env.tick();
        assert.equal(gate.clicks(), 1);
        for (let i = 0; i < 4; i++) { env.advance(3000); await env.tick(); }
        assert.equal(gate.clicks(), 3);
        assert.equal(JSON.parse(env.win.sessionStorage.getItem('xy-video-helper-v1')).running, false);
        assert.match(env.ui.querySelector('[data-status]').textContent, /手动确认/);
        assert.equal(env.ui.querySelector('[data-elapsed]').textContent, '00:00');
    } finally { env.dom.window.close(); }
});

test('unrelated confirmation buttons inside the resource are never auto-clicked', async () => {
    const env = await setup({ localStorage: { 'xy-learning-settings-v1:test-user:100': JSON.stringify({ queuePolicy: 'all' }) }, resources });
    try {
        await env.open(); const gate = confirmation(env);
        gate.result.querySelector('.ant-result-title').textContent = '确认提交任务';
        await env.start(); await env.tick();
        assert.equal(gate.clicks(), 0);
    } finally { env.dom.window.close(); }
});

test('a stale confirmation naming another file blocks timing and is not clicked', async () => {
    const env = await setup({ localStorage: { 'xy-learning-settings-v1:test-user:100': JSON.stringify({ queuePolicy: 'all' }) }, resources });
    try {
        await env.open(); const gate = confirmation(env, { filename: '旧的课件.ppt' });
        await env.start(); env.advance(180000); await env.tick(); await env.timers();
        assert.equal(gate.clicks(), 0);
        assert.equal(env.ui.querySelector('[data-elapsed]').textContent, '00:00');
        assert.equal(JSON.parse(env.win.sessionStorage.getItem('xy-video-helper-v1')).navigation, null);
    } finally { env.dom.window.close(); }
});

test('a preview failure after confirmation stops instead of accruing dwell time', async () => {
    const env = await setup({ localStorage: { 'xy-learning-settings-v1:test-user:100': JSON.stringify({ queuePolicy: 'all' }) }, resources });
    try {
        await env.open();
        confirmation(env, { onClick: body => { body.innerHTML = '<div class="ant-result-error">预览失败</div>'; } });
        await env.start(); await env.tick();
        assert.match(env.ui.querySelector('[data-status]').textContent, /预览失败/);
        assert.equal(JSON.parse(env.win.sessionStorage.getItem('xy-video-helper-v1')).running, false);
        assert.equal(env.ui.querySelector('[data-elapsed]').textContent, '00:00');
    } finally { env.dom.window.close(); }
});
