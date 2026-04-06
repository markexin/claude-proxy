/**
 * 页面内 hook：fetch(text/event-stream)、EventSource、WebSocket 文本帧（Claude 等常用 WS 而非 SSE）。
 */

import { setTimeout as sleep } from 'node:timers/promises';

/**
 * webSseUrlIncludes：`*` / `all` 匹配任意 URL；否则子串匹配；空则按 webChatUrl 推断主机名。
 * @param {Record<string, unknown>} cfg
 */
export function resolveSseUrlFilter(cfg) {
  const ex = String(cfg.webSseUrlIncludes ?? '').trim();
  if (ex === '*' || ex.toLowerCase() === 'all') return '*';
  if (ex) return ex;
  try {
    const h = new URL(String(cfg.webChatUrl || 'https://www.doubao.com')).hostname;
    if (h.endsWith('doubao.com')) return 'doubao.com';
    return h;
  } catch {
    return 'doubao.com';
  }
}

/**
 * @param {string} url
 * @param {string} filter
 */
function wsUrlMatches(url, filter) {
  const f = String(filter || '');
  if (!f || f === '*' || f.toLowerCase() === 'all') return true;
  return String(url).includes(f);
}

/**
 * @param {string | Buffer | ArrayBuffer} payload
 */
function payloadToText(payload) {
  if (typeof payload === 'string') return payload;
  if (Buffer.isBuffer(payload)) return payload.toString('utf8');
  if (payload instanceof ArrayBuffer) return Buffer.from(payload).toString('utf8');
  return String(payload ?? '');
}

/**
 * Claude / Anthropic SSE 里常见 JSON 行：提取 text_delta 便于合并成可读回答。
 * @param {string} s
 */
function normalizeAnthropicSseLine(s) {
  const t = String(s).trim();
  if (!t || t === '[DONE]') return '';
  if (!t.startsWith('{')) return t;
  try {
    const o = JSON.parse(t);
    if (
      o?.type === 'content_block_delta' &&
      o?.delta?.type === 'text_delta' &&
      typeof o.delta.text === 'string'
    ) {
      return o.delta.text;
    }
    const skip = new Set([
      'message_start',
      'content_block_start',
      'content_block_stop',
      'message_delta',
      'message_stop',
      'ping',
    ]);
    if (typeof o?.type === 'string' && skip.has(o.type)) return '';
    return t;
  } catch {
    return t;
  }
}

/**
 * 从单条 `data:` 后的 JSON 负载里取出助手增量文本（Anthropic 流）。
 * @param {string} payload
 */
function anthropicDataPayloadToAssistantDelta(payload) {
  const p = String(payload).trim();
  if (!p || p === '[DONE]' || !p.startsWith('{')) return '';
  try {
    const o = JSON.parse(p);
    if (
      o?.type === 'content_block_delta' &&
      o?.delta?.type === 'text_delta' &&
      typeof o.delta.text === 'string'
    ) {
      return o.delta.text;
    }
  } catch {
    // ignore
  }
  return '';
}

/**
 * 将缓冲区合并结果格式化为助手可读纯文本（去掉 event:/data: 外壳与元事件）。
 * @param {string} merged
 * @param {Record<string, unknown>} cfg
 */
