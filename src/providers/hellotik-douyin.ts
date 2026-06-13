import type { ParseRequest, ParseResult, Env, MediaItem } from '../types';
import { BaseProvider } from './base';
import {
  decryptHellotikResponse,
  encryptHellotikRequest,
} from '../crypto/hellotik-crypto';
import { AppError, ErrorCode, type HellotikRestrictedBody } from '../types/errors';
import { Cooldown } from '../utils/cooldown';

/**
 * HelloTik Douyin Provider
 *
 * 实现链路：
 *  1. 检查冷却（KV）—— 冷却期内直接拒绝，避免刷新上游限流计时
 *  2. 节流（KV）—— 强制最小请求间隔，降低风控触发概率
 *  3. POST /api/gate-e5eea8 → 获取 ticket(tk) + seed(sd)
 *  4. SHA-256(ticket:seed) → AES-256-GCM 密钥，加密 payload
 *  5. POST /api/parse → 获取加密响应
 *  6. decryptHellotikResponse 解密
 *
 * 风控处理：上游返回 TICKET_IP_RESTRICTED 时触发冷却，
 * 后续请求在冷却期内不发出网络请求。
 */
const BASE_URL = 'https://www.hellotik.app';

/** hellotik profile 配置（逆向自 8837 chunk） */
const PROFILE = {
  authRoute: 'gate-e5eea8',
  ticketResponseFields: {
    key: 'tk_e5eea8',
    seed: 'sd_e5eea8',
    expiresAt: 'ex_e5eea8',
  },
  parseRequestFields: {
    key: 'tk_e5eea8',
    payload: 'pl_e5eea8',
    iv: 'iv_e5eea8',
    version: 'vr_e5eea8',
  },
} as const;

/** 上游风控特征码（命中即触发冷却） */
const RESTRICTION_REASONS = new Set([
  'ticket_ip_restricted',
  'rate_limited',
]);

interface HellotikMediaItem {
  url?: string;
  duration?: number;
  width?: number;
  height?: number;
  size?: number;
  cover?: string;
  [k: string]: unknown;
}

interface HellotikRawData {
  title?: string;
  type?: string;
  videos?: (string | HellotikMediaItem)[];
  pics?: string[];
  author?: { nickname?: string; id?: string; avatar?: string };
  [k: string]: unknown;
}

export class HellotikDouyinProvider extends BaseProvider {
  readonly platform = 'douyin';
  readonly implementation = 'hellotik';

  /** 识别抖音分享文案/链接 */
  match(rawString: string): number {
    const lower = rawString.toLowerCase();
    if (
      lower.includes('douyin.com') ||
      lower.includes('iesdouyin.com') ||
      lower.includes('v.douyin.com') ||
      lower.includes('抖音')
    ) {
      return 0.9;
    }
    return 0;
  }

  /** 获取冷却器实例（每次请求新建，无状态开销） */
  private cooldown(env: Env): Cooldown | null {
    if (!env.COOLDOWN_KV) return null;
    return new Cooldown(env.COOLDOWN_KV);
  }

