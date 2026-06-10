import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  effectiveMessageSelector,
  fillComposerForProvider,
  findComposerForProvider,
  sessionHintForProvider,
  submitComposerForProvider,
  waitChatReadyForProvider,
} from './web-provider.js';

const DEFAULT_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function parseCookiePairs(header) {
  const pairs = [];
  for (const part of header.split(';')) {
    const s = part.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i <= 0) continue;
    const name = s.slice(0, i).trim();
    let value = s.slice(i + 1).trim();
    if (!name) continue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    pairs.push({ name, value });
  }
  return pairs;
}

function cookieOrigin(cfg) {
  const explicit = cfg.webCookieOrigin?.trim();
  if (explicit) return explicit.replace(/\/$/, '');
  try {
    return new URL(cfg.webChatUrl || 'https://www.doubao.com').origin;
  } catch {
    return 'https://www.doubao.com';
  }
}

export function buildPlaywrightCookies(header, cfg) {
  const pairs = parseCookiePairs(header);
  const mode = (cfg.webCookieInjectMode || 'url').toLowerCase();
  const domain = cfg.webCookieDomain || '.doubao.com';
  const baseUrl = cookieOrigin(cfg);
  const sameSite = cfg.webCookieSameSite || 'Lax';

  if (mode === 'domain') {
    return pairs.map(({ name, value }) => ({
      name,
      value,
      domain,
      path: '/',
      secure: true,
      sameSite,
    }));
  }

  return pairs.map(({ name, value }) => ({
    name,
    value,
    url: baseUrl,
    sameSite,
    secure: true,
  }));
}

function readCookieFile(cwd, fileName) {
  const p = resolve(cwd, fileName);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, 'utf8').trim();
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (!lines.length) return null;
  return lines.map((l) => l.replace(/;+\s*$/, '').trim()).filter(Boolean).join('; ');
}

export function loadCookieHeaderString(cfg, cwd) {
  const envName = cfg.webCookieEnv || 'DOUBAO_COOKIE';
  const fileName = cfg.webCookieFile || 'doubao-cookies.txt';
  const source = (cfg.webCookieSource || 'auto').toLowerCase();

  if (source === 'env') {
    const fromEnv = process.env[envName]?.trim();
    if (fromEnv) return fromEnv;
    throw new Error(
      `webCookieSource 为 env，但未设置环境变量 ${envName}。`,
    );
  }

  if (source === 'file') {
    const fromFile = readCookieFile(cwd, fileName);
    if (fromFile) return fromFile;
    throw new Error(
      `webCookieSource 为 file，但未找到或为空：${resolve(cwd, fileName)}（可多行拼接为一整段 Cookie）。`,
    );
  }

  const fromEnv = process.env[envName]?.trim();
  if (fromEnv) return fromEnv;

  const fromFile = readCookieFile(cwd, fileName);
  if (fromFile) return fromFile;

  throw new Error(
    `缺少 Cookie：设置 ${envName}，或在项目根目录创建 ${fileName}；也可在 config 设 webCookieSource 为 file 仅用文件。`,
  );
}

export async function extractMessageNodes(page, cfg) {
  const sel = effectiveMessageSelector(cfg);
  const maxHtml = Number(cfg.webMaxHtmlChars ?? 12_000);
  return page.locator(sel).evaluateAll(
    (els, max) =>
      els.map((el, index) => {
        const html = el.innerHTML || '';
        return {
          index,
          testId: el.getAttribute('data-testid') || 'message_text_content',
          text: (el.innerText || '').trim(),
          htmlLength: html.length,
          html:
            html.length > max ? `${html.slice(0, max)}…[truncated]` : html,
        };
      }),
    maxHtml,
  );
}

export async function withDoubaoSession(cfg, cwd, fn) {
  const header = loadCookieHeaderString(cfg, cwd);
  const cookies = buildPlaywrightCookies(header, cfg);
  const baseOrigin = cookieOrigin(cfg);

  const browser = await chromium.launch({
    headless: cfg.webHeadless !== false,
    channel: cfg.webChromeChannel || undefined,
  });

  try {
    const ua =
      cfg.webUserAgent?.trim() ||
      (cfg.webHeadless !== false ? DEFAULT_CHROME_UA : undefined);
    const vw = Number(cfg.webViewportWidth ?? 1280);
    const vh = Number(cfg.webViewportHeight ?? 800);

    const context = await browser.newContext({
      locale: cfg.webLocale || 'zh-CN',
      userAgent: ua || undefined,
      viewport: { width: vw, height: vh },
    });

    await context.addCookies(cookies);

    if (cfg.webCookieAlsoInjectWww === true && !baseOrigin.includes('www.')) {
      const wwwOrigin = baseOrigin.replace('://', '://www.');
      if (wwwOrigin !== baseOrigin) {
        const extra = parseCookiePairs(header).map(({ name, value }) => ({
          name,
          value,
          url: wwwOrigin,
          sameSite: cfg.webCookieSameSite || 'Lax',
          secure: true,
        }));
        await context.addCookies(extra);
      }
    }

    const page = await context.newPage();
    const navTimeout = Number(cfg.webNavigationTimeoutMs ?? 90_000);
    page.setDefaultTimeout(navTimeout);
    await page.goto(cfg.webChatUrl, {
      waitUntil: cfg.webWaitUntil || 'domcontentloaded',
      timeout: navTimeout,
    });

    const meta = {
      cookieInjectedCount: cookies.length,
      cookieOrigin: baseOrigin,
      finalUrl: page.url(),
      pageTitle: await page.title().catch(() => ''),
    };

    return await fn(page, meta);
  } finally {
    await browser.close();
  }
}

