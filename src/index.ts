import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import { registry } from './providers/registry';
import { HellotikDouyinProvider } from './providers/hellotik-douyin';
import { parseRouter } from './routes/parse';
import { metaRouter } from './routes/meta';
import { fail, json } from './utils/response';
import { log } from './utils/logger';

// ============ 注册 Provider（扩展点：新增平台在此加一行） ============
registry.register(new HellotikDouyinProvider());
// registry.register(new OfficialTiktokProvider());  // 未来
// registry.register(new BilibiliProvider());        // 未来

const app = new Hono<{ Bindings: Env }>();

// ============ 全局中间件 ============
app.use('*', cors()); // 默认放开所有来源

// ============ 路由挂载 ============
app.route('/api/parseUrl', parseRouter); // 解析主接口
app.route('/api', metaRouter);            // 元信息（/api/health, /api/providers）

// 根路径说明
app.get('/', () =>
  json({
    success: true,
    code: 0,
    message: 'tiktok-parser-proxy',
    data: {
      usage: '/api/parseUrl/:platform?string=<分享文案或链接>',
      platforms: registry
        .list()
        .map((p) => `${p.platform} (${p.implementation})`),
    },
  }),
);

// ============ 全局兜底 ============
app.notFound(() => json(fail('not found', 404), 404));
app.onError((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  log('error', 'unhandled', { error: msg, stack: (err as Error)?.stack });
  return json(fail(`internal error: ${msg}`, 500), 500);
});

export default {
  fetch(req: Request, env: Env): Response | Promise<Response> {
    return app.fetch(req, env);
  },
};