  protected async doParse(
    request: ParseRequest,
    env: Env,
  ): Promise<ParseResult> {
    const url = request.rawString.trim();
    if (!url) {
      throw new AppError('rawString 不能为空', ErrorCode.PARAM_MISSING, 400);
    }

    const cd = this.cooldown(env);

    // 1. 冷却期检查 —— 冷却中直接拒绝，避免刷新上游计时
    if (cd) {
      const st = await cd.status();
      if (st.active) {
        throw new AppError(
          `上游风控冷却中，请 ${st.remainingSec}s 后重试`,
          ErrorCode.UPSTREAM_RESTRICTED,
          503,
          { retryAfterSec: st.remainingSec },
        );
      }
      // 2. 节流：强制最小间隔
      if (await cd.shouldThrottle()) {
        throw new AppError(
          '请求过于频繁，请稍候',
          ErrorCode.RATE_LIMITED,
          429,
        );
      }
    }

    // 3. 获取 ticket + seed（内部已处理风控识别 → 触发冷却）
    const { ticketData, cookie } = await this.fetchTicket(
      url,
      request.isBatch ?? false,
      env,
      cd,
    );

    // 4. 构建 payload（与前端 buildParseRequestParams 对齐）
    const payload = {
      requestURL: url,
      isMobile: 'false',
      isoCode: 'Other',
      adType: 'adsense',
      uwx_id: request.meta?.uwx_id ?? '',
      successCount: '0',
      totalSuccessCount: '0',
      firstSuccessDate: null,
      geoipIp: '',
      ...request.meta,
    };

    // 5. 加密 payload
    const encrypted = await encryptHellotikRequest(
      payload,
      ticketData.ticket,
      ticketData.seed,
    );

    // 6. 组装 parse 请求体（字段名按 profile 映射）
    const prf = PROFILE.parseRequestFields;
    const parseBody: Record<string, unknown> = {
      [prf.key]: ticketData.ticket,
      [prf.payload]: encrypted.payload,
      [prf.iv]: encrypted.iv,
      [prf.version]: encrypted.v,
    };

    // 7. 发送 parse
    const parseResp = await this.fetchWithTimeout(
      `${BASE_URL}/api/parse`,
      {
        method: 'POST',
        headers: this.headers(env, cookie),
        body: JSON.stringify(parseBody),
      },
      env,
    );

    if (parseResp.status === 429) {
      // parse 阶段也可能风控
      const body = await this.tryJson(parseResp);
      await this.handleRestriction(cd, body);
      throw new AppError(
        '上游 parse 阶段风控',
        ErrorCode.UPSTREAM_RESTRICTED,
        503,
      );
    }

    if (!parseResp.ok) {
      throw new AppError(
        `parse 接口异常 HTTP ${parseResp.status}`,
        ErrorCode.UPSTREAM_UNAVAILABLE,
      );
    }

    const parseJson = (await parseResp.json()) as {
      status?: number;
      encrypt?: boolean;
      data?: string;
      key?: string;
      error?: string;
    };

    if (parseJson.status !== 0) {
      throw new AppError(
        parseJson.error ?? '上游解析失败',
        ErrorCode.UPSTREAM_PARSE_FAILED,
      );
    }

    // 8. 解密响应
    if (!parseJson.encrypt || !parseJson.data || !parseJson.key) {
      throw new AppError('响应缺少加密数据', ErrorCode.UPSTREAM_DECRYPT_FAILED);
    }

    let decrypted: HellotikRawData;
    try {
      decrypted = (await decryptHellotikResponse(
        parseJson.data,
        parseJson.key,
      )) as HellotikRawData;
    } catch {
      throw new AppError(
        '响应解密失败（算法可能已变更）',
        ErrorCode.UPSTREAM_DECRYPT_FAILED,
      );
    }

    return this.normalize(decrypted);
  }

  /** 调用 gate 接口获取 ticket */
  private async fetchTicket(
    url: string,
    isBatch: boolean,
    env: Env,
    cd: Cooldown | null,
  ): Promise<{
    ticketData: { ticket: string; seed: string; expiresAt: string };
    cookie: string | undefined;
  }> {
    const resp = await this.fetchWithTimeout(
      `${BASE_URL}/api/${PROFILE.authRoute}`,
      {
        method: 'POST',
        headers: { ...this.headers(env), 'Cache-Control': 'no-store' },
        body: JSON.stringify({
          requestURL: url,
          isBatch,
          mode: isBatch ? 'batch' : 'single',
        }),
      },
      env,
    );

    // gate 风控识别（核心）
    if (resp.status === 429) {
      const body = await this.tryJson(resp);
      await this.handleRestriction(cd, body);
      // handleRestriction 已写入冷却，此处抛标准化错误
      throw new AppError(
        '上游 gate 阶段风控，已进入冷却',
        ErrorCode.UPSTREAM_RESTRICTED,
        503,
      );
    }

    if (!resp.ok) {
      throw new AppError(
        `ticket 接口异常 HTTP ${resp.status}`,
        ErrorCode.UPSTREAM_UNAVAILABLE,
      );
    }

    const data = (await resp.json()) as Record<string, unknown>;
    if (!data.success) {
      throw new AppError(
        'ticket 获取失败',
        ErrorCode.UPSTREAM_PARSE_FAILED,
      );
    }

    const trf = PROFILE.ticketResponseFields;
    // 捕获 gate 下发的 set-cookie，parse 请求需回传以保持会话
    const setCookie = resp.headers.get('set-cookie') ?? undefined;
    const cookie = setCookie ? this.parseCookies(setCookie) : undefined;
    return {
      ticketData: {
        ticket: String(data[trf.key]),
        seed: String(data[trf.seed]),
        expiresAt: String(data[trf.expiresAt]),
      },
      cookie,
    };
  }

