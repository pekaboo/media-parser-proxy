import type { ParseRequest, ParseResult, Env, MediaItem } from '../types';
import { BaseProvider } from './base';
import {
  decryptHellotikResponse,
  encryptHellotikRequest,
} from '../crypto/hellotik-crypto';

/**
 * HelloTik Douyin Provider
 *
 * 实现链路：
 *  1. POST /api/gate-e5eea8  → 获取 ticket(tk) + seed(sd)
 *  2. SHA-256(ticket:seed) → AES-256-GCM 密钥，加密 payload
 *  3. POST /api/parse       → 获取加密响应
 *  4. decryptHellotikResponse 解密
 *
 * 该实现仅依赖 hellotik.app 的公开 Web 接口与逆向的加解密逻辑。
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

  protected async doParse(
    request: ParseRequest,
    env: Env,
  ): Promise<ParseResult> {
    const url = request.rawString.trim();
    if (!url) {
      throw new Error('rawString 不能为空');
    }

    // 1. 获取 ticket + seed
    const { ticketData, cookie } = await this.fetchTicket(
      url,
      request.isBatch ?? false,
      env,
    );

    // 2. 构建 payload（与前端 buildParseRequestParams 对齐）
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

    // 3. 加密 payload
    const encrypted = await encryptHellotikRequest(
      payload,
      ticketData.ticket,
      ticketData.seed,
    );

    // 4. 组装 parse 请求体（字段名按 profile 映射）
    const prf = PROFILE.parseRequestFields;
    const parseBody: Record<string, unknown> = {
      [prf.key]: ticketData.ticket,
      [prf.payload]: encrypted.payload,
      [prf.iv]: encrypted.iv,
      [prf.version]: encrypted.v,
    };

    // 5. 发送 parse
    const parseResp = await this.fetchWithTimeout(
      `${BASE_URL}/api/parse`,
      {
        method: 'POST',
        headers: this.headers(env, cookie),
        body: JSON.stringify(parseBody),
      },
      env,
    );

    if (!parseResp.ok) {
      throw new Error(`parse 接口异常: HTTP ${parseResp.status}`);
    }

    const parseJson = (await parseResp.json()) as {
      status?: number;
      encrypt?: boolean;
      data?: string;
      key?: string;
      error?: string;
    };

    if (parseJson.status !== 0) {
      throw new Error(`parse 失败: ${parseJson.error ?? JSON.stringify(parseJson)}`);
    }

    // 6. 解密响应
    if (!parseJson.encrypt || !parseJson.data || !parseJson.key) {
      throw new Error('响应缺少加密数据');
    }

    const decrypted = (await decryptHellotikResponse(
      parseJson.data,
      parseJson.key,
    )) as HellotikRawData;

    return this.normalize(decrypted);
  }

  /** 调用 gate 接口获取 ticket */
  private async fetchTicket(
    url: string,
    isBatch: boolean,
    env: Env,
  ): Promise<{
    ticketData: { ticket: string; seed: string; expiresAt: string };
    cookie: string | undefined;
  }> {
    const resp = await this.fetchWithTimeout(
      `${BASE_URL}/api/${PROFILE.authRoute}`,
      {
        method: 'POST',
        headers: { ...this.headers(env), 'Cache-Control': 'no-store' },
        body: JSON.stringify({ requestURL: url, isBatch, mode: isBatch ? 'batch' : 'single' }),
      },
      env,
    );
    if (!resp.ok) {
      throw new Error(`ticket 接口异常: HTTP ${resp.status}`);
    }
    const data = (await resp.json()) as Record<string, unknown>;
    if (!data.success) {
      throw new Error(`ticket 获取失败: ${JSON.stringify(data)}`);
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
      h['Cookie'] = env.HELLOTIK_COOKIE;
    } else if (cookie) {
      // 优先使用 gate 接口下发的会话 cookie
      h['Cookie'] = cookie;
    }
    return h;
  }

  /** 从 set-cookie 头解析出 name=value 对（多个用 ; 拼接） */
  private parseCookies(setCookie: string): string {
    // set-cookie 可能是多条用逗号分隔，简化处理：提取所有 name=value
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
    } finally {
      clearTimeout(timer);
    }
  }
}
