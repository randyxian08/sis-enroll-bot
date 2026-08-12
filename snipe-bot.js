// SIS 捡漏狙击机器人 v1 — 监控满员课程，出现空位立即自动提交
// 注入到 sis-main.hku.hk 的 Enrollment: Add Classes 页面运行
// 用法：window.__snipeBot.start({
//   targets: [{ nbr: "12345", term: 0 }],   // term: 0=Sem1, 1=Sem2
//   intervalMs: 5000,                        // 轮询间隔，最小 2000
// })
//
// 原理：Add Classes 第 1 页的 Temporary Course List 每行直接显示 Open/Closed 状态。
//       每个周期 = 1 次学期切换 POST（必要时补 1 次 Enter 加课 POST），
//       发现目标行为 Open 立刻走 Proceed to Step 2 → Finish Enrolling，与手动完全一致。
//       同一学期的所有目标共享一次页面加载，10 门课和 1 门课开销相同。
(function () {
  if (window.__snipeBot && window.__snipeBot.__v === 1) return;

  const frame = () => document.querySelector('#ptifrmtgtframe');
  const idoc = () => frame().contentDocument;
  const logs = [];
  const listeners = [];
  const log = (...a) => {
    const line = new Date().toISOString() + ' ' + a.join(' ');
    logs.push(line);
    console.log('[snipe-bot]', ...a);
    window.__snipeBot.lastLog = line;
    document.title = '[SNIPER] ' + a.join(' ').slice(0, 80);
    listeners.forEach((fn) => { try { fn(line); } catch (e) {} });
  };

  async function rawPost(url, body, timeoutMs) {
    const t0 = performance.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 90000);
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: ctrl.signal,
      });
    } finally { clearTimeout(timer); }
    const html = await resp.text();
    return { resp, html, ms: Math.round(performance.now() - t0) };
  }

  function formParams(doc, action) {
    const form = doc.querySelector('form[name=win0]') || doc.forms.win0;
    const p = new URLSearchParams(new FormData(form));
    p.set('ICAction', action);
    p.set('ICXPos', '0');
    p.set('ICYPos', '0');
    return { url: form.action, body: p.toString() };
  }

  async function post(doc, action, extra) {
    const { url, body } = formParams(doc, action);
    let finalBody = body;
    if (extra) {
      const p = new URLSearchParams(body);
      for (const [k, v] of Object.entries(extra)) p.set(k, v);
      finalBody = p.toString();
    }
    const r = await rawPost(url, finalBody);
    log(`POST ${action} -> ${r.resp.status} ${r.ms}ms`);
    return new DOMParser().parseFromString(r.html, 'text/html');
  }

  function findAction(doc, re, idPrefix) {
    for (const a of doc.querySelectorAll('a[href*="submitAction"]')) {
      const label = (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim();
      const img = a.querySelector('img');
      const alt = img ? (img.alt || '') : '';
      const m = (a.getAttribute('href') || '').match(/submitAction_\w+\(document\.\w+,'([^']*)'/);
      if (m && (re.test(label) || re.test(alt) || (idPrefix && m[1].indexOf(idPrefix) === 0))) return m[1];
    }
    for (const inp of doc.querySelectorAll('input.PSPUSHBUTTON, input[type=submit]')) {
      const label = (inp.value || '').trim();
      if ((re.test(label) || (idPrefix && (inp.id || '').indexOf(idPrefix) === 0)) && inp.name) return inp.name;
    }
    return null;
  }

  const pageText = (doc) => (doc.body ? doc.body.innerText.replace(/\s+/g, ' ') : '');

  // ---------- Add Classes 页专用 ----------
  const CLASS_NBR_FIELD = 'DERIVED_REGFRM1_CLASS_NBR$105$';
  const ENTER_ACTION = 'DERIVED_REGFRM1_SSR_PB_ADDTOLIST2$106$';

  // 确保拿到指定学期 Add Classes 第 1 页的 doc
  async function getStep1Doc(termIdx) {
    const want = termIdx === 1 ? 'Sem 2' : 'Sem 1';
    let doc = idoc();
    const txt = pageText(doc);
    // 已在 Add Classes 第 1 页且学期正确
    if (/Select classes to add/i.test(txt) && txt.includes('2026-27 ' + want + ' |')) return doc;

    if (doc.querySelector('input[name="SSR_DUMMY_RECV1$sels$0"]')) {
      // Select Term 页
      doc.querySelectorAll('input[name="SSR_DUMMY_RECV1$sels$0"]')
        .forEach((r, i) => { r.checked = (i === termIdx); });
      const cont = findAction(doc, /continue/i, 'DERIVED_SSS_SCT_SSR_PB_GO');
      if (!cont) throw new Error('Select Term 页没找到 Continue');
      doc = await post(doc, cont);
    } else if (/Select classes to add/i.test(txt)) {
      // Add 页但学期不对 → Change Term
      const change = findAction(doc, /change term/i, 'DERIVED_SSS_SCT_SSS_TERM_LINK');
      if (!change) throw new Error('没找到 Change Term');
      doc = await post(doc, change);
      const radios = doc.querySelectorAll('input[name="SSR_DUMMY_RECV1$sels$0"]');
      if (!radios.length) throw new Error('Change Term 后没到 Select Term 页');
      radios.forEach((r, i) => { r.checked = (i === termIdx); });
      const cont = findAction(doc, /continue/i, 'DERIVED_SSS_SCT_SSR_PB_GO');
      doc = await post(doc, cont);
    } else {
      throw new Error('当前页面既不是 Add Classes 也不是 Select Term，请把标签页停在 Enrollment: Add Classes 再注入。页面: ' + txt.slice(0, 120));
    }
    const t2 = pageText(doc);
    if (!/Select classes to add/i.test(t2)) throw new Error('没到 Add Classes 第 1 页: ' + t2.slice(0, 150));
    return doc;
  }

  // 从第 1 页表格里读某门课的状态：open / closed / waitlist / absent / unknown
  function readClassStatus(doc, nbr) {
    const rows = doc.querySelectorAll('tr');
    for (const tr of rows) {
      const txt = tr.innerText ? tr.innerText.replace(/\s+/g, ' ') : '';
      if (!txt.includes(nbr)) continue;
      const signals = [];
      for (const img of tr.querySelectorAll('img')) {
        signals.push((img.alt || '') + ' ' + (img.title || ''));
      }
      signals.push(txt);
      const sig = signals.join(' | ');
      if (/\bwait\s*list/i.test(sig)) return { status: 'waitlist', row: txt.slice(0, 120) };
      if (/\bclosed\b/i.test(sig)) return { status: 'closed', row: txt.slice(0, 120) };
      if (/\bopen\b/i.test(sig)) return { status: 'open', row: txt.slice(0, 120) };
      return { status: 'unknown', row: txt.slice(0, 120) };
    }
    return { status: 'absent' };
  }

  const inList = (doc, nbr) => readClassStatus(doc, nbr).status !== 'absent';

  async function ensureInList(doc, nbr) {
    if (inList(doc, nbr)) return doc;
    log(`课程 ${nbr} 不在列表，执行 Enter 加入`);
    doc = await post(doc, ENTER_ACTION, { [CLASS_NBR_FIELD]: nbr });
    const st = readClassStatus(doc, nbr);
    if (st.status === 'absent') {
      const msg = pageText(doc).match(new RegExp('[^.]*' + nbr + '[^.]*\\.')) || pageText(doc).match(/class number entered is not valid[^.]*/i);
      throw new Error(`课程 ${nbr} 加入失败: ${msg ? msg[0] : '未知原因'}`);
    }
    return doc;
  }

  function parseResults(doc) {
    const rows = [];
    for (const img of doc.querySelectorAll('img')) {
      const alt = (img.alt || img.title || '').toLowerCase();
      if (!/success|error|warning|wait/.test(alt)) continue;
      const tr = img.closest('tr');
      rows.push({ status: alt, row: tr ? tr.innerText.replace(/\s+/g, ' ').trim().slice(0, 120) : '' });
    }
    return { rows, summary: pageText(doc).slice(0, 400) };
  }

  // 开火：Proceed to Step 2 → Finish Enrolling（与手动完全一致）
  async function fire(doc) {
    const act = findAction(doc, /proceed to step 2/i, 'DERIVED_REGFRM1_LINK_ADD_ENRL');
    if (!act) return { error: '没找到 Proceed to Step 2 of 3' };
    const confirm = await post(doc, act);
    const finish = findAction(confirm, /finish enrolling/i);
    if (!finish) return { error: 'Confirm 页没找到 Finish Enrolling', dump: pageText(confirm).slice(0, 400) };
    const doneDoc = await post(confirm, finish);
    return { done: true, results: parseResults(doneDoc) };
  }

  let running = false;
  let stats = { cycles: 0, startedAt: null, fires: 0 };

  window.__snipeBot = {
    __v: 1,
    lastLog: '',
    stats,
    getLogs: () => logs.slice(),
    onLog: (fn) => listeners.push(fn),

    // 干跑一个周期：只看不抢，返回每门目标课的实时状态
    async check(cfg) {
      try {
        const targets = (cfg && cfg.targets) || [];
        if (!targets.length) return { error: 'targets 为空' };
        const byTerm = {};
        targets.forEach((t) => { (byTerm[t.term || 0] = byTerm[t.term || 0] || []).push(t.nbr); });
        const out = {};
        for (const [term, nbrs] of Object.entries(byTerm)) {
          let doc = await getStep1Doc(Number(term));
          for (const nbr of nbrs) {
            if (!inList(doc, nbr)) {
              try { doc = await ensureInList(doc, nbr); } catch (e) { out[nbr] = { status: 'error', note: e.message }; continue; }
            }
            out[nbr] = readClassStatus(doc, nbr);
          }
        }
        log('check:', JSON.stringify(out));
        return out;
      } catch (e) { log('check 异常:', e.message); return { error: e.message }; }
    },

    async start(cfg) {
      if (running) return 'already running';
      const targets = (cfg && cfg.targets) || [];
      if (!targets.length) return 'targets 为空';
      const interval = Math.max(cfg.intervalMs || 5000, 2000);
      const until = cfg.until ? new Date(cfg.until).getTime() : Infinity;
      running = true;
      stats.cycles = 0; stats.fires = 0; stats.startedAt = new Date().toISOString();
      log(`开蹲 ${targets.length} 门课，间隔 ${interval}ms`, JSON.stringify(targets));
      if (document.hidden) log('⚠️ 标签页不可见，浏览器会钳制定时器！请保持前台');

      const done = new Set(); // 已抢到的 nbr
      while (running && Date.now() < until) {
        stats.cycles++;
        try {
          const byTerm = {};
          targets.filter((t) => !done.has(t.nbr))
            .forEach((t) => { (byTerm[t.term || 0] = byTerm[t.term || 0] || []).push(t.nbr); });
          if (!Object.keys(byTerm).length) { log('全部目标已抢到，收工'); break; }

          for (const [term, nbrs] of Object.entries(byTerm)) {
            let doc = await getStep1Doc(Number(term));
            for (const nbr of nbrs) {
              if (!inList(doc, nbr)) {
                try { doc = await ensureInList(doc, nbr); } catch (e) { log(`课程 ${nbr} 加列表失败:`, e.message); }
              }
            }
            const openOnes = nbrs.filter((nbr) => {
              const st = readClassStatus(doc, nbr);
              if (st.status !== 'closed') log(`课程 ${nbr}: ${st.status} ${st.row || ''}`);
              return st.status === 'open';
            });
            if (openOnes.length && running) {
              log(`🎯 空位出现: ${openOnes.join(', ')} — 立即提交！`);
              stats.fires++;
              const r = await fire(doc);
              if (r.done) {
                const okRows = r.results.rows.filter((x) => x.status.includes('success'));
                log('提交结果:', JSON.stringify(r.results.rows).slice(0, 500));
                // 成功行里包含哪个 nbr 就标记哪个；若解析不出，保守起见不标记，下轮再看
                for (const nbr of openOnes) {
                  if (!r.results.rows.length || okRows.some((x) => x.row.includes(nbr))) done.add(nbr);
                }
              } else {
                log('开火异常:', JSON.stringify(r).slice(0, 300));
              }
            }
          }
        } catch (e) {
          log('轮询周期出错:', e.message, '— 下周期继续');
        }
        // 带 ±20% 抖动的间隔，避免请求过于规律
        const jitter = interval * (0.8 + Math.random() * 0.4);
        await new Promise((r2) => setTimeout(r2, jitter));
      }
      running = false;
      log('狙击结束', JSON.stringify({ cycles: stats.cycles, fires: stats.fires, done: [...done] }));
      return { cycles: stats.cycles, fires: stats.fires, enrolled: [...done] };
    },

    stop() { running = false; log('手动停止'); },
    isRunning: () => running,
  };
  log('snipe-bot v1 已加载');
})();
