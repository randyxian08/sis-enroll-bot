#!/bin/bash
# 用法:
#   ./sis-bot.sh inject              注入机器人到 SIS 页面
#   ./sis-bot.sh dryrun              演练（验证链路，预期返回 blocked）
#   ./sis-bot.sh start "2026-08-20T10:00:00+08:00"   设定开门时间，启动定时报名
#   ./sis-bot.sh status              查看机器人日志
BOT="$(cd "$(dirname "$0")" && pwd)/enroll-bot.js"
case "$1" in
  inject)
    python3 -c "
import json
code=open('$BOT').read()
json.dump({'action':'evaluate','args':{'code':code},'session':'sis-enroll'},open('/tmp/wb_bot_inject.json','w'))
"
    curl -s -X POST http://127.0.0.1:10086/command -H 'Content-Type: application/json' --data-binary @/tmp/wb_bot_inject.json
    ;;
  dryrun|start|status|stop)
    if [ "$1" = start ]; then
      # start "SEM1时间" ["SEM2时间"]  例: start "2026-08-18T10:00:00+08:00" "2026-08-18T10:10:00+08:00"
      if [ -n "$3" ]; then
        CODE="window.__enrollBot.start({rounds:[{openTime:'$2',term:0},{openTime:'$3',term:1}]})"
      else
        CODE="window.__enrollBot.start({rounds:[{openTime:'$2',term:0}]})"
      fi
    elif [ "$1" = dryrun ]; then
      CODE="window.__enrollBot.dryRun()"
    elif [ "$1" = stop ]; then
      CODE="window.__enrollBot.stop()"
    else
      CODE="window.__enrollBot ? window.__enrollBot.lastLog : 'bot not loaded'"
    fi
    python3 -c "
import json,sys
json.dump({'action':'evaluate','args':{'code':sys.argv[1]},'session':'sis-enroll'},open('/tmp/wb_bot_cmd.json','w'))
" "$CODE"
    curl -s -X POST http://127.0.0.1:10086/command -H 'Content-Type: application/json' --data-binary @/tmp/wb_bot_cmd.json
    ;;
  *) echo "unknown command"; exit 1;;
esac
echo
