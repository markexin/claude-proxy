import http from 'node:http';
import { randomBytes } from 'node:crypto';
import {
  attachDoubaoAutomation,
  detachDoubaoAutomation,
} from './doubao-web-watch.js';
import {
  createSseCaptureState,
  installSsePageHooks,
  normalizeMessageCapture,
  waitForNewSseStable,
} from './doubao-web-sse-capture.js';
import {
  readMessagesSnapshotOnPage,
  sendPromptAndCollectOnPage,
  sendPromptOnlyOnPage,
  waitForAssistantReplyStable,
  pickReplyMessage,
  sessionHint,
  extractMessageNodes,
} from './doubao-web.js';

/** UTF-8 字节粗算 token（约 4 字节/token，与多数本地估算一致） */
function roughTokenCount(text) {
  return Math.max(0, Math.ceil(Buffer.byteLength(String(text), 'utf8') / 4));
}

/**
 * `config.json` 设 `webServeTimingLog: true` 时用 console.log 打阶段耗时（累计 + 距上一段）。
 * @param {Record<string, unknown>} cfg
 * @returns {{ mark: (phase: string, extra?: string) => void } | null}
 */
function createTimingSink(cfg) {
  if (cfg.webServeTimingLog !== true) return null;
  const t0 = Date.now();
  let last = t0;
  let step = 0;
  return {
    mark(phase, extra = '') {
      const now = Date.now();
      const total = now - t0;
      const delta = now - last;
      step += 1;
      console.log(
        `[web-serve timing] #${step} ${phase} | 累计 ${total}ms | 距上段 +${delta}ms${extra ? ` | ${extra}` : ''}`,
      );
      last = now;
    },
  };
}

/**
 * 支持旧字段 prompt/text 与 OpenAI 风格 messages[]。
 * @param {unknown} j
 */
function extractChatPromptAndModel(j) {
  if (!j || typeof j !== 'object') {
    return { promptText: '', modelFromRequest: '' };
  }
  const o = /** @type {Record<string, unknown>} */ (j);
  const modelFromRequest =
    typeof o.model === 'string' ? o.model.trim() : '';

  const direct = String(
    o.prompt ?? o.text ?? o.message ?? o.content ?? '',
  ).trim();
  if (direct) {
    return { promptText: direct, modelFromRequest };
  }

  const msgs = o.messages;
  if (!Array.isArray(msgs)) {
    return { promptText: '', modelFromRequest };
  }
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || typeof m !== 'object') continue;
    const role = String(
      /** @type {Record<string, unknown>} */ (m).role ?? '',
    );
    if (role !== 'user') continue;
    const c = /** @type {Record<string, unknown>} */ (m).content;
    if (typeof c === 'string') {
      return { promptText: c.trim(), modelFromRequest };
    }
    if (Array.isArray(c)) {
      const texts = [];
      for (const part of c) {
        if (!part || typeof part !== 'object') continue;
        const p = /** @type {Record<string, unknown>} */ (part);
        if (p.type === 'text' && typeof p.text === 'string') {
          texts.push(p.text);
        }
      }
      const joined = texts.join('\n').trim();
      if (joined) return { promptText: joined, modelFromRequest };
    }
  }
  return { promptText: '', modelFromRequest };
}

function useOpenAiChatResponseShape(cfg) {
  const v = String(cfg.webServeChatResponseFormat ?? 'openai').toLowerCase();
  return v === 'openai' || v === 'siliconflow';
}

/**
 * @param {Record<string, unknown>} legacy
 * @param {string} promptText
 * @param {string} modelFromRequest
 * @param {Record<string, unknown>} cfg
 */
function toOpenAiChatCompletion(legacy, promptText, modelFromRequest, cfg) {
  const content = String(
    legacy.replyText ?? legacy.replyTextSse ?? legacy.replyTextDom ?? '',
  ).trim();
  const model = String(
    modelFromRequest || cfg.webOpenAiCompatModel || 'local/web-bridge',
  ).trim();
  const pt = roughTokenCount(promptText);
  const ct = roughTokenCount(content);
  return {
    id: randomBytes(16).toString('hex'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: pt,
      completion_tokens: ct,
      total_tokens: pt + ct,
      completion_tokens_details: { reasoning_tokens: 0 },
      prompt_tokens_details: { cached_tokens: 0 },
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: pt,
    },
    system_fingerprint: '',
  };
}

