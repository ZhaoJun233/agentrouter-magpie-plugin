# AgentRouter 插件（magpie）

给 magpie 接入 [agentrouter.org](https://agentrouter.org/)：模型调用、余额与用量查询、每日自动签到，以及**可自定义请求头**。

## 🚀 快速上手 (Quick Start)

只需 3 步即可完成插件安装、账号配置与客户端接入：

### 1. 安装插件

#### Docker 部署（推荐）
将插件克隆至 magpie 配置卷中的本地插件目录：
```bash
# 假设 magpie 配置卷挂在宿主机 $VOL（按你的实际部署路径修改）
VOL=/path/to/magpie/config          # 替换为你自己的配置卷路径

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
   - 仅需对话时跳过可选字段。GitHub 自动签到需额外配置 `githubCookie`（GitHub 登录态）和本站用户 ID；不能用 AgentRouter Cookie 代替，也不需要站点密码。
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
| API 密钥 + GitHub 登录态 | `githubCookie` 与本站用户 ID | 重新 GitHub OAuth 登录签到；会话过期/授权确认需人工处理 |
| 站点用户名密码（旧版兼容） | 仅适用于仍开放密码登录的站点 | GitHub-only AgentRouter 用户留空 |

API 密钥登录时，Cookie 和访问令牌任选其一即可。GitHub 登录需要先填写同一 AgentRouter 账号的系统访问令牌（「个人设置 → 访问令牌」），不能为空；不是 `sk-…` API 密钥，也不是 GitHub Token。Cookie 和用户 ID 由 GitHub 授权自动获取。访问令牌失效时可以继续尝试有效 Cookie；两者都不能保证通过滑动验证码。

## 签到：GitHub 重新登录

AgentRouter 的每日额度由**重新登录**触发，余额查询成功不等于签到。
当前 GitHub-only 账号不能设置站点密码，旧版“先设置密码”的说明不适用。

### 配置与安全边界

在账号表单的 **GitHub 登录 Cookie** 字段配置对应账号的 GitHub 登录态
（metadata 字段名为 `githubCookie`）。支持原始 Cookie 请求头、DevTools 表格和 Cookie JSON 数组。
它与 AgentRouter 的 `cookie` 字段不同；推理 API key、系统访问令牌、GitHub PAT/Actions token 均不能替代。
这是高权限凭据：只保存在你信任的网关服务器，像密码一样保护，不要发到聊天、工单、截图或 Git。
远程部署时不是“只存在本机”。如果不愿把 GitHub 会话交给网关，则不要配置此功能。

先在浏览器用对应 GitHub 账号登录并授权 AgentRouter，再配置完整 GitHub Cookie。
每个账号必须填写正确的本站用户 ID，插件会校验 OAuth 返回的 ID，防止把另一个账号的结果
记为当前账号已签到；不要把一个账号的 Cookie 复制给多个不同账号。
注意 ID 校验发生在兑换后：填错 Cookie 可能已经登录并给那个错误账号发放额度，
本校验只防止当前账号虚报成功，不保证消除错误账号的服务端副作用。

每次任务：获取站点配置 → 新建匿名 OAuth state/session（不带旧站点登录）→
只向 github.com 发送 GitHub Cookie → 校验本站回调地址、state 和 code →
兑换一次性 code → 校验账号 ID 与 `data.checked_in`。
不跨域转发 Cookie，不轮换原有推理密钥或系统访问令牌。

此轻量 HTTP 流程只支持 GitHub 对已有授权直接重定向的会话。若返回登录、授权确认、设备验证
或 2FA 页面，会停止并要求人工处理，不自动提交表单、不绕过验证。
浏览器可用的 Cookie 不保证服务器 HTTP 请求也能使用；若 WAF 要求浏览器执行 JS，
需要独立持久浏览器方案，不能仅靠此字段解决。会话过期需更新，不承诺永久无人值守。
配置后先手动点网关“签到”验证；缺少 GitHub 会话时，对话/余额查询不受影响，但不能自动签到。

### 结果含义

| 结果 | 证据与含义 |
|---|---|
| `claimed` | 匹配账号的登录响应明确返回 `data.checked_in === true`，站点确认本次新增额度 |
| `done` | 明确返回 `false`，本次登录未新增额度；不等于证明今日曾经到账 |
| `failed` | 网络/站点异常或缺少有效布尔签到标记，无法确认额度发放，允许重试 |
| `ineligible` | 未配置 GitHub 会话、需要人工恢复、ID 缺失/不匹配等，需要修改账号配置 |

用户名/密码字段仅为仍支持密码登录的旧站点保留；GitHub-only 用户留空。
修改凭据后可手动签到立即验证，不必等下一天。

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
- `githubCookie`：GitHub 登录会话，自动重新 OAuth 签到；高权限凭据，需妥善保护。
- 站点用户名密码：仅兼容旧站点；GitHub-only 用户留空。

`sk-` key 不能代替账号访问令牌。`/api/user/token` 会重新生成访问令牌，使旧令牌失效；插件不调用此接口，GitHub 登录直接保存你填写的系统访问令牌。

## 协议：只有 Responses API

AgentRouter 的模型**不支持** `/v1/chat/completions`：

```
400 模型 gpt-5.6-sol 不支持 /v1/chat/completions 接口，请改用 /v1/responses
```

所以 provider 声明为 `npm: "@ai-sdk/openai"`（Responses）。agent 发 Chat / Anthropic 请求时，由 magpie 网关负责翻译。

### 跨 OpenAI 资源的历史条目错误（0.1.2）

如果上游提示 `The requested item was created under a different ... OpenAI resource`，通常是请求引用了另一个资源创建的服务端条目。这不是内容敏感词，也不是改一次 API Key 就能恢复的历史。

默认开启 `portable-responses`：对 `POST .../responses` 中**带完整内联内容**的普通消息和 function-call / function-call-output，去掉用于条目查找的顶层 `id`。普通输出文本转换为 API 支持的内联输入消息，保留角色、正文和 `phase`；工具的 `call_id`、名称、参数、结果及嵌套业务 `id` 保持不变。有改写时设置 `store:false`，清除旧正文长度/摘要头。未改写时保留原始正文。实现见 [request.mjs](<request.mjs>)。

边界：

- **不删** `previous_response_id`、`conversation` 或 `item_reference`；这些请求不做 ID 重写，因为插件并不知道它们指向的完整历史。0.1.3 的独立文本过滤仍可替换请求中可见的匹配正文，但不能处理引用背后的历史。客户端需要重发完整内联历史，或由上游固定到原资源。
- **不删改推理及 compaction 条目**，包括它们的 ID、摘要和加密内容。`store:false` 不会让加密状态跨资源通用；不同密钥无法解密时仍须原资源。
- 非空引用注释、未知消息字段和未知条目类型保留原样，不为修复而静默丢失内容。文件/图像/容器等资源引用也不递归删除。
- 只处理最多 4 MiB 的 JSON 请求；读取 Request 副本最多 2 秒，支持取消。超限、非 JSON、压缩正文和其他端点不改写。不会自动重试，更不会重放用户历史。
- 关闭提供商选项 **Replay complete Responses items inline** 只关闭 ID 重写；若启用了下文的本地词表，文本过滤仍独立生效。两个选项都关闭才恢复原始正文透传。只有服务端引用、没有完整内联正文的旧会话，不保证仅升级插件就能继续。

当此错误仍出现，插件返回 `agent_router_resource_mismatch`，保留上游消息与可识别的 trace ID，说明需要完整内联历史或同一上游资源，而不是报成敏感词错误。

协议依据：[OpenAI 内联消息与 phase](<https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/responses/easy_input_message_param.py>)、[工具调用 id / call_id](<https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/responses/response_function_tool_call_param.py>)、[Azure 无存储推理延续](<https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/reasoning#preserve-reasoning-without-stored-responses>)。这些协议说明不等于厂商承诺跨资源加密状态可移植。

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

仓库保留的历史实验记录（2026-10-30，org 站点；不是当前版本的复测结果）：

| 内容 | 结果 |
|---|---|
| 普通长文，20 万 token | `200` |
| 20 万 token 的重复句 | `200` |
| 含 `transcript` 的短句（3 个 token） | **`400 content-blocked`** |
| `Here is the transcript of our call.` | **`400 content-blocked`** |

这些历史样例只能说明当时部分短句也被拦，不能外推为厂商的当前词表，也不能证明每次拦截都由某个词触发。只有 `content-blocked`、没有命中词或审核类别时，插件不能自动判定是哪段文字导致拒绝。

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

> 遇到这个 400：保留 request id，向服务商核实拒绝原因。只有明确需要替换的文本才加入下方词表；不要盲目重试或把可疑词猜测当成已证实结论。过滤后仍可能被拒。

### 本地词表自动替换（0.1.3）

提供商选项 **Filter configured prose before sending**（`text-filter`，默认开启）控制发送前替换。**没有词表或 `terms` 为空时不改正文**；不内置猜测词，不自动学习被拒的私密请求，不发送探测请求，也不追加重试。

1. 将插件目录中的 [content-filter.example.json](<content-filter.example.json>) 复制为 `content-filter.local.json`，与 [index.mjs](<index.mjs>) 放在同一目录。magpie 使用的是**服务端安装目录**，不是浏览器本机目录。
2. 仅填写自己确认需要替换的词；词表按字面量匹配，不支持正则。示例中的值仅为占位，不代表厂商拦截词：

   ```json
   { "terms": ["待替换的自定义文本"], "caseSensitive": true }
   ```

3. 词表属于私有配置，建议限制为仅运行插件的用户可读写。它已被 Git 忽略，也不在 npm 发布文件清单中；不要将真实词表放进示例文件、命令行参数或调试输出。
4. 保存后重新加载插件。运行中的 loader 使用加载时的快照；改文件本身不会立即改变在途请求。关闭 `text-filter` 可停用，重新开启后加载词表。

行为与边界：

- 仅处理 `POST .../responses` 的 `instructions`、字符串 `input`，以及 `input` 中普通 user/assistant/system/developer 消息的文本片段。Chat/Anthropic 客户端请求须先由 magpie 翻译为 Responses。`/responses/compact` 等其他端点不处理。
- 默认区分大小写；`caseSensitive:false` 可忽略大小写。按最长字面量优先、非重叠替换成 `[FILTERED]`，不递归替换生成的标记，不自动添加单词边界。短词可能命中更长词的一部分，配置前应自行评估。
- **不改**工具调用参数、工具结果、工具 schema、业务 ID、模型名、metadata、文件/图片、推理/compaction/加密状态和服务端历史引用。Markdown 行内代码、根级反引号/波浪线围栏和未闭合代码段保守保留。含缩进代码的段落不改，但其前后独立段落仍可过滤；遇到引用/列表容器中的围栏，为避免误判结束位置，整个文本字段不改。带引用注释或未知字段的片段也不改。它不是通用的密钥防泄漏或数据防泄漏系统，不能保证屏蔽上述范围里的词。
- 仅匹配可见的普通正文；保留被跳过内容可能意味着上游仍会拒绝。并非找到了厂商完整词表，也不保证对某次 `content-blocked` 有效。
- 没有命中时，不因过滤而重新序列化请求；有命中时仅替换发送副本，清理旧长度/摘要头，不回写本地历史。独立的 `portable-responses` 选项仍可执行 ID 兼容处理。
- 请求沿用 4 MiB UTF-8 / Request 副本 2 秒的边界。超限、无法读取、非 JSON、压缩正文按原有逻辑透传，**不是已过滤的证明**。
- 词表最多 32 KiB、128 条；每条最多 256 个 UTF-16 代码单元，总计最多 8192。不存在/空词表视为停用；配置存在但 JSON、结构、编码或读取失败时，启用状态下拒绝创建 loader，而不是静默忽略。错误只给固定提示，不输出词条或请求正文。

实现：[content-filter.mjs](<content-filter.mjs>)；回归测试：[content-filter.test.mjs](<content-filter.test.mjs>)。

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
3. GitHub 登录 Cookie —— 自动签到用，非本站 Cookie；用户名/密码仅旧版兼容
4. 旧版站点用户名/密码 —— GitHub-only 账号留空；保存在网关服务器
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

[维护脚本](<set-ar-headers.sh>)只输出固定成功提示，不回显请求头内容。但命令行参数仍可能进入 shell 历史或进程列表，因此该入口只适合非敏感客户端标识头；不要用它传入 Authorization、Cookie 或其他凭据。

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
      "githubCookie": "（可选：对应 GitHub 账号的完整登录 Cookie）",
      "username": "（GitHub-only 账号留空）",
      "password": "（GitHub-only 账号留空；保存在网关服务器）",
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

## 额外的本地拒绝策略（可选社区中间件）

这是独立于上文 0.1.3 发送前替换的 **reject** 策略，不会替换文字，也不能据此判断 AgentRouter 的真实拦截词。现有部署若需要正则拒绝，可另行评估社区中间件：

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

## 开发验证

在仓库根目录运行：

```bash
npm test                 # Node.js 插件与本地签到回归
npm run test:headers     # 需要 Python 3；仅执行维护脚本的 Python 部分，不调用 Docker
```

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