/**
 * @param {string} text
 * @param {string} url
 * @param {Record<string, unknown>} [cfg] 传 `config` 时可按 webProvider / 域名选用豆包或 Claude 的提示文案
 */
export function sessionHint(text, url, cfg) {
  return sessionHintForProvider(text, url, cfg ?? {});
}

/**
 * 在已打开的会话页上读取当前消息列表（用于 CDP / 持久化会话，不经由 Cookie 启动新浏览器）。
 * @param {import('playwright').Page} page
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, unknown>} [diagnosticsBase]
 */
export async function readMessagesSnapshotOnPage(page, cfg, diagnosticsBase = {}) {
  const sel = effectiveMessageSelector(cfg);
  await page
    .waitForSelector(sel, { state: 'attached', timeout: 25_000 })
    .catch(() => {});
  await sleep(Number(cfg.webDomSettleMs ?? 800));
  const messages = await extractMessageNodes(page, cfg);
  const bodySnippet = await page
    .evaluate(() => document.body?.innerText?.slice(0, 800) || '')
    .catch(() => '');
  const hint = sessionHint(bodySnippet, page.url(), cfg);
  return {
    messages,
    count: messages.length,
    diagnostics: { ...diagnosticsBase, finalUrl: page.url() },
    hint,
  };
}

/**
 * 在已打开的会话页上发送 prompt 并等待 DOM 稳定后抓取消息（与 webSendAndCollect 逻辑一致，但不开关浏览器）。
 * @param {import('playwright').Page} page
 * @param {Record<string, unknown>} cfg
 * @param {string} promptText
 * @param {Record<string, unknown>} [diagnosticsBase]
 */
/**
 * 从后往前找第一条「不是用户刚发的 prompt」的气泡，视为模型回复（与用户气泡共用同一 testid 时必需）。
 * @param {Awaited<ReturnType<typeof extractMessageNodes>>} messages
 * @param {string} promptTrim
 */
export function pickReplyMessage(messages, promptTrim) {
  const p = String(promptTrim).trim();
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = String(messages[i]?.text ?? '').trim();
    if (t && t !== p) return messages[i];
  }
  return null;
}

/**
 * 发送后轮询：先等到出现与 prompt 不同的回复文本，再等到该文本在 webReplySettleMs 内不再变化（流式结束）。
 * @export 供 web-serve 与 SSE 等待并行使用。
 */
export async function waitForAssistantReplyStable(
  page,
  cfg,
  promptText,
  replyWait,
  settle,
  poll,
) {
  const promptTrim = String(promptText).trim();
  const deadline = Date.now() + replyWait;
  let stableAccum = 0;
  let prevReply = /** @type {string | null} */ (null);

  while (Date.now() < deadline) {
    const messages = await extractMessageNodes(page, cfg);
    const replyMsg = pickReplyMessage(messages, promptTrim);
    const replyText = String(replyMsg?.text ?? '').trim();

    if (replyText) {
      if (replyText === prevReply) {
        stableAccum += poll;
        if (stableAccum >= settle) {
          return messages;
        }
      } else {
        prevReply = replyText;
        stableAccum = 0;
      }
    } else {
      prevReply = null;
      stableAccum = 0;
    }
    await sleep(poll);
  }

  return extractMessageNodes(page, cfg);
}

/**
 * 仅填写并发送 prompt，不等待回复（与 waitForAssistantReplyStable 搭配，便于与 SSE 并行等）。
 * @param {import('playwright').Page} page
 * @param {Record<string, unknown>} cfg
 * @param {string} promptText
 * @param {Record<string, unknown>} [diagnosticsBase]
 */
export async function sendPromptOnlyOnPage(page, cfg, promptText, diagnosticsBase = {}) {
  const { before } = await waitChatReadyForProvider(page, cfg);

  const composer = await findComposerForProvider(page, cfg);
  await fillComposerForProvider(page, composer, promptText, cfg);

  await submitComposerForProvider(page, composer, cfg);

  return {
    before,
    promptTrim: String(promptText).trim(),
    diagnosticsBase,
  };
}

export async function sendPromptAndCollectOnPage(page, cfg, promptText, diagnosticsBase = {}) {
  const { before, promptTrim } = await sendPromptOnlyOnPage(
    page,
    cfg,
    promptText,
    diagnosticsBase,
  );

  const replyWait = Number(cfg.webReplyWaitMs ?? 90_000);
  const settle = Number(cfg.webReplySettleMs ?? 2000);
  const poll = Number(cfg.webReplyPollMs ?? 400);

  const messages = await waitForAssistantReplyStable(
    page,
    cfg,
    promptText,
    replyWait,
    settle,
    poll,
  );

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

  return {
    promptChars: promptText.length,
    messageNodesBefore: before,
    messageNodesAfter: messages.length,
    messages,
    /** 模型回复气泡（与 prompt 文本不同的最后一条）；拿不到时为 null */
    replyMessage,
    replyText: replyMessage ? String(replyMessage.text ?? '').trim() : '',
    /** 兼容旧字段：优先为模型回复，否则为 DOM 最后一条 */
    lastMessage: replyMessage ?? lastDom,
    lastDomMessage: lastDom,
    diagnostics: { ...diagnosticsBase, finalUrl: page.url() },
    hint,
  };
}

export async function webFetchMessages(cfg, cwd) {
  return withDoubaoSession(cfg, cwd, async (page, meta) => {
    return readMessagesSnapshotOnPage(page, cfg, meta);
  });
}

export async function webSendAndCollect(cfg, cwd, promptText) {
  return withDoubaoSession(cfg, cwd, async (page, meta) => {
    return sendPromptAndCollectOnPage(page, cfg, promptText, meta);
  });
}
