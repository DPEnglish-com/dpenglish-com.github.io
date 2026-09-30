// 悬浮窗：查看视频 / 在线试用。
//
// 为什么单开一道门：这两个按钮是本页唯一"点开之后才会加载"的东西
// （视频 2 MB 级、demo 是 iframe），也唯一带焦点管理。渲染审计看不到它们
// ——它扫的是首屏静态渲染；图版交互那道门只点人形。没有这道门，
// 一个把 src 写错、或者焦点留在窗外的回归会安静地上线。
//
// 它查四件事：
//   1) 不点开不加载：页面上没有 <video src> / <iframe>，也没有对 mp4 的请求
//   2) 点「查看视频」：开的是窗、装的是 video、src 指向存在的文件
//   3) 点「在线试用」：开的是窗、装的是 iframe、src 指向存在的文件
//   4) 键盘与焦点：Esc 关闭；关闭后焦点回到当初那个按钮；Tab 不出窗
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, createReadStream, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, waitReady } from './wait-ready.mjs';
import { CHROME } from './chrome.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [target = 'index.html'] = process.argv.slice(2);
const PORT = 9393;
const REMOTE = /^https?:\/\//.test(target);

/* 为什么要起一个本地 http 服务，而不是像别的门那样开 file:// ——
   试用页是 iframe。在 file:// 下每个文件都是不透明的源，父页读不到
   iframe 的 contentDocument，"试用页渲染出内容"这条就永远查不了，
   只能写成"文件存在"这种弱检查。起 http 之后它同时验证了两件真事：
   相对路径在部署形态下能被解析、以及 iframe 里真的画出了东西。 */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.webp': 'image/webp', '.apk': 'application/vnd.android.package-archive' };
