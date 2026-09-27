// 收尾校验：移动端交互 / 减少动效 / 禁用 JS 三条路径。
// 目标可以是本地文件，也可以是线上 URL。
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { sleep, waitReady } from './wait-ready.mjs';
const [target='index.html'] = process.argv.slice(2);
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT=9391;
// 传 URL 就照用，传路径才当本地文件。/^https?:/ 判断，避免把 URL 拼成
// "file:///.../https:/..." 这种不存在的路径。
const url = /^https?:\/\//.test(target) ? target : 'file://' + resolve(target);
const chrome=spawn(CHROME,['--headless=new',`--remote-debugging-port=${PORT}`,`--user-data-dir=/tmp/chrome-fg-${PORT}`,'--no-first-run','--no-default-browser-check','--disable-gpu','--hide-scrollbars','--force-color-profile=srgb','--window-size=1440,1000','about:blank'],{stdio:'ignore'});
class CDP{constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();this.onEvent=null;}
 static async connect(p){for(let i=0;i<40;i++){try{const r=await fetch(`http://127.0.0.1:${p}/json/version`);return new CDP((await r.json()).webSocketDebuggerUrl);}catch{await sleep(250);}}throw new Error('no chrome');}
 async open(){return new Promise((res,rej)=>{this.sock=new WebSocket(this.ws);this.sock.onopen=res;this.sock.onerror=rej;this.sock.onmessage=e=>{const m=JSON.parse(e.data);
   if(m.id&&this.pending.has(m.id)){const{res,rej}=this.pending.get(m.id);this.pending.delete(m.id);m.error?rej(new Error(m.error.message)):res(m.result);}
   else if(m.method&&this.onEvent){this.onEvent(m.method);}};});}
 send(m,p={},s){const id=++this.id;return new Promise((res,rej)=>{this.pending.set(id,{res,rej});this.sock.send(JSON.stringify({id,method:m,params:p,sessionId:s}));});}}
const cdp=await CDP.connect(PORT); await cdp.open();
const {targetId}=await cdp.send('Target.createTarget',{url:'about:blank'});
const {sessionId}=await cdp.send('Target.attachToTarget',{targetId,flatten:true});
await cdp.send('Page.enable',{},sessionId); await cdp.send('Runtime.enable',{},sessionId);
const ev=async e=>(await cdp.send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true},sessionId)).result.value;
const fails=[]; const ck=(ok,m)=>{console.log(`  ${ok?'PASS':'FAIL'}  ${m}`); if(!ok)fails.push(m);};

// ---------- A) 移动端 390px：人形收起，三层照常展开 ----------
console.log('\n=== A) 移动端 390px 交互 ===');
await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true},sessionId);
await cdp.send('Page.navigate',{url},sessionId); await waitReady(ev);
const mob = await ev(`(function(){
  var f=document.querySelector('.map-figure');
  return { figDisplay: getComputedStyle(f).display,
           figW: f.getBoundingClientRect().width,
           bands: document.querySelectorAll('.band').length };
})()`);
console.log(`  人形 display=${mob.figDisplay} 宽=${Math.round(mob.figW)}px  初始行=${mob.bands}`);
ck(mob.figDisplay==='none'||mob.figW===0, '390px 人形应收起');
ck(mob.bands===3, `390px 初始应有 3 个部位行（实为 ${mob.bands}）`);
await ev(`document.querySelectorAll('.band-d')[0].click()`); await sleep(800);
const mob2 = await ev(`(function(){
  return { bands: document.querySelectorAll('.band').length,
           caps: document.querySelectorAll('.band-c').length,
           crumbs: document.querySelectorAll('.crumb').length,
           links: document.querySelectorAll('.map-link path').length,
           panel: (document.querySelector('.map-panel h3')||{}).textContent || null,
           panelLinks: document.querySelectorAll('.map-panel .p-actions a').length,
           hint: document.getElementById('map-hint').textContent,
           oflow: document.documentElement.scrollWidth > document.documentElement.clientWidth+1 };
})()`);
console.log(`  展开后：行=${mob2.bands} 子分类=${mob2.caps} 面包屑=${mob2.crumbs} 连线=${mob2.links} 应用=${mob2.panel} 链接=${mob2.panelLinks}`);
ck(mob2.caps===0, `390px 不应再有子分类行（实为 ${mob2.caps}）`);
ck(mob2.panel!==null, '390px 点部位应直接出应用面板');
ck(mob2.panelLinks===2, `390px 应用应带两个链接（实为 ${mob2.panelLinks}）`);
ck(mob2.crumbs===2, `390px 面包屑应有 2 段（实为 ${mob2.crumbs}）`);
ck(mob2.links===0, `390px 不应画连线（实为 ${mob2.links}）`);
ck(!mob2.oflow, '390px 展开后不应横向溢出');

