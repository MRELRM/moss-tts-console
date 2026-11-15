#!/usr/bin/env node
'use strict';

/**
 * MOSS TTS 四合一测试台 · 零依赖本地服务
 *
 * 职责：
 *   1. 托管 public/ 下的静态页面（原生 http/https 模块，无 Express、无任何 npm 依赖）
 *   2. 四个代理端点（把浏览器请求转发到 MOSS API，注入 Authorization: Bearer）：
 *        POST /api/moss/speech           → {BASE}/v1/audio/speech           单音色合成（moss-tts-1.5-flash）
 *        POST /api/moss/speech/speakers  → {BASE}/v1/audio/speech/speakers  对话合成（moss-ttsd-1.0）
 *        POST /api/moss/voice/generations→ {BASE}/v1/audio/voice/generations 音色设计（moss-voice-generator-1.0）
 *        POST /api/moss/voices           → {BASE}/v1/audio/voices           音色克隆（multipart/form-data）
 *   3. GET /api/proxy-download?url=   —— 下载代理：MOSS 签发的音频结果 URL（多为跨域 CDN），
 *                                        浏览器直接 a[download] 会失效，由本机代理转发为附件下载。
 *   4. GET /api/health —— 健康检查
 *   5. 缓存：以 endpoint + payload 的 SHA-256 为 key，结果缓存到 .cache/moss/，
 *      相同请求命中缓存时不再调用 MOSS API（避免重复消耗积分）。
 *
 * 统一代理响应：
 *   成功  { success: true, deliveryMethod: "audio"|"url", audio?, contentType?, format?, url?, cached?, cacheKey?, raw? }
 *   失败  { success: false, status: <httpStatus>, error: <上游响应原文> }
 *
 * 安全：API Key 只存在于本进程内存与 .env 文件中，永远不会下发给浏览器；
 *       下载代理仅允许 MOSS 相关域名（防 SSRF）。
 * 运行：node server.js，然后打开 http://127.0.0.1:8788
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ==================== 配置加载（.env，进程环境变量优先） ==================== */

function parseEnvText(text) {
  const out = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 &&
        ((value[0] === '"' && value[value.length - 1] === '"') ||
         (value[0] === "'" && value[value.length - 1] === "'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadDotEnv() {
  try {
    return parseEnvText(fs.readFileSync(path.join(__dirname, '.env'), 'utf8'));
  } catch (e) {
    return {};
  }
}

const dotEnv = loadDotEnv();
function cfg(name, fallback) {
  const v = process.env[name] !== undefined ? process.env[name] : dotEnv[name];
  return v === undefined || v === '' ? fallback : v;
}

const MOSS_API_KEY = cfg('MOSS_API_KEY', '');
// .env.example 中的占位符值：视为未配置，避免用户忘填 Key 时页面误显示“已配置”
const KEY_PLACEHOLDER = '你的Key';
const keyConfigured = MOSS_API_KEY.length > 0 && MOSS_API_KEY !== KEY_PLACEHOLDER;
const MOSS_API_BASE_URL = String(cfg('MOSS_API_BASE_URL', 'https://api.mosi.cn')).replace(/\/+$/, '');
const PORT = parseInt(cfg('PORT', '8788'), 10) || 8788;
const HOST = cfg('HOST', '127.0.0.1');
// TODO: 音色克隆 multipart 的文件字段名，官方文档未明确时按惯例默认 "file"。
//       如实际接口报“缺少音频/文件”类错误，修改 .env 中 MOSS_CLONE_FILE_FIELD 即可，无需改代码。
const CLONE_FILE_FIELD = String(cfg('MOSS_CLONE_FILE_FIELD', 'file')).replace(/[^\w.-]/g, '') || 'file';

const PUBLIC_DIR = path.join(__dirname, 'public');
const CACHE_DIR = path.join(__dirname, '.cache', 'moss');

const UPSTREAM_TIMEOUT_MS = 5 * 60 * 1000;  // 上游生成可能较慢，给 5 分钟
const BODY_LIMIT = 25 * 1024 * 1024;         // 请求体读取上限（音色克隆样本 base64 后留余量）
const MAX_SAMPLE_BYTES = 20 * 1024 * 1024;   // 克隆参考音频原始大小上限

fs.mkdirSync(CACHE_DIR, { recursive: true });

/* ==================== 小工具 ==================== */

function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(...args) {
  console.log(`[${now()}]`, ...args);
}

function fmtBytes(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

function sendJson(res, code, obj) {
  try {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch (e) {
    /* 客户端可能已断开连接，忽略写入失败 */
  }
}

/** 读取请求体，超过 limit 时 resolve(null)（不中断连接，保证能回 413 JSON） */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/** 向上游发起请求。streamBody=true 时返回 { status, headers, stream }（流式透传用），否则聚合为 body */
function requestUpstream(urlString, bodyBuffer, headers, timeoutMs, streamBody) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (e) {
      return reject(new Error(`无效的上游地址：${urlString}`));
    }
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: Object.assign({}, headers, { 'Content-Length': bodyBuffer.length }),
      },
      (resp) => {
        if (!streamBody) {
          const chunks = [];
          resp.on('data', (c) => chunks.push(c));
          resp.on('end', () => {
            resolve({
              status: resp.statusCode || 0,
              headers: resp.headers,
              body: Buffer.concat(chunks),
            });
          });
        } else {
          resolve({ status: resp.statusCode || 0, headers: resp.headers, stream: resp });
        }
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`上游请求超时（${Math.round(timeoutMs / 1000)} 秒）`));
    });
    req.on('error', reject);
    req.end(bodyBuffer);
  });
}

