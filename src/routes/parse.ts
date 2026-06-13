import { Hono, type Context } from 'hono';
import type { Env, ParseRequest } from '../types';
import { registry } from '../providers/registry';
import { ok, fail, json } from '../utils/response';
import { log } from '../utils/logger';
import { AppError, ErrorCode } from '../types/errors';

type AppEnv = { Bindings: Env };

/**
 * 解析路由：统一入口 /api/parseUrl/:platform
 *
 * 支持：
 *  - GET  /api/parseUrl/:platform?string=xxx
 *  - POST /api/parseUrl/:platform   body: { string, isBatch?, meta? }
 *  - platform=auto 时按输入内容自动嗅探
 *
 * platform 取值：douyin / tiktok / bilibili / auto / ...
 */
const app = new Hono<AppEnv>();

/** 解析输入并选择 provider */
function resolveProvider(platform: string, rawString: string) {
  if (platform === 'auto' || platform === '') {
    return registry.autoDetect({ rawString });
  }
  return registry.find(platform);
}

/** 处理解析的公共逻辑 */
async function handleParse(
  c: Context<AppEnv>,
  platform: string,
  rawString: string,
  isBatch: boolean,
  meta?: Record<string, string>,
): Promise<Response> {
  if (!rawString) {
    return json(fail('缺少 string 参数', ErrorCode.PARAM_MISSING), 400);
  }

  const provider = resolveProvider(platform, rawString);
  if (!provider) {
    return json(
      fail(
        `无可用 provider 处理 platform=${platform || 'auto'}`,
        ErrorCode.PLATFORM_UNSUPPORTED,
      ),
      404,
    );
  }

  const request: ParseRequest = { rawString, isBatch, meta };
  const start = Date.now();

  try {
    const result = await provider.parse(request, c.env);
    const elapsed = Date.now() - start;
    log('info', 'parse ok', {
      platform: provider.platform,
      impl: provider.implementation,
      type: result.type,
      elapsedMs: elapsed,
    });
    return json(ok(result, elapsed));
  } catch (e) {
    const elapsed = Date.now() - start;
    return handleError(e, provider.platform, provider.implementation, elapsed);
  }
}

/** 统一错误处理：AppError 映射标准码，未知错误兜底 */
function handleError(
  e: unknown,
  platform: string,
  impl: string,
  elapsedMs: number,
): Response {
  if (e instanceof AppError) {
    // 风控类错误带 retryAfterSec，透传给调用方做退避
    const extra =
      (e.details as { retryAfterSec?: number } | undefined)?.retryAfterSec;
    const httpStatus =
      e.code === ErrorCode.PARAM_MISSING ? 400 :
      e.code === ErrorCode.RATE_LIMITED ? 429 :
      e.code === ErrorCode.UPSTREAM_RESTRICTED ? 503 :
      502;
    log('warn', 'parse failed (app)', {
      platform,
      impl,
      code: e.code,
      error: e.message,
      retryAfterSec: extra,
      elapsedMs,
    });
    const body = fail(e.message, e.code) as unknown as Record<string, unknown>;
    if (extra) body.retryAfterSec = extra;
    return json(body, httpStatus);
  }
  // 未知异常
  const msg = e instanceof Error ? e.message : String(e);
  log('error', 'parse failed (unknown)', {
    platform,
    impl,
    error: msg,
    elapsedMs,
  });
  return json(fail(msg, ErrorCode.INTERNAL), 500);
}

// GET：参数从 query 读取（string 必填）
app.get('/:platform', async (c) =>
  handleParse(
    c as unknown as Context<AppEnv>,
    c.req.param('platform'),
    c.req.query('string') ?? '',
    c.req.query('isBatch') === 'true',
    safeParseMeta(c.req.query('meta')),
  ),
);

// POST：参数从 body 读取
app.post('/:platform', async (c) => {
  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) ?? {};
  } catch {
    // 允许空 body
  }
  const rawString = String(body.string ?? '');
  const isBatch = body.isBatch === true;
  const meta =
    body.meta && typeof body.meta === 'object'
      ? (body.meta as Record<string, string>)
      : undefined;
  return handleParse(
    c as unknown as Context<AppEnv>,
    c.req.param('platform'),
    rawString,
    isBatch,
    meta,
  );
});

function safeParseMeta(metaStr?: string): Record<string, string> | undefined {
  if (!metaStr) return undefined;
  try {
    return JSON.parse(metaStr);
  } catch {
    return undefined;
  }
}

export { app as parseRouter };
