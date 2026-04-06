import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { extractMessageNodes } from './doubao-web.js';
import { effectiveMessageSelector } from './web-provider.js';
import {
  createSseCaptureState,
  installSsePageHooks,
  normalizeMessageCapture,
} from './doubao-web-sse-capture.js';

/**
 * CDP 下在已打开标签中识别聊天页：优先 webPageUrlIncludes，否则从 webChatUrl 解析 hostname（含去 www）。
 * @param {Record<string, unknown>} cfg
 * @returns {string[]}
 */
export function chatPageUrlMatchers(cfg) {
  const explicit = String(cfg.webPageUrlIncludes ?? '').trim();
  if (explicit) return [explicit];
  const hint = String(cfg.webChatUrl || '').trim();
  if (!hint) return ['doubao.com'];
  try {
    const { hostname } = new URL(hint);
    const out = [hostname];
    if (hostname.startsWith('www.')) out.push(hostname.slice(4));
    return [...new Set(out)];
  } catch {
    return ['doubao.com'];
  }
}

function pageUrlMatchesChatSite(/** @type {string} */ url, /** @type {string[]} */ matchers) {
  return matchers.some((m) => url.includes(m));
}

/** @param {import('playwright').Browser} browser */
export async function findDoubaoPageInBrowser(browser, cfg) {
  const hint = (cfg.webChatUrl || 'https://www.doubao.com').trim();
  const matchers = chatPageUrlMatchers(cfg);
  let pathname = '';
  try {
    pathname = new URL(hint).pathname;
  } catch {
    pathname = '';
  }
  /** @type {import('playwright').Page | null} */
  let best = null;
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      let u = '';
      try {
        u = page.url();
      } catch {
        continue;
      }
      if (!pageUrlMatchesChatSite(u, matchers)) continue;
      if (!best) best = page;
      if (pathname && u.includes(pathname)) best = page;
    }
  }
  return best;
}

/** @param {import('playwright').Browser} browser */
export async function ensureDoubaoPage(browser, cfg) {
  let page = await findDoubaoPageInBrowser(browser, cfg);
  const contexts = browser.contexts();
  if (!contexts.length) {
    throw new Error('已连接浏览器但未找到任何上下文（context）。');
  }
  const context = page ? page.context() : contexts[0];
  const navTimeout = Number(cfg.webNavigationTimeoutMs ?? 90_000);
  if (!page) {
    page = await context.newPage();
    page.setDefaultTimeout(navTimeout);
    await page.goto(cfg.webChatUrl, {
      waitUntil: cfg.webWaitUntil || 'domcontentloaded',
      timeout: navTimeout,
    });
  } else {
    page.setDefaultTimeout(navTimeout);
  }
  return page;
}

/**
 * @param {'dom' | 'sse'} [captureMode]
 */
export function createWatchEmitter(captureMode = 'dom') {
  let lastSig = '';
  return {
    /**
     * @param {Awaited<ReturnType<typeof extractMessageNodes>>} messages
     * @param {string} url
     * @param {string} reason
     */
    emitIfChanged(messages, url, reason) {
      const sig = JSON.stringify(messages.map((m) => m.text));
      if (sig === lastSig) return false;
      lastSig = sig;
      const line = JSON.stringify({
        ok: true,
        type: 'web-watch',
        capture: captureMode,
        reason,
        ts: Date.now(),
        count: messages.length,
        url,
        messages,
      });
      process.stdout.write(`${line}\n`);
      return true;
    },
  };
}

/**
 * @param {import('playwright').Page} page
 * @param {Record<string, unknown>} cfg
 * @param {(messages: Awaited<ReturnType<typeof extractMessageNodes>>) => void} onChange
 */