/** 递归提取 JSON 中第一个像音频结果 URL 的字段（key 含 url 且值为 http(s) 字符串） */
function findAudioUrl(obj, depth) {
  const maxDepth = depth === undefined ? 6 : depth;
  if (maxDepth < 0 || obj === null || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const hit = findAudioUrl(item, maxDepth - 1);
      if (hit) return hit;
    }
    return null;
  }
  // 优先匹配常见字段名
  for (const key of ['url', 'audio_url', 'audioUrl', 'result_url', 'resultUrl', 'file_url', 'fileUrl', 'download_url', 'downloadUrl']) {
    const v = obj[key];
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v;
  }
  // 兜底：任意 key 含 url 的字符串字段
  for (const key of Object.keys(obj)) {
    if (/url/i.test(key)) {
      const v = obj[key];
      if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v;
    }
  }
  for (const key of Object.keys(obj)) {
    const hit = findAudioUrl(obj[key], maxDepth - 1);
    if (hit) return hit;
  }
  return null;
}

/** 递归提取 JSON 中的 Base64 音频字段（上游对 delivery=audio 实际返回 JSON 包装时的兜底） */
function findAudioBase64(obj, depth) {
  const maxDepth = depth === undefined ? 6 : depth;
  if (maxDepth < 0 || obj === null || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const hit = findAudioBase64(item, maxDepth - 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const key of ['audio', 'audio_base64', 'audioBase64', 'data', 'base64', 'content']) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 256 && /^[A-Za-z0-9+/=_-]+$/.test(v.slice(0, 512))) {
      return { base64: v, key };
    }
  }
  for (const key of Object.keys(obj)) {
    const hit = findAudioBase64(obj[key], maxDepth - 1);
    if (hit) return hit;
  }
  return null;
}

/** 从克隆接口响应 JSON 中提取音色对象的 id（即 voice_id）与名称 */
function extractVoice(json) {
  const candidates = [];
  const walk = (o, d) => {
    if (d < 0 || o === null || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach((x) => walk(x, d - 1)); return; }
    candidates.push(o);
    for (const k of Object.keys(o)) walk(o[k], d - 1);
  };
  walk(json, 4);
  // 优先取带 voice 语义的对象，其次取任意带 id 的对象
  const scored = candidates
    .filter((o) => typeof o.id === 'string' && o.id.length > 0)
    .sort((a, b) => {
      const rank = (o) => ('voice' in o ? 2 : 0) + (typeof o.name === 'string' ? 1 : 0);
      return rank(b) - rank(a);
    });
  const best = scored[0];
  if (!best) return { voiceId: null, voice: null };
  return { voiceId: best.id, voice: best };
}

/* ==================== 每端点本地校验（结构性错误尽早拦截；业务错误交上游原样返回） ==================== */

const MODEL_SPEECH = 'moss-tts-1.5-flash';
const MODEL_DIALOG = 'moss-ttsd-1.0';
const MODEL_DESIGN = 'moss-voice-generator-1.0';

