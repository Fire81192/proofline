import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../src/serve.js';
import { renderView } from '../src/views/view.js';

const fakeRender = async ({ root }) => `<!DOCTYPE html><html><body>root=${root}</body></html>`;

test('服务起来了，/ 返回渲染结果', async () => {
  const s = await startServer({ root: '/tmp/x', port: 0, render: fakeRender });
  try {
    const res = await fetch(s.url);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /root=\/tmp\/x/);
    assert.match(res.headers.get('cache-control'), /no-store/, '刷新必须看到当下的库');
  } finally {
    await s.close();
  }
});

test('/health 可用（给脚本判断服务在不在）', async () => {
  const s = await startServer({ root: '/tmp/x', port: 0, render: fakeRender });
  try {
    const res = await fetch(`${s.url}health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    await s.close();
  }
});

test('别的路径 404，不做静态文件服务', async () => {
  const s = await startServer({ root: '/tmp/x', port: 0, render: fakeRender });
  try {
    for (const p of ['../etc/passwd', '/secret', '/index.html.bak']) {
      const res = await fetch(`${s.url}${p.replace(/^\//, '')}`);
      assert.equal(res.status, 404, p);
    }
  } finally {
    await s.close();
  }
});

test('渲染出错时返回 500 和原因，不崩服务', async () => {
  const s = await startServer({ root: '/tmp/x', port: 0, render: async () => { throw new Error('故意失败'); } });
  try {
    const res = await fetch(s.url);
    assert.equal(res.status, 500);
    assert.match(await res.text(), /故意失败/);
  } finally {
    await s.close();
  }
});

test('每次请求都重新渲染，不是缓存一份', async () => {
  let n = 0;
  const s = await startServer({ root: '/tmp/x', port: 0, render: async () => `第 ${++n} 次` });
  try {
    assert.match(await (await fetch(s.url)).text(), /第 1 次/);
    assert.match(await (await fetch(s.url)).text(), /第 2 次/);
  } finally {
    await s.close();
  }
});

test('页面里没有脚本（刷新靠浏览器自带）', () => {
  const html = renderView({
    entries: [], sources: [],
    stats: { entries: 0, sources: 0, citable: 0, decisive: 0, blocking: 0, rules: 0, builtinRules: 0, libraryRules: 0, deprecated: 0 },
    generatedAt: 'now', served: true,
  });
  assert.match(html, /现算/);
  assert.ok(!/<script/i.test(html));
});

test('端口被占用时自动往后挪，不报错', async () => {
  const a = await startServer({ root: '/tmp/x', port: 0, render: fakeRender });
  try {
    // 拿 a 的真实端口去起 b，它必须自己找到一个能用的
    const b = await startServer({ root: '/tmp/x', port: a.port, render: fakeRender });
    try {
      assert.notEqual(b.port, a.port);
      assert.equal((await fetch(b.url)).status, 200);
    } finally {
      await b.close();
    }
    assert.equal((await fetch(a.url)).status, 200, 'a 不能被挤掉');
  } finally {
    await a.close();
  }
});

test('autoPort:false 时端口被占就直接报错（需要严格端口的场景）', async () => {
  const a = await startServer({ root: '/tmp/x', port: 0, render: fakeRender });
  try {
    await assert.rejects(
      () => startServer({ root: '/tmp/x', port: a.port, render: fakeRender, autoPort: false }),
      (err) => err.code === 'EADDRINUSE',
    );
  } finally {
    await a.close();
  }
});
