#!/usr/bin/env python3
# SIS 静默选课调度器 —— 计时/对表/重试全部在本地，页面只在开火瞬间执行 fetch
#
# 为什么比纯页面注入好：
#   1. 页面定时器在标签页后台时被 Chrome 钳制（1s 甚至 1min 粒度），本地定时器永不钳制
#      → 标签页随便藏，全程零窗口打扰（8/18 的 osascript 抢前台成为历史）
#   2. 每次开火命令自带全部逻辑（无状态），页面被刷新也不丢引擎 —— 刷新免疫
#
# 用法:
#   python3 sis-scheduler.py sync                          # 只测对表
#   python3 sis-scheduler.py probe 0                       # 干跑一次链路（到最后一步前停手）
#   python3 sis-scheduler.py fire "2027-08-17T10:00:00+08:00" "2027-08-17T10:10:00+08:00" [窗口分钟]
import json, re, ssl, sys, threading, time, urllib.request
from datetime import datetime, timezone

BRIDGE = 'http://127.0.0.1:10086/command'
SESSION = 'sis-enroll'
ORIGIN = 'https://sis-main.hku.hk'
# 只读 Date 响应头、不发送任何凭据，跳过证书校验（Python 证书库不认 SIS 的 CA）
SSL_CTX = ssl._create_unverified_context()

def log(*a):
    print(datetime.now().strftime('%H:%M:%S.%f')[:-3], *a, flush=True)

# ---------- WebBridge ----------
def wb_eval(code, timeout=180, retries=3):
    body = json.dumps({'action': 'evaluate', 'args': {'code': code}, 'session': SESSION}).encode()
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(BRIDGE, data=body, headers={'Content-Type': 'application/json'})
            resp = json.load(urllib.request.urlopen(req, timeout=timeout))
            if not resp.get('ok'):
                raise RuntimeError(resp.get('error', {}).get('message', 'bridge error')[:200])
            return resp.get('data', {}).get('value')
        except Exception as e:
            last = e
            time.sleep(1 + i)
    raise last

