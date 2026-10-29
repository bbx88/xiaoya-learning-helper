const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setup } = require('./fixture.cjs');

const resources = [{ id: '301', type: 6, name: '资料.pdf', task_id: 't1', task_type: 1 }];
const storage = env => Object.fromEntries(Object.entries(env.win.localStorage));
async function minutes(env, value) {
    const input = env.ui.querySelector('[data-default-minutes]');
    input.value = String(value); input.dispatchEvent(new env.win.Event('change')); await env.flush();
}

test('user default dwell duration follows the same account across courses while resource overrides stay local', async () => {
    const first = await setup({ resources });
    await first.open(); await minutes(first, 7);
    const override = first.ui.querySelector('[data-resource-minutes]');
    override.value = '3'; override.dispatchEvent(new first.win.Event('change')); await first.flush();
    const saved = storage(first); first.dom.window.close();
    const otherCourse = await setup({ resources, localStorage: saved,
        url: 'https://whut.ai-augmented.com/app/jx-web/mycourse/101/resource/200/301' });
    try {
        await otherCourse.open();
        assert.equal(otherCourse.ui.querySelector('[data-default-minutes]').value, '7');
        assert.equal(otherCourse.ui.querySelector('[data-resource-minutes]').value, '');
        assert.equal(otherCourse.ui.querySelector('[data-duration]').textContent, '07:00');
        await minutes(otherCourse, 9);
        const updated = storage(otherCourse);
        const reopened = await setup({ resources, localStorage: updated });
        try {
            await reopened.open();
            assert.equal(reopened.ui.querySelector('[data-default-minutes]').value, '9');
            assert.equal(reopened.ui.querySelector('[data-duration]').textContent, '03:00');
            reopened.ui.querySelector('[data-reset-resource]').click(); await reopened.flush();
            assert.equal(reopened.ui.querySelector('[data-duration]').textContent, '09:00');
        } finally { reopened.dom.window.close(); }
    } finally { otherCourse.dom.window.close(); }
});

test('legacy course default migrates once and cannot override an existing user default', async () => {
    const first = await setup({ resources, localStorage: {
        'xy-learning-settings-v1:test-user:100': JSON.stringify({ documentMinutes: 15 }),
        'xy-learning-settings-v1:test-user:101': JSON.stringify({ documentMinutes: 3 })
    } });
    await first.open();
    assert.equal(first.ui.querySelector('[data-default-minutes]').value, '15');
    const saved = storage(first); first.dom.window.close();
    const next = await setup({ resources, localStorage: saved,
        url: 'https://whut.ai-augmented.com/app/jx-web/mycourse/101/resource/200/301' });
    try { await next.open(); assert.equal(next.ui.querySelector('[data-default-minutes]').value, '15'); }
    finally { next.dom.window.close(); }
    const otherUser = await setup({ resources, userId: 'other-user', localStorage: saved });
    try { await otherUser.open(); assert.equal(otherUser.ui.querySelector('[data-default-minutes]').value, '2'); }
    finally { otherUser.dom.window.close(); }
});

test('another tab changing the same user default updates inherited duration without resetting elapsed time', async () => {
    const env = await setup({ resources });
    try {
        await env.start(); env.advance(30000); await env.tick();
        const key = 'xy-learning-defaults-v1:test-user';
        const value = JSON.stringify({ documentMinutes: 8 });
        env.win.localStorage.setItem(key, value);
        env.win.dispatchEvent(new env.win.StorageEvent('storage', { key, newValue: value, storageArea: env.win.localStorage }));
        await env.flush();
        assert.equal(env.ui.querySelector('[data-default-minutes]').value, '8');
        assert.equal(env.ui.querySelector('[data-duration]').textContent, '08:00');
        assert.equal(env.ui.querySelector('[data-elapsed]').textContent, '00:30');
    } finally { env.dom.window.close(); }
});
