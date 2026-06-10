import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const defaults = {
  webChatUrl: 'https://www.doubao.com/chat/38420252204674818',
  webPageUrlIncludes: '',
  webCookieSource: 'auto',
  webCookieEnv: 'DOUBAO_COOKIE',
  webCookieFile: 'doubao-cookies.txt',
  webCookieDomain: '.doubao.com',
  webCookieOrigin: '',
  webCookieInjectMode: 'url',
  webCookieSameSite: 'Lax',
  webCookieAlsoInjectWww: false,
  webViewportWidth: 1280,
  webViewportHeight: 800,
  /** 留空则按 `webProvider` 使用豆包/Claude 内置默认；可强制覆盖 */
  webMessageSelector: '',
  webInputSelector: '',
  webHeadless: true,
  webWaitUntil: 'domcontentloaded',
  webNavigationTimeoutMs: 90_000,
  webReplyWaitMs: 90_000,
  webReplySettleMs: 2000,
  webReplyPollMs: 400,
  webDomSettleMs: 800,
  webComposerTimeoutMs: 25_000,
  webSubmitKey: 'Enter',
  webMaxHtmlChars: 12_000,
  webLocale: 'zh-CN',
  webUserAgent: '',
  webChromeChannel: '',
  webWatchMode: 'cdp',
  webCdpUrl: 'http://127.0.0.1:9222',
  webWatchIntervalMs: 2000,
  webPersistentProfileDir: '.doubao-playwright-profile',
  webWatchUseMutation: true,
  webWatchMutationDebounceMs: 400,
  webMessageCaptureMode: 'dom',
  /** `auto` 由 webChatUrl 推断 doubao | claude | chatgpt；可显式指定 */
  webProvider: 'auto',
  webSseUrlIncludes: '',
  webSseMaxBufferLines: 2000,
  /** Claude 等场景下 cdp-completion 往往较晚，过小会过早放弃 SSE、掉进 DOM 兜底 */
  webSseGiveUpNoNewLinesMs: 45_000,
  webSseDebug: false,
  webServeHost: '127.0.0.1',
  webServePort: 3840,
  webServeToken: '',
  webServeCorsOrigin: '',
  webServeChatResponseFormat: 'openai',
  webOpenAiCompatModel: 'local/web-bridge',
  webServeAssumeOpenAiStream: true,
  /** `true` 时 web-serve 与 CDP SSE 抓包用 console.log 打耗时 */
  webServeTimingLog: false,
};

export function loadConfig(cwd = process.cwd()) {
  const candidates = [
    resolve(cwd, 'config.json'),
    resolve(cwd, 'config.local.json'),
  ];

  let merged = { ...defaults };
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const raw = readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      merged = { ...merged, ...parsed };
    } catch {
      // ignore broken config files for robustness
    }
  }
  return merged;
}