async function installMutationBridge(page, cfg, onChange) {
  const sel = effectiveMessageSelector(cfg);
  const debounceMs = Number(cfg.webWatchMutationDebounceMs ?? 400);
  await page.exposeBinding('__doubaoWatchNotify', async () => {
    const messages = await extractMessageNodes(page, cfg);
    onChange(messages);
  });
  await page.evaluate(
    ({ sel, debounceMs }) => {
      if (window.__doubaoWatchObserverInstalled) return;
      window.__doubaoWatchObserverInstalled = true;
      let t = 0;
      const run = () => {
        window.clearTimeout(t);
        t = window.setTimeout(() => {
          window.__doubaoWatchNotify().catch(() => {});
        }, debounceMs);
      };
      const obs = new MutationObserver(() => run());
      const root = document.body || document.documentElement;
      if (root) {
        obs.observe(root, { subtree: true, childList: true, characterData: true });
      }
      run();
    },
    { sel, debounceMs },
  );
}

/**
 * @param {import('playwright').Page} page
 * @param {Record<string, unknown>} cfg
 * @param {{
 *   intervalMs?: number;
 *   useMutation?: boolean;
 *   messageCapture?: string;
 *   capture?: string;
 * }} [options]
 */
export async function runWebWatch(page, cfg, options = {}) {
  const intervalMs = Number(options.intervalMs ?? cfg.webWatchIntervalMs ?? 2000);
  const capture = normalizeMessageCapture(cfg, options);

  if (capture === 'sse') {
    console.error(
      '[web-watch] 消息来源: sse（页面 fetch/EventSource + CDP Network：WebSocket 即时；HTTP SSE 多在整段流结束后才进快照）',
    );
    const state = createSseCaptureState(cfg);
    await installSsePageHooks(page, state, cfg);
    const { emitIfChanged } = createWatchEmitter('sse');
    emitIfChanged(state.toMessageNodesForWatch(), page.url(), 'initial');
    while (true) {
      await sleep(intervalMs);
      emitIfChanged(state.toMessageNodesForWatch(), page.url(), 'poll');
    }
    return;
  }

  console.error(
    '[web-watch] 消息来源: dom（message_text_content + MutationObserver 或轮询）',
  );

  const useMutation = options.useMutation !== false && cfg.webWatchUseMutation !== false;

  const { emitIfChanged } = createWatchEmitter('dom');
  const sel = effectiveMessageSelector(cfg);

  await page.waitForSelector(sel, { state: 'attached', timeout: 25_000 }).catch(() => {});
  await sleep(Number(cfg.webDomSettleMs ?? 800));

  const initial = await extractMessageNodes(page, cfg);
  emitIfChanged(initial, page.url(), 'initial');

  if (useMutation) {
    await installMutationBridge(page, cfg, (messages) => {
      emitIfChanged(messages, page.url(), 'mutation');
    });
    await new Promise(() => {});
  }

  while (true) {
    await sleep(intervalMs);
    const messages = await extractMessageNodes(page, cfg);
    emitIfChanged(messages, page.url(), 'poll');
  }
}

let attachedBrowser = null;
/** @type {import('playwright').BrowserContext | null} */
let attachedContext = null;
let sigintHandlerInstalled = false;

function installSigintHandler() {
  if (sigintHandlerInstalled) return;
  sigintHandlerInstalled = true;
  process.once('SIGINT', async () => {
    console.error('\n[web-watch] 正在断开 Playwright…');
    try {
      if (attachedBrowser) {
        await attachedBrowser.close();
        attachedBrowser = null;
      }
      if (attachedContext) {
        await attachedContext.close();
        attachedContext = null;
      }
    } catch {
      // ignore
    }
    process.exit(0);
  });
}

/**
 * @param {string} url
 * @returns {Promise<import('playwright').Browser>}
 */
