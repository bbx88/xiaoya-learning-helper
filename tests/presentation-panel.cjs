const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setup } = require('./fixture.cjs');

test('ordinary PPT and PPTX join the learning queue without self-study tags', async () => {
    const env = await setup({ localStorage: { 'xy-learning-settings-v1:test-user:100': JSON.stringify({ queuePolicy: 'all' }) }, resources: [
        { id: '301', parent_id: '200', type: 6, name: '1.ppt' },
        { id: '302', parent_id: '200', type: 6, name: '2.PPTX' },
        { id: '303', parent_id: '200', type: 6, name: '3.pdf' }
    ] });
    try {
        await env.open();
        assert.deepEqual([...env.ui.querySelectorAll('[data-node]')].map(node => node.dataset.node), ['301', '302', '303']);
        await env.start();
        assert.equal(env.ui.querySelector('[data-state]').textContent, '阅读中');
        assert.match(env.ui.querySelector('[data-kind]').textContent, /其他资料/);
        env.advance(120000); await env.tick(); await env.timers();
        assert.equal(JSON.parse(env.win.sessionStorage.getItem('xy-video-helper-v1')).navigation.node, '302');
        assert.ok(env.requests.every(request => request.method === 'GET'));
    } finally { env.dom.window.close(); }
});

test('PPT MIME types are recognized when filenames omit their extension', async () => {
    const env = await setup({ localStorage: { 'xy-learning-settings-v1:test-user:100': JSON.stringify({ queuePolicy: 'all' }) }, resources: [
        { id: '301', type: 6, name: '第一章', mimetype: 'application/vnd.ms-powerpoint' },
        { id: '302', type: 6, name: '第二章', mimetype: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
    ] });
    try {
        await env.start();
        assert.equal(env.ui.querySelectorAll('[data-node]').length, 2);
        assert.match(env.ui.querySelector('[data-kind]').textContent, /其他资料/);
    } finally { env.dom.window.close(); }
});

test('ordinary PPT uses its configured dwell time and supports single-resource study', async () => {
    const env = await setup({ localStorage: { 'xy-learning-settings-v1:test-user:100': JSON.stringify({ queuePolicy: 'all' }) }, resources: [{ id: '301', type: 6, name: '课件.pptx' }] });
    try {
        await env.open(); env.ui.querySelector('[data-learning-mode="single"]').click();
        const input = env.ui.querySelector('[data-resource-minutes]');
        input.value = '3'; input.dispatchEvent(new env.win.Event('change'));
        await env.start(); env.advance(120000); await env.tick(); await env.timers();
        assert.equal(env.ui.querySelector('[data-state]').textContent, '阅读中');
        env.advance(60000); await env.tick(); await env.timers();
        assert.equal(env.ui.querySelector('[data-state]').textContent, '本次已结束');
        assert.equal(JSON.parse(env.win.sessionStorage.getItem('xy-video-helper-v1')).navigation, null);
        assert.equal(env.ui.querySelector('[data-history]').textContent, '41 分钟');
    } finally { env.dom.window.close(); }
});

test('the panel stops moving down at the minimum height while its launcher can keep moving', async () => {
    const env = await setup();
    try {
        await env.open();
        const shell = env.ui.querySelector('.shell');
        shell.getBoundingClientRect = () => ({ width: 380, height: 620, top: 0 });
        env.ui.querySelector('.actions').getBoundingClientRect = () => ({ bottom: 400 });
        const launcher = env.ui.querySelector('[data-launcher]');
        launcher.dispatchEvent(new env.win.MouseEvent('pointerdown', { button: 0, clientX: 100, clientY: 100 }));
        launcher.dispatchEvent(new env.win.MouseEvent('pointermove', { clientX: 100, clientY: 600 }));
        launcher.dispatchEvent(new env.win.MouseEvent('pointerup', { clientX: 100, clientY: 600 }));
        const host = env.win.document.getElementById('xy-video-helper');
        const panelY = parseFloat(host.style.top) + parseFloat(shell.style.top);
        const minimum = parseFloat(shell.style.minHeight);
        assert.equal(minimum, 412, 'Minimum height ends at the playback controls, with 12px of bottom spacing');
        assert.equal(panelY + minimum, env.win.innerHeight - 12);
        assert.ok(parseFloat(host.style.top) > panelY, 'Only the round launcher can move below the panel minimum');
    } finally { env.dom.window.close(); }
});

test('header dragging moves the panel down and back up without changing playback', async () => {
    const env = await setup();
    try {
        await env.start();
        const shell = env.ui.querySelector('.shell'), header = env.ui.querySelector('[data-drag]');
        const host = env.win.document.getElementById('xy-video-helper');
        const y = () => parseFloat(host.style.top) + parseFloat(shell.style.top);
        const before = y();
        for (const delta of [100, -50]) {
            const start = y();
            header.dispatchEvent(new env.win.MouseEvent('pointerdown', { button: 0, clientX: 100, clientY: 100 }));
            header.dispatchEvent(new env.win.MouseEvent('pointermove', { clientX: 100, clientY: 100 + delta }));
            header.dispatchEvent(new env.win.MouseEvent('pointerup'));
            assert.equal(y(), start + delta);
        }
        assert.ok(Math.abs(y() - before - 50) < 0.001);
        assert.equal(env.video.paused, false);
    } finally { env.dom.window.close(); }
});

test('up and down buttons scroll the panel without moving it or pausing playback', async () => {
    const env = await setup();
    try {
        await env.start();
        const shell = env.ui.querySelector('.shell'), calls = [];
        shell.scrollBy = options => calls.push(options);
        const down = env.ui.querySelector('[data-panel-scroll="down"]');
        const up = env.ui.querySelector('[data-panel-scroll="up"]');
        assert.ok(down && up, 'Both directions must be accessible from the header');
        down.click(); up.click();
        assert.ok(calls[0].top > 0);
        assert.ok(calls[1].top < 0);
        assert.equal(env.video.paused, false);
        assert.equal(shell.hidden, false);
    } finally { env.dom.window.close(); }
});

test('scrolling upper content does not shrink the measured panel minimum', async () => {
    const env = await setup();
    try {
        await env.open();
        const shell = env.ui.querySelector('.shell');
        shell.getBoundingClientRect = () => ({ width: 380, height: 620, top: 0 });
        env.ui.querySelector('.actions').getBoundingClientRect = () => ({ bottom: 400 - shell.scrollTop });
        env.win.dispatchEvent(new env.win.Event('resize'));
        assert.equal(parseFloat(shell.style.minHeight), 412);
        shell.scrollTop = 160;
        env.win.dispatchEvent(new env.win.Event('resize'));
        assert.equal(parseFloat(shell.style.minHeight), 412, 'Use content coordinates rather than the currently scrolled button position');
    } finally { env.dom.window.close(); }
});

test('older list caches do not hide PPT resources after upgrading', async () => {
    const first = await setup(); await first.open();
    const saved = Object.fromEntries(Object.entries(first.win.localStorage));
    for (const key of Object.keys(saved)) if (key.startsWith('xy-learning-cache-')) {
        const legacyKey = key.replace(/xy-learning-cache-v\d+:/, 'xy-learning-cache-v5:');
        saved[legacyKey] = saved[key];
        if (key !== legacyKey) delete saved[key];
    }
    first.dom.window.close();
    const env = await setup({ localStorage: saved, resources: [{ id: '301', type: 6, name: '新增普通课件.pptx' }] });
    try {
        await env.open();
        assert.ok(env.requests.some(request => request.url.pathname.includes('queryCourseResources')));
        assert.equal(env.ui.querySelectorAll('[data-node]').length, 1);
        assert.match(env.ui.querySelector('[data-title]').textContent, /新增普通课件/);
    } finally { env.dom.window.close(); }
});
