import type { ParseProvider, ParseRequest } from '../types';

/**
 * Provider 注册中心（单例）
 *
 * - 统一注册 / 查找
 * - 支持按 platform + implementation 精确查找
 * - 支持按输入自动嗅探最匹配的 provider
 *
 * 新增平台后只需调用 register() 即可被路由系统使用。
 */
export class ProviderRegistry {
  private providers: ParseProvider[] = [];

  /** 注册一个 provider（幂等：同 platform+implementation 会替换） */
  register(provider: ParseProvider): this {
    this.providers = this.providers.filter(
      (p) =>
        !(
          p.platform === provider.platform &&
          p.implementation === provider.implementation
        ),
    );
    this.providers.push(provider);
    return this;
  }

  /** 按 platform 查找；可指定 implementation，否则取该平台第一个 */
  find(platform: string, implementation?: string): ParseProvider | undefined {
    const list = this.providers.filter((p) => p.platform === platform);
    if (implementation) {
      return list.find((p) => p.implementation === implementation);
    }
    return list[0];
  }

  /** 列出所有已注册 provider（调试/健康检查） */
  list(): ReadonlyArray<ParseProvider> {
    return this.providers;
  }

  /**
   * 自动嗅探：根据输入内容选择置信度最高的 provider
   * 用于未显式指定 platform 时的兜底路由
   */
  autoDetect(request: ParseRequest): ParseProvider | undefined {
    let best: ParseProvider | undefined;
    let bestScore = 0;
    for (const p of this.providers) {
      const score = p.match(request.rawString);
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return best;
  }
}

/** 全局单例 */
export const registry = new ProviderRegistry();
