/**
 * 极简结构化日志（Worker 环境无 console.format）
 * 生产环境可对接 Logpush / observability
 */
export function log(
  level: 'info' | 'warn' | 'error',
  msg: string,
  ctx?: Record<string, unknown>,
): void {
  const entry = {
    ts: Date.now(),
    level,
    msg,
    ...ctx,
  };
  // 控制台输出（dev / wrangler tail）
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(JSON.stringify(entry));
}
