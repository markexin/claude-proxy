import { setTimeout as sleep } from 'node:timers/promises';
import { extractMessageNodes, pickReplyMessage } from './doubao-web.js';
import {
  extractStreamTextSince,
  isJunkAssistantReplyText,
} from './doubao-web-sse-capture.js';
import { resolveWebProvider } from './web-provider.js';
import { isChatgptGenerating } from './web-chatgpt-page.js';

/**
 * 按 provider 取等待参数；ChatGPT 默认更短 settle/poll（仍可用 config 覆盖）。
 * @param {Record<string, unknown>} cfg
 */
export function effectiveReplyTiming(cfg) {
  const provider = resolveWebProvider(cfg);
  const replyWait = Number(cfg.webReplyWaitMs ?? 90_000);
  let settle = Number(cfg.webReplySettleMs ?? 2000);
  let poll = Number(cfg.webReplyPollMs ?? 400);

  if (provider === 'chatgpt') {
    if (cfg.webReplySettleMs == null || cfg.webReplySettleMs === '') {
      settle = 500;
    }
    if (cfg.webReplyPollMs == null || cfg.webReplyPollMs === '') {
      poll = 120;
    }
  }

  return {
    replyWait,
    settle: Math.max(200, settle),
    poll: Math.max(80, poll),
  };
}

/**
 * DOM +（可选）SSE 增量合并等待：网页停止生成且正文短暂稳定后立即返回。
 * @param {import('playwright').Page} page
 * @param {Record<string, unknown>} cfg
 * @param {string} promptText
 * @param {ReturnType<import('./doubao-web-sse-capture.js').createSseCaptureState> | null} sseState
 * @param {number} startLineCount
 * @param {{ mark: (phase: string, extra?: string) => void } | null | undefined} [timingSink]
 */
export async function waitForReplyReady(
  page,
  cfg,
  promptText,
  sseState,
  startLineCount,
  timingSink,
) {
  const mark = timingSink?.mark;
  const promptTrim = String(promptText).trim();
  const provider = resolveWebProvider(cfg);
  const { replyWait, settle, poll } = effectiveReplyTiming(cfg);
  const deadline = Date.now() + replyWait;
  let stableAccum = 0;
  let prevText = /** @type {string | null} */ (null);
  let pollCount = 0;
  /** @type {Awaited<ReturnType<typeof extractMessageNodes>>} */
  let lastMessages = [];

  mark?.(
    'waitForReplyReady 开始',
    `provider=${provider} settle=${settle}ms poll=${poll}ms`,
  );

  while (Date.now() < deadline) {
    pollCount += 1;
    lastMessages = await extractMessageNodes(page, cfg);
    const domReply = pickReplyMessage(lastMessages, promptTrim);
    const domText = String(domReply?.text ?? '').trim();

    let sseText = '';
    if (sseState) {
      sseText = extractStreamTextSince(sseState, startLineCount, cfg).trim();
    }

    let candidate = '';
    if (domText && !isJunkAssistantReplyText(domText)) {
      candidate = domText;
    } else if (sseText && !isJunkAssistantReplyText(sseText)) {
      candidate = sseText;
    }

    const generating =
      provider === 'chatgpt' ? await isChatgptGenerating(page) : false;

    if (candidate && !generating) {
      if (candidate === prevText) {
        stableAccum += poll;
        if (stableAccum >= settle) {
          mark?.(
            'waitForReplyReady 稳定返回',
            `source=${domText === candidate ? 'dom' : 'sse'} len=${candidate.length} polls=${pollCount}`,
          );
          const replyMessage =
            domText && candidate === domText ? domReply : pickReplyMessage(lastMessages, promptTrim);
          return {
            messages: lastMessages,
            replyMessage,
            replyText: candidate,
            replyTextDom: domText,
            replyTextSse: sseText,
            source: domText && candidate === domText ? 'dom' : 'sse',
          };
        }
      } else {
        prevText = candidate;
        stableAccum = 0;
      }
    } else {
      if (candidate) prevText = candidate;
      stableAccum = 0;
    }

    await sleep(poll);
  }

  const domReply = pickReplyMessage(lastMessages, promptTrim);
  const domText = String(domReply?.text ?? '').trim();
  const sseText = sseState
    ? extractStreamTextSince(sseState, startLineCount, cfg).trim()
    : '';
  let replyText = domText || sseText;
  if (isJunkAssistantReplyText(replyText)) replyText = domText || sseText;
  mark?.('waitForReplyReady 超时尾部', `polls=${pollCount} len=${replyText.length}`);

  return {
    messages: lastMessages,
    replyMessage: domReply,
    replyText,
    replyTextDom: domText,
    replyTextSse: sseText,
    source: domText ? 'dom' : 'sse',
  };
}
