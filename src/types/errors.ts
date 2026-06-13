/**
 * 业务错误码体系（对外稳定契约）
 *
 * 设计原则：
 *  - 1xxx 客户端错误（参数/鉴权/不支持）
 *  - 2xxx 上游错误（解析失败/限流/算法变更）
 *  - 9xxx 内部错误
 * 调用方按 code 处理，不应依赖 message 文本。
 */
export const ErrorCode = {
  // --- 1xxx 客户端 ---
  PARAM_MISSING: 1001,        // 参数缺失/非法
  PLATFORM_UNSUPPORTED: 1002, // 平台不支持
  UNAUTHORIZED: 1003,         // 鉴权失败
  RATE_LIMITED: 1004,         // 调用方自身限流

  // --- 2xxx 上游 ---
  UPSTREAM_PARSE_FAILED: 2001, // 上游解析失败
  UPSTREAM_RESTRICTED: 2002,   // 上游风控（IP/频率限制）
  UPSTREAM_DECRYPT_FAILED: 2003, // 解密失败（算法变更）
  UPSTREAM_UNAVAILABLE: 2004,  // 上游不可达/超时

  // --- 9xxx ---
  INTERNAL: 9000,
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * 业务异常 —— 携带标准错误码
 * 路由层捕获后直接映射为对外响应，不再透传上游细节
 */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCodeValue,
    public readonly httpStatus: number = 502,
    /** 附带数据，如冷却剩余秒数 */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** hellotik 风控响应体 */
export interface HellotikRestrictedBody {
  code?: string;
  reason?: string;
  restrictionMinutes?: number;
  restrictionPreset?: string;
  securityDialog?: boolean;
  clientIp?: string;
}
