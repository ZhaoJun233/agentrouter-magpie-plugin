# AgentRouter 本地纯 HTTP 签到

这是与网关插件分开的本机工具。**不控制浏览器、不读取浏览器配置或 Cookie 数据库、不向网关上传登录态。** 只在你自行配置后向所选 AgentRouter 站点及 GitHub 发起 OAuth HTTP 请求。HTTP 自动登录也可能触发风控；遇到验证、授权确认、异常或结果不明确就暂停，没有绕过验证的实现。

## 初始化与数据目录

程序：[local-checkin.mjs](<local-checkin.mjs>)，不需要安装额外依赖。请先在本机安装 Node.js；以下命令在插件仓库根目录执行，使用 PATH 中的 `node`，不依赖特定用户或其他应用附带的运行时。

```powershell
# 创建空配置并检查或设置专用目录权限；不联网
node ./local-checkin.mjs init
```

默认数据目录位于仓库外：Windows 为 `%LOCALAPPDATA%/AgentRouterCheckin`，Linux/macOS 为 `~/.local/share/agentrouter-checkin`。其中 `config.json` 保存站点与用户 ID，`github-cookie.txt` 保存仅本机使用的会话。初始化不会覆盖已有配置，也不会取得或填写真实 Cookie。**不要把这些文件发到聊天、截图、日志或 Git。**

填写会话前必须检查目录权限。Unix 工具要求目录对其他用户无权限；Windows 初始化通过系统原生 icacls 收紧专用目录 ACL，运行前再次检查目录及配置/会话/状态文件的 ACL；检查失败会拒绝运行，不能仅靠 Node 的文件 mode 断言安全。文件为明文，不是加密保险箱；管理员和本机恶意软件仍可能读取。不要放在代码仓库、共享目录、同步盘、网盘或公共临时目录。初始化拒绝任意带 .git 祖先的目录（包括通过父目录 junction 到达的仓库），也拒绝工具所在目录。

Windows ACL 中当前用户可能被系统序列化为 `LA` 等短名。工具通过给临时探针目录仅授予当前完整 SID、移除继承并再次原生导出，绑定这个短名；不会全局放行 `LA`，也不会仅凭 SID 的 `-500` 后缀认定是本机管理员。探针和真实 ACL 无法确认时均拒绝运行。Linux 的目录 `0700`、新建凭据文件 `0600` 及运行前权限检查保持不变。CI 在 Linux 和 Windows 上分别运行 Node.js 20、22、24 的完整测试。

## 你需要自行填写的两项

1. 用普通浏览器手动确认你要签到的 **AgentRouter 站点用户 ID**，以及对应的 GitHub 账号。编辑配置：

```json
{"version":1,"site":"org","userId":"填写真实的站点数字用户ID"}
```

只允许 site 为 org（agentrouter.org）或 air（ps.air-outer.com），不是 GitHub 的数字 ID。先只配置一个账号；不要猜 ID。配置只接受这三个字段。

2. 如果你接受持有会话的风险，通过浏览器自带开发者工具**自行**取得你本人当前 GitHub 会话 Cookie，粘贴到本机的会话文件并保存。可以是完整 Cookie 请求头的值（不要包含 `Cookie:` 字段名），也支持带 domain/name/value 的 JSON Cookie 数组。必须是 GitHub 的会话，不是 AgentRouter 的站点 Cookie。脚本不会替你抓取，也不需要 GitHub 密码、PAT、API key 或网关密钥。不要用来源不明的导出插件。

**错账号的边界：** 只有 OAuth 兑换后才能检查本站返回的用户 ID。配置错 GitHub 会话时工具会暂停，不会把目标账号记为成功，但此前服务端可能已经对另一个账号登录、注册或发奖，不能撤销。因此首次操作前请你本人核对账号对应关系。

## 命令（本机 PowerShell）

```powershell
# 只看是否配置和暂停状态；不输出 Cookie、不发起网络请求
node ./local-checkin.mjs status

# 手动请求一次；凭据齐全、未暂停且已到期时才会联网
node ./local-checkin.mjs run

# 保持当前窗口运行，按持久化的 24 小时间隔签到
node ./local-checkin.mjs watch
```

首次真实运行前，请自行核对账号、配置与文件权限；不要向他人发送会话文件内容。初始化不会启动 watch、后台作业、自启动或计划任务，只有明确执行相应命令才会运行。

## 定时、安全与恢复规则

- 同一个数据目录只有一个进程可以执行签到。一次尝试之前先落盘暂停状态和下一次允许时间，避免崩溃后自动重复登录。
- 正常 claimed/done 后至少间隔 24 小时；watch 每分钟只检查本地是否到期，不是每分钟请求 GitHub。电脑关机、睡眠、窗口关闭时不会执行；重新启动 watch 会沿用状态，不补跑一连串错过的任务。
- 网络错误、验证页、拒绝、账号不匹配、无法确认签到等都会暂停。watch 遇到这些结果退出，不进行网络重试。
- 人工确认账号、Cookie 和风控问题已解决后，可以执行 resume 解除暂停；该命令本身不联网，且不清除已有的 24 小时冷却时间。
- 如果程序异常终止遗留锁，先确认所有该工具进程已停止，再处理专用目录内的 run.lock。不能在另一个签到进程仍运行时删除锁。state.json 不含 Cookie，但保存节流和暂停记录；不要为反复尝试而删除它。
- 状态文件损坏会拒绝执行，不会静默恢复成可签到状态。错误输出只含固定错误代码，不含请求 URL、OAuth code、响应正文或异常原文。

## 怎样判定成功

| 输出 outcome | 含义 |
|---|---|
| claimed | 本次返回的服务端 checked_in 严格为 true，且站点用户 ID 匹配；不是余额推算 |
| done | 服务端 checked_in 严格为 false；**不代表本次发奖，也不据此声称先前发过奖** |
| failed / ineligible | 暂停，需要人工处理；不能据此说签到成功 |
| skipped | 24 小时间隔未到，没有再次联网 |
| paused / busy | 已暂停或有并发锁，没有再次联网 |

这只是直接重定向 OAuth 快速路径。GitHub 若需要交互确认，将不能全自动。跨日自动运行是否成功，必须等真实账号在后续到期时再次执行并取得结果，不能用模拟时钟测试代替。

## 离线验证

[本地规则测试](<local-checkin.test.mjs>)验证节流、落盘、恢复、并发、脱敏和错误状态；[整合测试](<local-checkin.integration.test.mjs>)通过模拟 HTTP 连接本地入口与真实插件 hook；[OAuth 原有测试](<checkin.test.mjs>)覆盖重定向/state/账号与奖励判定。测试不使用真实 Cookie，不连接真实账号。
