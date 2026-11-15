'use strict';

/* ============================================================
 * MOSS TTS 四合一测试台 · 前端逻辑
 *
 * 四个场景（POST 本地代理 → MOSS API，浏览器不接触 API Key）：
 *   speech  单音色合成    /api/moss/speech            → /v1/audio/speech            (moss-tts-1.5-flash)
 *   dialog  多人对话合成  /api/moss/speech/speakers   → /v1/audio/speech/speakers   (moss-ttsd-1.0)
 *   design  音色设计      /api/moss/voice/generations → /v1/audio/voice/generations (moss-voice-generator-1.0)
 *   clone   音色克隆      /api/moss/voices            → /v1/audio/voices            (multipart/form-data)
 *
 * delivery_method 统一处理：audio（Base64 二进制）/ url（结果 URL，下载走本机代理）。
 * “我的音色”保存在 localStorage，供单音色合成与多人对话选用。
 * ============================================================ */

/* ==================== 常量 ==================== */

const VOICES_LS_KEY = 'moss-tts-console.voices.v1';
const MAX_SAMPLE_BYTES = 20 * 1024 * 1024; // 参考音频原始大小上限（与服务端一致）

const MIME_BY_FORMAT = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};

// 官方文档示例 voice_id（来自平台文档请求示例；可能随平台调整而失效）
const DOC_SAMPLE_VOICES = [
  { id: '94aa4989-c7e9-5007-ae42-ab401823e6c9', name: '文档示例音色 A' },
];

const SCENE_META = {
  speech: {
    endpoint: '/api/moss/speech',
    upstream: 'POST /v1/audio/speech',
    model: 'moss-tts-1.5-flash',
    label: '单音色合成',
    showText: true, showVoice: true, showInstruction: false, showDialog: false, showClone: false,
    showDelivery: true, showFormat: true, showStream: true,
    deliveryDefault: 'audio',
    btnText: '生成语音',
    desc: '单音色语音合成：POST /v1/audio/speech，model=moss-tts-1.5-flash。输入文本 + voice_id（从“我的音色”选择，或手动输入 MOSS 音色库 ID），返回音频（audio）或音频 URL（url）。',
    previewNote: '请求体 JSON 原样发往 POST {MOSS_API_BASE_URL}/v1/audio/speech，服务端注入 Authorization: Bearer 后转发。',
  },
  dialog: {
    endpoint: '/api/moss/speech/speakers',
    upstream: 'POST /v1/audio/speech/speakers',
    model: 'moss-ttsd-1.0',
    label: '多人对话',
    showText: false, showVoice: false, showInstruction: false, showDialog: true, showClone: false,
    showDelivery: true, showFormat: true, showStream: true,
    deliveryDefault: 'audio',
    btnText: '生成对话',
    desc: '多人对话合成：POST /v1/audio/speech/speakers，model=moss-ttsd-1.0。用 speakers 声明说话人与各自 voice_id，用 segments 按顺序给出台词，合成一段完整对话音频。',
    previewNote: '请求体 JSON 原样发往 POST {MOSS_API_BASE_URL}/v1/audio/speech/speakers。segments.speaker 必须对应 speakers 中已声明的 id。',
  },
  design: {
    endpoint: '/api/moss/voice/generations',
    upstream: 'POST /v1/audio/voice/generations',
    model: 'moss-voice-generator-1.0',
    label: '音色设计',
    showText: true, showVoice: false, showInstruction: true, showDialog: false, showClone: false,
    showDelivery: true, showFormat: true, showStream: false,
    deliveryDefault: 'url',
    btnText: '生成预览',
    desc: '音色设计：POST /v1/audio/voice/generations，model=moss-voice-generator-1.0。输入待合成文本 + 声音风格描述 instruction，返回风格匹配的语音预览。注意：预览不是持久化音色，如需复用请到“音色克隆”或使用 MOSS 音色库。',
    previewNote: '请求体 JSON 原样发往 POST {MOSS_API_BASE_URL}/v1/audio/voice/generations。建议 delivery_method=url，便于统一处理；返回的是语音预览而非 voice_id。',
  },
  clone: {
    endpoint: '/api/moss/voices',
    upstream: 'POST /v1/audio/voices',
    model: null,
    label: '音色克隆',
    showText: false, showVoice: false, showInstruction: false, showDialog: false, showClone: true,
    showDelivery: false, showFormat: false, showStream: false,
    deliveryDefault: null,
    btnText: '开始克隆',
    desc: '音色克隆：POST /v1/audio/voices（multipart/form-data）。上传参考音频（wav/mp3，或浏览器录音自动转码），返回可复用的 voice_id，自动加入“我的音色”，供单音色合成与对话合成使用。',
    previewNote: '该接口使用 multipart/form-data 上传，无 JSON 请求体。上方为表单字段摘要（不显示文件二进制内容）；文件字段名默认 file，可在服务端 .env 中通过 MOSS_CLONE_FILE_FIELD 调整。',
  },
};

/* ==================== DOM ==================== */