/**
 * OpenAI 流式：`stream: true` 时返回 `text/event-stream`（Cursor 等默认走流式）。
 * 正文在本地整段生成后按块写出，非真·流式，但协议兼容。
 * @param {import('node:http').ServerResponse} res
 * @param {Record<string, string | string[] | undefined>} corsFlat
 * @param {Record<string, unknown>} legacy
 * @param {string} promptText
 * @param {string} modelFromRequest
 * @param {Record<string, unknown>} cfg
 */
function writeOpenAiChatCompletionStream(
  res,
  corsFlat,
  legacy,
  promptText,
  modelFromRequest,
  cfg,
) {
  const completion = toOpenAiChatCompletion(
    legacy,
    promptText,
    modelFromRequest,
    cfg,
  );
  const { id, created, model, choices, usage } = completion;
  const content = String(choices[0]?.message?.content ?? '');

  const headers = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...corsFlat,
  };
  res.writeHead(200, headers);

  const send = (/** @type {Record<string, unknown>} */ chunk) => {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  send({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  });

  const chunkChars = Math.max(
    16,
    Math.min(2000, Number(cfg.webServeStreamChunkChars ?? 160)),
  );
  for (let i = 0; i < content.length; i += chunkChars) {
    send({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { content: content.slice(i, i + chunkChars) },
          finish_reason: null,
        },
      ],
    });
  }

  send({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage,
  });
  res.write('data: [DONE]\n\n');
  res.end();
}

/** @param {string} message */
function openAiStyleError(message, type = 'invalid_request_error') {
  return {
    error: {
      message,
      type,
      param: null,
      code: null,
    },
  };
}

/**
 * OpenAI 兼容 `GET /v1/models`。
 * 列表来自 `webOpenAiCompatModels`（字符串数组）；未配置时用 `webOpenAiCompatModel` 一项。
 * @param {Record<string, unknown>} cfg
 */
function openAiModelsListResponse(cfg) {
  const raw = cfg.webOpenAiCompatModels;
  /** @type {string[]} */
  let ids = [];
  if (Array.isArray(raw)) {
    ids = raw
      .map((x) => String(x).trim())
      .filter((id) => id.length > 0);
  }
  if (ids.length === 0) {
    const one = String(cfg.webOpenAiCompatModel || 'local/web-bridge').trim();
    if (one) ids = [one];
  }
  const seen = new Set();
  ids = ids.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const created = Math.floor(Date.now() / 1000);
  return {
    object: 'list',
    data: ids.map((id) => ({
      id,
      object: 'model',
      created,
      owned_by: 'local',
    })),
  };
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} obj
 * @param {Record<string, string | string[] | undefined>} [extraHeaders]
 */
