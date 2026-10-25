# AgentRouter 插件（magpie）

给 magpie 接入 [agentrouter.org](https://agentrouter.org/)：模型、余额、每日签到，以及**可自定义请求头**。

## 为什么需要自定义请求头

AgentRouter 的网关只回应它认识的客户端。同一个 key：

| User-Agent | 结果 |
|---|---|
| `codex_cli_rs/0.101.0` | `200` |
| `curl/8.0` | `401 unauthorized client detected` |
| 空（删掉） | `401` |

所以请求头在这里不是装饰，是**决定成败**的东西。插件默认发 Codex CLI 的头，并且允许你在两处覆盖：

- **provider 级**：`providers.json` 里该 provider 的 `headers`
- **账号级**：登录时填的 `headers`（覆盖 provider 级）

格式是「一行一个 `Name: value`」，空行和 `#` 开头跳过 —— 从浏览器 devtools 整段复制过来就能用。

## 两个凭据，别混

AgentRouter 是 New API 站，它把两件事分给两种凭据：

| 用途 | 凭据 | 来源 |
|---|---|---|
| 对话/模型列表 | API key `sk-…` | 站点「令牌」页 |
| **每日签到 / 余额** | **access token** | 站点「个人设置 → 访问令牌」 |

`sk-` key 打到 `/api/user/*` 一律返回 `access token 无效` —— 这是实测结论，不是猜测。所以插件把 access token 做成登录时的独立一项：**不填也能用**，只是签到会返回 `ineligible` 并说明原因，不会假装签到成功。

## 签到

- 路由：`GET /api/user/checkin`（New API 标准签到路由）
- 返回 `claimed` / `done` / `inactive` / `captcha` / `failed` / `ineligible`
- 站点自己说「今日已签」时归为 `done`，不会每 30 分钟重试
- 遇到验证码返回 `captcha`，插件**不**去解验证码
- magpie 的调度：每个账号每个北京日一次，启动 2 分钟后首查，之后每 30 分钟

## 协议：只有 Responses API

AgentRouter 的模型**不支持** `/v1/chat/completions`：

```
400 模型 gpt-5.6-sol 不支持 /v1/chat/completions 接口，请改用 /v1/responses
```

所以 provider 声明为 `npm: "@ai-sdk/openai"`（Responses）。agent 发 Chat / Anthropic 请求时，由 magpie 网关负责翻译。

## 登录

面板或 CLI 的登录问答（**密钥最后单独问**）：

1. 请求端点（对话与模型列表）—— 默认 `https://agentrouter.org`
2. 签到站点 —— `agentrouter.org` / `ps.air-outer.com`
3. 访问令牌 —— 可留空，留空则跳过签到
4. 用户 ID —— 仅当站点要求时填
5. 自定义请求头 —— 每行一个 `Name: value`，留空用默认
6. **API 密钥**（`sk-…`）

> 这里**没有** `authorize` 钩子，是有意的：宿主调用 `authorize(inputs)` 时密钥**不在 inputs 里**
> （它是独立参数），在 `authorize` 里读 `inputs.key` 永远为空，会把正确密钥判成失败。
> 去掉它，宿主就会自己保存 `{type:"api", key, metadata: inputs}`。

## 改请求头（不用重新登录）

```bash
./set-ar-headers.sh 'User-Agent: codex_cli_rs/0.101.0'
./set-ar-headers.sh ''          # 清空，回到默认
```

脚本默认读 `/opt/magpie/config/magpie/plugin-auth.json`，用 `AUTH_FILE` 覆盖。

三层覆盖（后者覆盖前者）：插件默认 → 模型级 `headers`（面板可改）→ 账号级 `metadata.headers`。

## 安装

```bash
# 下面假设 magpie 以 Docker 跑、配置卷挂在 /opt/magpie/config（按你的部署改）
VOL=/opt/magpie/config

# 1. 放进容器可见的卷内
mkdir -p "$VOL/magpie/local-plugins"
cp -r . "$VOL/magpie/local-plugins/agentrouter"
chown -R 65532:65532 "$VOL/magpie/local-plugins"

# 2. 装进 magpie
docker exec magpie magpie plugin add /config/magpie/local-plugins/agentrouter

# 3. 登录（交互式）
docker exec magpie magpie plugin login agentrouter
```

不是 Docker 的话，把插件目录直接交给 magpie 即可：

```bash
magpie plugin add /path/to/agentrouter
magpie plugin login agentrouter
```

`plugin-auth.json` 的形态：

```json
{
  "agentrouter": {
    "type": "api",
    "key": "sk-…",
    "metadata": {
      "endpoint": "https://agentrouter.org",
      "site": "org",
      "accessToken": "（签到用，可省）",
      "userId": "（站点要求时填）",
      "headers": "User-Agent: codex_cli_rs/0.101.0"
    }
  }
}
```

改完 `docker restart magpie`。

## 端点与签到站点是分开的

- `endpoint`（默认 `https://agentrouter.org`）：对话和模型列表走这里
- `site`（`org` / `air`）：签到和余额走这里

所以你可以请求打 `agentrouter.org`、签到走 `ps.air-outer.com`，两者互不影响。

## 验证

```bash
docker exec magpie magpie provider test agentrouter
#   ✓ responses  3469 ms · gpt-6-astra
```

## 敏感词正则过滤（配套）

用社区中间件，不必自己写：

```bash
docker exec magpie magpie plugin add @magpie-community/middleware-word-guard
docker exec magpie magpie plugin options word-guard '{
  "action": "reject", "check": "last",
  "patterns": ["\\b\\d{3}-\\d{4}\\b", "secret[-_]?codename"],
  "words": [], "replies": false
}'
```

实测：命中 → `400 this request has "123-4567", which this gateway doesn't send`；正常 → `200`。

### 两个坑

1. **不要写 `(?i)`**。word-guard 把 `patterns` 拼进一个已经带 `gi` 的正则，再写 `(?i)` 会变成
   `Invalid group`，**整个匹配器失效**，于是什么都不拦（失败计数会涨）。大小写本来就忽略。
2. **它只过滤 agent 发的请求**。中间件挂在 `serveAgent` 上，curl 直连网关走 `serve`，不经过它。
   验证时要带 agent 的 User-Agent 或 `magpie-<app>` 形式的 key。

它只读用户自己写的文字（user message），不读工具结果、工具调用和 system prompt。

## 文件

- `index.mjs` — 插件本体（provider + 自定义头 + 余额 + 签到）
- `package.json` — 包描述
