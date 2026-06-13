import { Hono } from 'hono';
import type { Env } from '../types';
import { registry } from '../providers/registry';
import { ok, json } from '../utils/response';

/** 元信息路由：健康检查 + provider 清单 */
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

export { app as metaRouter };
