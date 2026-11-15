# MOSS TTS 四合一测试台

本地运行的 MOSS TTS 调试控制台，一个页面覆盖四个场景：

| 场景 | 端点 | 模型 / 方式 | 说明 |
|---|---|---|---|
| 单音色合成 | `POST /v1/audio/speech` | `moss-tts-1.5-flash` | 文本 + voice_id，返回音频（audio）或音频 URL（url） |
| 多人对话合成 | `POST /v1/audio/speech/speakers` | `moss-ttsd-1.0` | speakers 声明说话人，segments 按顺序给台词 |
| 音色设计 | `POST /v1/audio/voice/generations` | `moss-voice-generator-1.0` | 文本 + 风格描述 instruction，返回语音预览（非持久化音色） |
| 音色克隆 | `POST /v1/audio/voices` | multipart/form-data | 上传参考音频，返回可复用 voice_id |

**特点：零 npm 依赖**（Node 原生 `http`/`https`，不用 Express）、原生 HTML/CSS/JS 前端（无构建工具）、API Key 只保存在服务端 `.env` 中（浏览器端代码与网络请求里均不出现密钥）、相同请求命中本地缓存不重复消耗积分、URL 结果的下载由本机代理转发（跨域 CDN 地址浏览器直接下载会失效）。

---

## 快速开始

### 方式一：双击启动（Windows，需 Node.js 18+）

1. 双击 `start.bat`：首次运行会自动从 `.env.example` 生成 `.env` 并在记事本中打开
2. 填写 `MOSS_API_KEY=你的Key` 后保存并关闭记事本
3. 服务自动启动，浏览器自动打开 `http://127.0.0.1:8788`
4. 停止服务：直接关闭命令行窗口；修改 `.env` 后需重新双击 `start.bat`

### 方式二：命令行运行（需 Node.js 18+，无需 `npm install`）

```bash
# 1. 进入目录
cd moss-tts-console

# 2. 复制配置文件并填入你的 Key
cp .env.example .env            # Windows PowerShell: Copy-Item .env.example .env

# 3. 启动
node server.js

# 4. 打开页面
# http://127.0.0.1:8788
```

### 配置说明（.env）

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `MOSS_API_KEY` | 是 | — | 你的 MOSS API Key，仅保存在服务端 |
| `MOSS_API_BASE_URL` | 否 | `https://api.mosi.cn` | **注意域名是 api.mosi.cn（不是 moss.cn）**，端点在 /v1 路径下 |
| `PORT` | 否 | `8788` | 本地服务端口（与 mimo-tts-console 的 8787 错开） |
| `HOST` | 否 | `127.0.0.1` | 监听地址 |
| `MOSS_CLONE_FILE_FIELD` | 否 | `file` | 音色克隆 multipart 的文件字段名。官方文档未明确时按惯例默认 `file`；若实际接口报"缺少文件/音频样本"类错误，按官方文档改成实际字段名即可，无需改代码 |

> 修改 `.env` 后需重启 `node server.js`。页面顶部健康栏实时显示 Key 配置状态；健康检查接口：`GET /api/health`。

---

## 接口调用要点

- **鉴权**：所有请求统一 `Authorization: Bearer <MOSS_API_KEY>`（由服务端注入，前端不接触 Key）。
- **delivery_method 两种模式**：
  - `audio`：响应体直接是音频二进制，代理转 Base64 返回 `{ deliveryMethod: "audio", audio, contentType, format }`
  - `url`：响应 JSON 含结果 URL，代理提取（递归匹配 `url / audio_url / data.url` 等字段）返回 `{ deliveryMethod: "url", url, raw }`；下载走 `GET /api/proxy-download?url=`（仅允许 `*.mosi.cn / *.moss.cn`，防 SSRF）
- **stream**：`stream=true` 且 `delivery_method=audio` 时，代理把上游音频流逐块透传给浏览器（前端用 `fetch` 的 `ReadableStream` 逐块拼接），同时聚合写缓存；命中缓存时仍返回 JSON。音色设计场景不提供 stream。
- **音色设计**返回的是**语音预览**（音频/URL），不是持久化的 voice_id；要复用音色请用「音色克隆」或 MOSS 音色库。
- **音色克隆**使用 multipart/form-data：文件字段名默认 `file`（`.env: MOSS_CLONE_FILE_FIELD` 可配置），可选 `name`、`description` 文本字段；响应中音色对象的 **id 即 voice_id**，成功后自动加入页面「我的音色」列表（localStorage）。
- **对话合成**：`segments[].speaker` 必须对应 `speakers[].id`；每个 segment 的 `text` 不能为空（否则上游报 "text is required"）。

### 请求示例（单音色合成）

```json
{
  "model": "moss-tts-1.5-flash",
  "input": "要合成的文本",
  "voice_id": "94aa4989-c7e9-5007-ae42-ab401823e6c9",
  "response_format": "mp3",
  "delivery_method": "audio",
  "stream": false
}
```

### 请求示例（多人对话合成）