const $id = (id) => document.getElementById(id);
const els = {
  healthBar: $id('healthBar'),
  healthText: $id('healthText'),
  tabs: Array.from(document.querySelectorAll('.tab')),
  sceneDesc: $id('sceneDesc'),

  fieldText: $id('fieldText'),
  textLabel: $id('textLabel'),
  textNote: $id('textNote'),
  textInput: $id('textInput'),
  charCount: $id('charCount'),

  fieldVoice: $id('fieldVoice'),
  voiceSelect: $id('voiceSelect'),
  voiceManual: $id('voiceManual'),

  fieldInstruction: $id('fieldInstruction'),
  instructionInput: $id('instructionInput'),

  dialogSection: $id('dialogSection'),
  speakerList: $id('speakerList'),
  segmentList: $id('segmentList'),
  addSpeakerBtn: $id('addSpeakerBtn'),
  addSegmentBtn: $id('addSegmentBtn'),

  cloneSection: $id('cloneSection'),
  fileInput: $id('fileInput'),
  recordBtn: $id('recordBtn'),
  clearSampleBtn: $id('clearSampleBtn'),
  compressBtn: $id('compressBtn'),
  recordStatus: $id('recordStatus'),
  sampleInfo: $id('sampleInfo'),
  cloneName: $id('cloneName'),
  cloneDesc: $id('cloneDesc'),

  fieldDelivery: $id('fieldDelivery'),
  deliverySelect: $id('deliverySelect'),
  fieldFormat: $id('fieldFormat'),
  formatSelect: $id('formatSelect'),
  fieldStream: $id('fieldStream'),
  streamCheck: $id('streamCheck'),

  generateBtn: $id('generateBtn'),

  resultCard: $id('resultCard'),
  resultMeta: $id('resultMeta'),
  audioPlayer: $id('audioPlayer'),
  downloadBtn: $id('downloadBtn'),
  urlNote: $id('urlNote'),

  errorCard: $id('errorCard'),
  errorStatus: $id('errorStatus'),
  errorBody: $id('errorBody'),
  errorHints: $id('errorHints'),

  toggleVoiceFormBtn: $id('toggleVoiceFormBtn'),
  voiceAddForm: $id('voiceAddForm'),
  addVoiceName: $id('addVoiceName'),
  addVoiceId: $id('addVoiceId'),
  saveVoiceBtn: $id('saveVoiceBtn'),
  cancelVoiceBtn: $id('cancelVoiceBtn'),
  voiceList: $id('voiceList'),

  previewArea: $id('previewArea'),
  expertWrap: $id('expertWrap'),
  expertCheck: $id('expertCheck'),
  regenPreviewBtn: $id('regenPreviewBtn'),
  previewNote: $id('previewNote'),
};

/* ==================== 状态 ==================== */

const state = {
  scene: 'speech',
  voices: [],            // [{ id, name, source: 'clone'|'manual', createdAt }]
  speakers: [],          // [{ id, voiceId }]
  segments: [],          // [{ speaker, text }]
  sample: null,          // { blob, mime, name, sizeBytes, duration }
  recording: false,
  recorder: null,
  recChunks: [],
  stream: null,
  recTimer: null,
  recStart: 0,
  expert: false,
  loading: false,
  loadTimer: null,
  loadT0: 0,
  lastElapsed: '0.0',
  audioUrl: null,
  lastResult: null,      // { kind:'blob'|'url', format, url?, cached, scene }
};

/* ==================== 工具函数 ==================== */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmtSize(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

function fileTs() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function shortId(id, n) {
  const s = String(id || '');
  return s.length > (n || 14) ? s.slice(0, n || 14) + '…' : s;
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function getAudioDuration(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const a = new Audio();
    const finish = (v) => { URL.revokeObjectURL(url); resolve(v); };
    a.onloadedmetadata = () => finish(isFinite(a.duration) ? a.duration : null);
    a.onerror = () => finish(null);
    a.src = url;
  });
}

/* ==================== 我的音色（localStorage） ==================== */

function loadVoices() {
  try {
    const arr = JSON.parse(localStorage.getItem(VOICES_LS_KEY) || '[]');
    if (Array.isArray(arr)) {
      state.voices = arr.filter((v) => v && typeof v.id === 'string' && v.id);
    }
  } catch (e) {
    state.voices = [];
  }
}

function saveVoices() {
  try {
    localStorage.setItem(VOICES_LS_KEY, JSON.stringify(state.voices));
  } catch (e) {
    /* localStorage 不可用时静默降级为内存态 */
  }
}

function addVoice(id, name, source) {
  const trimmed = String(id || '').trim();
  if (!trimmed) return;
  if (state.voices.some((v) => v.id === trimmed)) return;
  state.voices.unshift({
    id: trimmed,
    name: String(name || '').trim() || shortId(trimmed, 10),
    source: source === 'clone' ? 'clone' : 'manual',
    createdAt: Date.now(),
  });
  saveVoices();
  renderVoiceList();
  refreshVoiceSelects();
}

function removeVoice(id) {
  state.voices = state.voices.filter((v) => v.id !== id);
  saveVoices();
  renderVoiceList();
  refreshVoiceSelects();
}

function renderVoiceList() {
  if (!state.voices.length) {
    els.voiceList.innerHTML = '<div class="voice-empty">暂无音色。克隆成功后会自动加入；也可点击右上角「手动添加」录入 MOSS 音色库 ID。</div>';
    return;
  }
  els.voiceList.innerHTML = state.voices.map((v) => (
    '<div class="voice-item" data-id="' + esc(v.id) + '">' +
      '<div class="v-main">' +
        '<div class="v-name">' + esc(v.name) + '</div>' +
        '<div class="v-id" title="' + esc(v.id) + '">' + esc(v.id) + '</div>' +
      '</div>' +
      '<span class="v-badge ' + (v.source === 'clone' ? 'clone' : '') + '">' + (v.source === 'clone' ? '克隆' : '手动') + '</span>' +
      '<button type="button" class="row-btn" data-act="copy" title="复制 voice_id">⧉</button>' +
      '<button type="button" class="row-btn danger" data-act="del" title="从列表删除">✕</button>' +
    '</div>'
  )).join('');
}

els.voiceList.addEventListener('click', async (e) => {
  const btn = e.target.closest('.row-btn');
  if (!btn) return;
  const item = e.target.closest('.voice-item');
  const id = item && item.dataset.id;
  if (!id) return;
  if (btn.dataset.act === 'copy') {
    try {
      await navigator.clipboard.writeText(id);
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = '⧉'; }, 900);
    } catch (err) {
      window.prompt('复制该 voice_id：', id);
    }
  } else if (btn.dataset.act === 'del') {
    removeVoice(id);
  }
});