function validateSpeech(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return '请求体必须是 JSON 对象';
  if (p.model !== MODEL_SPEECH) return `model 必须为 "${MODEL_SPEECH}"`;
  if (typeof p.input !== 'string' || !p.input.trim()) return 'input（待合成文本）必须是非空字符串';
  if (typeof p.voice_id !== 'string' || !p.voice_id.trim()) return 'voice_id 必须是非空字符串（可从“我的音色”选择，或从 MOSS 音色库复制）';
  if (p.response_format !== undefined && !['mp3', 'wav'].includes(p.response_format)) return 'response_format 仅支持 mp3 / wav';
  if (p.delivery_method !== undefined && !['audio', 'url'].includes(p.delivery_method)) return 'delivery_method 仅支持 audio / url';
  return null;
}

function validateDialog(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return '请求体必须是 JSON 对象';
  if (p.model !== MODEL_DIALOG) return `model 必须为 "${MODEL_DIALOG}"`;
  if (!Array.isArray(p.speakers) || p.speakers.length === 0) return 'speakers 必须是非空数组';
  const ids = new Set();
  for (const s of p.speakers) {
    if (!s || typeof s !== 'object') return 'speakers 中存在非法元素';
    if (typeof s.id !== 'string' || !s.id.trim()) return '每个 speaker 的 id 必须是非空字符串';
    if (ids.has(s.id)) return `speaker id "${s.id}" 重复`;
    ids.add(s.id);
    if (typeof s.voice_id !== 'string' || !s.voice_id.trim()) return `speaker "${s.id}" 缺少 voice_id`;
  }
  if (!Array.isArray(p.segments) || p.segments.length === 0) return 'segments 必须是非空数组';
  for (let i = 0; i < p.segments.length; i++) {
    const seg = p.segments[i];
    if (!seg || typeof seg !== 'object') return `segments[${i}] 非法`;
    if (typeof seg.speaker !== 'string' || !ids.has(seg.speaker)) {
      return `segments[${i}].speaker "${seg.speaker}" 未在 speakers 中声明`;
    }
    if (typeof seg.text !== 'string' || !seg.text.trim()) return `segments[${i}].text 不能为空（MOSS 会报 "text is required"）`;
  }
  if (p.response_format !== undefined && !['mp3', 'wav'].includes(p.response_format)) return 'response_format 仅支持 mp3 / wav';
  if (p.delivery_method !== undefined && !['audio', 'url'].includes(p.delivery_method)) return 'delivery_method 仅支持 audio / url';
  return null;
}

function validateDesign(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return '请求体必须是 JSON 对象';
  if (p.model !== MODEL_DESIGN) return `model 必须为 "${MODEL_DESIGN}"`;
  if (typeof p.input !== 'string' || !p.input.trim()) return 'input（待合成文本）必须是非空字符串';
  if (typeof p.instruction !== 'string' || !p.instruction.trim()) {
    return 'instruction（声音风格描述）必须是非空字符串，描述越具体，风格越稳定';
  }
  if (p.response_format !== undefined && !['mp3', 'wav'].includes(p.response_format)) return 'response_format 仅支持 mp3 / wav';
  if (p.delivery_method !== undefined && !['audio', 'url'].includes(p.delivery_method)) return 'delivery_method 仅支持 audio / url';
  return null;
}

function validateClone(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return '请求体必须是 JSON 对象';
  if (typeof p.fileBase64 !== 'string' || !p.fileBase64) return '缺少参考音频数据（fileBase64）';
  const buf = Buffer.from(p.fileBase64, 'base64');
  if (buf.length === 0) return 'fileBase64 不是合法的 Base64 音频数据';
  if (buf.length > MAX_SAMPLE_BYTES) {
    return `参考音频原始大小 ${fmtBytes(buf.length)} 超过 ${fmtBytes(MAX_SAMPLE_BYTES)} 上限，请截取片段或压缩后重试`;
  }
  if (p.name !== undefined && p.name !== null && typeof p.name !== 'string') return 'name 必须是字符串';
  if (p.description !== undefined && p.description !== null && typeof p.description !== 'string') return 'description 必须是字符串';
  return null;
}

