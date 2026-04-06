import { setTimeout as sleep } from 'node:timers/promises';

/** 豆包对话气泡（与历史 config 一致） */
export const DOUBAO_DEFAULT_MESSAGE_SELECTOR = '[data-testid="message_text_content"]';

/**
 * @param {import('playwright').Page} page
 * @param {Record<string, unknown>} cfg
 */
export async function findComposerDoubao(page, cfg) {
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
    page.locator('[data-testid="chat_input_input"]').first(),
    page.locator('[data-testid="chat_input"] textarea:not([readonly])').first(),
    page.locator('[data-testid="chat_input"] [role="textbox"]').first(),
    page.locator('[data-testid="chat_input"] [contenteditable="true"]').first(),
    page.locator('[data-testid="chat_input"]').first(),
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
 * 发送前：等待消息区挂载并统计条数（豆包页必有 message_text_content）。
 * @param {import('playwright').Page} page
 * @param {Record<string, unknown>} cfg
 */
export async function waitChatReadyDoubao(page, cfg) {
  const sel =
    String(cfg.webMessageSelector ?? '').trim() || DOUBAO_DEFAULT_MESSAGE_SELECTOR;
  await page
    .waitForSelector(sel, { state: 'attached', timeout: 30_000 })
    .catch(() => {});
  const before = await page.locator(sel).count();
  return { before };
}

/**
 * @param {string} text
 * @param {string} url
 * @returns {string | null}
 */
export function sessionHintDoubao(text, url) {
  const t = (text || '').slice(0, 800);
  const u = url || '';
  const lostChat = u.startsWith('http') && !u.includes('/chat/');
  if (
    t.includes('无权限访问该会话') ||
    t.includes('返回到首页') ||
    lostChat
  ) {
    return [
      '页面可能未带上登录态：在 Chrome 中打开豆包并登录 → F12 → Application → Cookies → https://www.doubao.com ，逐条复制或导出（须含 HttpOnly；不要用控制台 document.cookie，会缺登录关键项）。写入 doubao-cookies.txt。',
      '确认 webChatUrl 里的会话 id 是当前账号下的对话；他人链接或已删除会话会提示无权限。',
      '可试 config 中 webCookieInjectMode 改为 domain（少数环境 domain 比 url 更稳），或 web-chat --headed 看实际页面。',
    ].join(' ');
  }
  return null;
}
