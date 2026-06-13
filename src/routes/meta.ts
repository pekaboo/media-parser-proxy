import { Hono } from 'hono';
import type { Env } from '../types';
import { registry } from '../providers/registry';
import { ok, json } from '../utils/response';
import { Cooldown } from '../utils/cooldown';

/** 元信息路由：健康检查 + provider 清单 + 冷却状态 */
const app = new Hono<{ Bindings: Env }>();

// 健康检查
app.get('/health', () => json(ok({ status: 'up', ts: Date.now() })));

// 列出所有已注册 provider（便于对接方知道支持哪些平台）
app.get('/providers', () =>
  json(
    ok(
      registry.list().map((p) => ({
        platform: p.platform,
        implementation: p.implementation,
      })),
    ),
  ),
);

// 冷却状态（调试/运维，调用方可据此决定是否发解析请求）
app.get('/cooldown', async (c) => {
  if (!c.env.COOLDOWN_KV) {
    return json(ok({ active: false, remainingSec: 0, note: 'KV 未绑定' }));
  }
  const cd = new Cooldown(c.env.COOLDOWN_KV);
  const status = await cd.status();
  return json(ok(status));
});

// 手动清除冷却（运维操作）
app.delete('/cooldown', async (c) => {
  if (!c.env.COOLDOWN_KV) {
    return json(ok({ cleared: false }));
  }
  const cd = new Cooldown(c.env.COOLDOWN_KV);
  await cd.clear();
  return json(ok({ cleared: true }));
});

export { app as metaRouter };