function json(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(body);
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [maxBytes]
 */
function readBody(req, maxBytes = 2_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * @param {Record<string, unknown>} cfg
 */
function corsHeaders(cfg) {
  const origin = cfg.webServeCorsOrigin;
  if (typeof origin !== 'string' || !origin.trim()) return {};
  return {
    'Access-Control-Allow-Origin': origin.trim(),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {string} cwd
 * @param {{
 *   mode?: string;
 *   cdpUrl?: string;
 *   host?: string;
 *   port?: number;
 *   messageCapture?: string;
 *   capture?: string;
 * }} [options]
 */
export async function startWebServe(cfg, cwd, options = {}) {
  const host = String(options.host ?? cfg.webServeHost ?? '127.0.0.1');
  const port = Number(options.port ?? cfg.webServePort ?? 3840);
  const envToken = process.env.DOUBAO_WEB_SERVE_TOKEN?.trim() ?? '';
  const cfgToken =
    typeof cfg.webServeToken === 'string' ? cfg.webServeToken.trim() : '';
  const token = envToken || cfgToken;

  const att = await attachDoubaoAutomation(cfg, cwd, options);
  const { page } = att;

  const msgCapture = normalizeMessageCapture(cfg, options);
  /** @type {ReturnType<typeof createSseCaptureState> | null} */
  let sseState = null;
  if (msgCapture === 'sse') {
    sseState = createSseCaptureState(cfg);
    await installSsePageHooks(page, sseState, cfg);
    console.error(
      '[web-serve] GET /messages：SSE/CDP 缓冲；POST /chat：默认先等 SSE/CDP 稳定再返回（快），无正文再回退 DOM 等待（webServePreferSseReply:false 可改回先 DOM）',
    );
  }
  if (cfg.webServeTimingLog === true) {
    console.log(
      '[web-serve] webServeTimingLog=true：将用 console.log 输出 [web-serve timing]（含 CDP getResponseBody 与 sse-wait 各段）',
    );
  }

  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  /**
   * @template T
   * @param {() => Promise<T>} fn
   */
  function runExclusive(fn) {
    const result = queue.then(() => fn());
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  const server = http.createServer(async (req, res) => {
    const cors = corsHeaders(cfg);
    Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const openAiShapeGlobal = useOpenAiChatResponseShape(cfg);
    const base = `http://${req.headers.host || `${host}:${port}`}`;
    let url;
    try {
      url = new URL(req.url || '/', base);
    } catch {
      json(
        res,
        400,
        openAiShapeGlobal
          ? openAiStyleError('无效的 URL')
          : { ok: false, error: '无效的 URL' },
        cors,
      );
      return;
    }
    if (token) {
      const auth = String(req.headers.authorization || '');
      const qTok = url.searchParams.get('token');
      const ok =
        auth === `Bearer ${token}` || (qTok != null && qTok === token);
      if (!ok) {
        json(
          res,
          401,
          openAiShapeGlobal
            ? openAiStyleError(
                '未授权：请提供正确 token（Authorization: Bearer … 或 ?token=）',
                'invalid_request_error',
              )
            : {
                ok: false,
                error:
                  '未授权：请提供正确 token（Authorization: Bearer … 或 ?token=）',
              },
          cors,
        );
        return;
      }
    }

    try {
      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
        json(
          res,
          200,
          {
            ok: true,
            service: 'doubao-web-serve',
            messageCapture: msgCapture,
            routes: {
              'POST /chat 或 /v1/chat/completions':
                (useOpenAiChatResponseShape(cfg)
                  ? 'OpenAI 兼容 chat.completion JSON（默认）；'
                  : '内部 legacy JSON；') +
                (msgCapture === 'sse'
                  ? ' SSE 模式先等 CDP 再返回'
                  : ' DOM 发送与抓取'),
              'GET /v1/models': '模型列表；GET /v1/models/{id} 查询单项',
              'POST /v1/chat/completions stream': '默认 SSE（stream 省略时由 webServeAssumeOpenAiStream 控制）；显式 stream:false 返回整段 JSON',
              'GET /messages':
                msgCapture === 'sse'
                  ? 'SSE/CDP 缓冲 + 格式化 messages（不发送）'
                  : '读取当前会话 DOM，不发送',
            },
          },
          cors,
        );
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/models') {
        json(res, 200, openAiModelsListResponse(cfg), cors);
        return;
      }

      if (
        req.method === 'GET' &&
        url.pathname.startsWith('/v1/models/') &&
        url.pathname.length > '/v1/models/'.length
      ) {
        const mid = decodeURIComponent(
          url.pathname.slice('/v1/models/'.length),
        ).trim();
        if (!mid || mid.includes('..')) {
          json(
            res,
            404,
            openAiShapeGlobal
              ? openAiStyleError('模型不存在', 'invalid_request_error')
              : { ok: false, error: '模型不存在' },
            cors,
          );
          return;
        }
        const list = openAiModelsListResponse(cfg);
        const hit = list.data.find((m) => m.id === mid);
        if (!hit) {
          json(
            res,
            404,
            openAiShapeGlobal
              ? openAiStyleError(`模型不存在: ${mid}`, 'invalid_request_error')
              : { ok: false, error: `模型不存在: ${mid}` },
            cors,
          );
          return;
        }
        json(res, 200, hit, cors);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/messages') {
        const out = await runExclusive(async () => {
          if (sseState) {
            const snap = sseState.snapshot();
            const messages = sseState.toMessageNodesForWatch();
            return {
              capture: 'sse',
              messages,
              count: messages.length,
              sseLineCount: snap.lines.length,
              sseLines: snap.lines.slice(-80),
              mergedSseText: snap.mergedText,
              diagnostics: { source: 'web-serve', finalUrl: page.url() },
              hint:
                'messages[].text 已为格式化助手正文；mergedSseText 为原始合并。含 CDP 抓包，站点升级时若为空可调 webSseUrlIncludes / DOM 模式。',
            };
          }
          const dom = await readMessagesSnapshotOnPage(page, cfg, {
            source: 'web-serve',
          });
          return { ...dom, capture: 'dom' };
        });
        json(res, 200, { ok: true, step: 'messages', ...out }, cors);
        return;
      }

      if (
        req.method === 'POST' &&
        (url.pathname === '/chat' || url.pathname === '/v1/chat/completions')
      ) {
        const raw = await readBody(req);
        let promptText = '';
        let modelFromRequest = '';
        let wantStream = false;
        const ct = String(req.headers['content-type'] || '')
          .split(';')[0]
          .trim()
          .toLowerCase();
        const v1Completions = url.pathname === '/v1/chat/completions';

        if (ct === 'application/json' || ct === '') {
          let j;
          try {
            j = JSON.parse(raw.toString('utf8') || '{}');
          } catch {
            json(
              res,
              400,
              openAiShapeGlobal
                ? openAiStyleError('JSON 无法解析')
                : { ok: false, error: 'JSON 无法解析' },
              cors,
            );
            return;
          }
          const ex = extractChatPromptAndModel(j);
          promptText = ex.promptText;
          modelFromRequest = ex.modelFromRequest;
          if (j && typeof j === 'object') {
            const jo = /** @type {Record<string, unknown>} */ (j);
            const st = jo.stream;
            const s = String(st ?? '').toLowerCase();
            if (st === false || s === 'false') {
              wantStream = false;
            } else if (st === true || s === 'true') {
              wantStream = true;
            } else if (
              v1Completions &&
              openAiShapeGlobal &&
              cfg.webServeAssumeOpenAiStream !== false
            ) {
              // Cursor 等对 /v1/chat/completions 常默认流式且不显式传 stream
              wantStream = true;
            }
          }
        } else if (ct === 'text/plain') {
          promptText = raw.toString('utf8').trim();
        } else {
          json(
            res,
            415,
            openAiShapeGlobal
              ? openAiStyleError(
                  '仅支持 Content-Type: application/json 或 text/plain',
                  'invalid_request_error',
                )
              : { ok: false, error: '仅支持 Content-Type: application/json 或 text/plain' },
            cors,
          );
          return;
        }

        if (!promptText) {
          json(
            res,
            400,
            openAiShapeGlobal
              ? openAiStyleError(
                  '缺少用户消息：请在 JSON 中提供 prompt / text / message / content，或 OpenAI 风格 messages（含 user 角色）',
                )
              : {
                  ok: false,
                  error:
                    '缺少正文：JSON 使用字段 prompt / text / message / content，或 messages[].user.content，或发送 text/plain',
                },
            cors,
          );
          return;
        }

        const out = await runExclusive(async () => {
          if (sseState) {
            const timingSink = createTimingSink(cfg);
            timingSink?.mark('请求已出队（互斥开始）', `sseLines=${sseState.snapshot().lines.length}`);
            const startLc = sseState.snapshot().lines.length;
            const replyWait = Number(cfg.webReplyWaitMs ?? 90_000);
            const settle = Number(cfg.webReplySettleMs ?? 2000);
            const poll = Number(cfg.webReplyPollMs ?? 400);
            const preferSse = cfg.webServePreferSseReply !== false;

            const { before, diagnosticsBase } = await sendPromptOnlyOnPage(
              page,
              cfg,
              promptText,
              { source: 'web-serve' },
            );
            timingSink?.mark('sendPromptOnlyOnPage 完成', `before=${before}`);

            const t0 = Date.now();
            /** @type {Awaited<ReturnType<typeof extractMessageNodes>>} */
            let messages;
            /** @type {string} */
            let replyTextSse;

            if (preferSse) {
              replyTextSse = await waitForNewSseStable(
                sseState,
                startLc,
                cfg,
                timingSink,
              );
              timingSink?.mark('waitForNewSseStable 结束（prefer SSE）');
              messages = await extractMessageNodes(page, cfg);
              timingSink?.mark('extractMessageNodes 完成');
              if (!String(replyTextSse || '').trim()) {
                const elapsed = Date.now() - t0;
                const domBudget = Math.max(5000, replyWait - elapsed);
                timingSink?.mark(
                  'DOM 兜底 waitForAssistantReplyStable 开始',
                  `budget=${domBudget}ms`,
                );
                messages = await waitForAssistantReplyStable(
                  page,
                  cfg,
                  promptText,
                  domBudget,
                  settle,
                  poll,
                );
                timingSink?.mark('DOM 兜底 waitForAssistantReplyStable 结束');
              }
            } else {
              timingSink?.mark('先 DOM waitForAssistantReplyStable 开始');
              messages = await waitForAssistantReplyStable(
                page,
                cfg,
                promptText,
                replyWait,
                settle,
                poll,
              );
              timingSink?.mark('先 DOM waitForAssistantReplyStable 结束');
              const elapsed = Date.now() - t0;
              const sseBudget = Math.max(5000, replyWait - elapsed);
              replyTextSse = await waitForNewSseStable(
                sseState,
                startLc,
                {
                  ...cfg,
                  webReplyWaitMs: sseBudget,
                },
                timingSink,
              );
              timingSink?.mark('waitForNewSseStable 结束（SSE 余量）');
            }

            timingSink?.mark('组装 diagnostics / 选 reply 前');
            const promptTrim = String(promptText).trim();
            const replyMessage = pickReplyMessage(messages, promptTrim);
            const lastDom = messages.length ? messages[messages.length - 1] : null;
            const bodySnippet = await page
              .evaluate(() => document.body?.innerText?.slice(0, 800) || '')
              .catch(() => '');
            let hint = sessionHint(bodySnippet, page.url(), cfg);
            if (!replyMessage && messages.length > before) {
              const extra =
                '已出现新气泡但未解析到与提问不同的回复：可能页面结构变化，或回复与提问全文相同。可调大 webReplyWaitMs / webReplySettleMs。';
              hint = hint ? `${hint} ${extra}` : extra;
            }

            const replyTextDom = replyMessage
              ? String(replyMessage.text ?? '').trim()
              : '';
            const sseTrim = String(replyTextSse || '').trim();
            const replyText = sseTrim || replyTextDom;

            return {
              capture: 'sse',
              promptChars: promptText.length,
              messageNodesBefore: before,
              messageNodesAfter: messages.length,
              messages,
              replyMessage,
              replyText,
              replyTextSse: sseTrim,
              replyTextDom,
              lastMessage: replyMessage ?? lastDom,
              lastDomMessage: lastDom,
              diagnostics: { ...diagnosticsBase, finalUrl: page.url() },
              hint,
            };
          }

          return sendPromptAndCollectOnPage(page, cfg, promptText, {
            source: 'web-serve',
          }).then((domOut) => ({ ...domOut, capture: 'dom' }));
        });
        if (openAiShapeGlobal && wantStream) {
          writeOpenAiChatCompletionStream(
            res,
            cors,
            /** @type {Record<string, unknown>} */ (out),
            promptText,
            modelFromRequest,
            cfg,
          );
        } else if (openAiShapeGlobal) {
          json(
            res,
            200,
            toOpenAiChatCompletion(
              /** @type {Record<string, unknown>} */ (out),
              promptText,
              modelFromRequest,
              cfg,
            ),
            cors,
          );
        } else {
          json(res, 200, { ok: true, step: 'chat', ...out }, cors);
        }
        return;
      }

      json(
        res,
        404,
        openAiShapeGlobal
          ? openAiStyleError('未找到路由')
          : { ok: false, error: '未找到路由' },
        cors,
      );
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      json(
        res,
        500,
        useOpenAiChatResponseShape(cfg)
          ? openAiStyleError(err, 'api_error')
          : { ok: false, error: err },
        cors,
      );
    }
  });

  await new Promise((resolve, reject) => {
    server.listen(port, host, () => resolve(undefined));
    server.on('error', reject);
  });

  console.error(`[web-serve] 监听 http://${host}:${port}`);
  console.error(
    `[web-serve] 快照模式: ${msgCapture}（webMessageCaptureMode 或 --message-capture dom|sse）`,
  );
  console.error(
    '[web-serve] POST /chat 或 /v1/chat/completions ；GET /v1/models ；GET /messages ；GET /health ；Ctrl+C 退出',
  );
  if (token) {
    console.error('[web-serve] 已启用 token（环境变量 DOUBAO_WEB_SERVE_TOKEN 或 config webServeToken）');
  }

  const shutdown = async () => {
    console.error('\n[web-serve] 正在关闭…');
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    await detachDoubaoAutomation(att);
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  await new Promise(() => {});
}
