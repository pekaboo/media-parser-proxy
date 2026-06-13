import type { ParseProvider, ParseRequest, ParseResult, Env } from '../types';

/**
 * Provider 抽象基类 —— 提供公共能力，减少子类重复代码
 *
 * 新增平台时继承此类并实现 abstract 方法即可。
 * 如需对接同一平台的多个实现，只需创建多个子类并设置不同 implementation。
 */
export abstract class BaseProvider implements ParseProvider {
  abstract readonly platform: string;
  abstract readonly implementation: string;

  /** 默认：由子类重写 match() 实现平台嗅探 */
  abstract match(rawString: string): number;

  /** 子类实现具体解析逻辑 */
  protected abstract doParse(
    request: ParseRequest,
    env: Env,
  ): Promise<ParseResult>;

  /**
   * 模板方法：统一包裹解析流程
   * 子类只关心 doParse，日志/异常由基类处理
   */
  async parse(request: ParseRequest, env: Env): Promise<ParseResult> {
    const result = await this.doParse(request, env);
    // 保证字段一致性
    if (!result.platform) result.platform = this.platform;
    if (!result.source) result.source = `${this.platform}/${this.implementation}`;
    if (!result.videos) result.videos = [];
    if (!result.images) result.images = [];
    if (!result.type) {
      result.type =
        result.videos.length > 0 && result.images.length > 0
          ? 'mixed'
          : result.videos.length > 0
            ? 'video'
            : result.images.length > 0
              ? 'images'
              : 'unknown';
    }
    return result;
  }
}
