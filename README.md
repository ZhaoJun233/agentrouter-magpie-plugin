# AgentRouter 插件（magpie）

给 magpie 接入 [agentrouter.org](https://agentrouter.org/)：模型、余额、签到，以及**可自定义请求头**。

## 登录方式与需要填写的内容

| 方式 | 需要什么 | 能读取什么 |
|---|---|---|
| **用 GitHub 登录**（推荐） | 先填系统访问令牌，再浏览器授权并复制回调地址 | 保存手填令牌，自动获取 API 密钥、session Cookie 和用户 ID；余额读取仍可能被 WAF 拦截 |
| API 密钥 | `sk-…` | 对话、模型列表、累计消耗；不能推算剩余额度 |
| API 密钥 + Cookie 或访问令牌 | Cookie 填 `session=…` 等完整请求头内容，同时填用户 ID；或有效访问令牌 + 用户 ID | 尝试读取当前余额；被 WAF 拦截时降级到累计消耗 |
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

## 登录问答（API 密钥方式）

面板或 CLI 的登录问答（**密钥最后单独问**）：

1. 请求端点（对话与模型列表）—— 默认 `https://agentrouter.org`
2. 站点 —— `agentrouter.org` / `ps.air-outer.com`
3. 用户名或邮箱 —— 可留空；填了才能密码签到
4. 密码 —— 可留空；只存本机
5. 浏览器 Cookie —— 可留空；填完整 `session=…`，不能保证通过 WAF
6. 访问令牌 —— 可留空
7. 用户 ID —— Cookie 或访问令牌读取账号数据时填写 `New-Api-User` 的值
8. 自定义请求头 —— 每行一个 `Name: value`，留空用默认
9. **API 密钥**（`sk-…`）

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

改完 `docker restart magpie`。

## 端点与站点是分开的

- `endpoint`（默认 `https://agentrouter.org`）：对话和模型列表走这里
- `site`（`org` / `air`）：余额和签到走这里

所以你可以请求打 `agentrouter.org`、余额和签到走 `ps.air-outer.com`，两者互不影响。

## 验证

```bash
docker exec magpie magpie provider test agentrouter
#   ✓ responses  3469 ms · gpt-6-astra

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
- `package.json` — 包描述
- `set-ar-headers.sh` — 改请求头的小工具
