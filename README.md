# tiktok-parser-proxy

基于 **Cloudflare Worker + Hono + TypeScript** 的多平台解析代理。  
逆向 hellotik.app 的加解密链路，在 Worker 内自包含完成解析，对外提供统一 RESTful 接口。

## 核心设计

**对外统一，对内可扩展（策略模式 + 注册中心）：**

```
对外接口 (统一)
  GET  /api/parseUrl/:platform?string=xxx
  POST /api/parseUrl/:platform        body: { string, isBatch?, meta? }
  GET  /api/parseUrl/auto?string=xxx  ← 自动嗅探平台
       │
       ▼
  ProviderRegistry  ← 路由 / 嗅探
       │
       ▼
  BaseProvider (abstract)  ← 模板方法，统一字段/异常
       │
       ├── HellotikDouyinProvider   (douyin / hellotik 实现)
       ├── OfficialTiktokProvider   (未来扩展)
       └── BilibiliProvider         (未来扩展)
```

新增平台/实现只需两步：
1. 继承 `BaseProvider`，实现 `match()` + `doParse()`
2. 在 `src/index.ts` 调用 `registry.register(new XxxProvider())`

对外接口无需任何改动。

## 目录结构

```
src/
├── index.ts                       入口：注册 provider + 挂载路由 + 全局兜底
├── types/index.ts                 统一类型契约（ParseRequest/ParseResult/ApiResponse）
├── crypto/hellotik-crypto.ts      逆向产物：AES-GCM 请求加密 + 5层响应解密
├── providers/
│   ├── base.ts                    抽象基类（模板方法）
│   ├── registry.ts                注册中心（查找/嗅探）
│   └── hellotik-douyin.ts         抖音 × HelloTik 实现
├── routes/
│   ├── parse.ts                   /api/parseUrl/:platform
│   └── meta.ts                    /api/health, /api/providers
└── utils/
    ├── response.ts                标准响应包装（ok/fail/json）
    └── logger.ts                  结构化日志
```

## 快速开始

```bash
npm install

# 本地开发（热重载）
npm run dev
# → http://localhost:8787

# 类型检查
npm run typecheck

# 部署到 Cloudflare
npm run deploy
```

## 接口示例

**GET**（string 需 URL 编码）
```
GET /api/parseUrl/douyin?string=5.89%20复制打开抖音...%20https://v.douyin.com/d4rqQgaz89g/
GET /api/parseUrl/auto?string=https://v.douyin.com/d4rqQgaz89g/
```

**POST**（推荐，避免长文案编码问题）
```bash
curl -X POST https://<your-worker>/api/parseUrl/douyin \
  -H 'Content-Type: application/json' \
  -d '{"string":"5.89 复制打开抖音... https://v.douyin.com/d4rqQgaz89g/"}'
```

**响应**
```json
{
  "success": true,
  "code": 0,
  "message": "ok",
  "data": {
    "platform": "douyin",
    "type": "images",
    "title": "拒绝流水线 | 玛丽亚主题...",
    "videos": [],
    "images": [{ "url": "https://..." }],
    "source": "douyin/hellotik"
  },
  "elapsedMs": 1827
}
```

## 反爬应对（可选配置）

helloTik 的 parse 接口需要会话 cookie。Worker 已自动捕获 gate 接口的 `set-cookie` 并回传，多数情况无需额外配置。

若遇 403，可手动注入固定 cookie（环境变量）：

```bash
# 开发：写入 .dev.vars
echo 'HELLOTIK_COOKIE="NEXT_LOCALE=zh; parse_sid=xxx"' > .dev.vars

# 生产：设为 secret（不进仓库）
npx wrangler secret put HELLOTIK_COOKIE
```

## 扩展新平台示例

```typescript
// src/providers/bilibili.ts
import { BaseProvider } from './base';
import type { ParseRequest, ParseResult, Env } from '../types';

export class BilibiliProvider extends BaseProvider {
  readonly platform = 'bilibili';
  readonly implementation = 'official';

  match(rawString: string): number {
    return rawString.includes('bilibili.com') || rawString.includes('b23.tv') ? 0.9 : 0;
  }

  protected async doParse(req: ParseRequest, env: Env): Promise<ParseResult> {
    // 调用对应 API，转换为统一 ParseResult
    return { /* ... */ };
  }
}

// src/index.ts 加一行
registry.register(new BilibiliProvider());
```

随后 `GET /api/parseUrl/bilibili?string=...` 立即可用，对外接口零改动。

## 逆向细节

详见 `../reverse/` 目录的分析与 Python 验证脚本。关键链路：

- **请求加密**：`SHA-256(ticket:seed)` 派生密钥 → AES-256-GCM 加密 payload
- **响应解密**：`atob → XOR(0x5A) → blockReverse(8) → 自定义B64还原 → AES-256-CBC`