/** 重建“我的音色”下拉选项（供单音色、说话人、手动添加共同使用） */
function voiceOptionsHtml() {
  const groups = [];
  if (state.voices.length) {
    groups.push('<optgroup label="我的音色">' + state.voices.map((v) =>
      '<option value="' + esc(v.id) + '">' + esc(v.name) + '（' + esc(shortId(v.id, 10)) + '）</option>'
    ).join('') + '</optgroup>');
  }
  groups.push('<optgroup label="文档示例">' + DOC_SAMPLE_VOICES.map((v) =>
    '<option value="' + esc(v.id) + '">' + esc(v.name) + '（' + esc(shortId(v.id, 10)) + '）</option>'
  ).join('') + '</optgroup>');
  return groups.join('');
}

function refreshVoiceSelects() {
  const cur = els.voiceSelect.value;
  els.voiceSelect.innerHTML = voiceOptionsHtml();
  if (cur && state.voices.some((v) => v.id === cur)) els.voiceSelect.value = cur;
  // 对话编辑器中的 speaker 下拉同步刷新（保留当前选择）
  state.speakers.forEach((sp, i) => {
    const sel = els.speakerList.querySelector('.sp-voice[data-i="' + i + '"]');
    if (sel) {
      const v = sel.value;
      sel.innerHTML = '<option value="">— 请选择音色 —</option>' + voiceOptionsHtml();
      if (v && [...sel.options].some((o) => o.value === v)) sel.value = v;
    }
  });
  updatePreview();
}

/* ==================== 场景切换与表单联动 ==================== */

