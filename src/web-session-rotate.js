import { resolveWebProvider } from './web-provider.js';
import * as chatgptPage from './web-chatgpt-page.js';

/**
 * @param {Record<string, unknown>} cfg
 */
function pickNextRotateAt(cfg) {
  const fixed = Number(cfg.webSessionRotateEvery ?? 0);
  if (fixed > 0) return Math.max(1, Math.floor(fixed));
  const min = Number(cfg.webSessionRotateMin ?? 0);
  const max = Number(cfg.webSessionRotateMax ?? 0);
  if (min <= 0 && max <= 0) return 0;
  const lo = Math.max(1, Math.min(min, max));
  const hi = Math.max(lo, Math.max(min, max));
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function sessionRotationEnabled(cfg) {
  return pickNextRotateAt(cfg) > 0 && providerSupportsSessionRotation(cfg);
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function providerSupportsSessionRotation(cfg) {
  const id = resolveWebProvider(cfg);
  const allow = String(cfg.webSessionRotateProviders ?? 'chatgpt')
    .trim()
    .toLowerCase();
  if (allow === 'all' || allow === '*') return true;
  return allow.split(/[\s,|]+/).filter(Boolean).includes(id);
}

/**
 * @param {Record<string, unknown>} cfg
 */
export function createSessionRotationState(cfg) {
  const enabled = sessionRotationEnabled(cfg);
  return {
    enabled,
    turnCount: 0,
    rotationCount: 0,
    nextRotateAt: enabled ? pickNextRotateAt(cfg) : 0,
  };
}

/**
 * @param {import('playwright').Page} page
 * @param {Record<string, unknown>} cfg
 */
async function startNewSessionForProvider(page, cfg) {
  const id = resolveWebProvider(cfg);
  if (id === 'chatgpt') {
    return chatgptPage.startNewChatgptSession(page, cfg);
  }
  throw new Error(`当前 provider=${id} 未实现会话轮换，请设 webSessionRotateProviders=chatgpt 或关闭轮换。`);
}

/**
 * 达到阈值时在发送前开新会话；返回是否已轮换。
 * @param {import('playwright').Page} page
 * @param {Record<string, unknown>} cfg
 * @param {ReturnType<typeof createSessionRotationState>} rot
 * @param {{ clear?: () => void } | null | undefined} [sseState]
 */
export async function maybeRotateSessionBeforeChat(page, cfg, rot, sseState) {
  if (!rot.enabled || !providerSupportsSessionRotation(cfg)) {
    return { rotated: false };
  }
  if (rot.turnCount < rot.nextRotateAt) {
    return { rotated: false };
  }

  const prevTurns = rot.turnCount;
  const result = await startNewSessionForProvider(page, cfg);
  sseState?.clear?.();

  rot.rotationCount += 1;
  rot.turnCount = 0;
  rot.nextRotateAt = pickNextRotateAt(cfg);

  const msg = `[web-serve] 会话轮换 #${rot.rotationCount}：已完成 ${prevTurns} 轮，已开新对话（${result.method}）→ ${result.url}；下次轮换约 ${rot.nextRotateAt} 轮后`;
  console.error(msg);

  return {
    rotated: true,
    rotationCount: rot.rotationCount,
    previousTurnCount: prevTurns,
    nextRotateAt: rot.nextRotateAt,
    newSessionUrl: result.url,
  };
}

/** 一次 POST /chat 成功后调用 */
export function recordSessionChatTurn(rot) {
  if (!rot.enabled) return;
  rot.turnCount += 1;
}