export function formatSseCaptureForDisplay(merged, cfg = {}) {
  const m = String(merged);
  if (!m.trim()) return m;

  const wantPlain = cfg.webSseOutputPlainText !== false;
  if (!wantPlain) return m;

  const looksLikeAnthropicWire =
    /\bevent:\s*\S+/i.test(m) ||
    /^data:\s*\{/m.test(m) ||
    (m.includes('content_block_delta') && m.includes('data:'));

  const deltas = [];
  if (looksLikeAnthropicWire || /^data:\s*/m.test(m)) {
    for (const line of m.split(/\r?\n/)) {
      const dm = line.match(/^data:\s*(.+)$/);
      if (!dm) continue;
      const piece = anthropicDataPayloadToAssistantDelta(dm[1]);
      if (piece) deltas.push(piece);
    }
  }

  if (deltas.length > 0) {
    return deltas.join('').trim();
  }

  return m;
}

/**
 * 等待从 startLineCount 起新增的缓冲行经格式化后「内容稳定」（与 webReply* 配置一致，供 web-serve 与 DOM 并行等待）。
 * @param {ReturnType<typeof createSseCaptureState>} state
 * @param {number} startLineCount
 * @param {Record<string, unknown>} cfg
 * @param {{ mark: (phase: string, extra?: string) => void } | null | undefined} [timingSink] 与 `webServeTimingLog` 配合
 * @returns {Promise<string>}
 */
export async function waitForNewSseStable(state, startLineCount, cfg, timingSink) {
  const mark = timingSink?.mark;
  const tLog = cfg.webServeTimingLog === true;
  const replyWait = Number(cfg.webReplyWaitMs ?? 90_000);
  const settle = Number(cfg.webReplySettleMs ?? 2000);
  const poll = Number(cfg.webReplyPollMs ?? 400);
  const giveUpNoNewMs = Number(cfg.webSseGiveUpNoNewLinesMs ?? 6000);
  const needPollsNoNew = Math.max(1, Math.ceil(giveUpNoNewMs / poll));
  const deadline = Date.now() + replyWait;
  let stableAccum = 0;
  let prev = /** @type {string | null} */ (null);
  let noCompletionPolls = 0;
  let pollCount = 0;
  let sawCompletion = false;
  let sawText = false;
  /** @type {number | null} */
  let lastGrowLogAt = null;

  mark?.(
    'sse-wait 开始',
    `settle=${settle}ms poll=${poll}ms giveUpNoNew=${giveUpNoNewMs}ms startLines=${startLineCount}`,
  );

  while (Date.now() < deadline) {
    pollCount += 1;
    const snap = state.snapshot();
    const newCompletions = snap.lines
      .slice(startLineCount)
      .filter((l) => l.kind === 'cdp-completion');
    if (newCompletions.length === 0) {
      noCompletionPolls += 1;
      if (noCompletionPolls >= needPollsNoNew) {
        if (tLog) {
          console.log(
            `[web-serve timing] sse-wait 放弃：${giveUpNoNewMs}ms 内无新 cdp-completion（轮询 ${pollCount} 次）`,
          );
        }
        mark?.('sse-wait 结束(无 completion)', `polls=${pollCount}`);
        return '';
      }
    } else {
      if (!sawCompletion) {
        sawCompletion = true;
        mark?.(
          'sse-wait 首条 cdp-completion 入缓冲',
          `blocks=${newCompletions.length}`,
        );
      }
      noCompletionPolls = 0;
    }

    const lastBody =
      newCompletions.length > 0
        ? newCompletions[newCompletions.length - 1].body
        : '';
    const formatted = formatSseCaptureForDisplay(lastBody, cfg).trim();

    if (formatted) {
      if (!sawText) {
        sawText = true;
        mark?.('sse-wait 首段可展示正文', `len=${formatted.length}`);
      }
      if (formatted === prev) {
        stableAccum += poll;
        if (stableAccum >= settle) {
          mark?.(
            'sse-wait 稳定返回',
            `polls=${pollCount} len=${formatted.length} settleWindow=${settle}ms`,
          );
          return formatted;
        }
      } else {
        const now = Date.now();
        if (
          tLog &&
          (lastGrowLogAt === null || now - lastGrowLogAt >= 2000)
        ) {
          console.log(
            `[web-serve timing] sse-wait 正文仍在变 len=${formatted.length} poll=#${pollCount}`,
          );
          lastGrowLogAt = now;
        }
        prev = formatted;
        stableAccum = 0;
      }
    } else {
      prev = null;
      stableAccum = 0;
    }
    await sleep(poll);
  }

  const snap = state.snapshot();
  const newCompletions = snap.lines
    .slice(startLineCount)
    .filter((l) => l.kind === 'cdp-completion');
  const lastBody =
    newCompletions.length > 0
      ? newCompletions[newCompletions.length - 1].body
      : '';
  const tail = formatSseCaptureForDisplay(lastBody, cfg).trim();
  if (tLog) {
    console.log(
      `[web-serve timing] sse-wait 达上限 webReplyWaitMs=${replyWait}ms polls=${pollCount} tailLen=${tail.length}`,
    );
  }
  mark?.('sse-wait 结束(超时或尾部)', `polls=${pollCount}`);
  return tail;
}

/**
 * URL 是否应走 CDP 抓包（与 webSseUrlIncludes 一致，且 * 时排除常见噪音域名）。
 * @param {string} url
 * @param {string} filter
 */
function cdpUrlMatches(url, filter) {
  const u = String(url || '');
  if (!wsUrlMatches(u, filter)) return false;
  const f = String(filter || '');
  if (f === '*' || f.toLowerCase() === 'all') {
    if (u.includes('intercom.io') || u.includes('intercomcdn.com')) return false;
  }
  return true;
}

/**
 * @param {string} url
 */
function looksLikeSseOrCompletion(url) {
  const u = String(url);
  if (/\/completion(\?|$|\/)/i.test(u)) return true;
  if (u.includes('/v1/messages') && u.includes('stream')) return true;
  return false;
}

/** 正文是否像 Anthropic/Claude 流式对话（用于与 bootstrap 等 JSON 区分） */
function isAnthropicStyleStreamBody(bodyStr) {
  const t = String(bodyStr);
  return (
    t.includes('content_block_delta') ||
    /\bevent:\s*message_start\b/i.test(t) ||
    /\bevent:\s*content_block_delta\b/i.test(t)
  );
}

/**
 * CDP 单次 HTTP 响应体：对话 completion 记为 cdp-completion，其余记为 cdp-sse-side（不参与多轮 messages）。
 */
function kindForCdpFinishedBody(url, bodyStr) {
  if (looksLikeSseOrCompletion(url) || isAnthropicStyleStreamBody(bodyStr)) {
    return 'cdp-completion';
  }
  return 'cdp-sse-side';
}

export function normalizeMessageCapture(cfg, options = {}) {
  const v = String(
    options.messageCapture ??
      options.capture ??
      cfg.webMessageCaptureMode ??
      'dom',
  ).toLowerCase();
  if (v === 'sse' || v === 'network' || v === 'stream') return 'sse';
  return 'dom';
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function createSseCaptureState(cfg) {
  const max = Number(cfg.webSseMaxBufferLines ?? 2000);
  /** @type {{ t: number; url: string; kind: string; body: string }[]} */
  const lines = [];

  return {
    /**
     * @param {{ kind?: string; line?: string; data?: string; url?: string; raw?: boolean }} payload
     * `raw: true` 时跳过 Anthropic 行规范化（用于整段 JSON/非 data: 格式的 HTTP 体）。
     */
    pushFromPage(payload) {
      let body = String(payload.line ?? payload.data ?? '').trim();
      if (!body) return;
      const bypassNormalize = payload.raw === true;
      if (!bypassNormalize && cfg.webSseNormalizeAnthropic !== false) {
        const n = normalizeAnthropicSseLine(body);
        if (!n) return;
        body = n;
      }
      lines.push({
        t: Date.now(),
        url: String(payload.url ?? ''),
        kind: String(payload.kind ?? 'sse'),
        body,
      });
      while (lines.length > max) lines.shift();
    },
    snapshot() {
      return {
        lines: [...lines],
        mergedText: lines.map((l) => l.body).join('\n'),
      };
    },
    /** 与 extractMessageNodes 结构对齐，便于 web-watch 共用输出格式 */
    toMessageNodesForWatch() {
      const { lines: allLines, mergedText } = this.snapshot();
      const turnKinds = new Set(['cdp-completion', 'cdp-http-body']);
      const turnLines = allLines.filter((l) => turnKinds.has(l.kind));
      const turnsMode = String(cfg.webSseWatchTurns ?? 'all').toLowerCase();

      if (turnLines.length === 0) {
        const text = formatSseCaptureForDisplay(mergedText, cfg).trim();
        /** @type {Record<string, unknown>} */
        const node = {
          index: 0,
          testId: 'sse_capture',
          text,
          htmlLength: 0,
          html: '',
        };
        if (cfg.webSseIncludeRawWire === true && text !== mergedText) {
          node.sseRaw = mergedText;
        }
        return [node];
      }

      let segments = [...turnLines];
      if (turnsMode === 'latest') {
        segments = segments.slice(-1);
      } else if (turnsMode === 'merged') {
        const mergedTurn = turnLines.map((l) => l.body).join('\n');
        const text = formatSseCaptureForDisplay(mergedTurn, cfg).trim();
        /** @type {Record<string, unknown>} */
        const node = {
          index: 0,
          testId: 'sse_capture',
          text,
          htmlLength: 0,
          html: '',
        };
        if (cfg.webSseIncludeRawWire === true) {
          node.sseRaw = mergedTurn;
        }
        return [node];
      }

      return segments.map((line, index) => {
        const text = formatSseCaptureForDisplay(line.body, cfg).trim();
        /** @type {Record<string, unknown>} */
        const node = {
          index,
          testId: 'sse_capture',
          text,
          htmlLength: 0,
          html: '',
        };
        if (line.url) node.sseUrl = line.url;
        if (cfg.webSseIncludeRawWire === true && text !== line.body) {
          node.sseRaw = line.body;
        }
        return node;
      });
    },
  };
}

/**
 * @param {import('playwright').Page} page
 * @param {ReturnType<typeof createSseCaptureState>} state
 * @param {Record<string, unknown>} cfg
 */
/**
 * 在浏览器端安装 fetch/EventSource hook；须可单独序列化给 addInitScript / evaluate。
 * @param {{ filter: string }} arg
 */
function browserInstallSseHooks(arg) {
  const filter = String(arg?.filter ?? '');
  if (/** @type {Window & { __doubaoSseHooksInstalled?: boolean }} */ (window).__doubaoSseHooksInstalled) {
    return;
  }
  /** @type {Window & { __doubaoSseHooksInstalled?: boolean }} */ (window).__doubaoSseHooksInstalled = true;

  const f = filter;
  const matches = (/** @type {string} */ url) => {
    if (!f || f === '*' || f.toLowerCase() === 'all') return true;
    return String(url).includes(f);
  };

  const looksCompletionStream = (/** @type {string} */ urlStr) =>
    /\/completion(\?|$|\/)/i.test(urlStr);

  const shouldReadSseBody = (/** @type {string} */ urlStr, /** @type {string} */ contentType) => {
    const ct = contentType.toLowerCase();
    if (ct.includes('event-stream') || ct.includes('text/stream')) return true;
    return looksCompletionStream(urlStr);
  };

  const resolveFetchUrl = (/** @type {RequestInfo | URL} */ input) => {
    if (typeof input === 'string') return input;
    if (typeof URL !== 'undefined' && input instanceof URL) return input.href;
    if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
    return '';
  };

  const push = (/** @type {string} */ kind, /** @type {string} */ line, /** @type {string} */ url) => {
    try {
      window.__doubaoSseCapturePush({ kind, line, url: String(url) });
    } catch {
      // ignore
    }
  };

  const OrigES = window.EventSource;
  if (typeof OrigES === 'function') {
    function WrappedEventSource(
      /** @type {string | URL} */ url,
      /** @type {EventSourceInit | undefined} */ evInit,
    ) {
      const u = typeof url === 'string' ? url : url.href;
      const es = new OrigES(url, evInit);
      try {
        es.addEventListener('message', (ev) => {
          if (matches(u)) push('eventsource-message', ev.data, u);
        });
      } catch {
        // ignore
      }
      return es;
    }
    WrappedEventSource.prototype = OrigES.prototype;
    window.EventSource = /** @type {typeof EventSource} */ (WrappedEventSource);
  }

  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const res = await origFetch(input, init);
    try {
      const url = resolveFetchUrl(input);
      if (!url || !matches(url)) return res;

      const ct = res.headers.get('content-type') || '';
      if (!shouldReadSseBody(url, ct)) return res;

      const clone = res.clone();
      const buf = { v: '' };
      (async () => {
        try {
          const reader = clone.body?.getReader?.();
          if (!reader) return;
          const dec = new TextDecoder();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf.v += dec.decode(value, { stream: true });
            const parts = buf.v.split('\n');
            buf.v = parts.pop() || '';
            for (const line of parts) {
              const m = line.match(/^data:\s*(.*)$/);
              if (m) push('fetch-sse', m[1], url);
            }
          }
          const tail = buf.v.trim();
          if (tail) {
            const m = tail.match(/^data:\s*(.*)$/m);
            if (m) push('fetch-sse-tail', m[1], url);
          }
        } catch {
          // ignore
        }
      })();
    } catch {
      // ignore
    }
    return res;
  };
}