function switchScene(scene) {
  if (!SCENE_META[scene]) return;
  if (state.recording) stopRecording();
  state.scene = scene;
  const meta = SCENE_META[scene];
  els.tabs.forEach((b) => {
    const active = b.dataset.scene === scene;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  els.sceneDesc.textContent = meta.desc;
  els.fieldText.hidden = !meta.showText;
  els.fieldVoice.hidden = !meta.showVoice;
  els.fieldInstruction.hidden = !meta.showInstruction;
  els.dialogSection.hidden = !meta.showDialog;
  els.cloneSection.hidden = !meta.showClone;
  els.fieldDelivery.hidden = !meta.showDelivery;
  els.fieldFormat.hidden = !meta.showFormat;
  els.fieldStream.hidden = !meta.showStream;
  if (meta.deliveryDefault) els.deliverySelect.value = meta.deliveryDefault;
  if (meta.showStream) els.streamCheck.checked = false;
  els.generateBtn.textContent = meta.btnText;
  els.previewNote.textContent = meta.previewNote;
  // 专家模式仅对 JSON 类场景开放
  const expertOk = scene !== 'clone';
  els.expertWrap.hidden = !expertOk;
  if (!expertOk) {
    els.expertCheck.checked = false;
    state.expert = false;
    els.previewArea.readOnly = true;
    els.previewArea.classList.remove('editable');
  }
  updatePreview();
}

/* ==================== 对话编辑器 ==================== */

function defaultSpeakerId(i) {
  return 'speaker_' + String.fromCharCode(97 + (i % 26)); // speaker_a, speaker_b, …
}

function ensureUniqueSpeakerId(base) {
  let id = base || defaultSpeakerId(state.speakers.length);
  let n = 1;
  while (state.speakers.some((s) => s.id === id)) {
    id = base + '_' + n;
    n++;
  }
  return id;
}

function renderSpeakers() {
  els.speakerList.innerHTML = state.speakers.map((sp, i) => (
    '<div class="editor-row" data-i="' + i + '">' +
      '<input type="text" class="sp-id" data-i="' + i + '" value="' + esc(sp.id) + '" placeholder="id" spellcheck="false">' +
      '<select class="sp-voice" data-i="' + i + '"><option value="">— 请选择音色 —</option>' + voiceOptionsHtml() + '</select>' +
      '<div class="row-btns">' +
        '<button type="button" class="row-btn danger" data-act="del" title="删除说话人">✕</button>' +
      '</div>' +
    '</div>'
  )).join('');

  // 恢复选中
  state.speakers.forEach((sp, i) => {
    const sel = els.speakerList.querySelector('.sp-voice[data-i="' + i + '"]');
    if (sel) {
      const has = [...sel.options].some((o) => o.value === sp.voiceId);
      if (has) sel.value = sp.voiceId;
    }
  });

  renderSegments();
  updatePreview();
}

function renderSegments() {
  const speakerOptions = (cur) => state.speakers.map((sp) =>
    '<option value="' + esc(sp.id) + '"' + (sp.id === cur ? ' selected' : '') + '>' + esc(sp.id) + '</option>'
  ).join('');

  els.segmentList.innerHTML = state.segments.map((seg, i) => (
    '<div class="editor-row seg" data-i="' + i + '">' +
      '<select class="seg-speaker" data-i="' + i + '">' + speakerOptions(seg.speaker) + '</select>' +
      '<input type="text" class="seg-text" data-i="' + i + '" value="' + esc(seg.text) + '" placeholder="第' + (i + 1) + '句台词" spellcheck="false">' +
      '<div class="row-btns">' +
        '<button type="button" class="row-btn" data-act="up" title="上移"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
        '<button type="button" class="row-btn" data-act="down" title="下移"' + (i === state.segments.length - 1 ? ' disabled' : '') + '>↓</button>' +
        '<button type="button" class="row-btn danger" data-act="del" title="删除台词">✕</button>' +
      '</div>' +
    '</div>'
  )).join('');
  updatePreview();
}

els.speakerList.addEventListener('input', (e) => {
  const t = e.target;
  const i = Number(t.dataset.i);
  if (t.classList.contains('sp-id')) {
    state.speakers[i].id = t.value.trim() || state.speakers[i].id;
    renderSegments();
  }
});
els.speakerList.addEventListener('change', (e) => {
  const t = e.target;
  const i = Number(t.dataset.i);
  if (t.classList.contains('sp-voice')) {
    state.speakers[i].voiceId = t.value;
    updatePreview();
  }
});
els.speakerList.addEventListener('click', (e) => {
  const btn = e.target.closest('.row-btn');
  if (!btn || btn.dataset.act !== 'del') return;
  const i = Number(e.target.closest('.editor-row').dataset.i);
  const removedId = state.speakers[i].id;
  state.speakers.splice(i, 1);
  // 清理引用了该说话人的 segment
  state.segments = state.segments.filter((s) => s.speaker !== removedId);
  renderSpeakers();
});

els.segmentList.addEventListener('input', (e) => {
  const t = e.target;
  const i = Number(t.dataset.i);
  if (t.classList.contains('seg-text')) state.segments[i].text = t.value;
  updatePreview();
});
els.segmentList.addEventListener('change', (e) => {
  const t = e.target;
  const i = Number(t.dataset.i);
  if (t.classList.contains('seg-speaker')) {
    state.segments[i].speaker = t.value;
    updatePreview();
  }
});
els.segmentList.addEventListener('click', (e) => {
  const btn = e.target.closest('.row-btn');
  if (!btn) return;
  const i = Number(e.target.closest('.editor-row').dataset.i);
  const act = btn.dataset.act;
  if (act === 'del') {
    state.segments.splice(i, 1);
    renderSegments();
  } else if (act === 'up' && i > 0) {
    [state.segments[i - 1], state.segments[i]] = [state.segments[i], state.segments[i - 1]];
    renderSegments();
  } else if (act === 'down' && i < state.segments.length - 1) {
    [state.segments[i + 1], state.segments[i]] = [state.segments[i], state.segments[i + 1]];
    renderSegments();
  }
});

els.addSpeakerBtn.addEventListener('click', () => {
  state.speakers.push({ id: ensureUniqueSpeakerId(defaultSpeakerId(state.speakers.length)), voiceId: '' });
  renderSpeakers();
});
els.addSegmentBtn.addEventListener('click', () => {
  const sp = state.speakers[0] ? state.speakers[0].id : '';
  state.segments.push({ speaker: sp, text: '' });
  renderSegments();
});

function initDialogDefaults() {
  state.speakers = [
    { id: 'speaker_a', voiceId: '' },
    { id: 'speaker_b', voiceId: '' },
  ];
  state.segments = [
    { speaker: 'speaker_a', text: '你好，欢迎来到本期节目。今天我们聊聊语音合成技术的新进展。' },
    { speaker: 'speaker_b', text: '好啊，我正好准备了不少问题，咱们开始吧。' },
  ];
  renderSpeakers();
}

/* ==================== 克隆样本：上传 / 录音 / 转码 ==================== */

function isAllowedAudio(file) {
  const name = String(file.name || '').toLowerCase();
  const type = String(file.type || '').toLowerCase();
  return name.endsWith('.mp3') || name.endsWith('.wav') ||
    type === 'audio/mpeg' || type === 'audio/mp3' ||
    type === 'audio/wav' || type === 'audio/x-wav' || type === 'audio/wave';
}

function handleFile(file) {
  if (!file) return;
  if (!isAllowedAudio(file)) {
    showError({
      local: true,
      status: null,
      error: `仅支持 mp3 / wav 参考音频，收到「${file.name}」。浏览器录音得到的是 webm，请使用页面上的录音功能（已内置自动转码 WAV）。`,
    });
    return;
  }
  loadSampleFromBlob(file, file.name);
}

async function loadSampleFromBlob(blob, displayName) {
  if (blob.size > MAX_SAMPLE_BYTES) {
    state.sample = null;
    updateSampleUI();
    showError({
      local: true,
      status: null,
      error: `参考音频 ${fmtSize(blob.size)} 超过 ${fmtSize(MAX_SAMPLE_BYTES)} 上限。请点击「转码压缩（16kHz 单声道 WAV）」重新选择，或截取较短片段。`,
    });
    return;
  }
  let duration = null;
  try { duration = await getAudioDuration(blob); } catch (e) { duration = null; }
  state.sample = {
    blob,
    mime: blob.type || 'application/octet-stream',
    name: displayName,
    sizeBytes: blob.size,
    duration,
  };
  updateSampleUI();
  updatePreview();
}

function updateSampleUI() {
  const s = state.sample;
  if (!s) {
    els.sampleInfo.hidden = true;
    els.clearSampleBtn.hidden = true;
    els.compressBtn.hidden = true;
    return;
  }
  els.sampleInfo.hidden = false;
  els.clearSampleBtn.hidden = false;
  els.compressBtn.hidden = false;
  els.sampleInfo.textContent =
    `样本就绪：${s.name} · 大小 ${fmtSize(s.sizeBytes)}` +
    (s.duration ? ` · 时长 ${s.duration.toFixed(1)}s` : '');
}

function clearSample() {
  state.sample = null;
  updateSampleUI();
  updatePreview();
}

async function compressSample() {
  if (!state.sample || !state.sample.blob) return;
  els.recordStatus.hidden = false;
  els.recordStatus.textContent = '正在转码压缩为 16kHz 单声道 WAV…';
  try {
    const wav = await transcodeToWav16kMono(state.sample.blob);
    const baseName = (state.sample.name || 'sample').replace(/\.[^.]*$/, '');
    await loadSampleFromBlob(wav, baseName + '-16k.wav');
  } catch (e) {
    showError({ local: true, status: null, error: '转码失败：' + e.message + '。若原始文件无法解码，请换一个 mp3 / wav 文件。' });
  } finally {
    els.recordStatus.hidden = true;
  }
}

/* ---------- 录音（MediaRecorder → webm → 16kHz 单声道 WAV） ---------- */

async function startRecording() {
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    showError({ local: true, status: null, error: '当前浏览器不支持 MediaRecorder 录音，请使用 Chrome / Edge，或改用文件上传 mp3 / wav。' });
    return;
  }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch (e) {
    showError({ local: true, status: null, error: '无法获取麦克风权限：' + e.message });
    return;
  }
  const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
  const rec = new MediaRecorder(state.stream, mimeType ? { mimeType } : undefined);
  state.recorder = rec;
  state.recChunks = [];
  rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) state.recChunks.push(ev.data); };
  rec.onerror = (ev) => showError({ local: true, status: null, error: '录音出错：' + ((ev.error && ev.error.message) || '未知错误') });
  rec.onstop = async () => {
    stopRecTimer();
    if (state.stream) { state.stream.getTracks().forEach((t) => t.stop()); state.stream = null; }
    const webm = new Blob(state.recChunks, { type: rec.mimeType || 'audio/webm' });
    els.recordStatus.hidden = false;
    els.recordStatus.textContent = '正在转码为 16kHz 单声道 WAV…';
    try {
      const wav = await transcodeToWav16kMono(webm);
      await loadSampleFromBlob(wav, '录音-' + fileTs() + '.wav');
    } catch (e) {
      showError({ local: true, status: null, error: '录音转码失败：' + e.message + '（可改用文件上传 mp3 / wav）' });
    } finally {
      els.recordStatus.hidden = true;
    }
  };
  rec.start();
  state.recording = true;
  els.recordBtn.textContent = '停止录音';
  els.recordBtn.classList.add('recording');
  startRecTimer();
}