  /**
   * 处理上游风控响应
   * 识别已知 restriction reason，触发冷却；未知风控也保守触发默认冷却
   */
  private async handleRestriction(
    cd: Cooldown | null,
    body: HellotikRestrictedBody | null,
  ): Promise<void> {
    if (!cd) return; // 无 KV 时不做冷却
    const isKnown = body?.reason && RESTRICTION_REASONS.has(body.reason);
    // 已知风控用上游给的分钟数；未知风控用默认冷却
    await cd.trigger(isKnown ? body?.restrictionMinutes : undefined);
  }

  /** 安全解析 JSON（失败返回 null） */
  private async tryJson(resp: Response): Promise<HellotikRestrictedBody | null> {
    try {
      return (await resp.json()) as HellotikRestrictedBody;
    } catch {
      return null;
    }
  }

  /** 将 hellotik 原始结构转为统一 ParseResult */
  private normalize(raw: HellotikRawData): ParseResult {
    const videos: MediaItem[] = (raw.videos ?? []).map((v) =>
      typeof v === 'string' ? { url: v } : this.toMediaItem(v),
    );
    const images: MediaItem[] = (raw.pics ?? []).map((p) =>
      typeof p === 'string' ? { url: p } : this.toMediaItem(p),
    );

    let type: ParseResult['type'] = 'unknown';
    if (videos.length > 0 && images.length > 0) type = 'mixed';
    else if (videos.length > 0) type = 'video';
    else if (images.length > 0) type = 'images';

    return {
      platform: this.platform,
      type,
      title: raw.title ?? '',
      author: raw.author,
      videos,
      images,
      source: `${this.platform}/${this.implementation}`,
      raw,
    };
  }

  private toMediaItem(item: HellotikMediaItem): MediaItem {
    return {
      url: item.url ?? '',
      duration: item.duration,
      width: item.width,
      height: item.height,
      size: item.size,
      cover: item.cover,
    };
  }

  private headers(env?: Env, cookie?: string): Record<string, string> {
    const h: Record<string, string> = {
      Accept: '*/*',
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      Origin: BASE_URL,
      Referer: `${BASE_URL}/zh/douyin`,
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    };
    // 可选：注入 cookie（应对反爬，通过环境变量 HELLOTIK_COOKIE 配置）
    if (env?.HELLOTIK_COOKIE) {
      h['Cookie'] = env.HELLOTIK_COOKIE as string;
    } else if (cookie) {
      // 优先使用 gate 接口下发的会话 cookie
      h['Cookie'] = cookie;
    }
    return h;
  }

  /** 从 set-cookie 头解析出 name=value 对（多个用 ; 拼接） */
  private parseCookies(setCookie: string): string {
    const parts = setCookie.split(/,(?=\s*[A-Za-z0-9_-]+=)/);
    return parts
      .map((p) => p.split(';')[0]!.trim())
      .filter((p) => p.includes('='))
      .join('; ');
  }

  /** 带超时的 fetch */
  private async fetchWithTimeout(
    input: string,
    init: RequestInit,
    env: Env,
  ): Promise<Response> {
    const timeoutMs = Number(env.DEFAULT_TIMEOUT_MS ?? 30000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } catch (e) {
      // 超时/网络错误归一化
      throw new AppError(
        e instanceof Error && e.name === 'AbortError'
          ? '上游请求超时'
          : '上游网络错误',
        ErrorCode.UPSTREAM_UNAVAILABLE,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
