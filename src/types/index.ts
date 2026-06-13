/**
 * 核心类型定义
 *
 * 统一的数据契约：对内各 Provider 产出相同结构，对外接口返回标准化结果。
 * 新增平台只需实现 ParseProvider 接口，无需改动对外接口。
 */

/** 解析请求参数（统一入参） */
export interface ParseRequest {
  /** 用户粘贴的原始文案/链接（抖音复制内容、纯 URL 等） */
  rawString: string;
  /** 是否批量解析 */
  isBatch?: boolean;
  /** 客户端可选携带的额外字段（userID、uwx_id 等） */
  meta?: Record<string, string>;
}

/** 媒体资源 */
export interface MediaItem {
  /** 资源直链 */
  url: string;
  /** 视频时长（秒），仅视频 */
  duration?: number;
  /** 宽高，图/视频通用 */
  width?: number;
  height?: number;
  /** 文件大小（字节） */
  size?: number;
  /** 缩略图 */
  cover?: string;
}

/** 统一解析结果 */
export interface ParseResult {
  /** 平台标识 */
  platform: string;
  /** 内容类型 */
  type: 'video' | 'images' | 'mixed' | 'unknown';
  /** 原始标题/文案 */
  title: string;
  /** 作者信息 */
  author?: {
    nickname?: string;
    id?: string;
    avatar?: string;
  };
  /** 视频列表（type 为 video/mixed 时有值） */
  videos: MediaItem[];
  /** 图片列表（type 为 images/mixed 时有值） */
  images: MediaItem[];
  /** 原始解析来源 */
  source: string;
  /** 原始未加工数据（调试用，生产可关） */
  raw?: unknown;
}

/** 对外 API 标准响应包装 */
export interface ApiResponse<T> {
  success: boolean;
  code: number;
  message: string;
  data: T | null;
  /** 上游平台耗时 */
  elapsedMs?: number;
}

/**
 * Provider 接口 —— 每个平台/实现都必须实现
 *
 * 一个平台可有多个实现（如 douyin 可对接 hellotik 或官方 API），
 * 通过 implementation 字段选择具体实现。
 */
export interface ParseProvider {
  /** 平台唯一标识（如 'douyin'、'tiktok'） */
  readonly platform: string;
  /** 实现标识（如 'hellotik'、'official'） */
  readonly implementation: string;

  /**
   * 快速判断能否处理该输入（用于自动路由）
   * 返回 0~1 的置信度，0 表示无法处理
   */
  match(rawString: string): number;

  /** 执行解析 */
  parse(request: ParseRequest, env: Env): Promise<ParseResult>;
}

/** Worker 环境变量 */
export interface Env {
  DEFAULT_TIMEOUT_MS?: string;
  /** 冷却器使用的 KV namespace（风控节流） */
  COOLDOWN_KV?: KVNamespace;
  /** 各 Provider 可读取的自定义密钥/配置 */
  [key: string]: string | KVNamespace | undefined;
}
