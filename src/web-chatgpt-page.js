/**
 * ChatGPT 网页（https://chatgpt.com/）对话行与输入框。
 * 输入框多为 ProseMirror contenteditable（#prompt-textarea），`fill()` 常无效，需 execCommand / type。
 * @see https://chatgpt.com — 仍以实际 DOM 为准，可用 `webMessageSelector` / `webInputSelector` 覆盖
 */
export const CHATGPT_DEFAULT_MESSAGE_SELECTOR =
  '[data-message-author-role="user"], [data-message-author-role="assistant"]';

/**
 * @param {import('playwright').Page} page
 * @param {Record<string, unknown>} cfg
 */
export async function findComposerChatgpt(page, cfg) {
  const custom = cfg.webInputSelector?.trim();
  if (custom) {
    const loc = page.locator(custom).first();
    await loc.waitFor({
      state: 'visible',
      timeout: cfg.webComposerTimeoutMs ?? 25_000,
    });
    return loc;
  }

  const attempts = [
    page.locator('#prompt-textarea[contenteditable="true"]').first(),
    page.locator('#prompt-textarea').first(),
    page.locator('[data-testid="prompt-textarea"]').first(),
    page.locator('div.ProseMirror[contenteditable="true"]').first(),
    page.locator('div[contenteditable="true"][data-placeholder]').first(),
    page.locator('div[contenteditable="true"][role="textbox"]').first(),
    page.locator('textarea#prompt-textarea').first(),
    page.locator('textarea:not([readonly])').last(),
  ];

  let lastErr;
  for (const loc of attempts) {
    try {
      await loc.waitFor({ state: 'visible', timeout: 5000 });
      return loc;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `未找到 ChatGPT 输入框（最后错误: ${lastErr?.message ?? 'timeout'}）。请在 config 中设置 webInputSelector（如 #prompt-textarea）。`,
  );
}

/**
 * ProseMirror / contenteditable 需模拟用户输入；普通 textarea 仍用 fill。
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator} composer
 * @param {string} text
 */
export async function fillComposerChatgpt(page, composer, text) {
  await composer.click();

  const meta = await composer.evaluate((el) => ({
    tag: el.tagName.toLowerCase(),
    contentEditable: el.getAttribute('contenteditable'),
  }));

  if (meta.tag === 'textarea') {
    await composer.fill(text);
    return;
  }

  if (meta.contentEditable === 'true' || meta.contentEditable === 'plaintext-only') {
    const ok = await composer.evaluate((el, t) => {
      el.focus();
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      const inserted = document.execCommand('insertText', false, t);
      if (!inserted) {
        el.textContent = t;
      }
      el.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: t,
        }),
      );
      return true;
    }, text);
    if (ok) return;
  }

  await composer.pressSequentially(text, { delay: 0 });
}

/**
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator} composer
 * @param {Record<string, unknown>} cfg
 */
export async function submitComposerChatgpt(page, composer, cfg) {
  const key = cfg.webSubmitKey || 'Enter';
  await composer.press(key);

  const sendBtn = page.locator('button[data-testid="send-button"]').first();
  const visible = await sendBtn.isVisible().catch(() => false);
  if (visible) {
    const enabled = await sendBtn.isEnabled().catch(() => false);
    if (enabled) await sendBtn.click().catch(() => {});
  }
}

/**
 * @param {import('playwright').Page} page
 * @param {Record<string, unknown>} cfg
 */
export async function waitChatReadyChatgpt(page, cfg) {
  await page
    .locator('#prompt-textarea, [data-testid="prompt-textarea"]')
    .first()
    .waitFor({ state: 'visible', timeout: 25_000 })
    .catch(() => {});

  const sel =
    String(cfg.webMessageSelector ?? '').trim() || CHATGPT_DEFAULT_MESSAGE_SELECTOR;
  await page.waitForSelector(sel, { state: 'attached', timeout: 12_000 }).catch(() => {});

  const before = await page.locator(sel).count();
  return { before };
}

/**
 * @param {string} text
 * @param {string} url
 * @returns {string | null}
 */
export function sessionHintChatgpt(text, url) {
  const t = (text || '').slice(0, 800);
  const u = url || '';
  const onChatgpt =
    u.startsWith('http') &&
    (u.includes('chatgpt.com') || u.includes('chat.openai.com'));
  const lostChat =
    onChatgpt &&
    !u.includes('/c/') &&
    !u.includes('/g/') &&
    u.replace(/\/$/, '') !== 'https://chatgpt.com' &&
    u.replace(/\/$/, '') !== 'https://chat.openai.com';
  if (
    t.includes('Log in') ||
    t.includes('Sign up') ||
    t.includes('Welcome back') ||
    t.includes('Get started') ||
    lostChat
  ) {
    return [
      'ChatGPT 页可能未登录或会话无效：在浏览器登录 https://chatgpt.com 后导出 Cookie（须含 HttpOnly）到 webCookieFile；确认 webChatUrl 为当前账号下的 /c/{id} 会话。',
      'Composer 为 ProseMirror 时勿依赖 fill；本项目已用 execCommand。若 DOM 抓取不到回复，检查 [data-message-author-role="assistant"] 或设置 webMessageSelector。',
      'SSE 模式请将 webSseUrlIncludes 设为 chatgpt.com 或 *，以匹配 /backend-api/conversation 流。',
    ].join(' ');
  }
  return null;
}

/**
 * 开新 ChatGPT 对话（侧边栏按钮或跳转首页）。
 * @param {import('playwright').Page} page
 * @param {Record<string, unknown>} cfg
 * @returns {Promise<{ method: string; url: string }>}
 */
export async function startNewChatgptSession(page, cfg) {
  const navTimeout = Number(cfg.webNavigationTimeoutMs ?? 90_000);
  let origin = 'https://chatgpt.com';
  try {
    origin = new URL(
      String(cfg.webChatUrl || cfg.webCookieOrigin || 'https://chatgpt.com'),
    ).origin;
  } catch {
    // keep default
  }

  const newChatSelectors = [
    '[data-testid="create-new-chat-button"]',
    '[data-testid="sidebar-new-chat-button"]',
    'nav a[href="/"]',
    'a[href="/"]',
  ];

  for (const sel of newChatSelectors) {
    const btn = page.locator(sel).first();
    try {
      if (await btn.isVisible({ timeout: 1500 })) {
        await btn.click();
        await waitChatReadyChatgpt(page, cfg);
        return { method: 'click', url: page.url() };
      }
    } catch {
      // try next selector
    }
  }

  const newChatUrl = String(cfg.webNewChatUrl ?? '').trim() || `${origin}/`;
  await page.goto(newChatUrl, {
    waitUntil: cfg.webWaitUntil || 'domcontentloaded',
    timeout: navTimeout,
  });
  await waitChatReadyChatgpt(page, cfg);
  return { method: 'goto', url: page.url() };
}