/** 请求摘要（日志用，绝不打印 Key 与完整音频内容） */
function payloadSummary(p) {
  if (!p || typeof p !== 'object') return '（非法 payload）';
  const parts = [];
  if (p.model) parts.push(`model=${p.model}`);
  if (typeof p.input === 'string') parts.push(`input(${p.input.length}字符)`);
  if (typeof p.voice_id === 'string') parts.push(`voice_id=${p.voice_id}`);
  if (Array.isArray(p.speakers)) parts.push(`speakers=${p.speakers.length}`);
  if (Array.isArray(p.segments)) parts.push(`segments=${p.segments.length}`);
  if (typeof p.instruction === 'string') parts.push(`instruction(${p.instruction.length}字符)`);
  if (p.delivery_method) parts.push(`delivery=${p.delivery_method}`);
  if (p.response_format) parts.push(`format=${p.response_format}`);
  if (p.stream === true) parts.push('stream=true');
  if (p.fileBase64) {
    const buf = Buffer.from(p.fileBase64, 'base64');
    parts.push(`样本(${fmtBytes(buf.length)} ${p.filename || ''})`);
  }
  return parts.join(' ');
}

/* ==================== 缓存（endpoint + payload 的 SHA-256 key → .cache/moss/<key>.json） ==================== */

function cacheFileFor(key) {
  return path.join(CACHE_DIR, key + '.json');
}