export async function installSsePageHooks(page, state, cfg) {
  const urlFilter = resolveSseUrlFilter(cfg);
  const debug = cfg.webSseDebug === true;

  // CDP/Worker 场景下页面内 hook 不到 WebSocket；用 Playwright 协议层监听（需连接后再开的新 WS，见 README）
  page.on('websocket', (ws) => {
    const u = ws.url();
    if (!wsUrlMatches(u, urlFilter)) return;
    if (debug) {
      console.error(`[sse] Playwright WebSocket opened: ${u}`);
    }
    ws.on('framereceived', (event) => {
      const text = payloadToText(event.payload).trim();
      if (!text) return;
      const line =
        text.length > 12000 ? `${text.slice(0, 12000)}…[truncated]` : text;
      try {
        state.pushFromPage({ kind: 'pw-ws-rx', line, url: u });
      } catch {
        // ignore
      }
    });
  });

  await page.exposeFunction('__doubaoSseCapturePush', (payload) => {
    try {
      if (payload && typeof payload === 'object') {
        state.pushFromPage(
          /** @type {{ kind?: string; line?: string; data?: string; url?: string }} */ (payload),
        );
      }
    } catch {
      // ignore
    }
  });

  const hookArg = { filter: urlFilter };
  await page.addInitScript(browserInstallSseHooks, hookArg);

  for (const frame of page.frames()) {
    try {
      await frame.evaluate(browserInstallSseHooks, hookArg);
    } catch {
      // 跨域 iframe 等无法注入
    }
  }

  await installCdpStreamCapture(page, state, cfg, urlFilter, debug);
}