// ---------- B) prefers-reduced-motion ----------
console.log('\n=== B) prefers-reduced-motion: reduce ===');
await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false},sessionId);
await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]},sessionId);
await cdp.send('Page.navigate',{url},sessionId); await waitReady(ev);
await ev(`document.getElementById('map').scrollIntoView({block:'start'})`); await sleep(500);
const rm = await ev(`(function(){
  var bad=0, tot=0;
  document.querySelectorAll('.fig-zone path').forEach(function(p){
    tot++; if(!(parseFloat(getComputedStyle(p).strokeDashoffset)<0.5)) bad++;
  });
  var hidden=0, all=0;
  document.querySelectorAll('.reveal').forEach(function(e){ all++; if(parseFloat(getComputedStyle(e).opacity)===0) hidden++; });
  return {bad:bad,tot:tot,hidden:hidden,all:all};
})()`);
console.log(`  人形 ${rm.tot} 条线中未画完 ${rm.bad} 条；.reveal ${rm.all} 个中不可见 ${rm.hidden} 个`);
ck(rm.bad===0, 'reduce 时人形应直接到位（dashoffset=0）');
ck(rm.hidden===0, 'reduce 时不应有内容不可见');
await ev(`document.querySelectorAll('.band-d')[1].click()`); await sleep(400);
const rmL = await ev(`(function(){var p=document.querySelector('.map-link path');
  return p? {off:parseFloat(getComputedStyle(p).strokeDashoffset), len:Math.round(p.getTotalLength())} : {none:true};})()`);
if (rmL.none) { ck(false,'reduce 时点嘴巴应画出连线'); }
else { console.log(`  reduce 连线：长=${rmL.len}px dashoffset=${rmL.off}`); ck(rmL.off<0.5,'reduce 时连线应直接到位'); }
await cdp.send('Emulation.setEmulatedMedia',{features:[]},sessionId);

// ---------- C) 禁用 JS ----------
console.log('\n=== C) 禁用 JS 的等价内容 ===');
await cdp.send('Emulation.setScriptExecutionDisabled',{value:true},sessionId);
// 这一段不能用 waitReady：脚本已被禁用，Runtime.evaluate 求值不了。
// 改用 Page.loadEventFired 事件等文档真的加载完（线上要过网络）。
const loaded = new Promise(r => {
  const t = setTimeout(() => r('timeout'), 20000);
  cdp.onEvent = (method) => { if (method === 'Page.loadEventFired') { clearTimeout(t); r('load'); } };
});
await cdp.send('Page.navigate',{url},sessionId);
const how = await loaded;
cdp.onEvent = null;
if (how === 'timeout') console.log('  警告：等到 loadEventFired 超时，仍继续检查');
else await sleep(300);   // 让 <noscript> 布局稳定
const nojs = await ev(`(function(){
  var root=document.getElementById('map-root');
  var ns=document.querySelector('noscript');
  return {
    mapHidden: root ? getComputedStyle(root).display==='none' : null,
    noscriptRendered: ns ? ns.getBoundingClientRect().height>0 : false,
    panels: document.querySelectorAll('.map-panel').length,
    text: document.body.innerText.trim().length,
    hasHelp: document.body.innerText.indexOf('脚本已禁用')>=0
  };
})()`);
console.log(`  空外壳隐藏=${nojs.mapHidden}   noscript 渲染=${nojs.noscriptRendered}   等价面板=${nojs.panels}   正文=${nojs.text} 字`);
ck(nojs.mapHidden===true, '禁用 JS 时空的图版外壳应隐藏');
ck(nojs.noscriptRendered, '禁用 JS 时 <noscript> 应渲染');
ck(nojs.panels>=3, `禁用 JS 时应列出全部产品（实为 ${nojs.panels}）`);
ck(nojs.text>1200, `禁用 JS 时正文应完整（实为 ${nojs.text} 字）`);
await cdp.send('Emulation.setScriptExecutionDisabled',{value:false},sessionId);

chrome.kill();
console.log('\n'+'─'.repeat(62));
if(fails.length){console.log(`✗ ${fails.length} 项未通过：`);fails.forEach(f=>console.log('  - '+f));process.exit(1);}
console.log('✓ 收尾校验通过：移动端交互、减少动效、禁用 JS 三条路径都完整。');
process.exit(0);
