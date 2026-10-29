const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setup } = require('./fixture.cjs');

const storage = env => Object.fromEntries(Object.entries(env.win.localStorage));
const event = (env, name) => env.video.dispatchEvent(new env.win.Event(name));
async function remember(options = {}, seconds = 237) {
    const env = await setup(options);
    await env.start();
    env.video.currentTime = seconds;
    event(env, 'timeupdate');
    env.win.dispatchEvent(new env.win.Event('pagehide'));
    const saved = storage(env);
    env.dom.window.close();
    return saved;
}

test('a reopened page resumes the video position without session storage', async () => {
    const saved = await remember();
    const env = await setup({ localStorage: saved, currentTime: 0 });
    try {
        await env.open(); await env.tick();
        assert.equal(env.video.currentTime, 237);
        assert.equal(env.playCount(), 0, 'Opening the page should restore position without starting playback');
        await env.start();
        assert.equal(env.video.currentTime, 237);
        assert.equal(env.video.paused, false);
    } finally { env.dom.window.close(); }
});

test('manual player playback is remembered even when the helper has not been started', async () => {
    const env = await setup({ currentTime: 0 });
    await env.open(); await env.tick();
    await env.video.play();
    env.video.currentTime = 184.5; event(env, 'timeupdate');
    env.video.pause();
    const saved = storage(env); env.dom.window.close();
    const next = await setup({ localStorage: saved, currentTime: 0 });
    try { await next.open(); await next.tick(); assert.equal(next.video.currentTime, 184.5); }
    finally { next.dom.window.close(); }
});

test('course overview continues the last video rather than the first item', async () => {
    const saved = await remember({ url: 'https://whut.ai-augmented.com/app/jx-web/mycourse/100/resource/200/302' }, 312);
    const env = await setup({ localStorage: saved, url: 'https://whut.ai-augmented.com/app/jx-web/mycourse/100' });
    try {
        await env.open();
        assert.equal(env.ui.querySelector('[data-action-label]').textContent, '继续上次学习');
        assert.equal(env.ui.querySelector('[data-title]').textContent, '2.mp4');
        assert.equal(env.ui.querySelector('[data-elapsed]').textContent, '05:12');
        await env.start();
        assert.equal(JSON.parse(env.win.sessionStorage.getItem('xy-video-helper-v1')).navigation.node, '302');
    } finally { env.dom.window.close(); }
});

test('single mode also offers the last video from the course overview', async () => {
    const saved = await remember({ url: 'https://whut.ai-augmented.com/app/jx-web/mycourse/100/resource/200/302' });
    const key = Object.keys(saved).find(key => key.startsWith('xy-learning-settings-v1:')) || 'xy-learning-settings-v1:test-user:100';
    saved[key] = JSON.stringify({ mode: 'single' });
    const env = await setup({ localStorage: saved, url: 'https://whut.ai-augmented.com/app/jx-web/mycourse/100' });
    try {
        await env.open();
        assert.equal(env.ui.querySelector('[data-start]').disabled, false);
        await env.start();
        assert.equal(JSON.parse(env.win.sessionStorage.getItem('xy-video-helper-v1')).navigation.node, '302');
    } finally { env.dom.window.close(); }
});

test('late metadata restores the saved position before playing', async () => {
    const saved = await remember();
    const env = await setup({ localStorage: saved, currentTime: 0, readyState: 0 });
    try {
        await env.start();
        assert.equal(env.video.currentTime, 0);
        assert.equal(env.playCount(), 0);
        env.ready(1, 'loadedmetadata'); await env.flush();
        assert.equal(env.video.currentTime, 237);
        assert.equal(env.video.paused, false);
    } finally { env.dom.window.close(); }
});

test('an unready page closed again does not overwrite a saved position with zero', async () => {
    const saved = await remember();
    const unready = await setup({ localStorage: saved, currentTime: 0, readyState: 0 });
    await unready.open(); await unready.tick();
    unready.win.dispatchEvent(new unready.win.Event('pagehide'));
    const retained = storage(unready); unready.dom.window.close();
    const env = await setup({ localStorage: retained, currentTime: 0 });
    try { await env.open(); await env.tick(); assert.equal(env.video.currentTime, 237); }
    finally { env.dom.window.close(); }
});

