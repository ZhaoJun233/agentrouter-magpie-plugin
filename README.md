# AgentRouter 插件（magpie）

给 magpie 接入 AgentRouter [国际站](https://agentrouter.org/)或[国内站](https://ps.air-outer.com/)：支持 API Key、GitHub 与系统访问令牌登录，提供模型调用、余额与用量查询、每日签到，以及**可自定义请求头**。

## 文档导航

- [贡献指南](<CONTRIBUTING.md>)：Issue → PR → 自动检查 → 人工审查。
- [安全政策](<SECURITY.md>)：敏感信息处理与私密漏洞报告。

- [优化设计与升级指南](<docs/OPTIMIZATION.md>)：问题背景、与参考项目的取舍、兼容边界、升级/回滚与本地验证。
- [更新日志](<CHANGELOG.md>)：0.1.9 可配置限流等待、原生插件选项与历史版本的变化。
- [本地签到说明](<LOCAL-CHECKIN.md>)：独立签到工具的使用与安全边界。

> 仓库源码更新不等于 npm 发布或你的网关已升级。请按升级指南自行验证；不要把真实 Cookie、访问令牌、私有词表或抓包提交到仓库。

### 0.1.9：可配置 429 等待时间

- 已识别的 429 限流缺省等待 **10 秒**。在主导航 **插件 → 已安装 → agentrouter → 选项** 修改 `retryAfterSeconds` 并保存；这是插件级默认值，账号 metadata 中的同名字段可覆盖它。详见[自定义 429 等待时间](<#自定义-429-等待时间>)。
- 保留上游明确提供的等待提示，兼容 JSON 和 SSE；插件不自动重试。
- 原版 magpie 0.1.3906 的冷却下限为 60 秒，小于一分钟的实际倒计时还需要宿主支持；本 npm 包不包含宿主二进制补丁。

### 0.1.8：系统访问令牌接入，移除未通过真实验证的 LinuxDo 登录

- 登录顺序为 **API Key、GitHub、系统访问令牌**；三种方式都可选择国际站 `agentrouter.org` 或国内站 `ps.air-outer.com`，默认国际站。
- 新增 **系统访问令牌（读取已有 Key）**：询问站点、系统访问令牌、用户 ID 与可选的模型 Key ID，随后只读取该账号已有模型 Key。不请求任何 OAuth 授权接口，不创建、轮换或修改任何 Key。
- 多把启用 Key 时必须填写站点「令牌」页 ID 列的目标 Key ID，插件按 `GET /api/token/{id}` 只读读取该把；只有一把启用且完整的 Key 时直接使用。不替用户代选、不补页、不重试。
- **移除 LinuxDo OAuth 登录入口。** 真实验证结论：`connect.linux.do` 授权后回落到站点注册路由 `https://agentrouter.org/oauth/linuxdo`（并非请求里的 `/oauth/linuxdo/magpie` 子路径），站点前端在该路由挂载时立即请求 `/api/oauth/linuxdo`（真实验证记录到 1 次、HTTP 403）并跳转控制台，地址栏不再保留 `code`/`state`，插件侧手动回填在任何兑换请求之前即被拒绝。公开资料没有关于 LinuxDo redirect_uri 匹配语义的说明，站点前端确认该路由为精确匹配且没有任何可抑制自动兑换的标志位。
- 移除范围包含 LinuxDo 方法、其常量、`/api/status` 的 `linuxdo_client_id` 读取与死代码 `codeOf`；GitHub 登录链路、提问形状与密钥筛选规则不变。

> **本页登录流程适用于 0.1.9。** 下方命令固定该版本，安装前先查询 npm 官方 registry；源码版本号不等于已发布或你的网关已升级。0.1.7 曾发布 LinuxDo 登录入口，0.1.8 已将其移除，这不改变 0.1.7 已安装账号保存的数据。

### 0.1.7：站点选择与 LinuxDo 登录

- 登录顺序为 **API Key、GitHub、LinuxDo**；三种方式都可选择国际站 `agentrouter.org` 或国内站 `ps.air-outer.com`，默认国际站。
- API Key 仍只使用宿主原生的一个密钥输入框，插件仅增加站点选择；保存不代表验证通过。
- GitHub / LinuxDo 选择站点并填写系统访问令牌（遮蔽输入），随后由用户在浏览器授权、手动回填完整回调 URL，再查找已有模型密钥；**不是免令牌或全自动 OAuth**。
- 新国内站授权显式保存模型 API 地址；升级保留旧账号的 key、站点、端点及其他设置，不自动迁移旧账号。
- 仅在已有密钥列表中存在唯一可用候选时保存；缺失、歧义或分页不完整时转为手动 API Key 恢复。不自动创建、轮换密钥或重试，不以空 key 完成 OAuth。
- 同时包含完整 assistant 历史保留 `output_text` 的修复，以及 Windows Administrator 权限识别修复。loader 仍在缺失模型 key 时于网络请求前拒绝。

> **本节为 0.1.7 发布时的历史记录，当前登录流程见下方安装与登录说明。** 0.1.7 发布时尚未完成真实 LinuxDo OAuth 验证，后续复测发现该流程无法完成，0.1.8 已移除该入口。

### 0.1.5 变更

- JSON 错误诊断增加 **64 KiB / 2 秒** 上限；与请求改写共用不消费原始正文的限量读取模块。请求原有 **4 MiB / 2 秒** 边界不变。
- 在明确的错误封套内识别有限的限流、繁忙及服务故障；保留业务错误优先级、上游等待头与原有错误类型，不添加重试。
- SSE 前缀改用增量分行，覆盖 LF、CRLF、CR 及混合换行、跨块 UTF-8；正常内容、未知事件与后续错误仍逐字节透传。
- 本地文字过滤独立识别 `output_text.logprobs: []`，无论是否开启历史内联；关闭内联时只替换正文，不删 ID 或元数据。
- 递归错误包络、未知 SSE 数据形状、重复事件字段与 Markdown 分隔符均增加保守保护；重复过滤不再跨越已有标记或破坏代码块边界。
- 参考 [AgentRouter-Codex-Filter](<https://github.com/alexcarterio/AgentRouter-Codex-Filter>) 的保守诊断思路，保留当前插件形态；不引入其本地代理、仪表盘、自动重试或有损历史降级。

### 0.1.4 变更

- 历史版本改进了系统令牌遮蔽输入和可选签到配置；当前操作请以下文 0.1.9 登录流程为准。
- 修复完整历史消息含空 `logprobs: []` 时漏掉内联重放的情况，保留工具关联、非空概率数据、引用注释和不透明状态。
- 无法恢复仅存在于其他上游资源的历史或加密状态；这是范围受限的兼容补充，并非所有跨资源错误的通用解法。

## 🚀 快速上手 (Quick Start)

按以下步骤完成插件安装、账号配置与客户端接入；上游账号、网络与宿主版本仍需分别验证：

### 1. 安装插件

#### npm 包安装（固定版本）

包名为 [`opencode-agentrouter-auth`](<https://www.npmjs.com/package/opencode-agentrouter-auth>)。先在 npm 官方 registry 核对目标版本，再交给 **magpie 的插件管理器**安装；仅运行 `npm install` 不会自动把插件注册到 magpie：

```bash
# 在有 Node.js / npm 的终端查询目标版本；确认可用后再安装
npm view opencode-agentrouter-auth@0.1.9 version --registry=https://registry.npmjs.org

# Docker：查询成功后安装，容器名按你的实际部署修改
docker exec magpie magpie plugin add npm:opencode-agentrouter-auth@0.1.9

# 或者，本地 / 原生进程部署
magpie plugin add npm:opencode-agentrouter-auth@0.1.9
```

- Docker 与原生进程命令二选一。安装后用 `magpie plugin list --json`（Docker 中在命令前加 `docker exec magpie`）核对插件，再在面板检查 AgentRouter 的插件选项和登录状态。
- 如果版本查询返回 `E404`，该版本在所查 registry 尚不可用；不要把源码版本号当成 npm 已发布证明，可改用下方源码安装。若仅宿主安装失败，可运行 `magpie plugin registry` 检查它实际使用的 registry；查询命令不会替你修改宿主设置。
- 已用本地目录安装的用户，继续更新原目录即可；不要直接再添加一份 npm 插件。先备份并确认宿主如何关联插件路径、认证及选项，再决定是否迁移，避免重复注册或丢失原配置。
- 固定 `@0.1.9` 便于复现；省略版本会让宿主选择版本，但并不等同于更新所有插件。`magpie plugin update` 则可能更新其他插件，不作为本插件的定点升级步骤。
- 已通过 npm 安装的用户，升级或降级前须确认当前宿主的**单包替换方式以及认证/选项保留行为**；未确认前暂停操作，不直接重复执行 `plugin add`。旧版本也须经 npm 查询确认存在，不能假设仓库旧版本都已发布。下方[升级/回滚指南](<docs/OPTIMIZATION.md#11-升级与回退>)针对本地包/目录备份，不是已验证的 npm 定点降级流程。

#### Docker 源码安装

**源码安装与 npm 安装二选一，不要重复注册。** 克隆后核对提交及包版本为预期版本，更新已有目录前先备份；最终以宿主实际加载版本为准，不能仅凭本地文件已更新判断升级成功。

将插件源码放入 magpie 配置卷中的本地插件目录：
```bash
# 假设 magpie 配置卷挂在宿主机 $VOL（按你的实际部署路径修改）
VOL=/path/to/magpie/config          # 替换为你自己的配置卷路径

mkdir -p "$VOL/magpie/local-plugins"
git clone https://github.com/ZhaoJun233/agentrouter-magpie-plugin.git "$VOL/magpie/local-plugins/agentrouter"
chown -R 65532:65532 "$VOL/magpie/local-plugins/agentrouter"   # 仅修改本插件；uid/gid 按镜像实际情况修改

# 在 magpie 容器中加载插件
docker exec magpie magpie plugin add /config/magpie/local-plugins/agentrouter
```

#### 本地 / 原生进程源码安装
```bash
git clone https://github.com/ZhaoJun233/agentrouter-magpie-plugin.git
magpie plugin add /path/to/agentrouter-magpie-plugin
```

---

### 2. 登录并绑定账号（0.1.9）

以下流程适用于已加载 0.1.9 的宿主，沿用 0.1.8 的登录方式；0.1.7 及更早版本的菜单不同（0.1.7 的 LinuxDo 入口已在 0.1.8 移除）。新账号运行交互式登录命令（升级既有账号不要求重新登录）：
```bash
docker exec -it magpie magpie plugin login agentrouter
# 非 Docker 环境直接运行：magpie plugin login agentrouter
```

按宿主显示顺序选择：

#### 方案 A：API Key（最简，先列出）
1. 登录所用的 AgentRouter [国际站](<https://agentrouter.org/>)或[国内站](<https://ps.air-outer.com/>)，在「令牌」页面复制你要使用的**模型 API Key**。若尚无密钥，请自行在站点管理，插件不会代建。
2. 选择 `API Key（推荐）`，按宿主提示选择站点，在**宿主原生密钥输入框**粘贴一次并保存；没有第二个 key 字段。
3. 新账号模型请求使用所选站点，默认国际站。保存后按下一节运行模型测试；**已保存 / 宿主显示已登录 ≠ 模型已验证可用**。

当前宿主的 API `authorize` 不会收到原生输入框中的 key，插件无法在保存前验证它；本版本不新增 verified 标记或“已验证”状态徽章。仅有模型 key 时，余额和签到可能不可用，但不影响独立测试模型调用。

#### 方案 B：GitHub 授权（需要管理令牌及手动回调）
适合已绑定 GitHub 的 AgentRouter 账号，流程为：**选择站点 → 系统访问令牌 → 用户浏览器授权 → 完整手动回调 → 查找已有模型 key**。
1. 在 AgentRouter「个人设置」→「访问令牌」复制**系统访问令牌**。它是管理凭据，**不是模型 API Key，也不是 GitHub Personal Access Token**；不能当作模型 key 使用。
2. 选择 GitHub 登录方式和站点，再以遮蔽输入粘贴系统访问令牌。无需填写请求头、用户 ID、账号密码或 Cookie。
3. 打开宿主提供的授权链接，在浏览器完成 GitHub 授权。此流程需要你参与，不是免令牌或全自动 OAuth。
4. 跳转后，从地址栏**完整复制回调 URL**并粘贴回宿主（保留 `code`、`state` 等全部参数）。回调页面可能显示“页面未找到”；不要因此刷新、删参数或只复制授权码，也不要把回调 URL 发给他人。
5. 插件读取已有密钥列表，只接受唯一可用候选。候选须为启用状态（`status=1`）、非空、未掩码、未过期，重复 key 先去重。支持已知的 `data.items` 与 `data` 数组形状；多个候选、无候选、未知响应或分页截断导致结果不确定时，不会擅自选 key。

**恢复方式：** 按提示改选 API Key，将你明确选定的模型 key 填入宿主原生输入框。插件不自动创建或轮换密钥、不自动重试，也不会以空 key 宣告 OAuth 成功。即使凭据已保存，仍需模型测试；管理令牌或余额读取成功同样不证明模型可用。

#### 方案 C：系统访问令牌（读取已有 Key）

适合已经登录过站点、知道自己的用户 ID 与模型 Key ID 的 AgentRouter 账号。流程为：**选择站点 → 系统访问令牌 → 用户 ID →（多把 Key 时）模型 Key ID → 读取已有模型 key**。

1. 在 AgentRouter「个人设置」→「访问令牌」复制**系统访问令牌**。它是管理凭据，**不是模型 API Key**；此方式只用它读取你自己账号下的已有多模型 Key。
2. 选择「系统访问令牌（读取已有 Key）」和站点，粘贴系统访问令牌。
3. 填写**用户 ID**：该站点的用户接口必须同时带用户 ID，缺少时同接口返回 401。用户 ID 是站点「令牌」页请求头 `New-Api-User` 的纯数字值。
4. **模型 Key ID 可留空**：账号只有一把启用且完整的 Key 时直接使用。有多把时，在站点「令牌」页的 **ID 列**复制目标 Key 的数字 ID 并填写；插件随后按 `GET /api/token/{id}` 只读读取该把 Key。
5. 插件只读取，不创建、轮换或修改任何 Key；不请求任何 OAuth 授权接口。密钥筛选和恢复规则与 GitHub 相同：候选须启用（`status=1`）、非空、未掩码、未过期。

**恢复方式：** 与 GitHub 相同，按提示改选 API Key 并手动指定模型 key。没有唯一答案时不代选、不补页、不重试，也不以空 key 成功。

**为什么没有 LinuxDo 方案。** 0.1.7 曾提供 LinuxDo 授权登录；真实验证证明它无法完成：授权最终回落到站点注册路由 `/oauth/linuxdo`（不是插件请求的子路径），站点页面在该路由自行请求 `/api/oauth/linuxdo` 兑换并立即跳走，地址栏不再保留 `code`/`state`，插件拿不到可用于兑换的回调。这不是放宽路径校验能解决的问题——放宽只会让用户拿到一枚已被站点页面用掉的授权码。该入口已在 0.1.8 整体移除。若你需要用 LinuxDo 账号本身登录站点，请在浏览器里正常登录站点，再回到本插件的「系统访问令牌」方式。

---

### 3. 测试与验证

保存凭据后分别验证模型与账号数据；宿主“已登录”只说明认证记录已保存，不是模型可用性证明：

```bash
# 1. 测试模型对话是否正常响应
docker exec magpie magpie provider test agentrouter
# 成功时输出类似：✓ responses  3469 ms · gpt-6-astra

# 2. 查看已识别并激活的模型列表
docker exec magpie magpie provider models agentrouter

# 3. 可选：已配置账号数据凭据时检查额度与用量（不是模型验证）
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

## 登录与高级配置边界

| 方式（显示顺序） | 首次需要填写 | 保存后的边界 |
|---|---|---|
| **API Key** | 站点选择、宿主原生单个模型 key 输入框 | 保存不验证；可测试对话、模型列表，不能据此推算余额 |
| **GitHub** | 站点选择、系统访问令牌（遮蔽输入），浏览器授权后完整手动回调 | 查找唯一已有模型 key；管理令牌和宿主登录状态不等于模型验证 |
| **系统访问令牌** | 站点选择、系统访问令牌（遮蔽输入）、用户 ID、可选的模型 Key ID | 只读取该账号已有模型 key；不请求 OAuth，不创建或轮换 Key |

新账号默认使用 `agentrouter.org`，可选择国内站；升级不改写旧账号保存的 key、站点、请求头或其他设置。GitHub 方式只询问站点与系统访问令牌；系统访问令牌方式额外询问用户 ID 与可选的模型 Key ID（都能在站点「令牌」页看到），因为该站点的用户接口必须同时带这两项。

余额与签到的既有能力继续保留。需要高级配置时，先备份，再按下文 [手动配置格式](<#手动配置文件格式plugin-authjson>) 维护既有账号 metadata；这些不是额外登录方式或必填问题：

- `cookie` 或 `accessToken` + `userId`：尝试读取账号余额；访问令牌失效时仍可尝试已有有效 Cookie，均不保证通过 WAF。
- `githubCookie` + 本站 `userId`：可选签到续期，GitHub 会话过期或需要授权确认时仍须人工处理。
- `username` / `password`：仅兼容仍支持密码登录的旧站点；仅使用 GitHub / 系统访问令牌授权的用户无需填写。
- `endpoint` / `apiBase` / `site` / `headers`：保留既有端点、站点与请求头能力。
- `retryAfterSeconds`：已识别的 429 限流缺少上游等待提示时使用的等待秒数，默认 `10`，配置方法见下文。

**当前插件选项仅支持布尔开关，没有新增 Cookie 设置页或任意文本选项。** 不要把凭据粘贴到布尔选项；高级字段只能通过已有宿主能力或下文的手动配置路径维护。

## 签到：GitHub 重新登录

AgentRouter 的每日额度由**重新登录**触发，余额查询成功不等于签到。
当前 GitHub-only 账号不能设置站点密码，旧版“先设置密码”的说明不适用。

### 配置与安全边界

首次登录不收集签到 Cookie，也不会自动启用签到续期。以下是既有高级配置说明：仅在你明确需要并接受风险时，手动维护既有 metadata 的 **GitHub 登录 Cookie**（`githubCookie`）。支持 Cookie 值、单个 `Cookie:` 前缀、DevTools 表格和 Cookie JSON 数组。
它与 AgentRouter 的 `cookie` 字段不同；推理 API key、系统访问令牌、GitHub PAT/Actions token 均不能替代。
这是高权限凭据：只保存在你信任的网关服务器，像密码一样保护，不要发到聊天、工单、截图或 Git。
远程部署时不是“只存在本机”。如果不愿把 GitHub 会话交给网关，则不要配置此功能。

#### 如何取得 GitHub Cookie

1. 在自己的浏览器打开 [github.com](https://github.com/)，登录与 AgentRouter 绑定的同一 GitHub 账号。
2. 打开开发者工具 → **Network / 网络**，刷新页面，选中发往 `github.com` 的页面请求。
3. 在 **Request Headers / 请求标头** 中找到 **Cookie**，只复制其值并保存到既有账号 metadata 的 `githubCookie`；不要复制 `Set-Cookie`、整份请求标头或 AgentRouter 的 Cookie。
4. 不需要运行控制台脚本；`document.cookie` 读不到完整的 HttpOnly 登录 Cookie。插件不能替你读取浏览器或剪贴板。

找不到或不愿提供时，不配置此字段。不要因为包含某个 Cookie 名就认定登录态有效：完整会话仍可能过期、账号不匹配或被 WAF 拦截。旧 metadata 原样保留，升级不自动采集、更新或清除凭据。[本地签到说明](<LOCAL-CHECKIN.md>) 中的独立工具保持不变，也不会自动启用。

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

所以请求头在这里不是装饰，是**决定成败**的东西。插件默认发 Codex CLI 的头，可通过开关和以下配置层控制：

- **开关**（provider 编辑器里的 `Send the Codex client headers`）：默认开。关掉后不再发默认的 Codex 标识，只发你自己给的头 —— 适合你已经有别的可用标识时。
- **模型配置层**：宿主传入的 `provider.models[*].headers` 对象（provider 编辑器可在模型配置中保存这些头）
- **provider 级**：宿主传入的 `provider.headers` 多行文本，覆盖模型配置层
- **账号级**：既有账号的 `metadata.headers`（手动配置），覆盖前述配置层；当前登录流程不询问请求头

格式是「一行一个 `Name: value`」，空行和 `#` 开头跳过。这里**只适合放这种头**：不要整段粘贴浏览器 devtools 的请求头 —— Cookie 应放入用途对应的既有 metadata 字段，不在登录时询问，`Authorization` 由插件按 key/令牌设置，而 `User-Agent` 应该填**网关认的客户端标识**，不是浏览器的那一长串。

> 踩坑记录：把 Mobile Safari 的完整 `User-Agent` 贴进 `headers` 后，`/v1` 一律 401
> `unauthorized client detected`，而站点路由（余额、签到）却一切正常 —— 很容易以为是 key 或插件坏了。
> 网关只认它自己的客户端标识，换回 `codex_cli_rs/0.101.0`（或清空、用默认）即恢复。

## 凭据用途

- API key `sk-…`：对话、模型列表、累计消耗。
- session Cookie / access token + 用户 ID：账号数据读取；余额可能被 WAF 拦截。
- `githubCookie`：GitHub 登录会话，自动重新 OAuth 签到；高权限凭据，需妥善保护。
- 站点用户名密码：仅兼容旧站点；GitHub-only 用户留空。

`sk-` key 不能代替账号访问令牌。`/api/user/token` 会重新生成访问令牌，使旧令牌失效；插件不调用此接口，GitHub 流程用你填写的系统访问令牌查找已有模型 key 并随成功认证保存，不会把它当作模型 key。

## 协议：只有 Responses API

AgentRouter 的模型**不支持** `/v1/chat/completions`：

```
400 模型 gpt-5.6-sol 不支持 /v1/chat/completions 接口，请改用 /v1/responses
```

所以 provider 声明为 `npm: "@ai-sdk/openai"`（Responses）。agent 发 Chat / Anthropic 请求时，由 magpie 网关负责翻译。

### 跨 OpenAI 资源的历史条目错误（0.1.2）

如果上游提示 `The requested item was created under a different ... OpenAI resource`，通常是请求引用了另一个资源创建的服务端条目。这不是内容敏感词，也不是改一次 API Key 就能恢复的历史。

默认开启 `portable-responses`：对 `POST .../responses` 中**带完整内联内容**的普通消息和 function-call / function-call-output，去掉用于条目查找的顶层 `id`。完整 assistant 消息在内联后仍保留 `output_text` 及其空 `annotations` / `logprobs`，不会误转为 `input_text`；其他角色沿用输入文本转换。保留角色、正文和 `phase`；工具的 `call_id`、名称、参数、结果及嵌套业务 `id` 保持不变。有改写时设置 `store:false`，清除旧正文长度/摘要头。未改写时保留原始正文。实现见 [request.mjs](<request.mjs>)。

0.1.4 额外识别普通 `output_text` 中的空 `logprobs: []`（网关可能随完成消息一起输出）。空概率数组不阻碍完整消息内联，assistant 消息内联时仍原样保留该字段；**非空、`null` 或形状未知的概率数据保持原样**。这类完整消息的顶层 ID 曾因该字段未被识别而保留，合成资源切换回归覆盖了此缺口。

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

部分宿主会根据错误文案中的额度/限流类词判断是否切换账号或服务商。
当内容拒绝被误归类为可重试错误时，可能触发重试或故障转移；最终展示的错误也可能来自另一上游。
这只是一种可能的级联路径，**不能据此断言所有 429 都由内容拒绝引起**，应结合实际状态、错误代码和请求 ID 核验。

插件把明确的内容拒绝改写为专用说明，避免在说明中混入额度/限流类词（由回归测试约束）。
状态码保持 400，上游代码与请求 ID 保留，便于报障；是否重试或故障转移仍由宿主策略决定。
插件自身不会为此多发送请求。

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
- 默认区分大小写；`caseSensitive:false` 可忽略大小写。按最长字面量优先、非重叠替换成 `[FILTERED]`，不递归替换生成的标记，不自动添加单词边界。跨越已有过滤标记或代码块结构分隔符的词条匹配会被保守跳过，避免再次过滤时改变代码边界；普通正文中的跨段落字面量仍可整体替换。短词可能命中更长词的一部分，配置前应自行评估。
- **不改**工具调用参数、工具结果、工具 schema、业务 ID、模型名、metadata、文件/图片、推理/compaction/加密状态和服务端历史引用。Markdown 行内代码、根级反引号/波浪线围栏和未闭合代码段保守保留。含缩进代码的段落不改，但其前后独立段落仍可过滤；遇到引用/列表容器中的围栏，为避免误判结束位置，整个文本字段不改。带引用注释或未知字段的片段也不改。它不是通用的密钥防泄漏或数据防泄漏系统，不能保证屏蔽上述范围里的词。
- 仅匹配可见的普通正文；保留被跳过内容可能意味着上游仍会拒绝。并非找到了厂商完整词表，也不保证对某次 `content-blocked` 有效。
- 没有命中时，不因过滤而重新序列化请求；有命中时仅替换发送副本，清理旧长度/摘要头，不回写本地历史。独立的 `portable-responses` 选项仍可执行 ID 兼容处理。
- 请求沿用 4 MiB UTF-8 / Request 副本 2 秒的边界。超限、无法读取、非 JSON、压缩正文按原有逻辑透传，**不是已过滤的证明**。
- 词表最多 32 KiB、128 条；每条最多 256 个 UTF-16 代码单元，总计最多 8192。不存在/空词表视为停用；配置存在但 JSON、结构、编码或读取失败时，启用状态下拒绝创建 loader，而不是静默忽略。错误只给固定提示，不输出词条或请求正文。

实现：[content-filter.mjs](<content-filter.mjs>)；回归测试：[content-filter.test.mjs](<content-filter.test.mjs>)。

0.1.5 的文字过滤也接受普通 `output_text` 中的空 `logprobs: []`。过滤先于历史内联执行，因此开启或关闭内联都适用；关闭内联时保留原消息 ID、`output_text` 类型、空概率数组及注释。非空、`null`、形状未知的概率数据，以及未知字段、真实注释或签名仍原样保留。`input_text` 中的未知概率字段不会因此获得放行资格。

## 真正的 429：每分钟 token 上限

除了上面的内容拒绝，上游也可能报告真实的 token 速率限制。以下为**脱敏后的错误示例**，区域名仅作占位：

```json
{"message":"Your requests to gpt-6.1-sol for gpt-6.1-sol in example-region have exceeded token rate limit.","type":"api_error"}
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
- **保留上游等待提示和 request-id**；对已识别的 token 速率错误与通用 429 限流，在上游没有
  给出 `Retry-After`、`retry-after-ms` 或 `x-ms-retry-after-ms` 时补上可配置的 `Retry-After`，默认 **10 秒**。等待时间是建议，**不保证届时恢复**。
  宿主是否遵循等待提示、短间隔重试或跨账号调度，取决于其版本与配置；插件不保证某个等待阈值会关闭重试。
- `response.completed` 明确给出空 `output`、输入/输出用量均为零且此前无有效输出时，
  单独报 **502 `agent_router_empty_response`**，不会伪装成限流。
- 正常响应逐字节透传。已有正文、推理或工具调用后的错误不重新包装，避免丢失部分输出
  或诱发工具重复执行。未知错误、普通 429、截断流也不会凭空变成 token 限流。
- 只检查最多 **64 KiB / 15 秒** 的流前缀；超过任一边界就原样放行，不缓存整段回答。
  插件自身不发起重试，也不绕过上游限制；默认 `magpie.maxConcurrency` 保持 **2**。

> 看到这个 429：遵循等待提示，降低并发并评估上下文大小。如果持续发生，应向上游提供
> request-id 查询真实阈值。插件修复的是错误识别与退避信息，不会增加上游可用容量。

### 自定义 429 等待时间

在 magpie 的 **插件 → 已安装 → AgentRouter → 选项** 中修改 `retryAfterSeconds`，单位为秒，然后点击**保存**。例如希望缺省等待 30 秒：

```json
{ "retryAfterSeconds": 30 }
```

不配置时默认 **10 秒**。保存后宿主重新加载插件，下一次请求使用新值。原生编辑器由包的 `magpie.options` 提供示例，保存的对象通过插件入口的第二个参数传入；账号设置中的布尔开关是另一种选项接口。

接受正整数或纯数字字符串；空值、零、负数、小数、其他类型或超出 JavaScript 安全整数范围的值回退为 10 秒。需要单独设置某个账号时，可在它已有的 `metadata` 中加入同名字段，覆盖插件选项；兼容宿主传入的同名顶层字段。手工修改账号配置后须重新加载插件，且应保留已有 key 和其他字段。完整文件结构见 [手动配置格式](<#手动配置文件格式plugin-authjson>)。

上游已经给出的等待提示优先，秒数、HTTP 日期和毫秒头均保持原值。这个配置只为已识别的限流补充等待时间，不改变错误分类；余额不足、内容拒绝及未知错误不会因此获得新的等待提示。插件仍不发起自动重试，实际重试由宿主决定。

**宿主兼容性：**原版 magpie 0.1.3906 的限流冷却至少为 60 秒，即使插件返回 `Retry-After: 10` 也会显示约一分钟。要让倒计时使用小于一分钟的配置，宿主还需支持按 AgentRouter 的等待提示冷却；只升级本插件不能解除原版宿主的下限。

## 有界响应诊断与增量 SSE（0.1.5）

JSON 仅在 HTTP **200 / 400 / 429** 时检查副本，最多 **64 KiB / 2 秒**；检查的是实际 UTF-8 字节，不信任 `Content-Length`。超限、超时、错误编码、读取失败或非 JSON 时放弃诊断，保留原响应供调用方读取。该上限约束诊断工作量，不限制整段正常回复，也无法阻止上游一次分配更大的单个数据块。共享实现见 [body-inspection.mjs](<body-inspection.mjs>)。

只从明确的 `error`、`response.error`、SSE `event:error` 等错误封套读取最多四层嵌套的 `message` / `msg`，也支持其中 JSON 编码的错误。**不会扫描成功正文、工具结果或普通文字来猜错误**。无法识别的错误原样透传。每一层嵌套都先验证有效错误叶子，再继承有效数字状态；不借用包装层正文。预算耗尽且仍有未检查的嵌套时也原样放行，不根据已读取的祖先字段猜测。新增归类如下：

| 明确的上游错误依据 | HTTP 状态 | 插件类型 |
| --- | --- | --- |
| 数值或严格三位数字字符串 `429`，或 `rate_limit_exceeded` | 429 | `agent_router_upstream_rate_limit` |
| `overloaded_error`、`high_demand`，或错误消息中的完整短语 `currently experiencing high demand` | 503 | `agent_router_upstream_busy` |
| `server_error` | 500 | `agent_router_upstream_error` |
| 数值或严格三位数字字符串 `500` / `502` / `503` / `504` | 保留对应状态 | `agent_router_upstream_error` |

当封套同时包含可识别的数值状态和错误代码时，以状态为准；类型按限流、繁忙、服务故障区分。认证、权限、余额、配额和内容策略等明确业务错误优先，**不会被包装为暂时性服务故障**。已有 token 限流、内容拦截、跨资源历史与空输出的专用类型不变。

改写后的响应保留上游代码与消息（`error.code` / `error.upstream`）、request-id，以及 `Retry-After`（包括 HTTP 日期）和上游毫秒等待头；仅清除失效的正文长度、编码和摘要头。已识别的 429 在缺少等待提示时使用 `retryAfterSeconds`（默认 10 秒）；其他错误不补等待时间。调用是否重试由宿主决定，插件不会多发一次 POST、切换账号或降级历史。

SSE 仍只观察首个有效内容或未知事件之前最多 **64 KiB / 15 秒** 的前缀。增量解析兼容混合换行、注释、多行 `data:` 与跨块 UTF-8；重复 `event:` 取最后一个值，只移除冒号后的一个可选空格。已知字段内出现未知数据形状时也立即结束诊断，透传原始字节并保留取消、背压及超时中的在途读取；不发送心跳、不缓存整段回答、不观察已经放行的后续事件。相关实现见 [response.mjs](<response.mjs>)。

## API Key 保存与故障恢复（0.1.8）

API Key 方式保留宿主原生的一个 key 输入框，插件仅询问站点。当前宿主不会把原生 key 传给 API `authorize`，因此不做保存前联网验证，不读取不存在的 `inputs.key`，也不增加第二个 key 字段或 verified 状态。

- **保存不等于验证**：保存后运行 `magpie provider test agentrouter`，再判断模型是否可用。宿主已登录、管理令牌有效和余额可读都不是模型验证结果。
- **本地 `400 agentrouter_missing_api_key`**：loader 遇到缺失 key 或保留占位 key，在任何网络请求前返回。改选 API Key，保存真实模型 key 后再测。
- **旧配置端点误填 key**：`endpoint` 应为 HTTP(S) 地址。既有端点校验回退能力保留；如需手动修正，先备份，不要把 key 或其他凭据写入 URL。
- **GitHub / 系统访问令牌查 key 不确定**：没有唯一可用候选或列表分页不完整时，手动指定模型 key；不自动创建、轮换、重试或保存空 key。系统访问令牌方式有多把 Key 时，先按站点「令牌」页的 ID 列填写目标 Key ID。

## GitHub 登录怎么走

插件的 `authorize` 会：

1. `GET /api/oauth/state?mode=login` 拿所选站点签发的 state，并保留此次下发的 session Cookie
2. 从 `/api/status` 读站点的 `github_client_id` 和 `server_address`，拼出 GitHub 授权 URL
3. 你在打开的页面授权后，浏览器跳到站点回调，例如 `https://agentrouter.org/oauth/github/magpie`。以本次授权后的真实地址为准，保留实际受信任来源，不要照模板重建 URL（GitHub app 和回调均归站点）
4. 把**那一整条地址**粘回插件，保留 `code`、`state` 等所有参数
5. `GET /api/oauth/github?code=…&state=…&mode=login` 携带此次 state 对应的站点 Cookie 兑换登录态，拿到用户记录（`id`、`quota`、`checked_in`）
6. 从响应头提取 `Set-Cookie: session=…`，保存登录前填写的系统访问令牌，不重新生成令牌
7. 用填写的管理访问令牌及授权返回的用户 ID 调 `/api/token/` 查找已有模型密钥；仅接受去重后的唯一启用、非空、未掩码、未过期候选。多个候选或分页不完整等不确定结果均要求手动 API Key 恢复，不自动补页重试、创建或轮换密钥

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

系统访问令牌方式不使用回调与授权码：只带 `Authorization` 系统访问令牌与 `New-Api-User` 用户 ID 读取 `GET /api/token/`。未填 Key ID 时沿用上面的列表与唯一性规则；填写了 Key ID 时按 `GET /api/token/{id}` 只读读取该把 Key（站点确认该路由存在并以 `New-Api-User` 鉴权）。该方式不请求 `/api/oauth/*`，保存 `metadata.site` 与 `apiBase`（国内站）。GitHub 的子路径匹配规则不适用于其他提供商；0.1.7 的 LinuxDo 路径因真实验证失败已在 0.1.8 移除，详见上文「为什么没有 LinuxDo 方案」。

## 改请求头（不用重新登录）

[维护脚本](<set-ar-headers.sh>)只输出固定成功提示，不回显请求头内容。但命令行参数仍可能进入 shell 历史或进程列表，因此该入口只适合非敏感客户端标识头；不要用它传入 Authorization、Cookie 或其他凭据。

```bash
./set-ar-headers.sh 'User-Agent: codex_cli_rs/0.101.0'
./set-ar-headers.sh ''          # 清空，回到默认
```

脚本默认读 `<magpie 配置目录>/magpie/plugin-auth.json`（Docker 部署常见为
`/opt/magpie/config/magpie/plugin-auth.json`），用 `AUTH_FILE` 覆盖。

四层覆盖（后者覆盖前者）：插件默认 → 模型配置 `provider.models[*].headers` → provider 级 `provider.headers` → 账号级 `metadata.headers`。当前实现先按枚举顺序汇总该 provider 的模型头，同名项由后面的模型覆盖；这不是按当前请求模型隔离的设置。模型层接受对象，provider 与账号层接受上述多行文本；宿主界面名称及配置映射以其版本为准。

## 手动配置文件格式（plugin-auth.json）

这是已支持的高级路径，不是首次登录表单，也不是新的设置页面。修改前备份宿主的认证配置，保护文件权限；示例中的占位值不可原样用于真实账号。保持既有账号 key、站点和不相关字段不变。

`plugin-auth.json` 的形态：

```json
{
  "agentrouter": {
    "type": "api",
    "key": "sk-…",
    "metadata": {
      "endpoint": "https://agentrouter.org",
      "site": "org",
      "retryAfterSeconds": 10,
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

- `endpoint`：显式配置时优先决定对话和模型列表地址；没有显式端点时读取已保存的 `apiBase`，两者都没有才默认 `https://agentrouter.org/v1`
- `site`（`org` / `air`）：余额和签到所用站点；新账号默认 `org`，升级保留旧值
- 0.1.7 起的新国内站登录会显式保存 `apiBase: https://ps.air-outer.com/v1`，使新账号的模型调用与所选站点一致

旧账号若只有 `site: air` 而没有 endpoint / apiBase，升级后模型仍走国际站，不自动迁移。你仍可显式配置模型请求走国际站、余额和签到走国内站；仅改 site 不会覆盖已保存的模型端点。

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

| `index.mjs` — 插件本体（provider + 自定义头 + 余额 + 签到 + GitHub / 系统访问令牌登录）
- `response.mjs` — HTTP / SSE 早期失败识别与有界流透传（安装时必须一起复制）
- `package.json` — 包描述
- `set-ar-headers.sh` — 改请求头的小工具
- `usage.test.mjs` — 额度读取、登录与 HTTP 错误回归测试
- `loader-stream.test.mjs` — 流内错误、空完成、成功字节、工具调用等回归测试
- `response-bounds.test.mjs` — 有界缓存、检查超时与取消测试（统一运行 `npm test`）

## 已知问题与排查

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 所有模型都无响应，面板 0/7，且**没有任何报错** | 旧版把 `sk-…` 存进了 `metadata.endpoint`，请求打到 `sk-…/v1` | 当前登录流程不询问端点；既有非 URL 端点仍会被忽略并采用已存 apiBase 或默认值，升级无需重新登录 |
| `/v1` 一律 `401 unauthorized client detected` | 自定义头里放了浏览器 `User-Agent` 等网关不认的标识 | 清掉该头，或用默认（`codex_cli_rs/0.101.0`） |
| 某模型 `503 … 无可用渠道` | 面板列的是 models.dev 目录里已下架的模型 | 见「模型列表从哪来」，用站点真实列表或关掉该模型 |
| 模型列表比预期少 | provider 编辑器里只选中了部分模型 | `magpie provider models agentrouter` 看 `pickedFrom`，在编辑器里勾选 |
| 余额显示旧值 | magpie 在读取失败时保留上次成功的读数（`asOf`） | 看 `asOf` 时间；这不是刚查到的余额 |