```json
{
  "model": "moss-ttsd-1.0",
  "speakers": [
    { "id": "speaker_a", "voice_id": "7e5020e3-…" },
    { "id": "speaker_b", "voice_id": "2925f9ce-…" }
  ],
  "segments": [
    { "speaker": "speaker_a", "text": "第一句台词" },
    { "speaker": "speaker_b", "text": "第二句台词" }
  ],
  "response_format": "wav",
  "delivery_method": "audio"
}
```

---

## 页面功能

- **四场景切换**：顶部 Tab 切换，表单字段随场景联动（文本 / voice_id / 风格描述 / 对话编辑器 / 样本上传 / delivery / format / stream 按需显隐）
- **我的音色**：已克隆音色自动入库；支持手动添加外部 voice_id（从 MOSS 音色库复制）、复制、删除；localStorage 持久化
- **对话编辑器**：说话人与台词行级编辑，支持增删、上移/下移台词；默认预填 2 说话人 + 2 台词示例
- **克隆样本**：上传 mp3/wav 或浏览器录音（自动转码 16kHz 单声道 WAV），提供「转码压缩」
- **请求预览**：发送前查看完整 JSON 或 multipart 字段摘要（不显示二进制）；**专家模式**可直接编辑 JSON 发送（用于复现报错等调试，克隆场景不开放）
- **播放与下载**：audio 模式 Blob 播放；url 模式直接播放并经本机代理下载；文件名 `moss-tts-{场景}-{时间戳}.{格式}`
- **缓存**：以 endpoint + payload 的 SHA-256 为 key 缓存到 `.cache/moss/`，命中时 UI 标注「命中本地缓存 · 未调用 MOSS API」（URL 结果有时效，过期清缓存重生成）

## 后端接口（本测试台自身）

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/moss/speech` | POST | 转发到 `/v1/audio/speech` |
| `/api/moss/speech/speakers` | POST | 转发到 `/v1/audio/speech/speakers` |
| `/api/moss/voice/generations` | POST | 转发到 `/v1/audio/voice/generations` |
| `/api/moss/voices` | POST | 音色克隆：接收 `{ fileBase64, mime, filename, name?, description? }`，服务端构造 multipart 转发到 `/v1/audio/voices` |
| `/api/proxy-download?url=` | GET | 结果 URL 附件下载代理（仅 `*.mosi.cn / *.moss.cn`） |
| `/api/health` | GET | 健康检查，返回 `{ ok, keyConfigured, baseUrl, cloneFileField }` |

统一成功响应：`{ success: true, deliveryMethod: "audio"|"url", audio?, contentType?, format?, url?, cached?, cacheKey? }`；克隆：`{ success: true, voiceId, voice, raw }`。
失败响应：`{ success: false, status: <httpStatus>, error: <上游响应原文> }`（status 与 body 原样透传）。

## 错误排查速查

| 现象 | 原因与建议 |
|---|---|
| HTTP 401 / 403 | 检查 `.env` 中的 `MOSS_API_KEY`；MOSS 统一使用 `Authorization: Bearer`（本服务已按此实现），改 Key 后需重启 |
| HTTP 404 | 检查端点路径与域名：**api.mosi.cn**（不是 moss.cn）+ `/v1/audio/...` |
| `voice not found` | voice_id 无效或跨账号；克隆未成功返回 id；文档示例音色可能已失效 |
| `text is required` | 单音色 input 为空，或对话 segments 中 text 为空 |
| 克隆报"缺少文件/音频样本" | multipart 文件字段名与实际接口不符：改 `.env` 的 `MOSS_CLONE_FILE_FIELD` 后重启 |
| 连接失败 | 检查网络/DNS，或 `.env` 的 `MOSS_API_BASE_URL` 是否正确 |

页面收到错误时会以红框展示原始响应，并自动附上对应的中文排查建议。

## 目录结构

```
moss-tts-console/
├── .env               # 你的本地配置（首次运行 start.bat 自动生成；不入库不打包）
├── .env.example       # 配置示例
├── server.js          # 零依赖后端：静态托管 + 4 个代理端点 + 下载代理 + SHA-256 缓存
├── start.bat          # 一键启动（Windows）
├── public/
│   ├── index.html     # 页面结构
│   ├── style.css      # 深色控制台主题
│   └── app.js         # 前端逻辑（场景联动 / 对话编辑器 / 音色管理 / 流式拼接 / 播放下载）
└── .cache/moss/       # 结果缓存（运行时自动创建，可随时删除）
```

## 常见问题

- **生成的音频在哪里？** 在页面播放器中播放/下载；同时以 Base64 缓存在服务端 `.cache/moss/` 目录。
- **如何清空缓存？** 直接删除 `.cache/moss/` 目录即可，不影响运行。
- **音色设计能保存音色吗？** 不能，预览不是持久化音色；需要复用请走「音色克隆」或 MOSS 音色库。
- **端口被占用？** 修改 `.env` 中的 `PORT` 后重启（默认 8788）。

## 参考

- [单音语音生成](https://platform.moss.cn/docs/scenarios/single-voice) · [多人对话生成](https://platform.moss.cn/docs/scenarios/dialogue) · [音色设计](https://platform.moss.cn/docs/scenarios/voice-design) · [音色克隆](https://platform.moss.cn/docs/scenarios/voice-clone)

> AI生成
