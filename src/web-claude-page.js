/**
 * Claude 网页对话行：用户气泡 `user-message`，助手气泡根节点带 `data-is-streaming`（与旧版 `conversation-turn` 不同）。
 * @see https://claude.ai — 仍以实际 DOM 为准，可用 `webMessageSelector` 覆盖
 */
export const CLAUDE_DEFAULT_MESSAGE_SELECTOR =
  '[data-testid="user-message"], [data-is-streaming]';

/**
 * @param {import('playwright').Page} page
 * @param {Record<string, unknown>} cfg
 */
export async function findComposerClaude(page, cfg) {
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
    page.locator('[data-testid="chat-input"][contenteditable="true"]').first(),
    page.locator('[data-testid="chat-input"]').first(),
    page.locator('[data-testid="chat_input_input"]').first(),
    page.locator('[data-testid="chat_input"] [contenteditable="true"]').first(),
    page.locator('[data-testid="chat_input"] textarea:not([readonly])').first(),
    page.locator('[data-testid="chat_input"] [role="textbox"]').first(),
    page.locator('div[contenteditable="true"]').last(),
    page.locator('textarea:not([readonly])').last(),
    page.locator('div[role="textbox"]').last(),
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
    `未找到输入框（最后错误: ${lastErr?.message ?? 'timeout'}）。请在 config 中设置 webInputSelector。`,
  );
}

/**
 * 发送前：先等输入框（避免误用豆包 message 选择器白等 30s）；再短等消息区用于 before 统计。
 * @param {import('playwright').Page} page
 * @param {Record<string, unknown>} cfg
 */
export async function waitChatReadyClaude(page, cfg) {
  await page
    .locator('[data-testid="chat-input"]')
    .first()
    .waitFor({ state: 'visible', timeout: 25_000 })
    .catch(() => {});

  const sel =
    String(cfg.webMessageSelector ?? '').trim() || CLAUDE_DEFAULT_MESSAGE_SELECTOR;
  await page.waitForSelector(sel, { state: 'attached', timeout: 12_000 }).catch(() => {});

  const before = await page.locator(sel).count();
  return { before };
}

/**
 * @param {string} text
 * @param {string} url
 * @returns {string | null}
 */
export function sessionHintClaude(text, url) {
  const t = (text || '').slice(0, 800);
  const u = url || '';
  const lostChat =
    u.startsWith('http') && u.includes('claude.ai') && !u.includes('/chat/');
  if (
    t.includes('Sign in') ||
    t.includes('Unable to load conversation') ||
    lostChat
  ) {
    return [
      'Claude 页可能未登录或会话无效：在浏览器登录 claude.ai 后导出 Cookie（须含 HttpOnly）到 doubao-cookies.txt 或你在 config 指定的 webCookieFile；确认 webChatUrl 为当前账号下会话。',
      '若 DOM 抓取不到回复，在开发者工具中检查助手气泡的选择器，并设置 webMessageSelector。',
    ].join(' ');
  }
  return null;
}
