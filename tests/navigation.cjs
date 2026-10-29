// Real-browser regression: native link defaults and page targets cannot be checked by jsdom.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'xiaoya-video.user.js'));
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const resources = [301, 302, 303].map(id => ({ id: String(id), parent_id: '200', type: 9, name: `${id}.mp4`, sort_position: id }));
const html = `<!doctype html><html><head><base target="_blank"></head><body>
<div class="group-resource-body"><div class="group-resource-content"><div class="ali_player_wrapper"><video></video></div></div></div>
<script>
document.cookie='prd-access-token=local-navigation-test; Path=/';
// Simulate a page/extension that opens clicked links during capture, before helper handlers run.
document.addEventListener('click',event=>{
    const link=event.composedPath().find(element=>element.tagName==='A'&&element.href);
    if(link)window.open(link.href,'_blank');
},true);
const seen=JSON.parse(sessionStorage.getItem('navigation-visited')||'[]'), node=location.pathname.split('/').pop();
const revisited=seen.includes(node); if(!revisited){seen.push(node);sessionStorage.setItem('navigation-visited',JSON.stringify(seen))}
const video=document.querySelector('video'); let paused=true, readyState=revisited?0:4;
Object.defineProperties(video,{readyState:{get:()=>readyState},duration:{get:()=>600},paused:{get:()=>paused},ended:{get:()=>false}});
video.play=async()=>{paused=false;video.dispatchEvent(new Event('play'))};
video.pause=()=>{if(!paused){paused=true;video.dispatchEvent(new Event('pause'))}};
if(revisited){
    // Wait for the helper to bind this initially unready player before readiness changes.
    const timer=setInterval(()=>{
        const ui=document.querySelector('#xy-video-helper')?.shadowRoot;
        if(ui?.querySelector('[data-duration]').textContent!=='10:00')return;
        clearInterval(timer);readyState=3;video.dispatchEvent(new Event('canplay'));
    },25);
}
</script><script src="/helper.js"></script></body></html>`;
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/helper.js') { res.setHeader('Content-Type', 'application/javascript; charset=utf-8'); res.end(source); return; }
    if (url.pathname.startsWith('/api/')) {
        const data = url.pathname.includes('/oauth2/info') ? { info: { id: 'navigation-user' } }
            : url.pathname.includes('/group/queryGroup/') ? { id: '100', name: '本地导航测试' }
            : url.pathname.includes('queryCourseResources') ? resources
            : url.pathname.includes('/ads/duration/user') ? { total_duration: 41 } : {};
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ success: true, data })); return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html);
});

async function main() {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const profile = fs.mkdtempSync(path.join(root, '.tools/navigation-profile-'));
    const chrome = spawn(chromePath, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
        '--disable-background-networking', '--disable-popup-blocking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let socket;
    try {
        const endpoint = await new Promise((resolve, reject) => {
            let output = '';
            const timeout = setTimeout(() => reject(new Error('Chrome debugging endpoint timed out')), 15000);
            chrome.once('error', error => { clearTimeout(timeout); reject(error); });
            chrome.stderr.on('data', chunk => {
                output += chunk;
                const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
                if (match) { clearTimeout(timeout); resolve(match[1]); }
            });
        });
        socket = new WebSocket(endpoint); await once(socket, 'open');
        let serial = 0;
        const pending = new Map();
        socket.addEventListener('message', event => {
            const reply = JSON.parse(event.data);
            const item = pending.get(reply.id);
            if (!item) return;
            clearTimeout(item.timeout); pending.delete(reply.id);
            if (reply.error) item.reject(new Error(reply.error.message)); else item.resolve(reply.result);
        });
        const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
            const id = ++serial;
            const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 10000);
            pending.set(id, { resolve, reject, timeout }); socket.send(JSON.stringify({ id, method, params, sessionId }));
        });
        const { targetId } = await send('Target.createTarget', { url: `${origin}/app/jx-web/mycourse/100/resource/200/301` });
        const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
        const evaluate = async expression => {
            const reply = await send('Runtime.evaluate', { expression, returnByValue: true, userGesture: true }, sessionId);
            if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.text);
            return reply.result.value;
        };
        const waitFor = async expression => {
            for (let i = 0; i < 80; i++) { try { if (await evaluate(expression)) return; } catch {} await delay(50); }
            throw new Error(`Browser condition timed out: ${expression}`);
        };
        const ready = () => waitFor(`document.querySelector('#xy-video-helper')?.shadowRoot.querySelector('[data-step="next"]').getAttribute('aria-disabled')==='false'`);
        await ready();
        // Start playback, then preserve the browser's own page target and navigation defaults.
        await evaluate(`document.querySelector('#xy-video-helper').shadowRoot.querySelector('[data-start]').click()`);
        const scenarios = [
            ['next', '[data-step="next"]', '302'], ['previous', '[data-step="previous"]', '301'],
            ['preview', '[data-next-link]', '302'], ['list', '[data-node="303"]', '303'],
            ['ctrl-click', '[data-step="previous"]', '302', 'ctrlKey'],
            ['shift-click', '[data-step="previous"]', '301', 'shiftKey']
        ];
        for (const [name, selector, expected, modifier] of scenarios) {
            const before = (await send('Target.getTargets')).targetInfos.filter(item => item.type === 'page').length;
            const activation = modifier ? `dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,composed:true,${modifier}:true}))` : 'click()';
            await evaluate(`document.querySelector('#xy-video-helper').shadowRoot.querySelector(${JSON.stringify(selector)}).${activation}`);
            await delay(1500);
            const targets = (await send('Target.getTargets')).targetInfos;
            const current = targets.find(item => item.targetId === targetId);
            assert.ok(current.url.endsWith(`/resource/200/${expected}`), `${name}: current tab must navigate to ${expected}; actual ${current.url}`);
            assert.equal(targets.filter(item => item.type === 'page').length, before, `${name}: must not open a new tab`);
            await waitFor(`document.querySelector('#xy-video-helper')?.shadowRoot.querySelector('[data-state]').textContent==='播放中'`);
            assert.equal(await evaluate(`JSON.parse(sessionStorage.getItem('xy-video-helper-v1')).navigation`), null, `${name}: must clear jumping state`);
            console.log(`PASS ${name}: same tab, playback resumed, jumping state cleared`);
        }
        await send('Browser.close');
    } finally {
        socket?.close(); chrome.kill(); server.closeAllConnections(); server.close();
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
