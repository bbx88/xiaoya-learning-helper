const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('./fixture.cjs');

const output = path.resolve(__dirname, '../preview');
fs.mkdirSync(output, { recursive: true });
const titles = ['1.1绪论.mp4', '绪论.pptx', '2.3习近平关于劳动的重要论述.mp4', '2.2马克思主义劳动观.mp4', '2.1中国古代劳动思想.mp4', '2.2马克思主义劳动观.pptx'];
const resources = titles.map((name, index) => ({ id: String(297 + index), parent_id: '200', type: name.endsWith('pptx') ? 6 : 9,
    name, task_type: 1, task_id: `task-${index}`, sort_position: index + 1 }));
const taskStates = Object.fromEntries(resources.map(node => [node.id, { finished: true }]));

function escape(value) { return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;'); }
async function main() {
    for (const page of ['learning', 'paused', 'list', 'settings', 'settings-nonvideo', 'learning-single', 'settings-single-video', 'settings-single-nonvideo']) {
        const tab = page.startsWith('settings') ? 'settings' : page === 'learning-single' ? 'learning' : page;
        const items = page.includes('nonvideo') ? resources.map(node => node.id === '301' ? { ...node, type: 6, name: '2.1中国古代劳动思想.pptx' } : node) : resources;
        const env = await setup({ resources: items, taskStates, minutes: 71 });
        await env.start();
        if (page.includes('single')) env.ui.querySelector('[data-learning-mode="single"]').click();
        if (tab === 'settings') env.ui.querySelector('[data-tab="settings"]').click();
        else if (tab === 'paused') { env.ui.querySelector('[data-start]').click(); await env.flush(); }
        else env.ui.querySelector(`[data-tab="${tab}"]`).click();
        for (const input of env.ui.querySelectorAll('input')) {
            if (input.type === 'checkbox') input.toggleAttribute('checked', input.checked);
            else input.setAttribute('value', input.value);
        }
        const host = env.win.document.getElementById('xy-video-helper');
        host.style.left = 'calc(100vw - 72px)';
        host.style.top = tab === 'settings' ? '20px' : '86px';
        const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连播助手预览</title>
        <style>body{margin:0;background:#f4f7f5;color:#354b40;font:15px "Microsoft YaHei UI",sans-serif}aside{width:190px;background:white;position:fixed;inset:0 auto 0 0;padding:30px 24px;box-sizing:border-box;border-right:1px solid #e8ede9}aside strong{display:block;margin-bottom:45px}aside p{font-size:13px;color:#8a978e;margin:25px 0}.selected{color:#168868!important;font-weight:bold}main{margin-left:190px;padding:35px 40px}h1{font-size:22px;margin:0 0 10px}small{color:#89968c}.video{height:450px;margin-top:35px;border:1px solid #dce6de;border-radius:12px;background:#e8eeea;display:grid;place-content:center;text-align:center;color:#7c8e81}.video span{display:block;font-size:14px;margin-top:14px}</style>
        <aside><strong>大学生劳动教育</strong><p class="selected">课程内容</p><p>作业任务</p><p>我的学情</p><p>课程概况</p></aside><main><h1>第二章 劳动思想</h1><small>课程内容 / 当前资源</small><div class="video">2.1 中国古代劳动思想<span>课程视频区域</span></div></main>
        <section id="xy-video-helper" style="${escape(host.style.cssText)}"><template shadowrootmode="open">${env.ui.innerHTML}</template></section></html>`;
        fs.writeFileSync(path.join(output, `${page}.html`), html, 'utf8');
        env.dom.window.close();
    }
    console.log(`Preview pages: ${output}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
