/**
 * hellotik.app 加解密实现（逆向产物）
 *
 * 来源：
 *  - /js/DE5yxo86gVo0xI0l8W9N.js  → 响应解密 generateOutput
 *  - 8837-8cf987ac13788fdc.js     → 请求加密 AES-GCM
 *
 * 全部使用 WebCrypto API + TextEncoder，可在 Cloudflare Worker 原生运行。
 */

/** 常量（提取自混淆脚本，见 reverse/ 分析） */
const STANDARD_B64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const CUSTOM_B64 =
  'ZYXABCDEFGHIJKLMNOPQRSTUVWzyxabcdefghijklmnopqrstuvw9876543210-_';
const XOR_KEY = 0x5a;
const RESPONSE_AES_KEY = '93838338562359368888868323563256';

// ============ 基础工具 ============

/** Base64 解码 → 字符串（latin-1 保留每个字节为一个 char） */
function atobStr(b64: string): string {
  return atob(b64);
}

/** Base64 编码（Uint8Array） */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/** Base64 解码 → Uint8Array */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** 字符串 → latin-1 Uint8Array（每 char 一个字节） */
function latin1ToBytes(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i) & 0xff;
  }
  return bytes;
}

// ============ 响应解密链路（generateOutput） ============

/** 每个字符与 XOR_KEY 异或 */
function xorString(str: string, key: number = XOR_KEY): string {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    out += String.fromCharCode(str.charCodeAt(i) ^ key);
  }
  return out;
}

/** 每 blockSize 个字符的块内部反转（JS 默认 blockSize=8） */
function blockReverse(str: string, blockSize: number = 8): string {
  let out = '';
  for (let i = 0; i < str.length; i += blockSize) {
    out += str.slice(i, i + blockSize).split('').reverse().join('');
  }
  return out;
}

/** 自定义 Base64 字母表 → 标准 Base64 字母表 */
function customB64ToStandard(str: string): string {
  let out = '';
  for (const c of str) {
    const idx = CUSTOM_B64.indexOf(c);
    out += idx === -1 ? c : STANDARD_B64[idx]!;
  }
  return out;
}

/**
 * AES-256-CBC + PKCS7 解密
 * 对应 CryptoJS.AES.decrypt 的 createCipherParams 模式
 *
 * ciphertext/key/iv 均为标准 Base64 字符串
 * keyStr 为 32 字节 ASCII 密钥
 */
async function aesCbcDecrypt(
  ciphertextB64: string,
  ivB64: string,
  keyStr: string,
): Promise<string> {
  const keyBytes = latin1ToBytes(keyStr);
  const ivBytes = base64ToBytes(ivB64).slice(0, 16);
  const ciphertext = base64ToBytes(ciphertextB64);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-CBC' },
    false,
    ['decrypt'],
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv: ivBytes },
    cryptoKey,
    ciphertext,
  );

  return new TextDecoder('utf-8').decode(decrypted);
}

/**
 * 解密 hellotik parse 接口的响应
 *
 * 对应 window.generateOutput(data, key, "93838338562359368888868323563256")
 *  1. atob(data) / atob(key)
 *  2. xorString
 *  3. blockReverse (8)
 *  4. customB64ToStandard
 *  5. AES-256-CBC + PKCS7
 */
export async function decryptHellotikResponse(
  data: string,
  key: string,
): Promise<unknown> {
  // 1. base64 decode
  let d = atobStr(data);
  let k = atobStr(key);

  // 2. XOR
  d = xorString(d);
  k = xorString(k);

  // 3. block reverse
  d = blockReverse(d);
  k = blockReverse(k);

  // 4. custom b64 → standard b64
  d = customB64ToStandard(d);
  k = customB64ToStandard(k);

  // 5. AES-CBC decrypt
  const json = await aesCbcDecrypt(d, k, RESPONSE_AES_KEY);
  return JSON.parse(json);
}

// ============ 请求加密链路（AES-256-GCM） ============

/**
 * 派生 AES-256-GCM 密钥
 * SHA-256(`${ticket}:${seed}`)
 */
async function deriveGcmKey(ticket: string, seed: string): Promise<CryptoKey> {
  const material = new TextEncoder().encode(`${ticket}:${seed}`);
  const digest = await crypto.subtle.digest('SHA-256', material);
  return crypto.subtle.importKey(
    'raw',
    digest,
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );
}

/**
 * 加密 parse 请求 payload
 * 返回 hellotik 期望的 { payload, iv, v } 结构
 */
export async function encryptHellotikRequest(
  payload: unknown,
  ticket: string,
  seed: string,
): Promise<{ payload: string; iv: string; v: number }> {
  const key = await deriveGcmKey(ticket, seed);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintext,
  );

  return {
    payload: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
    v: 1,
  };
}