test('a temporarily rejected seek is retried without losing the saved position', async () => {
    const saved = await remember();
    const env = await setup({ localStorage: saved, currentTime: 0, seekFailures: 1 });
    try {
        await env.open(); env.ready(3, 'canplay'); await env.tick();
        assert.equal(env.video.currentTime, 237);
    } finally { env.dom.window.close(); }
});

test('position survives token rotation for the same confirmed account', async () => {
    const saved = await remember();
    const env = await setup({ localStorage: saved, currentTime: 0, cookie: 'prd-access-token=renewed-token' });
    try { await env.open(); await env.tick(); assert.equal(env.video.currentTime, 237); }
    finally { env.dom.window.close(); }
});

test('another account and another course do not inherit the saved position', async () => {
    const saved = await remember();
    for (const options of [{ userId: 'another-user' }, { url: 'https://whut.ai-augmented.com/app/jx-web/mycourse/101/resource/200/301' }]) {
        const env = await setup({ ...options, localStorage: saved, currentTime: 0 });
        try { await env.open(); await env.tick(); assert.equal(env.video.currentTime, 0); }
        finally { env.dom.window.close(); }
    }
});

test('an explicit different video does not inherit the last video position', async () => {
    const saved = await remember();
    const env = await setup({ localStorage: saved, currentTime: 0, url: 'https://whut.ai-augmented.com/app/jx-web/mycourse/100/resource/200/302' });
    try { await env.start(); assert.equal(env.video.currentTime, 0); }
    finally { env.dom.window.close(); }
});

test('seeking backwards replaces the previous position, including a return to zero', async () => {
    const saved = await remember();
    const env = await setup({ localStorage: saved, currentTime: 0 });
    await env.start(); env.video.currentTime = 0; event(env, 'seeked');
    env.video.pause();
    const rewound = storage(env); env.dom.window.close();
    const next = await setup({ localStorage: rewound, currentTime: 80 });
    try { await next.open(); await next.tick(); assert.equal(next.video.currentTime, 0); }
    finally { next.dom.window.close(); }
});

test('SPA navigation saves each video under its own identity and restores it on return', async () => {
    const env = await setup({ currentSrc: 'https://media.test/301.mp4', currentTime: 0 });
    try {
        await env.start(); env.video.currentTime = 180; event(env, 'timeupdate');
        env.ui.querySelector('[data-step="next"]').click();
        env.win.history.replaceState({}, '', '/app/jx-web/mycourse/100/resource/200/302');
        env.source('https://media.test/302.mp4'); env.video.currentTime = 0;
        await env.tick();
        assert.equal(env.video.currentTime, 0);
        env.video.currentTime = 42; event(env, 'timeupdate');
        env.ui.querySelector('[data-step="previous"]').click();
        env.win.history.replaceState({}, '', '/app/jx-web/mycourse/100/resource/200/301');
        env.source('https://media.test/301.mp4'); env.video.currentTime = 0;
        await env.tick();
        assert.equal(env.video.currentTime, 180);
    } finally { env.dom.window.close(); }
});

test('a completed last video continues with the following resource from the overview', async () => {
    const env = await setup({ currentTime: 0 });
    await env.start(); env.video.currentTime = 600; env.end();
    const saved = storage(env); env.dom.window.close();
    const next = await setup({ localStorage: saved, url: 'https://whut.ai-augmented.com/app/jx-web/mycourse/100' });
    try {
        await next.start();
        assert.equal(JSON.parse(next.win.sessionStorage.getItem('xy-video-helper-v1')).navigation.node, '302');
    } finally { next.dom.window.close(); }
});

test('pagehide captures the latest time even without a final timeupdate event', async () => {
    const env = await setup({ currentTime: 0 });
    await env.start(); env.video.currentTime = 212.25;
    env.win.dispatchEvent(new env.win.Event('pagehide'));
    const saved = storage(env); env.dom.window.close();
    const next = await setup({ localStorage: saved, currentTime: 0 });
    try { await next.open(); await next.tick(); assert.equal(next.video.currentTime, 212.25); }
    finally { next.dom.window.close(); }
});

test('periodic checkpoints survive a close without pagehide and do not need a final pause', async () => {
    const env = await setup({ currentTime: 0 });
    await env.start(); env.video.currentTime = 79; env.advance(5000); await env.tick();
    const saved = storage(env); env.dom.window.close();
    const next = await setup({ localStorage: saved, currentTime: 0 });
    try { await next.open(); await next.tick(); assert.equal(next.video.currentTime, 79); }
    finally { next.dom.window.close(); }
});

