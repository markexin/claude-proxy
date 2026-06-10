#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { cwd } from 'node:process';
import { loadConfig } from './config.js';
import { webFetchMessages, webSendAndCollect } from './doubao-web.js';
import { startWebWatch } from './doubao-web-watch.js';
import { startWebServe } from './doubao-web-serve.js';

function printJson(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function parseArgs(argv) {
  const out = { _: [], flags: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') {
      out.flags.set('file', argv[++i]);
      continue;
    }
    if (a === '--headed') {
      out.flags.set('headed', true);
      continue;
    }
    if (a.startsWith('--')) {
      out.flags.set(a.slice(2), argv[++i] ?? true);
      continue;
    }
    out._.push(a);
  }
  return out;
}

function getPromptText(args) {
  const file = args.flags.get('file');
  if (file) {
    if (!existsSync(file)) {
      throw new Error(`找不到文件: ${file}`);
    }
    return readFileSync(file, 'utf8');
  }
  const rest = args._.slice(1).join(' ').trim();
  if (!rest) {
    throw new Error('请提供要发送的文本，或使用 --file path.txt');
  }
  return rest;
}

function cfgForWeb(cfg, args) {
  return {
    ...cfg,
    webHeadless: args.flags.get('headed') ? false : cfg.webHeadless !== false,
  };
}

async function main() {
  const cfg = loadConfig();
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] ?? 'help';

  try {
    if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
      printJson({
        ok: true,
        usage: [
          'npm run install-browser              # 首次安装 Chromium',
          'node src/cli.js web-messages        # Cookie 打开会话页，读取消息 DOM',
          'node src/cli.js web-chat 你好       # 注入 Cookie 后输入并抓取回复',
          'node src/cli.js web-chat --headed 你好   # 有头浏览器调试',
          'node src/cli.js web-watch           # CDP 连接本机 Chrome，stdout NDJSON（Ctrl+C 不断关 Chrome）',
          'node src/cli.js web-watch --mode persistent',
          'node src/cli.js web-watch --poll-only --interval 3000',
          'node src/cli.js web-watch --message-capture sse',
          'node src/cli.js web-serve            # HTTP：POST /chat，GET /messages',
          'node src/cli.js web-serve --message-capture sse',
          'node src/cli.js web-serve --port 3840 --host 127.0.0.1 --mode cdp',
        ],
        webMessageCapture:
          'sse 含 fetch(SSE)、EventSource、WebSocket 文本帧。Claude 多为 WS；可设 webSseUrlIncludes 为 * 或 anthropic。CLI: --message-capture dom|sse。',
        webServe:
          '默认 127.0.0.1。DOUBAO_WEB_SERVE_TOKEN 或 webServeToken；Authorization: Bearer 或 ?token=。webServeCorsOrigin 可设 *。',
        webWatchCdp:
          'Chrome 示例（勿暴露公网）：chrome.exe --remote-debugging-port=9222 --user-data-dir="%TEMP%\\doubao-chrome-debug" 后登录站点，再运行 web-watch / web-serve。',
        webAuth:
          'Cookie 勿入库。webCookieSource=file + doubao-cookies.txt；auto 优先 DOUBAO_COOKIE 再读文件。',
        webConfig:
          'webChatUrl、webPageUrlIncludes、webMessageSelector、webInputSelector、webReply*、webProvider(auto|doubao|claude|chatgpt)；ChatGPT 见 config.chatgpt.json。',
      });
      return;
    }

    if (cmd === 'web-messages') {
      const wcfg = cfgForWeb(cfg, args);
      const out = await webFetchMessages(wcfg, cwd());
      printJson({ ok: true, step: 'web-messages', ...out });
      return;
    }

    if (cmd === 'web-chat') {
      const text = getPromptText(args);
      const wcfg = cfgForWeb(cfg, args);
      const out = await webSendAndCollect(wcfg, cwd(), text);
      printJson({ ok: true, step: 'web-chat', ...out });
      return;
    }

    if (cmd === 'web-watch') {
      const wcfg = { ...cfg };
      const mode = args.flags.get('mode') ?? wcfg.webWatchMode ?? 'cdp';
      const intervalMs = Number(args.flags.get('interval') ?? wcfg.webWatchIntervalMs ?? 2000);
      const cdpUrl = args.flags.get('cdp-url');
      const pollOnly = args.flags.get('poll-only');
      const useMutation =
        pollOnly !== true && pollOnly !== 'true' && pollOnly !== '1';
      const mc = args.flags.get('message-capture');
      const cap = args.flags.get('capture');
      await startWebWatch(wcfg, cwd(), {
        mode: String(mode),
        intervalMs,
        cdpUrl: cdpUrl != null ? String(cdpUrl) : undefined,
        useMutation,
        messageCapture: mc != null ? String(mc) : undefined,
        capture: cap != null ? String(cap) : undefined,
      });
      return;
    }

    if (cmd === 'web-serve') {
      const wcfg = { ...cfg };
      const mode = args.flags.get('mode') ?? wcfg.webWatchMode ?? 'cdp';
      const cdpUrl = args.flags.get('cdp-url');
      const host = args.flags.get('host');
      const port = args.flags.get('port');
      const mc = args.flags.get('message-capture');
      const cap = args.flags.get('capture');
      await startWebServe(wcfg, cwd(), {
        mode: String(mode),
        cdpUrl: cdpUrl != null ? String(cdpUrl) : undefined,
        host: host != null ? String(host) : undefined,
        port: port != null ? Number(port) : undefined,
        messageCapture: mc != null ? String(mc) : undefined,
        capture: cap != null ? String(cap) : undefined,
      });
      return;
    }

    printJson({ ok: false, error: `未知命令: ${cmd}` });
    process.exitCode = 1;
  } catch (e) {
    printJson({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
    process.exitCode = 1;
  }
}

main();
