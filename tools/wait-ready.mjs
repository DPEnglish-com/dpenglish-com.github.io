// 共享的就绪等待。
//
// 起因：几个审计脚本原本在 Page.navigate 之后睡固定毫秒数。
// 本地 file:// 够用，但线上要过网络，同样的 900ms 里文档可能还没解析完，
// 于是 getElementById 拿到 null、脚本报 "Cannot read properties of undefined"。
// 固定睡眠是在猜加载时间；正确做法是轮询到 DOM 真的就绪为止。
//
// 判据不是 document.readyState 就够 —— 图版的行是 JS 渲染的，
// readyState=complete 时 #map-flow 里可能还是空的。所以等到
// 图版真的画出来（或超时）再返回。

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * 等到页面就绪：#map-flow 里有内容，或 #map-root 存在（无 JS 场景）。
 * @param {(expr: string) => Promise<any>} evalJs 在该页面上下文求值
 * @param {{timeout?: number, label?: string}} opts
 */
export async function waitReady(evalJs, opts = {}) {
  const timeout = opts.timeout ?? 20000;
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    try {
      last = await evalJs(`(function(){
        if (document.readyState === 'loading') return 'loading';
        var flow = document.getElementById('map-flow');
        if (!flow) return document.getElementById('main') ? 'nojs' : 'nodom';
        return flow.children.length > 0 ? 'ready' : 'empty';
      })()`);
      if (last === 'ready' || last === 'nojs') return { state: last, ms: Date.now() - started };
    } catch (e) { last = 'error: ' + e.message; }
    await sleep(100);
  }
  throw new Error(`等待页面就绪超时（${timeout}ms，最后状态=${last}）`);
}