test('manual SPA navigation does not apply the next video bookmark to the outgoing source', async () => {
    const saved = await remember({ url: 'https://whut.ai-augmented.com/app/jx-web/mycourse/100/resource/200/302' }, 90);
    const env = await setup({ localStorage: saved, currentTime: 0, currentSrc: 'https://media.test/301.mp4' });
    try {
        await env.start(); env.video.currentTime = 210; event(env, 'timeupdate');
        env.win.history.replaceState({}, '', '/app/jx-web/mycourse/100/resource/200/302');
        await env.tick();
        assert.equal(env.video.currentTime, 210, 'The outgoing player must not be sought to the destination bookmark');
        env.source('https://media.test/302.mp4'); env.video.currentTime = 0;
        await env.tick();
        assert.equal(env.video.currentTime, 90);
    } finally { env.dom.window.close(); }
});

test('token renewal in the same tab does not permanently block the existing player', async () => {
    const env = await setup({ currentTime: 0, currentSrc: 'https://media.test/301.mp4' });
    try {
        await env.start(); env.video.currentTime = 150; event(env, 'timeupdate');
        env.win.document.cookie = 'prd-access-token=renewed-token; Path=/';
        await env.tick(); await env.tick(); await env.start();
        assert.equal(env.video.paused, false);
        assert.equal(env.video.currentTime, 150);
    } finally { env.dom.window.close(); }
});

test('a player with unknown duration can start loading frames and restore after duration becomes known', async () => {
    const saved = await remember();
    const env = await setup({ localStorage: saved, currentTime: 0, duration: NaN, readyState: 1 });
    try {
        await env.start();
        assert.ok(env.playCount() > 0);
        env.duration(600); env.ready(3, 'canplay'); await env.flush();
        assert.equal(env.video.currentTime, 237);
    } finally { env.dom.window.close(); }
});

test('restoration clamps a position when the current video has become shorter', async () => {
    const saved = await remember();
    const env = await setup({ localStorage: saved, currentTime: 0, duration: 100 });
    try { await env.open(); await env.tick(); assert.equal(env.video.currentTime, 99); }
    finally { env.dom.window.close(); }
});

test('unavailable local storage does not prevent playback', async () => {
    const env = await setup({ currentTime: 0 });
    try {
        await env.open();
        env.win.Storage.prototype.setItem = () => { throw new env.win.DOMException('Storage full', 'QuotaExceededError'); };
        await env.start(); env.video.currentTime = 99; event(env, 'timeupdate');
        env.video.pause(); await env.start();
        assert.equal(env.video.paused, false);
        assert.equal(env.video.currentTime, 99);
    } finally { env.dom.window.close(); }
});

test('malformed playback storage is ignored without breaking the course', async () => {
    const saved = await remember();
    const key = Object.keys(saved).find(key => key.startsWith('xy-learning-playback-v1:'));
    assert.ok(key, 'The first session must have saved persistent playback data');
    saved[key] = '{broken json';
    const env = await setup({ localStorage: saved, currentTime: 0 });
    try { await env.start(); assert.equal(env.video.currentTime, 0); assert.equal(env.video.paused, false); }
    finally { env.dom.window.close(); }
});

test('a paused old tab does not replace the more recently played video from another tab', async () => {
    const first = await setup({ currentTime: 0 });
    await first.start(); first.video.currentTime = 60; event(first, 'timeupdate'); first.video.pause();
    const second = await setup({ localStorage: storage(first), currentTime: 0,
        url: 'https://whut.ai-augmented.com/app/jx-web/mycourse/100/resource/200/302' });
    await second.start(); second.video.currentTime = 90;
    second.win.dispatchEvent(new second.win.Event('pagehide'));
    for (const [key, value] of Object.entries(storage(second))) first.win.localStorage.setItem(key, value);
    second.dom.window.close();
    first.advance(6000); await first.tick();
    first.win.dispatchEvent(new first.win.Event('pagehide'));
    const saved = storage(first); first.dom.window.close();
    const overview = await setup({ localStorage: saved, url: 'https://whut.ai-augmented.com/app/jx-web/mycourse/100' });
    try {
        await overview.start();
        assert.equal(JSON.parse(overview.win.sessionStorage.getItem('xy-video-helper-v1')).navigation.node, '302');
    } finally { overview.dom.window.close(); }
});