/**
 * CDP Network：绕过页面内 hook（Service Worker、预绑定 fetch 等），抓取 WebSocket 帧与请求结束后的完整 SSE 体。
 * @param {import('playwright').Page} page
 * @param {ReturnType<typeof createSseCaptureState>} state
 * @param {Record<string, unknown>} cfg
 * @param {string} urlFilter
 * @param {boolean} debug
 */
async function installCdpStreamCapture(page, state, cfg, urlFilter, debug) {
  if (cfg.webSseCdpNetwork === false) return;

  /** @type {import('playwright').CDPSession | null} */
  let client = null;
  try {
    client = await page.context().newCDPSession(page);
    await client.send('Network.enable', {
      maxTotalBufferSize: 100_000_000,
      maxResourceBufferSize: 50_000_000,
    });
  } catch (e) {
    if (debug) {
      console.error('[sse] CDP Network.enable 失败:', e instanceof Error ? e.message : e);
    }
    return;
  }

  /** @type {Map<string, string>} */
  const wsRequestToUrl = new Map();
  /** @type {Map<string, string>} */
  const requestIdToUrl = new Map();
  /** @type {Set<string>} */
  const sseTracked = new Set();
  /** responseReceived → loadingFinished / getResponseBody 间隔用 */
  /** @type {Map<string, number>} */
  const cdpSseResponseT0 = new Map();

  client.on('Network.webSocketCreated', (e) => {
    const url = e.url || '';
    if (!url || !cdpUrlMatches(url, urlFilter)) return;
    wsRequestToUrl.set(e.requestId, url);
    if (debug) console.error(`[sse] CDP WebSocket: ${url}`);
  });

  client.on('Network.webSocketClosed', (e) => {
    wsRequestToUrl.delete(e.requestId);
  });

  client.on('Network.webSocketFrameReceived', (e) => {
    const url = wsRequestToUrl.get(e.requestId);
    if (!url) return;
    const op = e.response?.opcode;
    let raw = String(e.response?.payloadData ?? '');
    if (op === 2) {
      try {
        raw = Buffer.from(raw, 'base64').toString('utf8');
      } catch {
        return;
      }
    } else if (op !== 1) {
      return;
    }
    const text = raw.trim();
    if (!text) return;
    const line =
      text.length > 12000 ? `${text.slice(0, 12000)}…[truncated]` : text;
    try {
      state.pushFromPage({ kind: 'cdp-ws-rx', line, url });
    } catch {
      // ignore
    }
  });

  client.on('Network.responseReceived', (e) => {
    const url = e.response?.url || '';
    if (!cdpUrlMatches(url, urlFilter)) return;
    const mime = String(e.response?.mimeType || '').toLowerCase();
    const sseMime =
      mime.includes('event-stream') ||
      mime.includes('text/stream') ||
      mime.includes('x-ndjson');
    if (!sseMime && !looksLikeSseOrCompletion(url)) return;
    requestIdToUrl.set(e.requestId, url);
    sseTracked.add(e.requestId);
    if (cfg.webServeTimingLog === true) {
      cdpSseResponseT0.set(e.requestId, Date.now());
    }
  });

  client.on('Network.loadingFailed', (e) => {
    sseTracked.delete(e.requestId);
    requestIdToUrl.delete(e.requestId);
    cdpSseResponseT0.delete(e.requestId);
  });

  client.on('Network.loadingFinished', async (e) => {
    if (!sseTracked.delete(e.requestId)) return;
    const url = requestIdToUrl.get(e.requestId) || '';
    requestIdToUrl.delete(e.requestId);
    const respT0 = cdpSseResponseT0.get(e.requestId);
    cdpSseResponseT0.delete(e.requestId);
    try {
      const gb0 = Date.now();
      const res = await client.send('Network.getResponseBody', {
        requestId: e.requestId,
      });
      const gb1 = Date.now();
      const bodyStr = res.base64Encoded
        ? Buffer.from(res.body, 'base64').toString('utf8')
        : String(res.body || '');
      // 每个 HTTP 响应只推一条，避免按 data: 拆行后多轮对话混成一段再解析
      const trimmed = bodyStr.trim();
      if (trimmed) {
        const max = Number(cfg.webSseCdpBodyMaxChars ?? 120_000);
        const line =
          trimmed.length > max
            ? `${trimmed.slice(0, max)}…[truncated]`
            : trimmed;
        const kind = kindForCdpFinishedBody(url, trimmed);
        try {
          state.pushFromPage({
            kind,
            line,
            url,
            raw: true,
          });
        } catch {
          // ignore
        }
      }
      if (cfg.webServeTimingLog === true && bodyStr.length > 0) {
        const kindLog = trimmed
          ? kindForCdpFinishedBody(url, trimmed)
          : 'empty';
        const sinceRx =
          respT0 != null ? `${gb1 - respT0}ms` : 'n/a';
        console.log(
          `[web-serve timing] cdp SSE 体入缓冲 | getResponseBody ${gb1 - gb0}ms | 自 responseReceived ${sinceRx} | ${bodyStr.length}b kind=${kindLog} | ${url.slice(0, 88)}`,
        );
      }
      if (debug && bodyStr.length > 0) {
        console.error(
          `[sse] CDP 已拉取 SSE 响应体 ${bodyStr.length} 字节: ${url.slice(0, 100)}`,
        );
      }
    } catch {
      // 流未结束、未缓存或不可读时常见
    }
  });
}