let server = null;
async function serve() {
  server = createServer((req, res) => {
    const p = join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (!p.startsWith(ROOT) || !existsSync(p) || !statSync(p).isFile()) { res.writeHead(404); res.end('nope'); return; }
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream', 'accept-ranges': 'bytes' });
    createReadStream(p).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}/index.html`;
}
const url = REMOTE ? target : await serve();

/* 这道门吃过一次"整段挂住、Node 以 13 退出、只留一句 unsettled top-level await"：
   挂在哪一行都看不出来。两个根治：
   ① profile 目录每次用 mkdtemp 新建 —— 固定的 /tmp 目录上若留着一次崩掉的
      Chrome 实例，新实例起不来，而 CDP 的重试会连上那个旧实例，行为不可预期；
   ② 整段包一个看门狗 —— 超时就带着"卡在哪一步"退出非零，绝不静默。
   send() 也带 15s 单发超时：一个不回包的 CDP 调用立刻报错，不攒成悬案。 */
const WATCHDOG_MS = 180_000;
let phase = '启动';
const watchdog = setTimeout(() => {
  console.error(`✗ 悬浮窗检查超过 ${WATCHDOG_MS / 1000}s 没有跑完，按挂住处理（最后一步：${phase}）`);
  chrome?.kill('SIGKILL'); if (server) server.close();
  process.exit(3);
}, WATCHDOG_MS);
let cdp = null;

const profile = mkdtempSync(join(tmpdir(), 'chrome-modal-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--force-color-profile=srgb', '--window-size=1440,1000', 'about:blank',
], { stdio: 'ignore' });
chrome.on('error', e => { console.error('✗ Chrome 启动失败：' + e.message); process.exit(2); });

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.onEvent = null; }
  static async connect(p) {
    for (let i = 0; i < 40; i++) {
      try { const r = await fetch(`http://127.0.0.1:${p}/json/version`); return new CDP((await r.json()).webSocketDebuggerUrl); }
      catch { await sleep(250); }
    }
    throw new Error(`40 次都没连上 127.0.0.1:${p} 的 CDP —— Chrome 没起来，或端口被别的进程占了`);
  }
  async open() {
    return new Promise((res, rej) => {
      this.sock = new WebSocket(this.ws);
      this.sock.onopen = res;
      this.sock.onerror = () => rej(new Error('CDP WebSocket 连接失败'));
      this.sock.onclose = () => { for (const { rej: r } of this.pending.values()) r(new Error('CDP 连接被关闭')); this.pending.clear(); };
      this.sock.onmessage = e => {
        const m = JSON.parse(e.data);
        if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
        else if (m.method && this.onEvent) this.onEvent(m.method);
      };
    });
  }
  send(m, p = {}, s) {
    return new Promise((res, rej) => {
      const id = ++this.id;
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${m} 15s 没有回包`)); }, 15_000);
      this.pending.set(id, { res: v => { clearTimeout(t); res(v); }, rej: e => { clearTimeout(t); rej(e); } });
      this.sock.send(JSON.stringify({ id, method: m, params: p, sessionId: s }));
    });
  }
  close() { try { this.sock.close(); } catch {} }
}

const fails = [];
const ck = (ok, m) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${m}`); if (!ok) fails.push(m); };

try {
  phase = '连接 CDP';
  cdp = await CDP.connect(PORT); await cdp.open();
  phase = '建会话';
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  phase = '开 Page/Runtime/Network 域';
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);

  // 记录每一次对 mp4 的请求 —— "不点开不加载"要靠网络层证明，不是靠读代码
  const mp4Requests = [];
  cdp.onEvent = (m) => { };
  const ev = async e => (await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, sessionId)).result.value;

  await cdp.send('Page.navigate', { url }, sessionId); await waitReady(ev);

  // ---------- 1) 打开前：没有播放器，也没有请求 ----------
  console.log('\n=== A) 点开之前 ===');
  const before = await ev(`(function(){
    return { videos: document.querySelectorAll('video').length,
             iframes: document.querySelectorAll('iframe').length,
             acts: document.querySelectorAll('.slot-act').length,
             slots: document.querySelectorAll('.slot').length };
  })()`);
  ck(before.acts >= 6, `三个产品各有视频与试用两个按钮（实为 ${before.acts} 个）`);
  ck(before.videos === 0 && before.iframes === 0, '打开前页面上没有 video / iframe');
  const reqBefore = await ev(`performance.getEntriesByType('resource').filter(r=>/\\.mp4$/.test(r.name)).length`);
  ck(reqBefore === 0, `打开前没有请求过任何 mp4（实为 ${reqBefore} 次）`);

  // ---------- 2) 查看视频 ----------
  console.log('\n=== B) 查看视频 ===');
  await ev(`document.querySelector('.slot-act[data-open="video"]').click()`); await sleep(500);
  const v = await ev(`(function(){
    var m=document.getElementById('modal'), v=document.querySelector('#modalBody video');
    return { hidden:m.hidden, kind:m.querySelector('.modal-box').getAttribute('data-kind'),
             hasVideo:!!v, src:v?v.getAttribute('src'):null,
             title:document.getElementById('modalTitle').textContent,
             labelled:!!document.getElementById('modalTitle').textContent,
             bodyLocked:document.body.classList.contains('modal-open'),
             focusIn: m.contains(document.activeElement) };
  })()`);
  ck(!v.hidden && v.hasVideo, '窗打开了，里面是 <video>');
  ck(v.kind === 'video', '窗自己知道这一格是视频');
  ck(!!v.title, `窗有标题（${v.title}）`);
  ck(v.bodyLocked, '打开时页面锁定滚动');
  ck(v.focusIn, '焦点进了窗内');
  const vPath = v.src && !/^[a-z]+:/i.test(v.src) ? join(ROOT, v.src.replace(/^\.?\//, '')) : null;
  ck(!!vPath && existsSync(vPath), `视频文件真的在仓库里（${v.src}）`);
  // 播放器要能播：等一小会儿读 readyState / duration
  const playable = await ev(`new Promise(function(res){
    var v=document.querySelector('#modalBody video');
    if(!v) return res({ok:false,why:'no video'});
    var done=false; var fin=function(o){if(!done){done=true;res(o);}};
    v.addEventListener('loadedmetadata',function(){fin({ok:true,dur:Math.round(v.duration*10)/10,w:v.videoWidth});});
    v.addEventListener('error',function(){fin({ok:false,why:'error event'});});
    setTimeout(function(){fin({ok:false,why:'timeout rs='+v.readyState});},6000);
  })`);

  // ---------- Esc 关闭 + 焦点归位 ----------
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
  await sleep(300);
  const afterEsc = await ev(`(function(){
    var m=document.getElementById('modal');
    return { hidden:m.hidden, videos:document.querySelectorAll('video').length,
             focusIsAct: document.activeElement && document.activeElement.classList.contains('slot-act'),
             unlocked: !document.body.classList.contains('modal-open') };
  })()`);
  ck(afterEsc.hidden, 'Esc 能关闭');
  ck(afterEsc.videos === 0, '关闭后播放器被丢掉（不在后台继续占用）');
  ck(afterEsc.unlocked, '关闭后恢复滚动');
  ck(afterEsc.focusIsAct, '关闭后焦点回到当初那个按钮');

  // ---------- 3) 在线试用 ----------
  console.log('\n=== C) 在线试用 ===');
  await ev(`document.querySelectorAll('.slot-act[data-open="demo"]')[0].click()`); await sleep(900);
  const d = await ev(`(function(){
    var m=document.getElementById('modal'), f=document.querySelector('#modalBody iframe');
    return { hidden:m.hidden, kind:m.querySelector('.modal-box').getAttribute('data-kind'),
             hasFrame:!!f, src:f?f.getAttribute('src'):null,
             title:f?f.getAttribute('title'):null,
             note:(document.getElementById('modalSub').textContent||'').slice(0,20) };
  })()`);
  ck(!d.hidden && d.hasFrame, '窗打开了，里面是 <iframe>');
  ck(d.kind === 'demo', '窗自己知道这一格是试用');
  ck(!!d.title, 'iframe 有标题（给读屏用）');
  ck((d.note || '').length > 4, `说了这一步能做什么（${d.note}…）`);
  const dPath = d.src && !/^[a-z]+:/i.test(d.src) ? join(ROOT, d.src.replace(/^\.?\//, '')) : null;
  ck(!!dPath && existsSync(dPath), `试用页真的在仓库里（${d.src}）`);
  // 等 iframe 真的渲染出东西（不是一张白纸）
  const rendered = await ev(`new Promise(function(res){
    var f=document.querySelector('#modalBody iframe'); if(!f) return res({ok:false});
    var n=0; var t=setInterval(function(){
      try { var d=f.contentDocument;
        if(d && d.body && d.body.textContent.trim().length>80) { clearInterval(t); res({ok:true, chars:d.body.textContent.trim().length, title:d.title}); }
      } catch(e){}
      if(++n>40){ clearInterval(t); res({ok:false,why:'empty'}); }
    },150);
  })`);
  ck(rendered.ok, rendered.ok ? `试用页渲染出内容（${rendered.chars} 字，标题「${rendered.title}」）` : `试用页没有渲染出内容（${rendered.why}）`);

  // 三份 demo 都能开、都能切设备
  console.log('\n=== D) 三份试用页与设备切换 ===');
  const srcs = await ev(`Array.prototype.map.call(document.querySelectorAll('.slot-act[data-open="demo"]'), function(b){return b.getAttribute('data-src');})`);
  for (const s of srcs) {
    const ok = await ev(`new Promise(function(res){
      var f=document.createElement('iframe'); f.style.cssText='position:fixed;left:-9999px;width:1100px;height:800px';
      f.src=${JSON.stringify(s)}; document.body.appendChild(f);
      var n=0; var t=setInterval(function(){
        var w;
        try { w=f.contentWindow; } catch(e){}
        if(w && w.document && w.document.body && w.document.body.textContent.trim().length>80){
          var dev=w.document.getElementById('device');
          var before=dev?dev.getAttribute('data-device'):null;
          var tgl=w.document.querySelector('.toggle button[data-dev="phone"]');
          if(tgl) tgl.click();
          var after=dev?dev.getAttribute('data-device'):null;
          clearInterval(t); f.remove();
          res({ok:true, len:w.document.body.textContent.trim().length, before:before, after:after});
        }
        if(++n>40){ clearInterval(t); f.remove(); res({ok:false,why:'empty'}); }
      },150);
    })`);
    if (!ok.ok) { ck(false, `${s} 打开后没有内容`); continue; }
    ck(true, `${s}：${ok.len} 字，切换前 ${ok.before} → 切换后 ${ok.after}`);
    ck(ok.before !== ok.after, `${s}：手机/平板真的换了布局`);
  }

  console.log(`\n${fails.length ? '✗ ' + fails.length + ' 项未通过' : '✓ 悬浮窗全部通过'}`);
} finally {
  clearTimeout(watchdog);
  cdp?.close();
  chrome.kill('SIGKILL');
  if (server) server.close();
  // 删 profile 只能尽力而为：SIGKILL 之后 Chrome 的子进程可能还在往里写，
  // rmSync 走到一半目录又被填回来就抛 ENOTEMPTY —— CI 上真炸过一次（全部 PASS 之后）。
  // 目录在 /tmp 里，系统会清；这里失败就算了。
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

if (fails.length) { fails.forEach(f => console.log('  · ' + f)); process.exit(1); }
process.exit(0);