function stopRecording() {
  if (!state.recording) return;
  state.recording = false;
  els.recordBtn.textContent = '开始录音';
  els.recordBtn.classList.remove('recording');
  if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
}

function startRecTimer() {
  state.recStart = Date.now();
  els.recordStatus.hidden = false;
  const tick = () => {
    const s = Math.floor((Date.now() - state.recStart) / 1000);
    els.recordStatus.textContent = '录音中 ' + fmtRecTime(s) + '（停止后将自动转码为 16kHz 单声道 WAV）';
  };
  tick();
  state.recTimer = setInterval(tick, 500);
}

function stopRecTimer() {
  if (state.recTimer) { clearInterval(state.recTimer); state.recTimer = null; }
}

function fmtRecTime(s) {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
}

/* ---------- Web Audio 转码：任意音频 → 16kHz 单声道 WAV ---------- */

async function transcodeToWav16kMono(source) {
  const arrayBuffer = source instanceof Blob ? await source.arrayBuffer() : source;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new Error('当前浏览器不支持 Web Audio API');
  const tmp = new Ctx();
  let decoded;
  try {
    decoded = await tmp.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    if (tmp.close) { try { tmp.close(); } catch (e) { /* 忽略 */ } }
  }
  const targetRate = 16000;
  const length = Math.max(1, Math.ceil(decoded.duration * targetRate));
  const offline = new OfflineAudioContext(1, length, targetRate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return encodeWavBlob(rendered);
}

/** AudioBuffer → 16-bit PCM 单声道 WAV Blob */
function encodeWavBlob(audioBuffer) {
  const numChannels = 1;
  const sampleRate = audioBuffer.sampleRate;
  const src = audioBuffer.getChannelData(0);
  const bytesPerSample = 2;
  const dataSize = src.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let off = 44;
  for (let i = 0; i < src.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, src[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/* ==================== payload 构造与请求预览 ==================== */

function resolveVoiceId() {
  const manual = els.voiceManual.value.trim();
  if (manual) return manual;
  return els.voiceSelect.value || '';
}

function buildPayload() {
  const meta = SCENE_META[state.scene];
  const delivery = els.deliverySelect.value;
  const format = els.formatSelect.value;
  const useStream = meta.showStream && els.streamCheck.checked && delivery === 'audio';

  if (state.scene === 'speech') {
    const p = {
      model: meta.model,
      input: els.textInput.value,
      voice_id: resolveVoiceId(),
      response_format: format,
      delivery_method: delivery,
    };
    if (useStream) p.stream = true;
    return p;
  }
  if (state.scene === 'dialog') {
    const p = {
      model: meta.model,
      speakers: state.speakers.map((s) => ({ id: s.id, voice_id: s.voiceId })),
      segments: state.segments.map((s) => ({ speaker: s.speaker, text: s.text })),
      response_format: format,
      delivery_method: delivery,
    };
    if (useStream) p.stream = true;
    return p;
  }
  if (state.scene === 'design') {
    return {
      model: meta.model,
      input: els.textInput.value,
      instruction: els.instructionInput.value,
      delivery_method: delivery,
      response_format: format,
    };
  }
  return null; // clone 走独立分支
}

/** 生成预览文本：JSON 场景显示完整 JSON；克隆场景显示 multipart 字段摘要 */
function previewText() {
  const meta = SCENE_META[state.scene];
  if (state.scene === 'clone') {
    const s = state.sample;
    const fields = [{
      name: 'file（可配置，默认 file）',
      type: 'file',
      filename: s ? s.name : '(未选择文件)',
      size: s ? s.sizeBytes : 0,
    }];
    if (s) fields[0].mime = s.mime;
    const name = els.cloneName.value.trim();
    const desc = els.cloneDesc.value.trim();
    if (name) fields.push({ name: 'name', type: 'text', value: name });
    if (desc) fields.push({ name: 'description', type: 'text', value: desc });
    const summary = {
      endpoint: '/v1/audio/voices',
      method: 'POST',
      contentType: 'multipart/form-data; boundary=…',
      fields,
    };
    return '// multipart/form-data 摘要（POST {MOSS_API_BASE_URL}/v1/audio/voices）\n// 二进制文件内容不在此显示\n' + JSON.stringify(summary, null, 2);
  }

  const payload = buildPayload();
  return JSON.stringify(payload, null, 2);
}

function updatePreview() {
  if (state.expert) return; // 专家模式下不覆盖用户编辑
  els.previewArea.value = previewText();
}

function onExpertToggle() {
  state.expert = els.expertCheck.checked && state.scene !== 'clone';
  els.previewArea.readOnly = !state.expert;
  els.previewArea.classList.toggle('editable', state.expert);
  if (!state.expert) updatePreview();
}

/* ==================== 校验与发送 ==================== */

function validate() {
  const meta = SCENE_META[state.scene];
  if (state.scene === 'speech') {
    if (!els.textInput.value.trim()) return '待合成文本（input）不能为空。';
    if (!resolveVoiceId()) return '请选择或手动输入 voice_id。可先到「音色克隆」生成音色，或在右侧「我的音色」手动添加 MOSS 音色库 ID。';
  } else if (state.scene === 'dialog') {
    if (!state.speakers.length) return '请至少配置 1 个说话人（建议 2 个以上）。';
    if (!state.segments.length) return '请至少添加 1 句台词。';
    for (const s of state.speakers) {
      if (!s.id.trim()) return '存在说话人 id 为空，请补全。';
      if (!s.voiceId) return `说话人「${s.id}」尚未选择 voice_id。`;
    }
    const ids = new Set(state.speakers.map((s) => s.id));
    if (ids.size !== state.speakers.length) return '说话人 id 重复，请修改。';
    for (let i = 0; i < state.segments.length; i++) {
      const seg = state.segments[i];
      if (!seg.speaker || !ids.has(seg.speaker)) return `segments[${i}] 的说话人未在 speakers 中声明。`;
      if (!seg.text.trim()) return `第 ${i + 1} 句台词为空（MOSS 会报 "text is required"）。`;
    }
  } else if (state.scene === 'design') {
    if (!els.textInput.value.trim()) return '待合成文本（input）不能为空。';
    if (!els.instructionInput.value.trim()) return '声音风格描述（instruction）不能为空。描述越具体，风格越稳定。';
  } else if (state.scene === 'clone') {
    if (!state.sample) return '请先上传或录制参考音频（mp3 / wav）。';
  }
  return null;
}

async function generate() {
  if (state.loading) return;
  const meta = SCENE_META[state.scene];

  // 专家模式：仅 JSON 类场景，完全由用户构造 payload
  if (!state.expert) {
    const problem = validate();
    if (problem) {
      showError({ local: true, status: null, error: problem });
      return;
    }
  }

  hideResult();
  setLoading(true);
  const t0 = Date.now();

  try {
    if (state.scene === 'clone' && !state.expert) {
      await doClone(t0);
    } else {
      let payload;
      if (state.expert) {
        try {
          payload = JSON.parse(els.previewArea.value);
        } catch (e) {
          showError({ local: true, status: null, error: '专家模式 JSON 解析失败：' + e.message });
          return;
        }
      } else {
        payload = buildPayload();
      }
      await doSynthesis(payload, t0);
    }
  } catch (e) {
    showError({ status: null, error: '请求失败：' + ((e && e.message) || e) });
  } finally {
    setLoading(false);
  }
}

async function doSynthesis(payload, t0) {
  const meta = SCENE_META[state.scene];
  const wantStream = payload.stream === true && payload.delivery_method !== 'url';
  const resp = await fetch(meta.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const contentType = (resp.headers.get('content-type') || '').toLowerCase();

  /* 流式分支：后端直接透传音频二进制（仅 stream=true 且 delivery=audio 且未命中缓存时） */
  if (wantStream && resp.ok && contentType.indexOf('audio/') === 0 && resp.body) {
    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      const s = Math.floor((Date.now() - t0) / 1000);
      els.generateBtn.textContent = `接收中… ${fmtSize(received)} · ${s}s`;
    }
    const mime = contentType.split(';')[0].trim();
    const format = /wav/i.test(mime) ? 'wav' : 'mp3';
    state.lastElapsed = ((Date.now() - t0) / 1000).toFixed(1);
    handleAudioBlob(new Blob(chunks, { type: mime }), format, false, payload.stream === true);
    return;
  }

  /* 常规分支：JSON 响应（成功结果 / 缓存命中 / 错误） */
  let data = null;
  try {
    data = await resp.json();
  } catch (e) {
    throw new Error('本地代理返回了非 JSON 响应（HTTP ' + resp.status + '）');
  }
  state.lastElapsed = ((Date.now() - t0) / 1000).toFixed(1);
  if (data && data.success) {
    handleSynthesisResult(data, payload);
  } else {
    showError(data || { status: resp.status, error: '空响应' });
  }
}

async function doClone(t0) {
  const s = state.sample;
  const buf = await s.blob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  const fileBase64 = btoa(binary);
  const body = {
    fileBase64,
    mime: s.mime || 'audio/wav',
    filename: s.name || 'sample.wav',
  };
  const name = els.cloneName.value.trim();
  const desc = els.cloneDesc.value.trim();
  if (name) body.name = name;
  if (desc) body.description = desc;

  const resp = await fetch('/api/moss/voices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try {
    data = await resp.json();
  } catch (e) {
    throw new Error('本地代理返回了非 JSON 响应（HTTP ' + resp.status + '）');
  }
  state.lastElapsed = ((Date.now() - t0) / 1000).toFixed(1);
  if (data && data.success && data.voiceId) {
    handleCloneSuccess(data);
  } else {
    showError(data || { status: resp.status, error: '空响应' });
  }
}

function setLoading(on) {
  state.loading = on;
  els.generateBtn.disabled = on;
  if (on) {
    state.loadT0 = Date.now();
    const isClone = state.scene === 'clone';
    els.generateBtn.textContent = (isClone ? '克隆中… 0s' : '生成中… 0s');
    state.loadTimer = setInterval(() => {
      const s = Math.floor((Date.now() - state.loadT0) / 1000);
      els.generateBtn.textContent = (isClone ? '克隆中… ' : '生成中… ') + s + 's（首次生成可能需要数十秒）';
    }, 500);
  } else {
    if (state.loadTimer) { clearInterval(state.loadTimer); state.loadTimer = null; }
    els.generateBtn.textContent = SCENE_META[state.scene].btnText;
  }
}

/* ==================== 结果展示 ==================== */

function revokeAudioUrl() {
  if (state.audioUrl && state.lastResult && state.lastResult.kind === 'blob') {
    URL.revokeObjectURL(state.audioUrl);
  }
  state.audioUrl = null;
}

function handleSynthesisResult(data, payload) {
  hideError();
  const scene = state.scene;
  if (data.deliveryMethod === 'url' && data.url) {
    state.lastResult = { kind: 'url', url: data.url, format: payload && payload.response_format || 'mp3', cached: !!data.cached, scene };
    els.audioPlayer.src = data.url;
    els.urlNote.hidden = false;
    showResultMeta([
      `场景 ${SCENE_META[scene].label}`,
      `模型 ${payload && payload.model || SCENE_META[scene].model}`,
      `格式 ${state.lastResult.format}`,
      `模式 url`,
      `耗时 ${state.lastElapsed}s`,
      data.cached ? '<span class="badge badge-cache">命中本地缓存 · 未调用 MOSS API</span>' : '<span class="badge badge-fresh">MOSS API 生成</span>',
    ]);
    els.resultCard.hidden = false;
    els.resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }

  // audio 模式（含 JSON 内嵌 Base64 兜底）
  if (data.audio) {
    const format = data.format || 'mp3';
    const mime = data.contentType || MIME_BY_FORMAT[format] || 'audio/mpeg';
    handleAudioBlob(new Blob([base64ToBytes(data.audio)], { type: mime }), format, !!data.cached, payload && payload.stream === true);
    return;
  }

  showError({ local: true, status: null, error: '代理返回成功但缺少音频内容（audio / url 均为空）。' });
}

function handleAudioBlob(blob, format, cached, streamed) {
  hideError();
  revokeAudioUrl();
  state.audioUrl = URL.createObjectURL(blob);
  state.lastResult = { kind: 'blob', format, cached, scene: state.scene };
  els.audioPlayer.src = state.audioUrl;
  els.urlNote.hidden = true;
  showResultMeta([
    `场景 ${SCENE_META[state.scene].label}`,
    `格式 ${esc(format)}`,
    `大小 ${fmtSize(blob.size)}`,
    `耗时 ${state.lastElapsed}s`,
    streamed ? '<span class="badge badge-fresh">流式接收</span>' : '',
    cached ? '<span class="badge badge-cache">命中本地缓存 · 未调用 MOSS API</span>' : '<span class="badge badge-fresh">MOSS API 生成</span>',
  ]);
  els.resultCard.hidden = false;
  els.resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function showResultMeta(parts) {
  els.resultMeta.innerHTML = parts.filter(Boolean).join(' · ');
}

function handleCloneSuccess(data) {
  hideError();
  const v = data.voice || {};
  const name = els.cloneName.value.trim() || v.name || shortId(data.voiceId, 10);
  addVoice(data.voiceId, name, 'clone');
  els.resultCard.hidden = true;
  els.resultMeta.innerHTML = '';
  els.audioPlayer.removeAttribute('src');
  showResultMeta([]);
  els.resultCard.hidden = false;
  els.resultMeta.innerHTML = [
    `场景 音色克隆`,
    `voice_id <span class="ok-text">${esc(data.voiceId)}</span>`,
    `耗时 ${state.lastElapsed}s`,
    '<span class="badge badge-fresh">已加入「我的音色」</span>',
  ].join(' · ');
  els.urlNote.hidden = true;
  els.resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  // 提示：可到单音色/对话场景直接使用
  els.resultMeta.innerHTML += '<div class="field-help">现在可切换到「单音色合成」或「多人对话」，在音色下拉中选择刚克隆的音色直接试听。</div>';
}

function downloadAudio() {
  const r = state.lastResult;
  if (!r) return;
  const a = document.createElement('a');
  const ext = r.format || 'mp3';
  a.download = `moss-tts-${r.scene || state.scene}-${fileTs()}.${ext}`;
  if (r.kind === 'blob') {
    a.href = state.audioUrl;
  } else {
    // url 模式：结果 URL 为跨域地址，浏览器直接 a[download] 会失效，走本机下载代理
    a.href = '/api/proxy-download?url=' + encodeURIComponent(r.url);
  }
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function hideResult() {
  els.resultCard.hidden = true;
  els.audioPlayer.removeAttribute('src');
  els.urlNote.hidden = true;
}

/* ==================== 错误展示与友好提示 ==================== */

function showError(data) {
  const status = data && data.status;
  const error = data && data.error;
  els.errorCard.hidden = false;
  els.errorStatus.textContent = (data && data.local)
    ? '本地提示（请求未发送或已被拦截）'
    : (status ? `请求失败 · HTTP ${status}` : '请求失败');

  let body = typeof error === 'string' ? error : (error ? JSON.stringify(error, null, 2) : '未知错误');
  if (data && data.raw) {
    body += '\n\n—— MOSS 原始响应 ——\n' + JSON.stringify(data.raw, null, 2);
  }
  els.errorBody.textContent = body;

  const hints = buildHints(status, body);
  els.errorHints.innerHTML = hints.length
    ? '<div class="hints-title">可能的原因与排查建议</div>' +
      hints.map((h) => `<div class="hint-item">${esc(h)}</div>`).join('')
    : '';
  els.errorCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function hideError() {
  els.errorCard.hidden = true;
}

function buildHints(status, errorText) {
  const t = String(errorText || '');
  const hints = [];

  if (status === 401 || status === 403 || /unauthorized|forbidden|invalid.{0,12}key|api key/i.test(t)) {
    hints.push('【鉴权】401/403：MOSS 所有接口使用 Authorization: Bearer <MOSS_API_KEY>（本测试台服务端已按此实现）。请检查 .env 中的 MOSS_API_KEY 是否正确、是否有对应权限，修改后需重启 node server.js。');
  }
  if (status === 404) {
    hints.push('【路径】404：检查端点路径与域名。MOSS 的域名是 api.mosi.cn（不是 moss.cn），端点在 /v1 路径下：/v1/audio/speech、/v1/audio/speech/speakers、/v1/audio/voice/generations、/v1/audio/voices。请确认 .env 中 MOSS_API_BASE_URL 配置正确。');
  }
  if (/voice not found/i.test(t)) {
    hints.push('【音色】"voice not found"：voice_id 无效。请检查：① 单音色/说话人的 voice_id 是否拼写正确（UUID）；② 该音色是否属于当前账号（跨账号音色不可用）；③ 音色克隆是否成功返回了 id；④ 文档示例音色可能已失效，请改用「我的音色」中的真实 ID。');
  }
  if (/text is required|input.{0,16}required/i.test(t)) {
    hints.push('【参数】"text is required"：单音色的 input 不能为空；对话合成中每个 segment 的 text 不能为空。请检查表单。');
  }
  if (/file|audio sample|multipart|upload/i.test(t) && state.scene === 'clone') {
    hints.push('【上传】克隆接口报文件相关错误：① 检查文件字段名是否与官方文档一致（服务端默认 file，可在 .env 中改 MOSS_CLONE_FILE_FIELD，改完重启）；② 检查文件大小与格式（建议 wav/mp3，原始大小 ≤ 20MB）；③ 确认参考音频时长与质量符合平台要求（建议 10 秒以上清晰人声）。');
  }
  if (/MOSS_API_KEY/.test(t)) {
    hints.push('【配置】服务端尚未配置 API Key：复制 .env.example 为 .env，填入 MOSS_API_KEY 后重启 node server.js。');
  }
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|getaddrinfo|certificate/i.test(t)) {
    hints.push('【网络】无法连接上游：检查本机网络与 DNS，或 .env 中 MOSS_API_BASE_URL 是否正确（默认 https://api.mosi.cn）。');
  }
  if (!hints.length && status >= 500) {
    hints.push(`【上游】MOSS 服务端错误（HTTP ${status}），可稍后重试；若持续出现请检查网络或 .env 配置。`);
  }
  return hints;
}

/* ==================== 健康检查 ==================== */

async function checkHealth() {
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    const d = await r.json();
    if (d && d.ok) {
      els.healthBar.className = 'health-bar ok';
      els.healthText.innerHTML =
        `本地服务正常 · API 基址 ${esc(d.baseUrl)} · API Key ` +
        (d.keyConfigured
          ? '<span class="ok-text">已配置</span>'
          : '<span class="bad-text">未配置（编辑 .env 后重启 node server.js）</span>');
      return;
    }
    throw new Error('ok = false');
  } catch (e) {
    els.healthBar.className = 'health-bar bad';
    els.healthText.textContent = '本地服务异常：' + ((e && e.message) || e);
  }
}

/* ==================== 初始化 ==================== */

function init() {
  els.tabs.forEach((b) => b.addEventListener('click', () => switchScene(b.dataset.scene)));

  els.textInput.addEventListener('input', () => { els.charCount.textContent = els.textInput.value.length + ' 字符'; updatePreview(); });
  els.voiceSelect.addEventListener('change', updatePreview);
  els.voiceManual.addEventListener('input', updatePreview);
  els.instructionInput.addEventListener('input', updatePreview);
  els.cloneName.addEventListener('input', updatePreview);
  els.cloneDesc.addEventListener('input', updatePreview);
  els.deliverySelect.addEventListener('change', updatePreview);
  els.formatSelect.addEventListener('change', updatePreview);
  els.streamCheck.addEventListener('change', updatePreview);

  els.generateBtn.addEventListener('click', generate);
  els.downloadBtn.addEventListener('click', downloadAudio);

  els.fileInput.addEventListener('change', (e) => {
    handleFile(e.target.files && e.target.files[0]);
    e.target.value = '';
  });
  els.recordBtn.addEventListener('click', () => (state.recording ? stopRecording() : startRecording()));
  els.clearSampleBtn.addEventListener('click', clearSample);
  els.compressBtn.addEventListener('click', compressSample);

  // 我的音色：手动添加表单
  els.toggleVoiceFormBtn.addEventListener('click', () => {
    els.voiceAddForm.hidden = !els.voiceAddForm.hidden;
    if (!els.voiceAddForm.hidden) els.addVoiceId.focus();
  });
  els.cancelVoiceBtn.addEventListener('click', () => { els.voiceAddForm.hidden = true; });
  els.saveVoiceBtn.addEventListener('click', () => {
    const id = els.addVoiceId.value.trim();
    if (!id) {
      els.addVoiceId.focus();
      return;
    }
    addVoice(id, els.addVoiceName.value, 'manual');
    els.addVoiceId.value = '';
    els.addVoiceName.value = '';
    els.voiceAddForm.hidden = true;
  });
  els.addVoiceId.addEventListener('keydown', (e) => { if (e.key === 'Enter') els.saveVoiceBtn.click(); });

  els.expertCheck.addEventListener('change', onExpertToggle);
  els.regenPreviewBtn.addEventListener('click', () => { els.previewArea.value = previewText(); });

  loadVoices();
  renderVoiceList();
  initDialogDefaults();
  refreshVoiceSelects();
  switchScene('speech');
  els.charCount.textContent = els.textInput.value.length + ' 字符';
  checkHealth();
  els.textInput.focus();
}

init();
