// SIS 选课自动报名机器人 v5 — DOM 解析 + 客户端极限优化
// 注入到 sis-main.hku.hk 选课车页面运行
// 用法：window.__enrollBot.start({rounds:[
//   {openTime:"2026-08-18T10:00:00+08:00", term:0},   // Sem 1
//   {openTime:"2026-08-18T10:10:00+08:00", term:1},   // Sem 2
// ]})
//
// 设计：解析全部走 DOM（PeopleSoft 页面结构稳定，DOM 最不容易踩边界）；
//       优化全在调度与网络层：亚秒时钟同步、连接池预热、请求体预封装、自旋精确定时。
(function () {
  if (window.__enrollBot && window.__enrollBot.__v === 9) return;

  const frame = () => document.querySelector('#ptifrmtgtframe');
  const idoc = () => frame().contentDocument;
  const logs = [];
  const log = (...a) => {
    const line = new Date().toISOString() + ' ' + a.join(' ');
    logs.push(line);
    console.log('[enroll-bot]', ...a);
    window.__enrollBot.lastLog = line;
    document.title = '[BOT] ' + a.join(' ').slice(0, 80);
  };
  const origin = location.origin;

  // ---------- 网络 ----------
  async function rawPost(url, body, timeoutMs) {
    const t0 = performance.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 120000); // 高峰转圈可能 40s+
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

  // ---------- 亚秒级时钟同步（Date 头秒翻转相位检测，±60ms）----------
  async function preciseSync() {
    const samples = [];
    let lastSec = null;
    const start = Date.now();
    while (Date.now() - start < 4500) {
      const t0 = performance.now();
      const r = await fetch(origin + '/favicon.ico', { method: 'HEAD', cache: 'no-store', credentials: 'include' }).catch(() => null);
      const t1 = performance.now();
      if (r) {
        const sec = Math.floor(new Date(r.headers.get('Date')).getTime() / 1000);
        if (lastSec !== null && sec === lastSec + 1) {
          const mid = Date.now() - (performance.now() - (t0 + t1) / 2);
          samples.push(sec * 1000 - mid);
        }
        lastSec = sec;
      }
      await new Promise((r2) => setTimeout(r2, 120));
    }
    if (!samples.length) {
      const r = await fetch(origin + '/favicon.ico', { method: 'HEAD', cache: 'no-store', credentials: 'include' });
      return { offset: new Date(r.headers.get('Date')).getTime() - Date.now(), accuracy: 1000 };
    }
    samples.sort((a, b) => a - b);
    return { offset: samples[Math.floor(samples.length / 2)], accuracy: Math.max((samples[samples.length - 1] - samples[0]) / 2, 60), samples: samples.length };
  }

  async function warmPool(n) {
    const jobs = [];
    for (let i = 0; i < (n || 3); i++) {
      jobs.push(fetch(origin + '/favicon.ico', { method: 'HEAD', cache: 'no-store', credentials: 'include' }).catch(() => {}));
    }
    await Promise.all(jobs);
  }

  // ---------- 精度调度器：粗等待 → 细轮询 → 末 20ms 自旋 ----------
  // 粗等待阶段每 30s 检查一次停止标志，保证 stop() 能及时生效
  async function sleepUntil(clientTs) {
    let d = clientTs - Date.now();
    while (d > 500) {
      if (!running) return;
      await new Promise((r) => setTimeout(r, Math.min(d - 300, 30000)));
      d = clientTs - Date.now();
    }
    while (d > 20) { await new Promise((r) => setTimeout(r, 10)); d = clientTs - Date.now(); }
    while (Date.now() < clientTs) { /* spin */ }
  }

  // 后台节流侦测：标签页不可见时浏览器会把定时器钳到 1s+
  function detectThrottling(cb) {
    let last = performance.now();
    const t = setInterval(() => {
      const now = performance.now();
      const drift = now - last - 100;
      last = now;
      if (drift > 500) cb(Math.round(drift));
    }, 100);
    return () => clearInterval(t);
  }

  // ---------- DOM 解析 ----------
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
  const BLOCKED_RE = /CANNOT enroll during suspension|outside course selection period/i;

  // 确保在指定学期的选课车页（term: 0=Sem1, 1=Sem2）
  // 覆盖三种起始状态：已是该车 / 在 Select Term 页 / 在另一学期的车
  // 注意：学期选择不改共享 DOM（并发轮次会串台），而是直接覆盖提交参数
  async function ensureTerm(doc, termIdx) {
    const want = termIdx === 1 ? 'Sem 2' : 'Sem 1';
    if (pageText(doc).includes('2026-27 ' + want + ' |')) return doc;

    let radios = doc.querySelectorAll('input[name="SSR_DUMMY_RECV1$sels$0"]');
    if (!radios.length) {
      // 不在 Select Term 页 → 先点 Change Term 过去
      log('切换学期到', want);
      const change = findAction(doc, /change term/i, 'DERIVED_SSS_SCT_SSS_TERM_LINK');
      if (!change) throw new Error('没找到 Change Term 按钮，当前页面: ' + pageText(doc).slice(0, 150));
      doc = await post(doc, change);
      radios = doc.querySelectorAll('input[name="SSR_DUMMY_RECV1$sels$0"]');
    }
    if (!radios.length) throw new Error('Select Term 页没找到学期选项');
    log('选择', want);
    const cont = findAction(doc, /continue/i, 'DERIVED_SSS_SCT_SSR_PB_GO');
    if (!cont) throw new Error('Select Term 页没找到 Continue');
    doc = await post(doc, cont, { 'SSR_DUMMY_RECV1$sels$0': radios[termIdx].value });
    if (!pageText(doc).includes('2026-27 ' + want + ' |')) throw new Error('选学期后页面不符: ' + pageText(doc).slice(0, 150));
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

  // ---------- 开火 ----------
  async function fireRound(round, prepared) {
    let doc = await ensureTerm(idoc(), round.term || 0);

    let first;
    if (prepared) {
      const r = await rawPost(prepared.url, prepared.body);
      log(`POST [prepared ${prepared.action}] -> ${r.resp.status} ${r.ms}ms`);
      first = new DOMParser().parseFromString(r.html, 'text/html');
    } else {
      const act = findAction(doc, /proceed to step 2|^enroll$/i, 'DERIVED_REGFRM1_LINK_ADD_ENRL');
      if (!act) return { error: '没找到 step2/Enroll 按钮（选课车是否为空？）', dump: pageText(doc).slice(0, 300) };
      first = await post(doc, act);
    }
    if (BLOCKED_RE.test(pageText(first))) return { blocked: true };

    const finish = findAction(first, /finish enrolling/i);
    if (!finish) return { error: 'Confirm classes 页没找到 Finish Enrolling', dump: pageText(first).slice(0, 500) };
    const doneDoc = await post(first, finish);
    return { done: true, results: parseResults(doneDoc) };
  }

  let running = false;

  window.__enrollBot = {
    __v: 9,
    lastLog: '',
    getLogs: () => logs.slice(),
    async warmup() { await warmPool(1); },
    async dryRun() {
      try {
        const doc = await ensureTerm(idoc(), 0);
        const act = findAction(doc, /proceed to step 2|^enroll$/i, 'DERIVED_REGFRM1_LINK_ADD_ENRL');
        if (!act) { log('dryRun: 选课车为空，链路只能验到学期选择（正常）'); return { note: 'cart empty, chain OK up to term select' }; }
        const r = await post(doc, act);
        const blocked = BLOCKED_RE.test(pageText(r));
        log('dryRun:', blocked ? 'blocked(符合预期，链路完整)' : 'unblocked?!');
        return { blocked };
      } catch (e) { log('dryRun 异常:', e.message); return { error: e.message }; }
    },
    async start(cfg) {
      if (running) return 'already running';
      running = true;
      if (document.hidden) log('⚠️ 标签页不可见，浏览器会钳制定时器！请保持前台');
      const stopDetect = detectThrottling((drift) => log(`⚠️ 定时器被钳制 (漂移 ${drift}ms)——请保持标签页前台！`));

      const rounds = cfg.rounds && cfg.rounds.length ? cfg.rounds : [{ openTime: cfg.openTime, term: 0 }];
      log('亚秒级时钟同步中…');
      const sync = await preciseSync();
      const offset = sync.offset;
      log(`时钟偏差 ${Math.round(offset)}ms (精度 ±${Math.round(sync.accuracy)}ms, ${sync.samples || 0} 样本)`);
      const warmTimer = setInterval(() => this.warmup(), 15000);

      // 每轮独立调度、独立开火，全部并发——同时开闸的学期互不等待
      const runRound = async (round, i) => {
        const T = new Date(round.openTime).getTime();
        if (isNaN(T)) { log(`第 ${i + 1} 轮 openTime 无效，跳过`); return { round: i + 1, error: 'invalid openTime' }; }

        await sleepUntil(T - offset - 30000);
        if (!running) return { round: i + 1, error: 'stopped' };
        await warmPool(3);
        log(`第 ${i + 1} 轮连接池已预热`);

        // T-8s: DOM 预封装请求体
        await sleepUntil(T - offset - 8000);
        let prepared = null;
        try {
          const doc = await ensureTerm(idoc(), round.term || 0);
          const act = findAction(doc, /proceed to step 2|^enroll$/i, 'DERIVED_REGFRM1_LINK_ADD_ENRL');
          if (act) {
            const fp = formParams(doc, act);
            prepared = { url: fp.url, body: fp.body, action: act };
            log(`第 ${i + 1} 轮请求体已预封装 (${act})`);
          } else {
            log(`第 ${i + 1} 轮预封装没找到 Enroll 按钮（车为空？），开火时实时找`);
          }
        } catch (e) { log(`第 ${i + 1} 轮预封装失败(不致命):`, e.message); }
        await warmPool(3);

        const fireAt = T - offset - 60;
        log(`第 ${i + 1} 轮 (term=${round.term || 0}) 目标 ${new Date(T).toISOString()}，等待 ${Math.round((fireAt - Date.now()) / 1000)}s`);
        await sleepUntil(fireAt);
        if (!running) return { round: i + 1, error: 'stopped' };

        const deadline = Date.now() + (round.retryWindowMs || 120000);
        let attempt = 0;
        while (Date.now() < deadline && running) {
          attempt++;
          try {
            const r = await fireRound(round, attempt === 1 ? prepared : null);
            if (r.blocked) {
              log(`第 ${i + 1} 轮第 ${attempt} 次 blocked，300ms 后重试`);
              await new Promise((r2) => setTimeout(r2, 300));
              continue;
            }
            if (r.done) {
              const ok = r.results.rows.filter((x) => x.status.includes('success')).length;
              const err = r.results.rows.filter((x) => x.status.includes('error')).length;
              log(`第 ${i + 1} 轮完成! 开窗后 ${((Date.now() + offset) - T) / 1000}s 搞定。成功 ${ok} 门, 失败 ${err} 门`, JSON.stringify(r.results.rows).slice(0, 400));
            } else {
              log(`第 ${i + 1} 轮异常:`, JSON.stringify(r).slice(0, 300));
            }
            return { round: i + 1, ...r };
          } catch (e) {
            log(`第 ${i + 1} 轮第 ${attempt} 次出错:`, e.message, '— 800ms 后重试');
            await new Promise((r2) => setTimeout(r2, 800));
          }
        }
        if (running) log(`第 ${i + 1} 轮超过重试窗口仍未成功`);
        return { round: i + 1, error: 'retry window expired' };
      };

      const allResults = await Promise.all(rounds.map((round, i) => runRound(round, i)));
      clearInterval(warmTimer);
      stopDetect();
      running = false;
      log('全部轮次结束');
      return allResults;
    },
    stop() { running = false; log('手动停止'); },
  };
  log('enroll-bot v9 已加载');
})();
