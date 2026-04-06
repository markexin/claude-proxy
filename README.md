# 网页对话自动化（Playwright）

通过 **Playwright** 操作浏览器中的聊天页：支持 **Cookie 注入** 启动 Chromium、或 **CDP** 连接本机已登录的 Chrome；可 **读 DOM**、**监听变化**，或 **HTTP 接口** 发送消息并取回复。

---

## 环境要求

- [Node.js](https://nodejs.org/)（建议 LTS）
- 首次使用需安装 Playwright 自带的 Chromium：

```bash
npm install
npm run install-browser
```

---

## 快速开始

1. 复制配置模板：

```bash
# Windows
copy config.example.json config.json
# macOS / Linux
cp config.example.json config.json
```

2. 编辑 `config.json`，至少设置 **`webChatUrl`** 为你的会话地址（含对话 ID）。

3. 任选一种登录态方式（见下文「登录与 Cookie」）。

4. 运行命令（示例）：

```bash
node src/cli.js help
node src/cli.js web-messages
node src/cli.js web-serve
```

---

## 配置说明（`config.json`）

| 配置项 | 说明 |
|--------|------|
| `webChatUrl` | 聊天页完整 URL（必改） |
| `webPageUrlIncludes` | CDP 模式下匹配标签页的 URL 子串；**留空**则从 `webChatUrl` 解析主机名 |
| `webMessageSelector` | 消息气泡的 CSS 选择器（豆包默认 `[data-testid="message_text_content"]`） |
| `webInputSelector` | 输入框选择器；留空则自动探测（含 `chat_input_input` 等） |
| `webCookieSource` | `auto` / `file` / `env`：Cookie 来源 |
| `webCookieFile` | 文件模式时的 Cookie 文件路径（默认 `doubao-cookies.txt`） |
| `webCookieDomain` / `webCookieOrigin` | 注入 Cookie 时的域与 Origin（换站点需改） |
| `webHeadless` | `web-messages` / `web-chat` 是否无头；命令行 `--headed` 可临时有头 |
| `webReplyWaitMs` / `webReplySettleMs` / `webReplyPollMs` | 发送后等待回复与流式稳定相关 |
| `webWatchMode` | `cdp`（连本机 Chrome）或 `persistent`（Playwright 持久化目录） |
| `webCdpUrl` | CDP 地址，默认 `http://127.0.0.1:9222` |
| `webMessageCaptureMode` | `dom`（读 DOM）或 `sse`（见下节） |
| `webSseUrlIncludes` | 过滤 URL 子串；留空则按 `webChatUrl` 推断；值为 `*` 或 `all` 时匹配全部 URL |
| `webSseDebug` | `true` 时在 stderr 打印 Playwright 捕获到的 WebSocket 连接 URL |
| `webServeHost` / `webServePort` | HTTP 服务监听地址与端口 |
| `webServeToken` | 非空则要求鉴权（也可用环境变量 `DOUBAO_WEB_SERVE_TOKEN`） |
| `webServeCorsOrigin` | 跨域时设为 `*` 等（勿与公网暴露同用） |
| `webServeChatResponseFormat` | `openai`（默认，OpenAI 风格 `chat.completion`）或 `legacy`（旧版 `ok` / `replyText` 等） |
| `webOpenAiCompatModel` | 响应里 `model` 字段的默认值（请求体带 `model` 时以请求为准） |
| `webServePreferSseReply` | `web-serve` 在 `sse` 模式下是否优先等 CDP/SSE 再返回（默认 `true`，比纯 DOM 更快） |
| `webServeAssumeOpenAiStream` | 对 **`POST /v1/chat/completions`**，请求 JSON **未写 `stream`** 时是否按流式 SSE 响应（默认 `true`，便于 Cursor）；`false` 则与 OpenAI 一致默认非流式 |
| `webServeStreamChunkChars` | 流式响应里每块 `delta.content` 最大字符数（默认 `160`） |

更全字段见仓库内 **`config.example.json`**。另支持 **`config.local.json`** 覆盖（且已在 `.gitignore` 思路外需注意勿提交密钥）。

---

## 登录与 Cookie

### 方式 A：Cookie 文件 / 环境变量（`web-messages`、`web-chat`）

1. 在浏览器中登录目标站点，打开开发者工具 → **Application → Cookies**，对对应站点导出或逐条复制（**须含 HttpOnly**；不要用控制台 `document.cookie`）。
2. 写入项目根目录 **`doubao-cookies.txt`**（勿提交 Git），或在 `config.json` 设 `webCookieSource` 与 `webCookieFile`。
3. 也可设置环境变量 **`DOUBAO_COOKIE`**（`webCookieSource: auto` 时优先于文件）。

### 方式 B：CDP 连接已打开的 Chrome（`web-watch`、`web-serve`）

1. 关闭其他占用同一用户数据的 Chrome 实例后，用**独立用户目录**启动带调试端口的 Chrome（**勿把调试端口暴露到公网**），例如 Windows：

```text
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%TEMP%\doubao-chrome-debug"
```

2. 在该窗口打开 `webChatUrl` 对应会话并完成登录。
3. 运行 `web-watch` 或 `web-serve`；**Ctrl+C** 只会断开自动化连接，**一般不会关掉**你这个 Chrome 窗口。

若连接报错 `ECONNREFUSED`，说明本机 `9222` 上没有浏览器在监听，请检查是否用上述参数启动。

### 方式 C：持久化目录（`--mode persistent`）

由 Playwright 使用本地目录（默认 `.doubao-playwright-profile`）启动浏览器，首次手动登录。**结束进程时会关闭该 Playwright 浏览器窗口**（与 CDP 行为不同）。

---

## 命令说明

查看内置帮助（JSON）：

```bash
npm start
# 或
node src/cli.js help
```

### `web-messages`

使用 Cookie 启动 Chromium，打开 `webChatUrl`，读取当前页消息 DOM，打印 JSON。

```bash
node src/cli.js web-messages
node src/cli.js web-messages --headed
```

### `web-chat`

注入 Cookie 后，在页面输入框发送内容，等待回复并打印 JSON（含 `replyText`、`messages` 等）。

```bash
node src/cli.js web-chat 你好
node src/cli.js web-chat --headed 你好
node src/cli.js web-chat --file prompt.txt
```

### `web-watch`

连接 CDP 或持久化浏览器，将消息变化以 **NDJSON** 形式输出到 **stdout**（每行一条 JSON）。

```bash
node src/cli.js web-watch
node src/cli.js web-watch --mode persistent
node src/cli.js web-watch --poll-only --interval 3000
node src/cli.js web-watch --message-capture sse
node src/cli.js web-watch --cdp-url http://127.0.0.1:9222
```

- **`capture` 字段**：`dom` 或 `sse`，与 `webMessageCaptureMode` / `--message-capture` 一致。
- 简写：`--capture sse`。

### `web-serve`

启动本地 **HTTP 服务**（默认 `http://127.0.0.1:3840`）。

```bash
npm run web-serve
node src/cli.js web-serve --port 3840 --host 127.0.0.1
node src/cli.js web-serve --message-capture sse
```

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` 或 `/health` | 服务状态与路由说明 |
| GET | `/messages` | 读取快照：`dom` 模式读 DOM；`sse` 模式返回 SSE 缓冲 |
| POST | `/chat` | 发送消息并等待回复（见下） |
| POST | `/v1/chat/completions` | 与 `/chat` 相同；**Cursor 等默认走流式**：未传 `stream` 时默认 **`text/event-stream`**（`chat.completion.chunk`），与 `webServeAssumeOpenAiStream` 有关；要整段 JSON 请加 **`"stream": false`** |
| GET | `/v1/models/{id}` | 查询单个模型元数据（与列表中 `id` 一致） |

**请求体**（`application/json`）：

- 简写：`{"prompt":"你好"}`（或 `text` / `message` / `content`）
- **OpenAI 兼容**：`{"model":"任意展示名","messages":[{"role":"user","content":"你好"}]}`

**响应**（默认 `webServeChatResponseFormat: openai`）：标准 `chat.completion` 形态（`id`、`choices[0].message.content`、`usage` 等）。`usage` 为本地粗算 token，非官网精确值。设为 `legacy` 时仍为旧版 `ok` / `replyText` 等字段。

**鉴权**（可选）：配置 `webServeToken` 或环境变量 `DOUBAO_WEB_SERVE_TOKEN` 后，请求需带：

- 头：`Authorization: Bearer <token>`，或  
- 查询参数：`?token=<token>`

**示例：**

```bash
curl -s http://127.0.0.1:3840/health
curl -s -X POST http://127.0.0.1:3840/chat -H "Content-Type: application/json" -d "{\"prompt\":\"你好\"}"
```

说明：**`POST /chat`（及 `/v1/chat/completions`）** 通过 **DOM** 在页面里输入并发送；在 **`sse` 模式下优先用 CDP 捕获的流式结果** 作为回复（见 `webServePreferSseReply`）。**`GET /messages`** 受 `webMessageCaptureMode` / `--message-capture` 影响。

### 在 Cursor 里接入本项目的 `web-serve`

Cursor 可把「自定义 OpenAI 兼容接口」指到本机，从而用 **已登录的浏览器会话**（如 Claude 网页）完成对话。

1. **先按上文「方式 B」** 用 CDP 启动 Chrome，打开 `webChatUrl` 并登录；再在本机启动（**建议 SSE**，响应更快、格式为 OpenAI 兼容）：

   ```bash
   node src/cli.js web-serve --message-capture sse
   ```

2. 确认 **`config.json`** 中 **`webServeChatResponseFormat`** 为 **`openai`**（默认），且 **`webOpenAiCompatModel`**、**`webServePort`** 等符合你的习惯。

3. 打开 **Cursor → Settings（设置）→ Models / 模型**（具体菜单名随版本可能略有不同），找到 **OpenAI API** 相关项：

   - **Override OpenAI Base URL**（或「自定义 API 地址 / Base URL」）填：  
     **`http://127.0.0.1:3840/v1`**  
     （Cursor 会请求 `{Base URL}/chat/completions`，即本服务的 **`POST /v1/chat/completions`**。）
   - **API Key**：若未配置 `webServeToken`，可填任意占位字符串（如 `local`）；若已配置 Token，则填相同值，并在 Cursor 里使用 **Bearer** 方式（与 `curl` 一致）。

4. 在模型列表里 **添加自定义模型**：名称须与 **`GET /v1/models`** 里返回的 **`data[].id`** 完全一致。默认使用 **`local/web-bridge`**（`命名空间/模型`，类似硅基流动，多数客户端校验更松）；**不要用** **`gpt-4o`** 等官方 id（易触发地区限制，见下条）。若 Cursor 仍报 **Model name is not valid**，可改用列表里仅含 **字母数字与下划线** 的备选（默认 **`custom_web_bridge`**），或在 `config.json` 里把 `webOpenAiCompatModels` 改成你能通过校验的字符串。

5. **若出现 “This model provider doesn't serve your region”**：多半是 Cursor 把 **`gpt-4o`** 等当成了 **自家/官方的 OpenAI 线路**，先做 **地区与账号策略校验**，**没有走你填的 Base URL**。请改用 **`local/web-bridge`** 这类 **非官方目录 id**，并确保对话里选的模型与 **`/v1/models`** 一致。可先在本机验证已打到本地：

   ```bash
   curl -s http://127.0.0.1:3840/v1/models
   curl -s -X POST http://127.0.0.1:3840/v1/chat/completions -H "Content-Type: application/json" -d "{\"model\":\"local/web-bridge\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
   ```

6. **注意**：
   - **`POST /v1/chat/completions`** 已支持 **OpenAI 流式协议**（`text/event-stream`、`data: {...}`、`[DONE]`）。正文仍在页面与 CDP **整段就绪后**再分块写出，属「协议兼容」而非逐 token 真流式。
   - 若连接异常，可在 Cursor **Settings → Network** 尝试 **HTTP Compatibility Mode / 使用 HTTP/1.1**（部分环境对本地 HTTP/2 不友好）。社区讨论：[Cursor Forum — Override OpenAI Base URL](https://forum.cursor.com/t/override-openai-base-url/152006)。
   - 延迟取决于网页生成与 CDP 抓包，通常长于直连官方 API。
   - **勿将** `web-serve` 绑到公网；仅本机或可信网络使用。
   - **Override OpenAI Base URL** 建议写 **`http://127.0.0.1:3840/v1`**（末尾 **`/v1`**，无尾斜杠亦可），与 Cursor 请求 **`/v1/chat/completions`**、`/v1/models` 的路径拼接一致。

---

## 消息捕获：`dom` 与 `sse`

- **`dom`（默认）**：根据 `webMessageSelector` 等从页面 DOM 读取文本；`web-watch` 可用 MutationObserver 或轮询。
- **`sse`**（名称沿用，实际包含多种流）：
  - **Playwright `page.on('websocket')`**：在浏览器侧监听 **WebSocket 下行帧**（Claude 等常用，且不依赖页面里能否 hook 到 `WebSocket`）。
  - **页面内**：`fetch` + `text/event-stream`、`EventSource` 的 `data:` 行。

**重要**：请先启动 **`web-watch` / `web-serve` 并连上 CDP**，再对聊天页 **F5 刷新**（或重新打开会话），这样之后建立的 WebSocket 才会被 Playwright 挂到监听上；在「先连上 WS、后连自动化」的旧页面上往往收不到帧。

`webSseUrlIncludes` 需能匹配实际请求 URL：Claude 的 **SSE 在 `https://claude.ai/api/...`**（`fetch`），不一定带 `anthropic` 字符串；另有流可能走 **WebSocket**。可用 `claude.ai` 或 `*`。调试时可设 **`"webSseDebug": true`** 查看 Playwright 打开的 `wss://` 连接。

修改 `config.json` 中 `webMessageCaptureMode` 或使用 **`--message-capture sse`** 后，需**重启** Node 进程。

---

## 更换其他聊天站点（如 Claude）

1. 修改 **`webChatUrl`** 为目标对话 URL。
2. **`sse` 模式与 `webSseUrlIncludes`**：Claude 网页的流式接口是 **`https://claude.ai/api/.../completion`**，响应头为 **`text/event-stream`**（你复制的 curl 即如此）。过滤串必须能匹配 **`claude.ai`**；若只填 **`anthropic`**，则**不会**匹配到这条 URL，缓冲区会一直是空的。可填 **`claude.ai`**、**`*`**，或留空（由 `webChatUrl` 解析出 `claude.ai`）。
3. 在开发者工具中重新确认 **消息列表** 与 **输入框** 的选择器，更新 **`webMessageSelector`**、**`webInputSelector`**。
4. Cookie 模式需同步修改 **`webCookieDomain`**、**`webCookieOrigin`** 及 Cookie 文件来源域名。

---

## 安全提示

- **Cookie、Token、CDP 端口**均属高敏感信息，勿提交到仓库；建议将 `doubao-cookies.txt`、`config.local.json` 排除在版本控制外。
- 远程调试端口仅在本机或可信网络使用；勿绑定 `0.0.0.0` 并暴露到公网。
- 使用第三方网页自动化前，请遵守该网站服务条款与当地法规。

---

## 许可证

ISC（见 `package.json`）。
