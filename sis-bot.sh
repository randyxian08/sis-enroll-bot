#!/bin/bash
# SIS 选课机器人启动器
#
# 抢课（选课车页面）:
#   ./sis-bot.sh nav cart           打开/定位选课车页面
#   ./sis-bot.sh inject             注入抢课引擎 + 可视化面板
#   ./sis-bot.sh dryrun             演练（验证链路，预期 blocked）
#   ./sis-bot.sh start "SEM1时间" ["SEM2时间"]   定时开火
#   ./sis-bot.sh status / stop      看日志 / 停止
#
# 捡漏（Add Classes 页面）:
#   ./sis-bot.sh nav add            打开/定位 Add Classes 页面
#   ./sis-bot.sh inject-snipe       注入捡漏引擎 + 可视化面板
#   ./sis-bot.sh check "12345,1 23456,2"   查一次目标课状态（1=Sem1 2=Sem2）
#   ./sis-bot.sh snipe "12345,1 23456,2" [间隔ms]   开始蹲守，有空位立即抢
#   ./sis-bot.sh snipe-stop         停止蹲守
DIR="$(cd "$(dirname "$0")" && pwd)"
ENROLL_BOT=$DIR/enroll-bot.js
SNIPE_BOT=$DIR/snipe-bot.js
PANEL=$DIR/panel.js
BRIDGE=http://127.0.0.1:10086/command

CART_URL='https://sis-main.hku.hk/psp/sisprod/EMPLOYEE/PSFT_CS/c/SA_LEARNER_SERVICES.SSR_SSENRL_CART.GBL?pslnkid=Z_HC_SSR_SSENRL_CART_LNK'
ADD_URL='https://sis-main.hku.hk/psp/sisprod/EMPLOYEE/PSFT_CS/c/SA_LEARNER_SERVICES.SSR_SSENRL_ADD.GBL?pslnkid=Z_HC_SSR_SSENRL_ADD_LNK'

wb() { # wb <session> <code>
  python3 -c "
import json,sys
json.dump({'action':'evaluate','args':{'code':sys.argv[1]},'session':sys.argv[2]},open('/tmp/wb_bot_cmd.json','w'))
" "$1" "$2"
  curl -s -m 120 -X POST $BRIDGE -H 'Content-Type: application/json' --data-binary @/tmp/wb_bot_cmd.json
  echo
}

wbfile() { # wbfile <session> <js文件1> [js文件2 ...]
  python3 -c "
import json,sys
code='\n'.join(open(f).read() for f in sys.argv[2:])
json.dump({'action':'evaluate','args':{'code':code},'session':sys.argv[1]},open('/tmp/wb_bot_inject.json','w'))
" "$@"
  curl -s -m 120 -X POST $BRIDGE -H 'Content-Type: application/json' --data-binary @/tmp/wb_bot_inject.json
  echo
}

nav() { # nav <session> <url>
  python3 -c "
import json,sys
json.dump({'action':'navigate','args':{'url':sys.argv[2]},'session':sys.argv[1]},open('/tmp/wb_bot_nav.json','w'))
" "$1" "$2"
  curl -s -m 60 -X POST $BRIDGE -H 'Content-Type: application/json' --data-binary @/tmp/wb_bot_nav.json
  echo
}

# 把 "12345,1 23456,2" 转成 JS targets 数组（面板里 1=Sem1 2=Sem2；引擎里 term 0=Sem1 1=Sem2）
targets_js() {
  python3 -c "
import sys,re
out=[]
for tok in sys.argv[1].split():
    m=re.match(r'(\d{3,6})[,/\s]*([12])?',tok)
    if m: out.append({'nbr':m.group(1),'term':0 if m.group(2)!='2' else 1})
import json; print(json.dumps(out))
" "$1"
}

case "$1" in
  nav)
    [ "$2" = cart ] && nav sis-enroll "$CART_URL"
    [ "$2" = add ]  && nav sis-snipe "$ADD_URL"
    ;;
  inject)       wbfile sis-enroll "$ENROLL_BOT" "$PANEL" ;;
  inject-snipe) wbfile sis-snipe "$SNIPE_BOT" "$PANEL" ;;
  dryrun)       wb "window.__enrollBot.dryRun()" sis-enroll ;;
  start)
    if [ -n "$3" ]; then
      CODE="window.__enrollBot.start({rounds:[{openTime:'$2',term:0},{openTime:'$3',term:1}]})"
    else
      CODE="window.__enrollBot.start({rounds:[{openTime:'$2',term:0}]})"
    fi
    wb "$CODE" sis-enroll ;;
  status) wb "window.__enrollBot ? window.__enrollBot.getLogs().slice(-8).join('\n') : 'bot not loaded'" sis-enroll ;;
  stop)   wb "window.__enrollBot.stop()" sis-enroll ;;
  check)
    T=$(targets_js "$2")
    wb "window.__snipeBot.check({targets:$T})" sis-snipe ;;
  snipe)
    T=$(targets_js "$2")
    IV=${3:-5000}
    wb "window.__snipeBot.start({targets:$T,intervalMs:$IV})" sis-snipe ;;
  snipe-status) wb "window.__snipeBot ? window.__snipeBot.getLogs().slice(-8).join('\n') : 'bot not loaded'" sis-snipe ;;
  snipe-stop)   wb "window.__snipeBot.stop()" sis-snipe ;;
  *) echo "unknown command: $1"; exit 1;;
esac
