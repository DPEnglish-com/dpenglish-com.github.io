// 共享的就绪等待：轮询到新母站的六章与脊柱真的渲染出来，不再睡固定毫秒。
export const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * @param {(expr: string) => Promise<any>} evalJs
 * @param {{timeout?: number, selector?: string}} opts
 */
export async function waitReady(evalJs, opts = {}) {
  const timeout = opts.timeout ?? 20000;
  const selector = opts.selector ?? null;
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    try {
      last = await evalJs(selector
        ? `(function(){
             if (document.readyState === 'loading') return 'loading';
             return document.querySelector(${JSON.stringify(selector)}) ? 'ready' : 'empty';
           })()`
        : `(function(){
             if (document.readyState === 'loading') return 'loading';
             if (!document.getElementById('main')) return 'nodom';
             return document.querySelectorAll('.chapter').length >= 6 ? 'ready' : 'empty';
           })()`);
      if (last === 'ready') return { state: last, ms: Date.now() - started };
    } catch (e) { last = 'error: ' + e.message; }
    await sleep(100);
  }
  throw new Error(`等待页面就绪超时（${timeout}ms，最后状态=${last}）`);
}