# ---------- 对表（HTTP Date 头秒翻转相位检测，与引擎同款算法）----------
def sync_clock():
    samples, last_sec = [], None
    start = time.time()
    while time.time() - start < 4.5:
        t0 = time.time()
        try:
            req = urllib.request.Request(ORIGIN + '/favicon.ico', method='HEAD')
            date_hdr = urllib.request.urlopen(req, timeout=5, context=SSL_CTX).headers.get('Date')
            t1 = time.time()
            sec = int(datetime.strptime(date_hdr, '%a, %d %b %Y %H:%M:%S %Z').replace(tzinfo=timezone.utc).timestamp())
            if last_sec is not None and sec == last_sec + 1:
                samples.append(sec - (t0 + t1) / 2)  # 秒翻转瞬间 ≈ 请求往返中点
            last_sec = sec
        except Exception:
            pass
        time.sleep(0.12)
    if not samples:
        log('对表失败（服务器无响应），offset=0 兜底')
        return 0.0
    samples.sort()
    offset = samples[len(samples) // 2]
    log(f'时钟偏差 {offset*1000:.0f}ms（{len(samples)} 样本，±{max((samples[-1]-samples[0])/2, 0.06)*1000:.0f}ms）')
    return offset

# ---------- 无状态开火载荷（自带全部逻辑，页面只需已登录 + 停在任意 SIS 组件页）----------
ATTEMPT_JS = r'''
(async () => {
  const TERM = %TERM%; // 0=Sem1 1=Sem2
  const DRY = %DRY%;
  const parse = h => new DOMParser().parseFromString(h, 'text/html');
  const pageText = d => (d.body ? d.body.innerText.replace(/\s+/g, ' ') : '');
  async function post(doc, act, extra) {
    const form = doc.querySelector('form[name=win0]') || doc.forms.win0;
    if (!form) throw new Error('no win0 form');
    const p = new URLSearchParams(new FormData(form));
    p.set('ICAction', act); p.set('ICXPos', '0'); p.set('ICYPos', '0');
    if (extra) for (const [k, v] of Object.entries(extra)) p.set(k, v);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    let resp;
    try {
      resp = await fetch(form.action, { method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: p.toString(), signal: ctrl.signal });
    } finally { clearTimeout(timer); }
    return parse(await resp.text());
  }
  function findAct(doc, re, pre) {
    for (const a of doc.querySelectorAll('a[href*="submitAction"]')) {
      const t = (a.innerText || '').replace(/\s+/g, ' ').trim();
      const m = (a.getAttribute('href') || '').match(/submitAction_\w+\(document\.\w+,'([^']*)'/);
      if (m && (re.test(t) || (pre && m[1].startsWith(pre)))) return m[1];
    }
    for (const inp of doc.querySelectorAll('input.PSPUSHBUTTON, input[type=submit]')) {
      const t = (inp.value || '').trim();
      if ((re.test(t) || (pre && (inp.id || '').startsWith(pre))) && inp.name) return inp.name;
    }
    return null;
  }
  const want = TERM === 1 ? 'Sem 2' : 'Sem 1';
  const onTerm = d => { const m = pageText(d).match(/\d{4}-\d{2} (Sem \d) \|/); return m && m[1] === want; };
  // 新鲜 GET 拿当前组件状态（ICStateNum）
  const f = document.querySelector('#ptifrmtgtframe');
  if (!f) return { state: 'error', note: 'no iframe — 标签页不在 SIS 组件页' };
  let doc = parse(await (await fetch(f.src, { credentials: 'include' })).text());
  // 切到目标学期
  for (let i = 0; i < 3 && !onTerm(doc); i++) {
    let radios = doc.querySelectorAll('input[name="SSR_DUMMY_RECV1$sels$0"]');
    if (!radios.length) {
      const chg = findAct(doc, /change term/i, 'DERIVED_SSS_SCT_SSS_TERM_LINK');
      if (!chg) return { state: 'retry', note: '响应异常(非组件页)' };
      doc = await post(doc, chg);
      radios = doc.querySelectorAll('input[name="SSR_DUMMY_RECV1$sels$0"]');
    }
    if (!radios.length) return { state: 'retry', note: '无学期选项' };
    const cont = findAct(doc, /continue/i, 'DERIVED_SSS_SCT_SSR_PB_GO');
    if (!cont) return { state: 'retry', note: '无 Continue' };
    doc = await post(doc, cont, { 'SSR_DUMMY_RECV1$sels$0': radios[TERM].value });
  }
  if (!onTerm(doc)) return { state: 'retry', note: '学期切换失败' };
  // Proceed → Confirm
  const act = findAct(doc, /proceed to step 2|^enroll$/i, 'DERIVED_REGFRM1_LINK_ADD_ENRL');
  if (!act) return { state: 'error', note: '车为空或无 Proceed 按钮' };
  const conf = await post(doc, act);
  const ctxt = pageText(conf);
  if (/CANNOT enroll during suspension|outside course selection period/i.test(ctxt)) return { state: 'blocked' };
  const fin = findAct(conf, /finish enrolling/i);
  if (!fin) return { state: 'retry', note: '弹回/无 Finish（标题: ' + ((conf.querySelector('.PAPAGETITLE') || {}).textContent || '?') + '）' };
  if (DRY) return { state: 'dry', note: '链路完整，Finish 按钮=' + fin };
  const done = await post(conf, fin);
  const rows = [];
  for (const img of done.querySelectorAll('img')) {
    const alt = (img.alt || img.title || '').toLowerCase();
    if (!/success|error|warning|wait/.test(alt)) continue;
    const tr = img.closest('tr');
    rows.push({ status: alt, row: tr ? tr.innerText.replace(/\s+/g, ' ').trim().slice(0, 150) : '' });
  }
  const ok = rows.filter(x => x.status.includes('success')).length;
  const err = rows.filter(x => x.status.includes('error')).length;
  if (ok + err > 0) return { state: 'settled', ok, err, rows };
  return { state: 'retry', note: '过渡页(' + (rows.map(x => x.status).join('/') || '无行') + ')' };
})()
'''

def attempt(term, dry=False):
    code = ATTEMPT_JS.replace('%TERM%', str(term)).replace('%DRY%', 'true' if dry else 'false')
    v = wb_eval(code)
    return json.loads(v) if isinstance(v, str) else v

# ---------- 一轮的调度（本地计时，线程独立）----------
def run_round(idx, open_time, term, window_sec, offset):
    T = datetime.fromisoformat(open_time).timestamp()
    fire_at = T - offset - 0.06
    wait = fire_at - time.time()
    if wait > 0:
        log(f'第{idx}轮 (term={term}) 等待 {wait:.0f}s → {open_time}')
        while True:
            d = fire_at - time.time()
            if d <= 0: break
            time.sleep(min(d - 0.02, 30) if d > 0.5 else max(d - 0.005, 0.001))
        while time.time() < fire_at: pass  # 末段自旋
    deadline = time.time() + window_sec
    n = 0
    while time.time() < deadline:
        n += 1
        try:
            r = attempt(term)
        except Exception as e:
            log(f'第{idx}轮第{n}次 桥接错误: {e} — 1s 后重试')
            time.sleep(1)
            continue
        state = r.get('state')
        if state == 'settled':
            log(f'第{idx}轮完成! 成功 {r["ok"]} 门, 失败 {r["err"]} 门')
            for row in r['rows']: log('  ', row['status'], '|', row['row'][:100])
            return r
        log(f'第{idx}轮第{n}次 {state}: {r.get("note", "")[:110]}')
        time.sleep(0.3 if state == 'blocked' else 0.8)
    log(f'第{idx}轮超过重试窗口仍未成功')
    return {'state': 'expired'}

def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'sync':
        sync_clock()
    elif cmd == 'probe':
        term = int(sys.argv[2]) if len(sys.argv) > 2 else 0
        log('干跑链路（不点 Finish）…')
        print(json.dumps(attempt(term, dry=True), ensure_ascii=False, indent=1))
    elif cmd == 'fire':
        t1, t2 = sys.argv[2], sys.argv[3]
        win = int(sys.argv[4]) * 60 if len(sys.argv) > 4 else 900
        offset = sync_clock()
        threads = [threading.Thread(target=run_round, args=(1, t1, 0, win, offset)),
                   threading.Thread(target=run_round, args=(2, t2, 1, win, offset))]
        for t in threads: t.start()
        for t in threads: t.join()
        log('全部轮次结束')
    else:
        print(__doc__)

if __name__ == '__main__':
    main()
