import * as claudePage from './web-claude-page.js';
import * as doubaoPage from './web-doubao-page.js';

/** @typedef {'doubao' | 'claude'} WebProviderId */

/**
 * @param {Record<string, unknown>} cfg
 * @returns {WebProviderId}
 */
export function resolveWebProvider(cfg) {
  const explicit = String(cfg.webProvider ?? 'auto').trim().toLowerCase();
  if (explicit === 'doubao') return 'doubao';
  if (explicit === 'claude') return 'claude';
  if (explicit && explicit !== 'auto') {
    console.error(
      `[web-provider] 未知 webProvider=${JSON.stringify(cfg.webProvider)}，回退 auto`,
    );
  }
  try {
    const host = new URL(String(cfg.webChatUrl || '').trim() || 'https://x').hostname.toLowerCase();
    if (host.includes('claude.ai')) return 'claude';
    if (host.includes('doubao.com')) return 'doubao';
  } catch {
    // ignore
  }
  return 'doubao';
}

/**
 * `webMessageSelector` 未配置时按厂商默认（仍可在 config 覆盖）。
 * @param {Record<string, unknown>} cfg
 * @returns {string}
 */
export function effectiveMessageSelector(cfg) {
  const custom = String(cfg.webMessageSelector ?? '').trim();
  if (custom) return custom;
  return resolveWebProvider(cfg) === 'claude'
    ? claudePage.CLAUDE_DEFAULT_MESSAGE_SELECTOR
    : doubaoPage.DOUBAO_DEFAULT_MESSAGE_SELECTOR;
}

/**
 * @param {Record<string, unknown>} cfg
 * @returns {Promise<{ before: number }>}
 */
export async function waitChatReadyForProvider(page, cfg) {
  const id = resolveWebProvider(cfg);
  if (id === 'claude') return claudePage.waitChatReadyClaude(page, cfg);
  return doubaoPage.waitChatReadyDoubao(page, cfg);
}

/**
 * @param {import('playwright').Page} page
 * @param {Record<string, unknown>} cfg
 */
export async function findComposerForProvider(page, cfg) {
  const id = resolveWebProvider(cfg);
  if (id === 'claude') return claudePage.findComposerClaude(page, cfg);
  return doubaoPage.findComposerDoubao(page, cfg);
}

/**
 * @param {string} text
 * @param {string} url
 * @param {Record<string, unknown>} cfg
 * @returns {string | null}
 */
export function sessionHintForProvider(text, url, cfg) {
  const id = resolveWebProvider(cfg);
  if (id === 'claude') return claudePage.sessionHintClaude(text, url);
  return doubaoPage.sessionHintDoubao(text, url);
}
