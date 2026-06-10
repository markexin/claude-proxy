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
  /** 非流式 JSON 里 message.reasoning_content（无思考链时为空字符串） */
  webOpenAiIncludeReasoningContent: true,
  webOpenAiSystemFingerprint: 'fp_local_web_bridge',
  /** false 时 /v1/chat/completions 默认返回整段 chat.completion JSON（DeepSeek 风格） */
  webServeAssumeOpenAiStream: false,
  /** `true` 时 web-serve 与 CDP SSE 抓包用 console.log 打耗时 */
  webServeTimingLog: false,
  /** 每 N 轮对话后开新网页会话；0 表示用 min/max 随机区间 */
  webSessionRotateEvery: 0,
  /** 随机轮换区间（含端点），如 20–30 表示每 20~30 轮开新 ChatGPT 对话 */
  webSessionRotateMin: 0,
  webSessionRotateMax: 0,
  /** 仅对这些 provider 轮换：`chatgpt` / `all` / 逗号分隔 */
  webSessionRotateProviders: 'chatgpt',
  /** ChatGPT 开新对话时的 URL，默认 `${webChatUrl.origin}/` */
  webNewChatUrl: '',
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
