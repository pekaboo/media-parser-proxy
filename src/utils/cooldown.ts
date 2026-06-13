/**
 * 上游冷却器（基于 KV）
 *
 * 解决核心痛点：hellotik 命中风控后窗口是 15 分钟，且每次请求都会刷新计时。
 * 一旦收到 TICKET_IP_RESTRICTED，立即写入冷却标记到 KV，
 * 后续请求在冷却期内直接拒绝（不发出网络请求），避免反复刷新限流计时。
 *
 * 同时承担节流职责：记录最近请求时间，强制最小间隔，降低触发风控概率。
 */

/** KV key */
const KEY_COOLDOWN = 'hellotik:cooldown';
const KEY_LASTREQ = 'hellotik:lastreq';

/** 默认值 */
const DEFAULT_COOLDOWN_SEC = 120; // 命中未知风控时的保守冷却
const MAX_COOLDOWN_SEC = 900; // 冷却时长上限（15min），防止上游给异常大值锁死服务
const DEFAULT_MIN_INTERVAL_MS = 1500; // 两次请求最小间隔（节流）

export interface CooldownState {
  /** 是否处于冷却期 */
  active: boolean;
  /** 冷却剩余秒数（向上取整） */
  remainingSec: number;
}

export class Cooldown {
  constructor(
    private readonly kv: KVNamespace,
    private readonly cooldownSec: number = DEFAULT_COOLDOWN_SEC,
    private readonly minIntervalMs: number = DEFAULT_MIN_INTERVAL_MS,
  ) {}

  /** 查询当前冷却状态（只读，不发请求） */
  async status(): Promise<CooldownState> {
    const until = await this.kv.get(KEY_COOLDOWN);
    if (!until) return { active: false, remainingSec: 0 };
    const untilTs = Number(until);
    const remainingMs = untilTs - Date.now();
    if (remainingMs <= 0) return { active: false, remainingSec: 0 };
    return {
      active: true,
      remainingSec: Math.ceil(remainingMs / 1000),
    };
  }

  /**
   * 进入冷却（收到风控时调用）
   * 优先使用上游返回的 restrictionMinutes，否则用默认冷却
   */
  async trigger(restrictionMinutes?: number): Promise<void> {
    // 上游给分钟，转秒；封顶避免异常大值锁死服务
    let secs = restrictionMinutes ? restrictionMinutes * 60 : this.cooldownSec;
    if (secs > MAX_COOLDOWN_SEC) secs = MAX_COOLDOWN_SEC;
    const untilTs = Date.now() + secs * 1000;
    await this.kv.put(KEY_COOLDOWN, String(untilTs));
  }

  /**
   * 节流：若距离上次请求太近，返回 true 表示需要等待
   * 成功放行后会记录本次请求时间
   */
  async shouldThrottle(): Promise<boolean> {
    const last = await this.kv.get(KEY_LASTREQ);
    if (last) {
      const elapsed = Date.now() - Number(last);
      if (elapsed < this.minIntervalMs) return true;
    }
    await this.kv.put(KEY_LASTREQ, String(Date.now()));
    return false;
  }

  /** 手动清除冷却（调试/运维） */
  async clear(): Promise<void> {
    await this.kv.delete(KEY_COOLDOWN);
    await this.kv.delete(KEY_LASTREQ);
  }
}
