import type { ApiResponse } from '../types';

/** 成功响应 */
export function ok<T>(data: T, elapsedMs?: number): ApiResponse<T> {
  return { success: true, code: 0, message: 'ok', data, elapsedMs };
}

/** 失败响应 */
export function fail(message: string, code = 500): ApiResponse<null> {
  return { success: false, code, message, data: null };
}

/** 统一 JSON 返回（resp 可附带额外字段） */
export function json<T>(resp: ApiResponse<T> | Record<string, unknown>, status = 200): Response {
  return Response.json(resp, {
    status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store',
    },
  });
}
