/**
 * 本地只读服务：打开或刷新，就是当下真实的状态。
 *
 * ## "实时"和"即时"不是一回事
 *
 * 即时 = 文件一变，页面自己跳。
 * 实时 = 你打开的那一刻，看到的是现在。
 *
 * 这里只做后者。理由很实际：自动刷新会在你正读到一半时把页面冲掉，
 * 那不是帮你，是打断你。想更新，按一下刷新就行——那一按，重算的就是此刻。
 *
 * 所以它和静态快照的差别只有一条：**静态是某一刻存下来的文件，服务是每次打开现算。**
 *
 * ## 三条边界
 *
 * 1. 只读。只响应 GET，没有任何写接口。
 * 2. 只绑 127.0.0.1，不做局域网访问。
 * 3. 只认 /、/map、/health 三个路径，不做静态文件服务，不碰路径拼接。
 *
 * 页面本身不含脚本：刷新是浏览器自带的，不是我们塞的。
 */

import { createServer } from 'node:http';

/**
 * @param {object} args
 * @param {string} args.root
 * @param {number} [args.port]  0 表示随便挑一个空闲端口
 * @param {boolean} [args.autoPort] 端口被占用时自动往后找（默认 true）
 * @param {string} [args.host]
 * @param {(ctx:{root:string})=>Promise<string>} args.render 每次请求都重新渲染
 * @returns {Promise<{url:string, port:number, close:()=>Promise<void>}>}
 */
export async function startServer({ root, port = 4321, host = '127.0.0.1', render, autoPort = true }) {
  const server = createServer(async (req, res) => {
    const url = req.method === 'GET' ? req.url ?? '/' : null;

    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url === '/' || url === '/index.html' || url === '/index' || url === '/map') {
      try {
        const html = await render({ root }, url);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          // 不缓存：刷新必须看到当下的库，而不是浏览器里存着的那一份
          'Cache-Control': 'no-store, must-revalidate',
        });
        res.end(html);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`渲染失败：${err.message}`);
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('只有 / 这一个页面。');
  });

  // 端口被占就往后挪几个。手动数端口是很没必要的摩擦——
  // 上一轮就出现过「4400 上跑的是旧代码」，其实是两台服务撞在一起了。
  const listenOnce = (p) => new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(p, host);
  });

  let actualPort = port;
  const tried = [];
  for (let i = 0; i < (autoPort ? 20 : 1); i += 1) {
    const candidate = port === 0 ? 0 : port + i;
    try {
      await listenOnce(candidate);
      actualPort = candidate;
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || !autoPort || port === 0) throw err;
      tried.push(candidate);
      if (i === 19) {
        throw new Error(`端口 ${port}–${port + 19} 都被占用了（试过 ${tried.join(', ')}）`);
      }
    }
  }

  const addr = server.address();
  if (addr && typeof addr === 'object') actualPort = addr.port;

  return {
    url: `http://${host}:${actualPort}/`,
    port: actualPort,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