function readCache(key) {
  try {
    return JSON.parse(fs.readFileSync(cacheFileFor(key), 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeCache(key, entry) {
  try {
    fs.writeFileSync(cacheFileFor(key), JSON.stringify(entry));
    return true;
  } catch (e) {
    log('缓存写入失败（不影响本次请求）：', e.message);
    return false;
  }
}

function cacheKeyFor(endpoint, payloadStr) {
  return crypto.createHash('sha256')
    .update(`${endpoint}::${payloadStr}`, 'utf8')
    .digest('hex');
}

/* ==================== 合成类端点共用处理（speech / speakers / voice generations） ==================== */

/**
 * @param {string} endpoint 上游路径，如 /v1/audio/speech
 * @param {Function} validator 本地校验函数
 */
async function handleSynthesis(req, res, endpoint, validator) {
  const started = Date.now();

  let rawBuf;
  try {
    rawBuf = await readBody(req, BODY_LIMIT);
  } catch (e) {
    return sendJson(res, 200, { success: false, status: 400, error: `读取请求体失败：${e.message}` });
  }
  if (rawBuf === null) {
    return sendJson(res, 200, {
      success: false,
      status: 413,
      error: `请求体超过本地代理上限（${fmtBytes(BODY_LIMIT)}）。`,
    });
  }

  let payload;
  try {
    payload = JSON.parse(rawBuf.toString('utf8'));
  } catch (e) {
    return sendJson(res, 200, { success: false, status: 400, error: `请求体不是合法 JSON：${e.message}` });
  }

  const invalid = validator(payload);
  if (invalid) {
    log('拒绝请求（本地校验）：', invalid);
    return sendJson(res, 200, { success: false, status: 400, error: invalid });
  }

  log(`收到请求 ${endpoint}：`, payloadSummary(payload));

  const payloadStr = JSON.stringify(payload);
  const cacheKey = cacheKeyFor(endpoint, payloadStr);
  const hit = readCache(cacheKey);
  if (hit && (hit.type === 'audio' || hit.type === 'url')) {
    log(`命中缓存 key=${cacheKey.slice(0, 16)}… 直接返回，未调用 MOSS API`);
    return sendJson(res, 200, Object.assign({ success: true, cached: true, cacheKey }, hit.data));
  }

  if (!keyConfigured) {
    return sendJson(res, 200, {
      success: false,
      status: 500,
      error: MOSS_API_KEY
        ? '服务端检测到 MOSS_API_KEY 仍是占位符“你的Key”：请编辑 .env 填入真实 Key 后，关闭窗口并重新双击 start.bat（或重启 node server.js）。'
        : '服务端未配置 MOSS_API_KEY：请将 .env.example 复制为 .env，填入 MOSS_API_KEY=你的Key 后重启 node server.js。',
    });
  }

  const wantStream = payload.stream === true && payload.delivery_method !== 'url';

  log(`调用上游 ${MOSS_API_BASE_URL}${endpoint}（payload ${fmtBytes(rawBuf.length)}${wantStream ? ' · 流式透传' : ''}）…`);

  let upstream;
  try {
    upstream = await requestUpstream(
      MOSS_API_BASE_URL + endpoint,
      Buffer.from(payloadStr, 'utf8'),
      {
        'Authorization': `Bearer ${MOSS_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': wantStream ? 'audio/*, application/json' : 'application/json, audio/*',
      },
      UPSTREAM_TIMEOUT_MS,
      wantStream
    );
  } catch (e) {
    log('上游请求失败：', e.message);
    return sendJson(res, 200, {
      success: false,
      status: 502,
      error: `无法连接 MOSS API（${MOSS_API_BASE_URL}）：${e.message}。请检查网络、DNS，或 .env 中的 MOSS_API_BASE_URL 是否正确（注意域名应为 api.mosi.cn）。`,
    });
  }

  const contentType = String((upstream.headers && upstream.headers['content-type']) || '');
  const isAudioResp = /^audio\//i.test(contentType.trim());

  /* ---------- 失败：聚合响应体，原样透传 status + body ---------- */
  if (upstream.status < 200 || upstream.status >= 300 || (!isAudioResp && wantStream && !/^application\/json/i.test(contentType) && upstream.status >= 400)) {
    // 流式模式下未拿到 2xx 音频流：聚合后再回 JSON 错误
    let errBody = '';
    if (upstream.stream) {
      errBody = await new Promise((resolve) => {
        const chunks = [];
        upstream.stream.on('data', (c) => chunks.push(c));
        upstream.stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        upstream.stream.on('error', () => resolve(''));
      });
    } else {
      errBody = upstream.body.toString('utf8');
    }
    log(`上游返回 HTTP ${upstream.status}`);
    return sendJson(res, 200, { success: false, status: upstream.status, error: errBody || `HTTP ${upstream.status}` });
  }

  /* ---------- 成功 + 流式：逐块转发音频给浏览器，同时聚合写缓存 ---------- */
  if (wantStream && upstream.stream) {
    const mime = contentType.trim() || 'audio/mpeg';
    const chunks = [];
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': 'no-store',
      'X-Moss-Proxy-Audio': 'stream',
    });
    upstream.stream.on('data', (c) => {
      chunks.push(c);
      try { res.write(c); } catch (e) { /* 客户端断开 */ }
    });
    upstream.stream.on('end', () => {
      try { res.end(); } catch (e) { /* 忽略 */ }
      const full = Buffer.concat(chunks);
      writeCache(cacheKey, { type: 'audio', data: { deliveryMethod: 'audio', audio: full.toString('base64'), contentType: mime, format: payload.response_format || 'mp3' } });
      log(`流式完成：音频 ${fmtBytes(full.length)}，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s，已写缓存`);
    });
    upstream.stream.on('error', (e) => {
      log('流式转发中断：', e.message);
      try { res.end(); } catch (e2) { /* 忽略 */ }
    });
    return;
  }

  /* ---------- 成功 + 非流式：按 Content-Type 统一解析 ---------- */

  // ① 音频二进制（delivery_method=audio 的正常路径）
  if (isAudioResp) {
    const mime = contentType.trim() || 'audio/mpeg';
    const entry = {
      deliveryMethod: 'audio',
      audio: upstream.body.toString('base64'),
      contentType: mime,
      format: payload.response_format || 'mp3',
    };
    writeCache(cacheKey, { type: 'audio', data: entry });
    log(`成功：音频 ${fmtBytes(upstream.body.length)}，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s，已写缓存`);
    return sendJson(res, 200, Object.assign({ success: true, cached: false, cacheKey }, entry));
  }

  // ② JSON（delivery_method=url 的正常路径；delivery=audio 但上游返回 JSON 包装时的兜底）
  let json;
  try {
    json = JSON.parse(upstream.body.toString('utf8'));
  } catch (e) {
    return sendJson(res, 200, {
      success: false,
      status: 502,
      error: `MOSS 返回了无法解析的非 JSON、非音频响应（Content-Type: ${contentType || '未知'}）：${upstream.body.toString('utf8').slice(0, 600)}`,
    });
  }

  const url = findAudioUrl(json);
  if (url) {
    const entry = { deliveryMethod: 'url', url, contentType: 'application/json' };
    writeCache(cacheKey, { type: 'url', data: entry, raw: json });
    log(`成功：结果 URL 模式，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s，已写缓存`);
    return sendJson(res, 200, Object.assign({ success: true, cached: false, cacheKey, raw: json }, entry));
  }

  const b64 = findAudioBase64(json);
  if (b64) {
    const entry = { deliveryMethod: 'audio', audio: b64.base64, contentType: 'audio/mpeg', format: payload.response_format || 'mp3', base64From: b64.key };
    writeCache(cacheKey, { type: 'audio', data: entry });
    log(`成功：JSON 内嵌 Base64 音频（字段 ${b64.key}），耗时 ${((Date.now() - started) / 1000).toFixed(1)}s，已写缓存`);
    return sendJson(res, 200, Object.assign({ success: true, cached: false, cacheKey }, entry));
  }

  log('上游 200 但响应中未找到音频 URL 或 Base64 字段');
  return sendJson(res, 200, {
    success: false,
    status: 502,
    error: 'MOSS 响应中没有找到音频 URL（url/audio_url/data.url）或 Base64 音频字段',
    raw: json,
  });
}

/* ==================== 音色克隆端点（multipart 构造转发） ==================== */

/**
 * 前端把参考音频读为 Base64，POST JSON：
 *   { fileBase64, mime, filename, name?, description? }
 * 本服务手动构造 multipart/form-data（零依赖，不引入 busboy/formidable），转发到 /v1/audio/voices。
 *
 * TODO: MOSS 文档未明确 multipart 的文件字段名，默认 "file"（.env: MOSS_CLONE_FILE_FIELD 可改）。
 *       文件名后缀与 Content-Type 按前端上传的实际文件透传。
 */
async function handleVoiceClone(req, res) {
  const started = Date.now();

  let rawBuf;
  try {
    rawBuf = await readBody(req, BODY_LIMIT);
  } catch (e) {
    return sendJson(res, 200, { success: false, status: 400, error: `读取请求体失败：${e.message}` });
  }
  if (rawBuf === null) {
    return sendJson(res, 200, {
      success: false,
      status: 413,
      error: `请求体超过本地代理上限（${fmtBytes(BODY_LIMIT)}）。参考音频请截取片段或压缩。`,
    });
  }

  let payload;
  try {
    payload = JSON.parse(rawBuf.toString('utf8'));
  } catch (e) {
    return sendJson(res, 200, { success: false, status: 400, error: `请求体不是合法 JSON：${e.message}` });
  }

  const invalid = validateClone(payload);
  if (invalid) {
    log('拒绝请求（本地校验）：', invalid);
    return sendJson(res, 200, { success: false, status: 400, error: invalid });
  }

  log('收到克隆请求：', payloadSummary(payload));

  if (!keyConfigured) {
    return sendJson(res, 200, {
      success: false,
      status: 500,
      error: MOSS_API_KEY
        ? '服务端检测到 MOSS_API_KEY 仍是占位符“你的Key”：请编辑 .env 填入真实 Key 后重启服务。'
        : '服务端未配置 MOSS_API_KEY：请将 .env.example 复制为 .env，填入 MOSS_API_KEY=你的Key 后重启 node server.js。',
    });
  }

  const audioBuf = Buffer.from(payload.fileBase64, 'base64');
  const filename = String(payload.filename || 'sample.wav').replace(/[\r\n"]/g, '');
  const fileMime = String(payload.mime || 'audio/wav').replace(/[\r\n"]/g, '');

  // ---- 手动构造 multipart/form-data ----
  const boundary = '----MossConsoleBoundary' + crypto.randomBytes(16).toString('hex');
  const parts = [];

  // 文件 part（字段名可经 .env 配置）
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${CLONE_FILE_FIELD}"; filename="${filename}"\r\n` +
    `Content-Type: ${fileMime}\r\n\r\n`,
    'utf8'
  ));
  parts.push(audioBuf);
  parts.push(Buffer.from('\r\n', 'utf8'));

  // 文本字段 part
  const textFields = [];
  if (payload.name && String(payload.name).trim()) textFields.push(['name', String(payload.name).trim()]);
  if (payload.description && String(payload.description).trim()) textFields.push(['description', String(payload.description).trim()]);
  for (const [k, v] of textFields) {
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${k}"\r\n\r\n` +
      `${v}\r\n`,
      'utf8'
    ));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

  const multipartBody = Buffer.concat(parts);
  log(`转发 multipart：字段 [${[CLONE_FILE_FIELD].concat(textFields.map((t) => t[0])).join(', ')}]，文件 ${filename}（${fmtBytes(audioBuf.length)}），总计 ${fmtBytes(multipartBody.length)}`);

  let upstream;
  try {
    upstream = await requestUpstream(
      MOSS_API_BASE_URL + '/v1/audio/voices',
      multipartBody,
      {
        'Authorization': `Bearer ${MOSS_API_KEY}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Accept': 'application/json',
      },
      UPSTREAM_TIMEOUT_MS,
      false
    );
  } catch (e) {
    log('上游请求失败：', e.message);
    return sendJson(res, 200, {
      success: false,
      status: 502,
      error: `无法连接 MOSS API（${MOSS_API_BASE_URL}）：${e.message}。请检查网络、DNS，或 .env 中的 MOSS_API_BASE_URL。`,
    });
  }

  const bodyText = upstream.body.toString('utf8');
  if (upstream.status < 200 || upstream.status >= 300) {
    log(`上游返回 HTTP ${upstream.status}`);
    return sendJson(res, 200, { success: false, status: upstream.status, error: bodyText || `HTTP ${upstream.status}` });
  }

  let json;
  try {
    json = JSON.parse(bodyText);
  } catch (e) {
    return sendJson(res, 200, {
      success: false,
      status: 502,
      error: `MOSS 返回了无法解析的非 JSON 响应：${bodyText.slice(0, 600)}`,
    });
  }

  const { voiceId, voice } = extractVoice(json);
  if (!voiceId) {
    log('上游 200 但响应中未找到音色对象 id 字段');
    return sendJson(res, 200, {
      success: false,
      status: 502,
      error: 'MOSS 响应中没有找到音色对象的 id 字段（即 voice_id）。',
      raw: json,
    });
  }

  log(`克隆成功：voice_id=${voiceId}，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return sendJson(res, 200, { success: true, voiceId, voice, raw: json });
}

/* ==================== 下载代理（结果 URL → 附件下载；仅允许 MOSS 相关域名，防 SSRF） ==================== */

function isAllowedDownloadHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  const allowedSuffixes = ['mosi.cn', 'moss.cn'];           // 主站与 CDN 根域
  const baseHost = (() => {
    try { return new URL(MOSS_API_BASE_URL).hostname.toLowerCase(); } catch (e) { return ''; }
  })();
  return allowedSuffixes.some((s) => h === s || h.endsWith('.' + s)) || (baseHost && h === baseHost);
}

async function handleProxyDownload(req, res, searchParams) {
  const target = searchParams.get('url');
  if (!target) {
    return sendJson(res, 400, { success: false, status: 400, error: '缺少 url 参数' });
  }
  let url;
  try {
    url = new URL(target);
  } catch (e) {
    return sendJson(res, 400, { success: false, status: 400, error: 'url 参数不是合法 URL' });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return sendJson(res, 400, { success: false, status: 400, error: '仅支持 http/https 下载' });
  }
  if (!isAllowedDownloadHost(url.hostname)) {
    return sendJson(res, 403, { success: false, status: 403, error: `出于安全考虑，下载代理仅允许 MOSS 相关域名（*.mosi.cn / *.moss.cn），收到：${url.hostname}` });
  }

  const mod = url.protocol === 'https:' ? https : http;
  await new Promise((resolve) => {
    const upReq = mod.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { 'User-Agent': 'moss-tts-console-local', 'Accept': 'audio/*, */*' },
      },
      (upResp) => {
        const mime = String(upResp.headers['content-type'] || 'application/octet-stream');
        const disposition = `attachment; filename="moss-tts-${Date.now()}.${/wav/i.test(mime) ? 'wav' : 'mp3'}"`;
        res.writeHead(upResp.statusCode || 502, {
          'Content-Type': mime,
          'Content-Disposition': disposition,
          'Cache-Control': 'no-store',
        });
        upResp.pipe(res);
        upResp.on('end', resolve);
      }
    );
    upReq.setTimeout(120000, () => upReq.destroy(new Error('下载超时')));
    upReq.on('error', (e) => {
      if (!res.headersSent) {
        sendJson(res, 502, { success: false, status: 502, error: `下载失败：${e.message}` });
      } else {
        try { res.end(); } catch (e2) { /* 忽略 */ }
      }
      resolve();
    });
    upReq.end();
  });
}

/* ==================== 健康检查 ==================== */

function handleHealth(res) {
  sendJson(res, 200, {
    ok: true,
    keyConfigured,
    baseUrl: MOSS_API_BASE_URL,
    port: PORT,
    cloneFileField: CLONE_FILE_FIELD,
    models: {
      speech: MODEL_SPEECH,
      dialogue: MODEL_DIALOG,
      design: MODEL_DESIGN,
    },
    time: new Date().toISOString(),
  });
}

/* ==================== 静态文件 ==================== */

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function serveStatic(pathname, res, isHead) {
  let rel = pathname;
  try {
    rel = decodeURIComponent(rel);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Bad Request');
  }
  if (rel === '/' || rel === '') rel = '/index.html';

  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  const root = path.normalize(PUBLIC_DIR + path.sep);
  if (filePath !== path.normalize(PUBLIC_DIR) && !filePath.startsWith(root)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
      return res.end(isHead ? undefined : '404 Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(isHead ? undefined : data);
  });
}

/* ==================== 路由 ==================== */

async function route(req, res, searchParams) {
  let pathname = '/';
  try {
    pathname = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`).pathname;
  } catch (e) {
    /* 保持默认 */
  }

  if (req.method === 'GET' && pathname === '/api/health') {
    return handleHealth(res);
  }
  if (req.method === 'POST' && pathname === '/api/moss/speech') {
    return handleSynthesis(req, res, '/v1/audio/speech', validateSpeech);
  }
  if (req.method === 'POST' && pathname === '/api/moss/speech/speakers') {
    return handleSynthesis(req, res, '/v1/audio/speech/speakers', validateDialog);
  }
  if (req.method === 'POST' && pathname === '/api/moss/voice/generations') {
    return handleSynthesis(req, res, '/v1/audio/voice/generations', validateDesign);
  }
  if (req.method === 'POST' && pathname === '/api/moss/voices') {
    return handleVoiceClone(req, res);
  }
  if (req.method === 'GET' && pathname === '/api/proxy-download') {
    return handleProxyDownload(req, res, searchParams);
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(pathname, res, req.method === 'HEAD');
  }
  sendJson(res, 405, { success: false, status: 405, error: '不支持的请求方法：' + req.method });
}

const server = http.createServer((req, res) => {
  let searchParams;
  try {
    searchParams = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`).searchParams;
  } catch (e) {
    searchParams = new URLSearchParams();
  }
  Promise.resolve()
    .then(() => route(req, res, searchParams))
    .catch((e) => {
      log('处理请求时出错：', e && e.message);
      sendJson(res, 500, { success: false, status: 500, error: '本地服务内部错误：' + ((e && e.message) || e) });
    });
});

// 合成可能超过默认 300s，关闭整体请求超时（上游自身仍有 5 分钟超时兜底）
server.requestTimeout = 0;
server.headersTimeout = 65000;

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('==========================================================');
  console.log('  MOSS TTS 四合一测试台 · 本地服务已启动');
  console.log('==========================================================');
  console.log(`  页面地址      http://${HOST}:${PORT}`);
  console.log(`  API 基址      ${MOSS_API_BASE_URL}`);
  console.log(`  API Key       ${keyConfigured ? '已配置' : '未配置（请复制 .env.example 为 .env 并填写 MOSS_API_KEY，然后重启）'}`);
  console.log(`  克隆文件字段  ${CLONE_FILE_FIELD}（.env: MOSS_CLONE_FILE_FIELD 可改）`);
  console.log(`  音频缓存      ${CACHE_DIR}`);
  console.log(`  Node 版本     ${process.version}`);
  console.log('==========================================================');
  console.log('  按 Ctrl+C 停止服务');
  console.log('');
});

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`启动失败：端口 ${PORT} 已被占用，请修改 .env 中的 PORT 后重试`);
  } else {
    console.error('服务器启动失败：', e && e.message);
  }
  process.exit(1);
});

// 兜底：单个请求异常不应杀掉整个本地服务
process.on('uncaughtException', (e) => {
  console.error(`[${now()}] 未捕获异常（服务继续运行）：`, e && e.message);
});
