# AgentRouter 插件（magpie）

给 magpie 接入 [agentrouter.org](https://agentrouter.org/)：模型调用、余额与用量查询、每日自动签到，以及**可自定义请求头**。

## 🚀 快速上手 (Quick Start)

只需 3 步即可完成插件安装、账号配置与客户端接入：

### 1. 安装插件

#### Docker 部署（推荐）
将插件克隆至 magpie 配置卷中的本地插件目录：
```bash
# 假设 magpie 配置卷挂在宿主机 $VOL（按你的实际部署路径修改）
VOL=/path/to/magpie/config          # 例：/opt/magpie/config

mkdir -p "$VOL/magpie/local-plugins"
git clone https://github.com/ZhaoJun233/agentrouter-magpie-plugin.git "$VOL/magpie/local-plugins/agentrouter"
chown -R 65532:65532 "$VOL/magpie/local-plugins"   # 容器内运行用户 uid，按镜像实际情况修改

# 在 magpie 容器中加载插件
docker exec magpie magpie plugin add /config/magpie/local-plugins/agentrouter
```

#### 本地 / 原生进程部署
```bash
git clone https://github.com/ZhaoJun233/agentrouter-magpie-plugin.git
magpie plugin add /path/to/agentrouter-magpie-plugin
```

---

### 2. 登录并绑定账号

运行交互式登录命令：
```bash
docker exec -it magpie magpie plugin login agentrouter
# 非 Docker 环境直接运行：magpie plugin login agentrouter
```

根据需求选择以下两种登录方式之一：

#### 方案 A：GitHub 授权登录（推荐，支持读取额度）
适合已绑定 GitHub 的 AgentRouter 账号，可自动获取 key、用户 ID 并读取实时余额：
1. **获取系统访问令牌**：登录 [AgentRouter 官网](https://agentrouter.org/)，点击右上角头像进入「个人设置」→「访问令牌」，复制**系统访问令牌**（注意：**不是** `sk-…` API 密钥，也**不是** GitHub Personal Access Token）。
2. 在终端登录交互中选择 `用 GitHub 登录 AgentRouter（推荐）`。
3. 按提示粘贴第 1 步复制的系统访问令牌。
4. 终端会生成 GitHub 授权 URL 并在浏览器中打开；完成授权后，浏览器会跳转至 `agentrouter.org/oauth/github/magpie?...`。
   > ⚠️ **跳转后显示「页面未找到」是正常现象**（站点在此特定子路由不会提早自动兑换授权码）。请直接从浏览器地址栏**完整复制该整条 URL**（包含 `code=…`）。
5. 粘贴回终端回车，插件将自动完成凭据保存与登录。

#### 方案 B：API 密钥快速登录（最简，仅模型对话）
如果仅需调用模型进行聊天/编程，无需读取余额与签到：
1. **获取 API 密钥**：登录 AgentRouter，在「令牌」页面新建或复制已有密钥（`sk-…`）。
2. 在终端登录交互中选择 `AgentRouter API 密钥`。
3. 按照提示输入参数：
   - **请求端点**：直接按**回车留空**（默认 `https://agentrouter.org`，**切勿在此处填入 `sk-…` 密钥**）。
   - **站点**：回车默认选择 `agentrouter.org`。
   - **用户名 / 密码 / Cookie / 用户ID / 自定义头**：仅需对话时**全部直接按回车跳过**；如需密码自动签到，可填入站点的用户名与独立密码。
   - **API 密钥**：最后单独提示时，粘贴你的 `sk-…` 密钥。

---

### 3. 测试与验证

绑定完成后，执行以下命令验证状态：

```bash
# 1. 测试模型对话是否正常响应
docker exec magpie magpie provider test agentrouter
# 成功时输出类似：✓ responses  3469 ms · gpt-6-astra

# 2. 查看已识别并激活的模型列表
docker exec magpie magpie provider models agentrouter

# 3. 检查账号额度与用量读取
docker exec magpie magpie quota agentrouter
```

---

### 4. 在客户端中调用

在任何兼容 OpenAI 接口的客户端（如 Chatbox、NextChat、OpenCode、Cherry Studio、Cursor 等）中配置：

- **API 接口地址 (Base URL)**：`https://你的-magpie-域名/v1`（本地直连填 `http://localhost:3425/v1`）
- **API Key**：你在 magpie 中配置的 Caller Key（网关访问密钥）
- **模型名称**：
  - `agentrouter/gpt-5.6-sol`
  - `agentrouter/gpt-6-astra`
  - `agentrouter/gpt-6.1-sol`
  （或你在 magpie 中配置的统一全局模型名称）

> 💡 **请求头说明**：AgentRouter 网关强制校验客户端标识（User-Agent 白名单）。本插件**默认已自动附带官方兼容的客户端请求头**，日常在任意客户端发起调用均无需做任何额外请求头配置。

---

## 登录方式与需要填写的内容

| 方式 | 需要什么 | 能读取什么 |
|---|---|---|
| **用 GitHub 登录**（推荐） | 先填系统访问令牌，再浏览器授权并复制回调地址 | 保存手填令牌，自动获取 API 密钥、session Cookie 和用户 ID；余额读取仍可能被 WAF 拦截 |
| API 密钥 | `sk-…` | 对话、模型列表、累计消耗；不能推算剩余额度 |
| API 密钥 + Cookie 或访问令牌 | Cookie 只填 Cookie 的值（`session=…`，多个用 `; ` 连接），同时填用户 ID；或有效访问令牌 + 用户 ID | 尝试读取当前余额；被 WAF 拦截时降级到累计消耗 |
| API 密钥 + 站点用户名密码 | 站点账号密码，GitHub 密码不能代替 | 登录签到，并尝试从登录响应读取当前余额 |

API 密钥登录时，Cookie 和访问令牌任选其一即可。GitHub 登录需要先填写同一 AgentRouter 账号的系统访问令牌（「个人设置 → 访问令牌」），不能为空；不是 `sk-…` API 密钥，也不是 GitHub Token。Cookie 和用户 ID 由 GitHub 授权自动获取。访问令牌失效时可以继续尝试有效 Cookie；两者都不能保证通过滑动验证码。

## 签到：就是登录一次

这个站点**没有** `GET /api/user/checkin`。这一点是实测确认的，不是猜的：

```
/api/user/checkin  →  {"message":"无权进行此操作，权限不足"}
/api/user/check_in →  {"message":"无权进行此操作，权限不足"}
/api/user/foo      →  {"message":"无权进行此操作，权限不足"}
/api/user/zzz      →  {"message":"无权进行此操作，权限不足"}
```

四者**一模一样**，因为 `/api/user/checkin` 并没有对应路由，请求落到了 New API 的**管理员**路由 `/api/user/:id` 上。站点的每日额度是在**登录时**发放的 —— 登录响应带 `checked_in`，站点前端据此弹「签到成功，新增额度已到账」，后台设置项叫 `DailyCheckinQuota`。

所以插件把签到实现为「登录一次」：

- 有用户名密码 → `POST /api/user/login`，`checked_in: true` 记 `claimed`，`false` 记 `done`
- 没有密码 → 返回 `ineligible`，并说明「签到就是登录一次，需要站点用户名和密码」
- 密码错误 → `ineligible` + `signIn: expired`，不会每 30 分钟重试
- 站点接口挂掉 → `failed`，交给 magpie 30 分钟后重试

> 用 GitHub 登录的账号可能**没有站点密码**。要密码签到，先去站点「设置」里设一个密码。

## 余额与累计消耗

读取顺序：

1. 有 Cookie 或访问令牌时，带用户 ID 请求 `GET /api/user/self`，读取 `quota`（剩余）和 `used_quota`（累计消耗）。
2. 失败后，有站点用户名密码则 `POST /api/user/login`，尝试从登录响应读取同样的字段。
3. 仍无余额时，尝试 `GET /api/log/self/stat`，读取账号累计消耗。
4. 再失败则用 API 密钥请求 `/v1/dashboard/billing/usage`，将 `total_usage` 的美分换成美元。

只有前两条返回完整额度字段时才显示余额和使用比例。缺字段不会当成零。只读到消耗时，插件返回“累计消耗 $…；剩余额度未知”，不会把消耗计入余额，也不会生成虚假的 0% 使用条。

magpie 可能在查询失败时保留上次成功的额度，并标记旧读取时间（`asOf`）。这种余额是历史数据，不能当成刚查到的实时余额；没有历史读数的账号会直接显示上述状态提示。

`/api/user/self` 常返回 HTTP 200 的阿里云滑动验证码 HTML，偶尔放行。有效 Cookie 也可能被拦；复制浏览器 Cookie 后不保证服务器可以读取。插件不自动破解滑块。

`/api/token/` 的 `remain_quota` 是单把令牌的限额，不是账号余额；无限令牌的该值可能为负。`/api/log/self/stat` 和 billing usage 只有消耗，不能用于推算余额。

## 为什么需要自定义请求头

AgentRouter 的网关只回应它认识的客户端 —— 白名单里是它**自家客户端**的标识。同一个 key：

| User-Agent | 结果 |
|---|---|
| `codex_cli_rs/0.101.0` | `200` |
| 浏览器（Chrome / Mobile Safari 的完整 UA） | `401 unauthorized client detected` |
| `curl/8.0` | `401 unauthorized client detected` |
| 空（删掉） | `401` |

**这条只管模型网关**（`/v1/models`、`/v1/responses`）。站点自己的路由（`/api/...`）不看这个头，浏览器 UA 也一样能用；反过来，`codex_cli_rs` 也不会帮忙过滑动验证码。

所以请求头在这里不是装饰，是**决定成败**的东西。插件默认发 Codex CLI 的头，并且允许你在三处覆盖：

- **开关**（provider 编辑器里的 `Send the Codex client headers`）：默认开。关掉后不再发默认的 Codex 标识，只发你自己给的头 —— 适合你已经有别的可用标识时。
- **provider 级**：`providers.json` 里该 provider 的 `headers`
- **账号级**：登录时填的 `headers`（覆盖 provider 级）

格式是「一行一个 `Name: value`」，空行和 `#` 开头跳过。这里**只适合放这种头**：不要整段粘贴浏览器 devtools 的请求头 —— `Cookie` 有专门的一问，`Authorization` 由插件按 key/令牌设置，而 `User-Agent` 应该填**网关认的客户端标识**，不是浏览器的那一长串。

> 踩坑记录：把 Mobile Safari 的完整 `User-Agent` 贴进 `headers` 后，`/v1` 一律 401
> `unauthorized client detected`，而站点路由（余额、签到）却一切正常 —— 很容易以为是 key 或插件坏了。
> 网关只认它自己的客户端标识，换回 `codex_cli_rs/0.101.0`（或清空、用默认）即恢复。

## 凭据用途

- API key `sk-…`：对话、模型列表、累计消耗。
- session Cookie / access token + 用户 ID：账号数据读取；余额可能被 WAF 拦截。
- 站点用户名密码：登录签到，并尝试读取余额。访问令牌不能密码签到。

`sk-` key 不能代替账号访问令牌。`/api/user/token` 会重新生成访问令牌，使旧令牌失效；插件不调用此接口，GitHub 登录直接保存你填写的系统访问令牌。

## 协议：只有 Responses API

AgentRouter 的模型**不支持** `/v1/chat/completions`：

```
400 模型 gpt-5.6-sol 不支持 /v1/chat/completions 接口，请改用 /v1/responses
```

所以 provider 声明为 `npm: "@ai-sdk/openai"`（Responses）。agent 发 Chat / Anthropic 请求时，由 magpie 网关负责翻译。

## 模型列表从哪来

面板里的模型来自**两个来源的并集**：

1. **插件自己的名单**（本仓库 `index.mjs` 的 `DECLARED_MODELS`）：登录前展示用，也是读不到站点列表时的兜底。当前是 `gpt-5.6-sol` / `gpt-6-astra` / `gpt-6.1-sol`。
2. **magpie 自带的 models.dev 目录**：`magpie` 会把目录里同名条目（`agentrouter`）的模型并进来。这个目录在服务器上是 `config/cache/magpie/models.json`，**由 magpie 自己同步，不由本插件控制**。

两者取并集去重。因此如果站点下架了某个模型，而目录缓存里还留着，面板就会多列出已下架的模型 —— 选中它只会得到：

```
503 当前分组 default 下对于模型 xxx 无可用渠道
```

插件这边能保证的是：**站点自己的列表**（`GET /v1/models`，账号有效时）永远优先，读不到时才回落到插件名单，而**不会再回落到目录里那些名字**。所以正确的做法是让站点列表生效：

```bash
# 让 magpie 重新拉一次账号的模型列表
docker exec magpie magpie providers        # 状态里会写 "N of M models · fetched …"
docker exec magpie magpie provider models agentrouter
```

如果你的面板仍显示已下架的模型，那是目录缓存的贡献，不是插件声明的。可以：

- 在 provider 编辑器里把不需要的模型关掉（`disabled`），它们在列表里就不再生效；
- 或者清掉/更新 `config/cache/magpie/models.json` 里的 `agentrouter` 条目（升级 magpie 也会刷新目录）。

> 站点给你几个模型，以 `GET /v1/models` 为准 —— 它和面板是两回事。

## 内容过滤器：被拒的请求不是限流

AgentRouter 在模型前面挂了自己的**内容过滤器**。它拒绝一段文字时回的是 HTTP **400**、
`code: "content-blocked"`，既不提密钥也不提额度，看上去很像一个可以重试的临时故障。

实测（2026-10-30，org 站点）：

| 内容 | 结果 |
|---|---|
| 普通长文，20 万 token | `200` |
| 20 万 token 的重复句 | `200` |
| 含 `transcript` 的短句（3 个 token） | **`400 content-blocked`** |
| `Here is the transcript of our call.` | **`400 content-blocked`** |

也就是说：**与体积无关，是某些词和自指句式被拦**。具体词表是厂商的，插件不复述；能确定的是
改写那句话就能过。

### 为什么它会被误当成 429

magpie 判断「换一个服务商是否可能成功」时，会在错误体里匹配额度/限流类词
（`internal/gateway/fallback.go` 的 `retryable` / `quotaWords`）。被拒的 400 一旦读起来
像限流，magpie 就会**在多个账号上重试、再故障转移到别的服务商**——最后落在 Codex 上，
而 Codex 额度耗尽，于是看到的是 **`429 Codex: The usage limit has been reached`**。

这正是「AgentRouter 429 限流」的真实来源：根因是内容被拒，429 是级联产物。

插件现在的做法：把这种拒绝改写为明确说明，且**措辞里不含任何额度/限流类词**
（有测试守着这一条），于是 magpie 不再重试、不再转移。状态码保持 400，厂商的
`code` 与 `request id` 都保留，方便报障。

修复前后同一个被拒请求：

| | 状态 | magpie `tries` | 最终落到 |
|---|---|---|---|
| 修复前 | 400 → 重试 → 转移 | 5 | Codex 的 **429** |
| 修复后 | **400**，就地说明 | — | AgentRouter 自己 |

> 遇到这个 400：改写被拒的那句话，或换服务商。等它、重发它，都不会通过。

## 真正的 429：每分钟 token 上限

除了上面的内容拒绝，AgentRouter 确实会真的回 **429**，原文是：

```json
{"message":"Your requests to gpt-6.1-sol for gpt-6.1-sol in eastus2 have exceeded token rate limit.","type":"api_error"}
```

这是上游明确报告的 **token 速率上限**，不能据此断言账号余额用尽。厂商没有给出
具体计数范围、准确阈值或恢复时间；也不能仅凭多个账号同时失败就断言它们共用同一个计数器。

### 为什么会显示 200 / 零用量空回，同时又出现 429

上游会先发 **HTTP 200 + `text/event-stream`**，随后在流中报告失败。
旧插件只检查 HTTP 400/429，因此漏掉这种流内错误，也没有补上等待时间。
magpie 识别流内错误为 429 后，可能立即换账号，再对同一账号进行短间隔重试。
上游未生成有效回答时可能记为零用量，但**零用量本身不是限流的证据**。

修复后的处理：

- 在首段正文、推理或工具调用发出前，检查 SSE 的元数据前缀。明确的 token 速率错误
  转成 **HTTP 429**；明确的内容拒绝转成 400。支持嵌套 JSON 错误及 HTTP 200 JSON 错误信封。
- **保留上游 `Retry-After` 和 request-id**；仅对已识别的 token 速率错误，在上游没有
  给出等待时间时补 `Retry-After: 60`。60 秒是保守建议，**不保证一分钟后恢复**。
  magpie 对超过 8 秒的等待不再做秒级同账号重试；跨账号调度仍由宿主决定。
- `response.completed` 明确给出空 `output`、输入/输出用量均为零且此前无有效输出时，
  单独报 **502 `agent_router_empty_response`**，不会伪装成限流。
- 正常响应逐字节透传。已有正文、推理或工具调用后的错误不重新包装，避免丢失部分输出
  或诱发工具重复执行。未知错误、普通 429、截断流也不会凭空变成 token 限流。
- 只检查最多 **64 KiB / 15 秒** 的流前缀；超过任一边界就原样放行，不缓存整段回答。
  插件自身不发起重试，也不绕过上游限制；默认 `magpie.maxConcurrency` 保持 **2**。

> 看到这个 429：遵循等待提示，降低并发并评估上下文大小。如果持续发生，应向上游提供
> request-id 查询真实阈值。插件修复的是错误识别与退避信息，不会增加上游可用容量。

## 登录问答（API 密钥方式）

面板或 CLI 的登录问答（**密钥最后单独问**）：

1. 请求端点（对话与模型列表）—— 可留空，默认 `https://agentrouter.org`；**这一问只填地址**，填了 `sk-…` 会被当场拒绝并提示
2. 站点 —— `agentrouter.org` / `ps.air-outer.com`
3. 用户名或邮箱 —— 可留空；填了才能密码签到
4. 密码 —— 可留空；只存本机
5. 浏览器 Cookie —— 可留空；填完整 `session=…`，不能保证通过 WAF
6. 访问令牌 —— 可留空
7. 用户 ID —— Cookie 或访问令牌读取账号数据时填写 `New-Api-User` 的值
8. 自定义请求头 —— 每行一个 `Name: value`，留空用默认
9. **API 密钥**（`sk-…`）

> 第 1 问**只填地址**。旧版本的这一问容易让人把 `sk-…` 粘进去，那会让对话请求打到 `sk-…/v1`，
> 表现是**每个模型都无响应、也不报错**（插件当时没有任何提示）。现在两头都堵上了：问答时校验，
> 以及读取该值时不是 `http(s)://` 就忽略、退回默认端点 —— 已经存坏的账号不用重新登录也能恢复。

> 这里**没有** `authorize` 钩子，是有意的：宿主调用 `authorize(inputs)` 时密钥**不在 inputs 里**
> （它是独立参数），在 `authorize` 里读 `inputs.key` 永远为空，会把正确密钥判成失败。
> 去掉它，宿主就会自己保存 `{type:"api", key, metadata: inputs}`。

## GitHub 登录怎么走

插件的 `authorize` 会：

1. `GET /api/oauth/state?mode=login` 拿站点签发的 state
2. 从 `/api/status` 读站点的 `github_client_id` 和 `server_address`，拼出 GitHub 授权 URL
3. 你在打开的页面授权后，浏览器跳到 `agentrouter.org/oauth/github/magpie`（GitHub app 是站点的，回调也归站点）
4. 把**那一整条地址**粘回插件，插件从里面取出 `code`
5. `GET /api/oauth/github?code=…&state=…` 兑换登录态，拿到用户记录（`id`、`quota`、`checked_in`）
6. 从响应头提取 `Set-Cookie: session=…`，保存登录前填写的系统访问令牌，不重新生成令牌
7. 用填写的访问令牌及授权返回的用户 ID 调 `/api/token/` 取出密钥

开始授权前必须先填系统访问令牌；留空会提示补填，不会发起 GitHub 授权。令牌应属于本次 GitHub 登录对应的 AgentRouter 账号。`session` 同时保存到 `metadata.cookie`，后续账号查询会带上它。

> **为什么回调要带 `/magpie` 这一段？** 站点自己的回调页 `/oauth/github` 是它单页应用里的一个路由，
> 页面一加载就**立刻**把 `code` 兑换掉。等用户从地址栏复制出来，这个 `code` 已经被用过了，
> 再拿去兑换只会得到 `code is incorrect or expired`——这就是「code 出现时间很短、复制到也报错」的原因。
>
> `/oauth/github/magpie` 是它下面的一层，**不是**路由，所以站点显示「页面未找到」而不碰这个 `code`。
> GitHub 允许回调是注册地址的子目录（见 [授权 OAuth 应用](https://docs.github.com/zh/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)），
> 且站点自己兑换 token 时根本不传 `redirect_uri`（见其 `oauth/github.go` 的 `ExchangeToken`），
> 所以这个地址只需在授权那一步通过即可。
>
> 因此跳过去看到「页面未找到」是**正常现象**，照常复制地址栏即可；真正让 code 失效的是站点那个会自兑换的回调页。

## 改请求头（不用重新登录）

```bash
./set-ar-headers.sh 'User-Agent: codex_cli_rs/0.101.0'
./set-ar-headers.sh ''          # 清空，回到默认
```

脚本默认读 `<magpie 配置目录>/magpie/plugin-auth.json`（Docker 部署常见为
`/opt/magpie/config/magpie/plugin-auth.json`），用 `AUTH_FILE` 覆盖。

三层覆盖（后者覆盖前者）：插件默认 → 模型级 `headers`（面板可改）→ 账号级 `metadata.headers`。

## 手动配置文件格式（plugin-auth.json）

除了上述 `magpie plugin login` 交互式登录外，也可以直接手动编辑配置文件。

`plugin-auth.json` 的形态：

```json
{
  "agentrouter": {
    "type": "api",
    "key": "sk-…",
    "metadata": {
      "endpoint": "https://agentrouter.org",
      "site": "org",
      "username": "（密码签到时填）",
      "password": "（只存本机）",
      "cookie": "session=…（可选，配合用户 ID）",
      "accessToken": "（可选，配合用户 ID 读账号数据）",
      "userId": "（Cookie/访问令牌读取时填）",
      "headers": "User-Agent: codex_cli_rs/0.101.0"
    }
  }
}
```

改完后执行 `docker restart magpie`（或重启 magpie 进程）生效。

## 端点与站点是分开的

- `endpoint`（默认 `https://agentrouter.org`）：对话和模型列表走这里
- `site`（`org` / `air`）：余额和签到走这里

所以你可以请求打 `agentrouter.org`、余额和签到走 `ps.air-outer.com`，两者互不影响。

## 额度百分比与字段说明

```bash
docker exec magpie magpie quota | grep -i agentrouter
#   agentrouter · example-user · API key …XXXX   subscription  Balance 25% ($150.00 / $200.00)
#   上述为虚构示例；实际输出也可能提示“累计消耗…；剩余额度未知”。
```

`Balance` 里的百分比是 magpie 的 `Used` 字段（剩余 = 100 − 已用），金额在 `Amount` / `Limit`。
**不要把美元金额塞进 `Used`** —— 例如把 $250 当成 250%，会使剩余被截成 0%。

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

- `index.mjs` — 插件本体（provider + 自定义头 + 余额 + 签到 + GitHub 登录）
- `response.mjs` — HTTP / SSE 早期失败识别与有界流透传（安装时必须一起复制）
- `package.json` — 包描述
- `set-ar-headers.sh` — 改请求头的小工具
- `usage.test.mjs` — 额度读取、登录与 HTTP 错误回归测试
- `loader-stream.test.mjs` — 流内错误、空完成、成功字节、工具调用等回归测试
- `response-bounds.test.mjs` — 有界缓存、检查超时与取消测试（统一运行 `npm test`）

## 已知问题与排查

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 所有模型都无响应，面板 0/7，且**没有任何报错** | 旧版把 `sk-…` 存进了 `metadata.endpoint`，请求打到 `sk-…/v1` | 本版已修：端点问答会拒绝，非 URL 的已存值会被忽略并回退默认端点；无需重新登录 |
| `/v1` 一律 `401 unauthorized client detected` | 自定义头里放了浏览器 `User-Agent` 等网关不认的标识 | 清掉该头，或用默认（`codex_cli_rs/0.101.0`） |
| 某模型 `503 … 无可用渠道` | 面板列的是 models.dev 目录里已下架的模型 | 见「模型列表从哪来」，用站点真实列表或关掉该模型 |
| 模型列表比预期少 | provider 编辑器里只选中了部分模型 | `magpie provider models agentrouter` 看 `pickedFrom`，在编辑器里勾选 |
| 余额显示旧值 | magpie 在读取失败时保留上次成功的读数（`asOf`） | 看 `asOf` 时间；这不是刚查到的余额 |
