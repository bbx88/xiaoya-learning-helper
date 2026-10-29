const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setup } = require('./fixture.cjs');

const elapsed = env => env.ui.querySelector('[data-session-duration]')?.textContent;
async function playFor(env, seconds) {
    env.advance(seconds * 1000); env.video.currentTime += seconds * env.video.playbackRate; await env.tick();
}

test('session time counts actual playback and pause/resume preserves it without changing historical time', async () => {
    const env = await setup();
    try {
        await env.start(); await playFor(env, 10);
        assert.equal(elapsed(env), '00:00:10');
        env.ui.querySelector('[data-start]').click(); await env.flush(); env.advance(20000); await env.tick();
        assert.equal(elapsed(env), '00:00:10');
        await env.start(); await playFor(env, 5);
        assert.equal(elapsed(env), '00:00:15');
        assert.equal(env.ui.querySelector('[data-history]').textContent, '41 分钟');
    } finally { env.dom.window.close(); }
});

test('seeking does not add skipped video minutes and buffering without progress is excluded', async () => {
    const env = await setup();
    try {
        await env.start(); await playFor(env, 10);
        env.video.currentTime = 500; env.video.dispatchEvent(new env.win.Event('seeked')); await env.tick();
        assert.equal(elapsed(env), '00:00:10');
        env.ready(2, 'waiting'); env.advance(30000); await env.tick();
        assert.equal(elapsed(env), '00:00:10');
        env.ready(4, 'canplay'); await env.flush(); await playFor(env, 5);
        assert.equal(elapsed(env), '00:00:15');
    } finally { env.dom.window.close(); }
});

test('native playback while the helper is paused does not add to session or daily totals', async () => {
    const env = await setup();
    try {
        await env.start(); await playFor(env, 10);
        env.ui.querySelector('[data-start]').click(); await env.flush();
        await env.video.play(); await playFor(env, 5);
        assert.equal(elapsed(env), '00:00:10');
        assert.equal(env.ui.querySelector('[data-today-duration]').textContent, '00:00:10');
        env.video.pause(); await env.flush();
        await env.start(); await playFor(env, 5);
        assert.equal(elapsed(env), '00:00:15');
    } finally { env.dom.window.close(); }
});

test('faster playback counts elapsed study time rather than the media timeline distance', async () => {
    const env = await setup();
    try {
        env.video.playbackRate = 2;
        await env.start(); await playFor(env, 10);
        assert.equal(elapsed(env), '00:00:10');
        assert.equal(env.ui.querySelector('[data-today-duration]').textContent, '00:00:10');
    } finally { env.dom.window.close(); }
});

test('nonvideo session time follows valid dwell time and excludes loading and paused time', async () => {
    const env = await setup({ resources: [{ id: '301', type: 6, task_type: 1, task_id: 't1', name: '课件.pdf' }] });
    try {
        const body = env.win.document.querySelector('.group-resource-content');
        body.innerHTML = '<div aria-busy="true">加载中</div>';
        await env.start(); env.advance(20000); await env.tick();
        assert.equal(elapsed(env), '00:00:00');
        body.innerHTML = '<div>预览已就绪</div>'; await env.tick(); env.advance(30000); await env.tick();
        assert.equal(elapsed(env), '00:00:30');
        env.ui.querySelector('[data-start]').click(); await env.flush(); env.advance(20000); await env.tick();
        assert.equal(elapsed(env), '00:00:30');
    } finally { env.dom.window.close(); }
});

test('navigation continues the same session, excludes navigation waits, and stop starts a new session next time', async () => {
    const env = await setup({ currentSrc: 'https://media.test/301.mp4' });
    try {
        await env.start(); await playFor(env, 10);
        env.ui.querySelector('[data-step="next"]').click(); env.advance(10000); await env.tick();
        assert.equal(elapsed(env), '00:00:10');
        env.win.history.replaceState({}, '', '/app/jx-web/mycourse/100/resource/200/302');
        env.source('https://media.test/302.mp4'); env.video.currentTime = 0; await env.tick();
        await playFor(env, 5); assert.equal(elapsed(env), '00:00:15');
        env.ui.querySelector('[data-stop]').click(); await env.flush();
        assert.equal(elapsed(env), '00:00:15');
        await env.start(); assert.equal(elapsed(env), '00:00:00');
    } finally { env.dom.window.close(); }
});

test('refresh restores the accumulated time without counting time away from the page', async () => {
    const first = await setup(); await first.start(); await playFor(first, 10);
    first.win.dispatchEvent(new first.win.Event('pagehide'));
    const saved = { sessionStorage: Object.fromEntries(Object.entries(first.win.sessionStorage)),
        localStorage: Object.fromEntries(Object.entries(first.win.localStorage)), currentTime: first.video.currentTime };
    first.dom.window.close();
    const env = await setup(saved);
    try {
        await env.open(); await env.tick();
        assert.equal(elapsed(env), '00:00:10');
        await playFor(env, 5); assert.equal(elapsed(env), '00:00:15');
    } finally { env.dom.window.close(); }
    const another = await setup({ ...saved, userId: 'other-user' });
    try { await another.open(); assert.equal(elapsed(another), '00:00:00'); }
    finally { another.dom.window.close(); }
});

test('today time survives a new tab while the new session starts from zero and stays isolated by course/user', async () => {
    const first = await setup(); await first.start(); await playFor(first, 10);
    first.win.dispatchEvent(new first.win.Event('pagehide'));
    const saved = Object.fromEntries(Object.entries(first.win.localStorage)); first.dom.window.close();
    const next = await setup({ localStorage: saved });
    try {
        await next.open();
        assert.equal(next.ui.querySelector('[data-today-duration]').textContent, '00:00:10');
        assert.equal(elapsed(next), '00:00:00');
        await next.start(); await playFor(next, 5);
        assert.equal(next.ui.querySelector('[data-today-duration]').textContent, '00:00:15');
        assert.equal(elapsed(next), '00:00:05');
    } finally { next.dom.window.close(); }
    for (const options of [{ userId: 'another-user' }, { url: 'https://whut.ai-augmented.com/app/jx-web/mycourse/101/resource/200/301' }]) {
        const env = await setup({ ...options, localStorage: saved });
        try { await env.open(); assert.equal(env.ui.querySelector('[data-today-duration]').textContent, '00:00:00'); }
        finally { env.dom.window.close(); }
    }
});

test('crossing midnight allocates playback to the correct Shanghai date without resetting the session', async () => {
    const env = await setup({ now: Date.parse('2026-10-29T15:59:55Z') });
    try {
        await env.start(); await playFor(env, 10);
        assert.equal(elapsed(env), '00:00:10');
        assert.equal(env.ui.querySelector('[data-today-duration]').textContent, '00:00:05');
        await playFor(env, 5);
        assert.equal(env.ui.querySelector('[data-today-duration]').textContent, '00:00:10');
        assert.equal(elapsed(env), '00:00:15');
    } finally { env.dom.window.close(); }
});