async function connectOverCdpWithHint(url) {
  try {
    return await chromium.connectOverCDP(url);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const refused =
      msg.includes('ECONNREFUSED') ||
      msg.toLowerCase().includes('connection refused');
    if (refused) {
      const hint = [
        `连不上 CDP（${url}）：该地址没有浏览器在监听远程调试端口。`,
        '',
        '请先退出其它 Chrome 窗口，再在 PowerShell 或「运行」里启动带调试端口的 Chrome（路径按你本机安装位置改）：',
        '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%TEMP%\\doubao-chrome-debug"',
        '',
        '窗口打开后进入豆包并登录，再重新执行 web-watch / web-serve。',
        '若使用其它端口：config 里改 webCdpUrl，或加参数 --cdp-url http://127.0.0.1:端口',
        '不想用 CDP 时可用：--mode persistent（web-watch 或 web-serve）。',
      ].join('\n');
      throw new Error(hint);
    }
    throw e;
  }
}

/**
 * 连接 CDP 或启动持久化上下文，得到已打开 webChatUrl 的 Page（供 web-watch / web-serve 复用）。
 * @param {Record<string, unknown>} cfg
 * @param {string} cwd
 * @param {{ mode?: string; cdpUrl?: string }} [options]
 * @returns {Promise<{
 *   page: import('playwright').Page;
 *   browser: import('playwright').Browser | null;
 *   context: import('playwright').BrowserContext | null;
 * }>}
 */
export async function attachDoubaoAutomation(cfg, cwd, options = {}) {
  const mode = String(options.mode || cfg.webWatchMode || 'cdp').toLowerCase();

  if (mode === 'persistent') {
    const dir = resolve(cwd, String(cfg.webPersistentProfileDir || '.doubao-playwright-profile'));
    console.error(`[doubao] 模式 persistent：用户数据目录 ${dir}`);
    console.error(
      '[doubao] 首次请在本窗口完成登录；结束进程时会关闭此 Playwright 打开的浏览器（保留窗口请用 Chrome + CDP）。',
    );
    const context = await chromium.launchPersistentContext(dir, {
      headless: false,
      channel: cfg.webChromeChannel || undefined,
      locale: cfg.webLocale || 'zh-CN',
      viewport:
        cfg.webViewportWidth && cfg.webViewportHeight
          ? {
              width: Number(cfg.webViewportWidth),
              height: Number(cfg.webViewportHeight),
            }
          : null,
    });
    let page = context.pages()[0];
    if (!page) page = await context.newPage();
    const navTimeout = Number(cfg.webNavigationTimeoutMs ?? 90_000);
    page.setDefaultTimeout(navTimeout);
    await page.goto(cfg.webChatUrl, {
      waitUntil: cfg.webWaitUntil || 'domcontentloaded',
      timeout: navTimeout,
    });
    return { page, browser: null, context };
  }

  const url = String(options.cdpUrl || cfg.webCdpUrl || 'http://127.0.0.1:9222').trim();
  console.error(`[doubao] 模式 cdp：${url}`);
  console.error('[doubao] 结束进程时仅断开调试连接，不会关闭你已打开的 Chrome。');
  const browser = await connectOverCdpWithHint(url);
  const page = await ensureDoubaoPage(browser, cfg);
  return { page, browser, context: null };
}

/**
 * @param {{ browser: import('playwright').Browser | null; context: import('playwright').BrowserContext | null }} att
 */
export async function detachDoubaoAutomation(att) {
  if (att.browser) await att.browser.close();
  if (att.context) await att.context.close();
}

/**
 * @param {Record<string, unknown>} cfg
 * @param {string} cwd
 * @param {{
 *   mode?: string;
 *   cdpUrl?: string;
 *   intervalMs?: number;
 *   useMutation?: boolean;
 *   messageCapture?: string;
 *   capture?: string;
 * }} [options]
 */
export async function startWebWatch(cfg, cwd, options = {}) {
  installSigintHandler();
  const att = await attachDoubaoAutomation(cfg, cwd, options);
  attachedBrowser = att.browser;
  attachedContext = att.context;
  await runWebWatch(att.page, cfg, options);
}
