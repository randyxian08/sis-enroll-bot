// SIS 机器人控制面板 v1 — 悬浮可视化界面
// 依赖页面里已注入的 window.__enrollBot（抢课）和/或 window.__snipeBot（捡漏）
// 注入后右下角出现面板；配置存 localStorage，刷新不丢。
(function () {
  if (window.__sisPanel) {
    const old = document.getElementById('sis-bot-panel');
    if (old) old.remove(); // 允许重复注入：刷新面板而不重复叠加
  }
  window.__sisPanel = true;

  const CFG_KEY = 'sisBotCfg.v1';
  const cfg = Object.assign({
    sem1: '2026-08-18T10:00',
    sem2: '2026-08-18T10:10',
    snipeTargets: '',        // 每行一个：课号,学期(1或2)
    intervalMs: 5000,
    retrySec: 120,           // 抢课重试窗口（秒）：服务器晚开也能捕捉
    collapsed: false,
  }, JSON.parse(localStorage.getItem(CFG_KEY) || '{}'));
  const save = () => localStorage.setItem(CFG_KEY, JSON.stringify(cfg));

  const host = document.createElement('div');
  host.id = 'sis-bot-panel';
  const shadow = host.attachShadow({ mode: 'open' });
  document.body.appendChild(host);

  shadow.innerHTML = `
  <style>
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, "SF Pro", "PingFang SC", sans-serif; }
    .card { position: fixed; right: 16px; bottom: 16px; width: 360px; z-index: 2147483647;
      background: #1c1c1e; color: #f2f2f7; border-radius: 14px; overflow: hidden;
      box-shadow: 0 12px 40px rgba(0,0,0,.45); font-size: 13px; }
    .hd { display: flex; align-items: center; gap: 8px; padding: 10px 12px;
      background: #2c2c2e; cursor: move; user-select: none; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #8e8e93; }
    .dot.on { background: #30d158; } .dot.busy { background: #ff9f0a; }
    .hd b { font-size: 13px; letter-spacing: .3px; }
    .hd .sp { flex: 1; }
    .hd button { background: none; border: none; color: #98989d; font-size: 15px; cursor: pointer; padding: 0 4px; }
    .tabs { display: flex; background: #2c2c2e; }
    .tabs div { flex: 1; text-align: center; padding: 7px 0; cursor: pointer; color: #98989d; border-bottom: 2px solid transparent; }
    .tabs div.act { color: #fff; border-bottom-color: #0a84ff; }
    .bd { padding: 12px; max-height: 460px; overflow-y: auto; }
    .row { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
    label { color: #98989d; white-space: nowrap; font-size: 12px; }
    input, textarea, select { flex: 1; background: #2c2c2e; border: 1px solid #3a3a3c; color: #f2f2f7;
      border-radius: 7px; padding: 6px 8px; font-size: 12px; min-width: 0; }
    textarea { resize: vertical; min-height: 56px; font-family: ui-monospace, monospace; }
    .btns { display: flex; gap: 6px; margin-top: 4px; }
    .btns button { flex: 1; border: none; border-radius: 8px; padding: 8px 0; font-size: 13px; cursor: pointer; }
    .go { background: #0a84ff; color: #fff; } .go:hover { background: #0070e0; }
    button:disabled { opacity: .35; cursor: not-allowed; }
    .ghost { background: #3a3a3c; color: #f2f2f7; } .ghost:hover { background: #48484a; }
    .stop { background: #ff453a; color: #fff; }
    .hint { color: #636366; font-size: 11px; margin-top: 8px; line-height: 1.5; }
    .status { margin-top: 8px; padding: 8px; background: #2c2c2e; border-radius: 8px;
      font-size: 12px; color: #d1d1d6; word-break: break-all; max-height: 90px; overflow-y: auto; }
    .log { font-family: ui-monospace, monospace; font-size: 10.5px; line-height: 1.6;
      white-space: pre-wrap; word-break: break-all; color: #b8b8bd; }
    .log .err { color: #ff6961; } .log .ok { color: #30d158; } .log .hit { color: #ffd60a; }
    .tag { font-size: 10px; padding: 1px 6px; border-radius: 4px; background: #3a3a3c; color: #98989d; }
    .mini { font-size: 11px; color: #98989d; }
  </style>
  <div class="card" id="card">
    <div class="hd" id="hd">
      <span class="dot" id="dot"></span><b>SIS 选课机器人</b><span class="tag" id="ver"></span>
      <span class="sp"></span>
      <button id="min">—</button>
    </div>
    <div id="body">
      <div class="tabs">
        <div data-t="rush" class="act">抢课</div>
        <div data-t="snipe">捡漏</div>
        <div data-t="log">日志</div>
      </div>
      <div class="bd" id="bd"></div>
    </div>
  </div>`;

  const $ = (s) => shadow.querySelector(s);
  const bd = $('#bd'), dot = $('#dot');

  // ---------- 结果文案格式化（把原始 JSON 翻译成人话）----------
  const esc = (s) => String(s).replace(/</g, '&lt;');
  function fmtDryrun(r) {
    if (!r) return '❓ 演练无返回';
    if (r.blocked) return '✅ 演练通过：链路完整，流程已打通。<br><span class="mini">服务器在封窗期正常拒绝（outside course selection period），符合预期——等开闸后引擎会自动提交，无需再演练。</span>';
    if (r.note) return '⚠️ ' + esc(r.note) + '<br><span class="mini">选课车为空时只能验证到学期选择这一步。</span>';
    if (r.error) return '❌ 演练失败：' + esc(r.error);
    return '❓ 演练结果异常：' + esc(JSON.stringify(r));
  }
  function fmtRounds(rs) {
    const arr = Array.isArray(rs) ? rs : [rs];
    if (!arr.length) return '（无轮次）';
    return arr.map((r, i) => {
      const rows = (r.results && r.results.rows) || [];
      if (r.done) {
        const ok = rows.filter((x) => x.status.includes('success')).length;
        const err = rows.filter((x) => x.status.includes('error')).length;
        return `第 ${i + 1} 轮：✅ 成功 ${ok} 门，失败 ${err} 门<span class="mini">（${esc(JSON.stringify(rows)).slice(0, 160)}）</span>`;
      }
      if (r.blocked) return `第 ${i + 1} 轮：⏳ 封窗期内未提交（重试窗口已结束）`;
      if (r.error) return `第 ${i + 1} 轮：❌ ${esc(r.error)}`;
      return `第 ${i + 1} 轮：${esc(JSON.stringify(r))}`;
    }).join('<br>');
  }

  $('#ver').textContent =
    (window.__enrollBot ? '抢课v' + window.__enrollBot.__v : '') +
    (window.__enrollBot && window.__snipeBot ? ' · ' : '') +
    (window.__snipeBot ? '捡漏v' + window.__snipeBot.__v : '') || '引擎未加载';

  // ---------- 拖拽 ----------
  let drag = null;
  $('#hd').addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    const card = $('#card').getBoundingClientRect();
    drag = { dx: e.clientX - card.left, dy: e.clientY - card.top };
  });
  document.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const card = $('#card');
    card.style.left = (e.clientX - drag.dx) + 'px';
    card.style.top = (e.clientY - drag.dy) + 'px';
    card.style.right = 'auto'; card.style.bottom = 'auto';
  });
  document.addEventListener('mouseup', () => { drag = null; });

  $('#min').onclick = () => {
    cfg.collapsed = !cfg.collapsed; save();
    $('#body').style.display = cfg.collapsed ? 'none' : '';
    $('#min').textContent = cfg.collapsed ? '+' : '—';
  };
  if (cfg.collapsed) { $('#body').style.display = 'none'; $('#min').textContent = '+'; }

  // ---------- 三个页签 ----------
  const views = {
    rush() {
      bd.innerHTML = `
        <div class="row"><label>Sem 1 开闸</label><input type="datetime-local" id="t1" value="${cfg.sem1}"></div>
        <div class="row"><label>Sem 2 开闸</label><input type="datetime-local" id="t2" value="${cfg.sem2}"></div>
        <div class="row"><label>重试窗口(s)</label><input type="number" id="rw" value="${cfg.retrySec}" min="30" step="30" title="开火后持续重试这么久，捕捉服务器晚开。担心晚开>2分钟就调大，如 300"></div>
        <div class="btns">
          <button class="ghost" id="dry">演 练</button>
          <button class="go" id="start">开始抢课</button>
          <button class="stop" id="stop">停止</button>
        </div>
        <div class="status" id="st">引擎${window.__enrollBot ? '就绪' : '<b style="color:#ff6961">未加载</b>（请在选课车页面注入）'}</div>
        <div class="hint">到点自动：对表 → 预热连接 → 预封装请求 → 毫秒级提交。<br>开火后持续重试「重试窗口」这么久（默认 120s），服务器晚开 1-2 分钟也能捕捉。期间保持本标签页前台。</div>`;
      $('#t1').onchange = (e) => { cfg.sem1 = e.target.value; save(); };
      $('#t2').onchange = (e) => { cfg.sem2 = e.target.value; save(); };
      $('#rw').onchange = (e) => { cfg.retrySec = Math.max(30, +e.target.value || 120); save(); };
      if (!window.__enrollBot) { bd.querySelectorAll('.btns button').forEach((b) => { b.disabled = true; }); return; }
      $('#dry').onclick = async () => { $('#st').innerHTML = '演练中…'; const r = await window.__enrollBot.dryRun(); $('#st').innerHTML = fmtDryrun(r); };
      $('#start').onclick = () => {
        const iso = (v) => new Date(v).toISOString();
        $('#st').innerHTML = '已启动，等待开闸…<br><span class="mini">两轮并发调度：对表 → 预热 → 预封装 → 到点提交，开火后重试窗口 ' + cfg.retrySec + ' 秒。保持本页前台。</span>';
        window.__enrollBot.start({ rounds: [
          { openTime: iso(cfg.sem1), term: 0, retryWindowMs: cfg.retrySec * 1000 },
          { openTime: iso(cfg.sem2), term: 1, retryWindowMs: cfg.retrySec * 1000 },
        ] }).then((r) => { $('#st').innerHTML = '结束：<br>' + fmtRounds(r); });
      };
      $('#stop').onclick = () => window.__enrollBot.stop();
    },

    snipe() {
      bd.innerHTML = `
        <div class="row"><label>目标课号</label></div>
        <textarea id="targets" placeholder="每行一个：课号,学期&#10;例：&#10;12345,1&#10;23456,2">${cfg.snipeTargets}</textarea>
        <div class="row"><label>间隔(ms)</label><input type="number" id="iv" value="${cfg.intervalMs}" min="2000" step="500"></div>
        <div class="btns">
          <button class="ghost" id="chk">查一次状态</button>
          <button class="go" id="go">开始蹲守</button>
          <button class="stop" id="stop">停止</button>
        </div>
        <div class="status" id="st">引擎${window.__snipeBot ? '就绪' : '<b style="color:#ff6961">未加载</b>（请在 Add Classes 页面注入）'}</div>
        <div class="hint">课号 = Class Nbr（4-5 位数字），在 Class Search 结果或你的课表里查。<br>学期：1 = Sem 1，2 = Sem 2。建议间隔 ≥ 5000ms。</div>`;
      const readTargets = () => $('#targets').value.split('\n')
        .map((l) => l.trim()).filter(Boolean)
        .map((l) => { const [nbr, t] = l.split(/[,\s]+/); return { nbr, term: t === '2' ? 1 : 0 }; })
        .filter((t) => /^\d{3,6}$/.test(t.nbr));
      $('#targets').oninput = (e) => { cfg.snipeTargets = e.target.value; save(); };
      $('#iv').onchange = (e) => { cfg.intervalMs = +e.target.value; save(); };
      if (!window.__snipeBot) { bd.querySelectorAll('.btns button').forEach((b) => { b.disabled = true; }); return; }
      $('#chk').onclick = async () => {
        $('#st').textContent = '查询中…';
        const r = await window.__snipeBot.check({ targets: readTargets() });
        $('#st').innerHTML = Object.entries(r).map(([k, v]) =>
          `<div>${k}: <b>${v.status || v.error}</b>${v.row ? ' <span class="mini">' + v.row + '</span>' : ''}</div>`).join('');
      };
      $('#go').onclick = () => {
        const targets = readTargets();
        if (!targets.length) { $('#st').textContent = '先填课号'; return; }
        $('#st').textContent = '蹲守中…';
        window.__snipeBot.start({ targets, intervalMs: cfg.intervalMs })
          .then((r) => { $('#st').textContent = '结束: ' + JSON.stringify(r); });
      };
      $('#stop').onclick = () => window.__snipeBot.stop();
    },

    log() {
      bd.innerHTML = `
        <div class="btns">
          <button class="ghost" id="clr">清空显示</button>
          <button class="ghost" id="cpy">复制全部</button>
          <button class="go" id="exp">导出日志</button>
        </div>
        <div class="status log" id="lg" style="max-height:340px"></div>
        <div class="status" id="st2" style="margin-top:6px;min-height:18px"></div>
        <div class="hint">日志存在页面内存里，刷新/关闭标签页即丢失——复盘前务必点「导出日志」下载保存。</div>`;
      renderLogs(true);
      $('#clr').onclick = () => { $('#lg').innerHTML = ''; $('#st2').textContent = '显示已清空（内存日志仍在）'; };
      $('#cpy').onclick = () => {
        navigator.clipboard.writeText(allLogs().join('\n')).then(
          () => { $('#st2').textContent = '已复制'; },
          () => { $('#st2').textContent = '复制失败（浏览器限制），用导出'; }
        );
      };
      $('#exp').onclick = () => {
        const text = allLogs().join('\n') + '\n';
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'sis-bot-' + new Date().toISOString().replace(/[:.]/g, '-') + '.log';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
        $('#st2').textContent = '已触发下载（查看浏览器下载目录）';
      };
    },
  };

  function allLogs() {
    const a = (window.__enrollBot ? window.__enrollBot.getLogs() : [])
      .concat(window.__snipeBot ? window.__snipeBot.getLogs() : []);
    return a.sort((x, y) => x.localeCompare(y));
  }

  let logTimer = null;
  function renderLogs(reset) {
    const el = $('#lg');
    if (!el) return;
    const lines = allLogs();
    el.innerHTML = lines.map((l) => {
      const c = /出错|异常|失败|error/i.test(l) ? 'err'
        : /成功|完成|enrolled/i.test(l) ? 'ok'
        : /🎯|空位/.test(l) ? 'hit' : '';
      return `<div class="${c}">${l.replace(/</g, '&lt;')}</div>`;
    }).join('');
    el.scrollTop = el.scrollHeight;
    if (reset) { clearInterval(logTimer); logTimer = setInterval(() => renderLogs(false), 800); }
  }

  shadow.querySelectorAll('.tabs div').forEach((tab) => {
    tab.onclick = () => {
      shadow.querySelectorAll('.tabs div').forEach((x) => x.classList.remove('act'));
      tab.classList.add('act');
      clearInterval(logTimer);
      views[tab.dataset.t]();
    };
  });

  // ---------- 状态灯 + 引擎版本标签（每秒刷新，引擎后注入也能识别）----------
  setInterval(() => {
    const busy = (window.__snipeBot && window.__snipeBot.isRunning && window.__snipeBot.isRunning());
    const last = (window.__enrollBot && window.__enrollBot.lastLog || '') + (window.__snipeBot && window.__snipeBot.lastLog || '');
    dot.className = 'dot' + (busy ? ' busy' : (last ? ' on' : ''));
    $('#ver').textContent =
      (window.__enrollBot ? '抢课v' + window.__enrollBot.__v : '') +
      (window.__enrollBot && window.__snipeBot ? ' · ' : '') +
      (window.__snipeBot ? '捡漏v' + window.__snipeBot.__v : '') || '引擎未加载';
  }, 1000);

  views.rush();
  console.log('[sis-panel] 控制面板已加载');
})();
