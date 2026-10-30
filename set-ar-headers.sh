#!/bin/bash
# 修改 AgentRouter 账号的自定义请求头，不用重新登录。
#
#   ./set-ar-headers.sh 'User-Agent: codex_cli_rs/0.101.0'
#   ./set-ar-headers.sh ''            # 清空，回到插件默认
#
# 默认改 Docker 部署常见的 <config>/magpie/plugin-auth.json，
# 用 AUTH_FILE 覆盖；RESTART=0 可跳过自动重启。
set -e
[ $# -eq 1 ] || { echo "用法: $0 '<每行一个 名称: 值>'"; exit 1; }

# 你的配置卷在哪就指哪；这里只是 Docker 部署最常见的位置
AUTH_FILE="${AUTH_FILE:-/opt/magpie/config/magpie/plugin-auth.json}"
[ -f "$AUTH_FILE" ] || { echo "找不到 $AUTH_FILE（用 AUTH_FILE=... 指定）"; exit 1; }

python3 -c '
import json,io,sys
p=sys.argv[2]
d=json.load(io.open(p,encoding="utf-8"))
if "agentrouter" not in d:
    sys.exit("尚未登录 agentrouter")
h=sys.argv[1].strip()
if h:
    d["agentrouter"].setdefault("metadata",{})["headers"]=h
else:
    d["agentrouter"].get("metadata",{}).pop("headers",None)
io.open(p,"w",encoding="utf-8").write(json.dumps(d,ensure_ascii=False,indent=2))
print("已写入:", h or "(清空，使用默认)")
' "$1" "$AUTH_FILE"

# 容器里以 65532 运行，改完要对得上
chown 65532:65532 "$AUTH_FILE" 2>/dev/null || true

if [ "${RESTART:-1}" = "1" ]; then
  if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -qx magpie; then
    docker restart magpie >/dev/null 2>&1 && echo "已重启 magpie"
  else
    echo "（没找到 magpie 容器，改完请自行重启 magpie 生效）"
  fi
fi
