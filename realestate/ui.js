/* 블라인드 서울 — 화면 */
(function () {
  'use strict';

  var E = window.Engine;
  var fmt = E.fmt;
  var pct = E.pct;
  var SAVE_KEY = 'blind-seoul-v1';
  var BEST_KEY = 'blind-seoul-best';
  var HOWTO_KEY = 'blind-seoul-howto';
  var TONE_TAG = { good: '호재', bad: '악재', warn: '주의', info: '알림' };
  var LEASE_LABEL = { jeonse: '전세', wolse: '월세' };

  var st = null;
  var dlg = document.getElementById('dlg');
  var dlgBody = document.getElementById('dlg-body');
  var dlgLocked = false;
  var dlgView = null;     // 다시 그릴 때 쓰는 현재 대화상자 렌더 함수

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function cls(x) { return x > 0.0005 ? 'up' : x < -0.0005 ? 'down' : ''; }
  function arrow(x) { return x > 0.0005 ? '▲' : x < -0.0005 ? '▼' : ''; }
  function prob(p) { return Math.round(p * 100) + '%'; }
  function short(n) {
    if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(Math.abs(n) >= 1e9 ? 1 : 2).replace(/\.?0+$/, '') + '억';
    return Math.round(n / 1e4).toLocaleString('ko-KR') + '만';
  }
  function money(n, opts) { return '<span class="num">' + esc(fmt(n, opts)) + '</span>'; }
  function placeLabel(p) { return E.REGION_LABEL[p.region] + '권 · ' + p.dong; }
  function specLabel(p) { return '전용 ' + p.m2 + '㎡ · ' + p.py + ' · ' + p.age; }

  /* ---------- 저장 ---------- */

  function save() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(st)); } catch (e) { /* 저장 불가 환경 */ }
  }
  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(SAVE_KEY));
      return s && s.version === 2 && s.series ? s : null;
    } catch (e) { return null; }
  }
  function loadBest() {
    try { return JSON.parse(localStorage.getItem(BEST_KEY)); } catch (e) { return null; }
  }
  function saveBest(r) {
    try {
      var b = loadBest();
      if (!b || r.net > b.net) localStorage.setItem(BEST_KEY, JSON.stringify({ net: r.net, mult: r.mult, grade: r.grade, from: r.from.key, to: r.to.key }));
    } catch (e) { /* 무시 */ }
  }

  /* ---------- 상단 ---------- */

  function renderTop() {
    var tot = E.totals(st);
    var m = E.market(st);
    var d = tot.net / E.CONFIG.startCash - 1;
    $('turn-label').textContent = st.turn + ' / ' + st.turns + '개월';
    $('s-cash').innerHTML = esc(fmt(st.cash));
    $('s-cash').style.color = st.cash < 0 ? 'var(--danger)' : '';
    $('s-net').innerHTML = esc(fmt(tot.net)) + '<small class="' + cls(d) + '">' + pct(d, 0) + '</small>';
    $('s-rate').innerHTML = m.rate.toFixed(2) + '%' +
      (Math.abs(m.rateChange) > 0.004 ? '<small class="' + cls(m.rateChange) + '">' + arrow(m.rateChange) + Math.abs(m.rateChange).toFixed(2) + '</small>' : '');
    $('s-ltv').textContent = Math.round(m.ltv * 100) + '%';

    var html = '';
    for (var y = 0; y < st.turns / 12; y++) {
      html += '<div class="year">';
      for (var k = 0; k < 12; k++) {
        var i = y * 12 + k;
        html += '<div class="month' + (i < st.turn ? ' done' : i === st.turn && !st.over ? ' now' : '') + '"></div>';
      }
      html += '</div>';
    }
    $('months').innerHTML = html;
  }

  /* ---------- 정산서 ---------- */

  function renderReport() {
    var r = st.report;
    var title = r.span ? r.span[0] + '~' + r.span[1] + '개월차 정산' : r.t === 0 ? '출발' : r.t + '개월차 정산';
    var total = r.ledger.reduce(function (a, x) { return a + x.amount; }, 0);
    var rows = r.ledger.length
      ? r.ledger.map(function (x) {
        return '<tr><td>' + esc(x.label) + '</td><td>' + money(x.amount, { plus: true }) + '</td></tr>';
      }).join('') + '<tr class="total"><td>합계</td><td>' + money(total, { plus: true }) + '</td></tr>'
      : '<tr><td class="empty" colspan="2">' + (r.t === 0 ? '아직 들어오고 나간 돈이 없습니다.' : '이번 달 손익 항목이 없습니다.') + '</td></tr>';
    var items = r.items.length
      ? r.items.map(function (it) {
        return '<li class="' + (it.important ? 'important' : '') + '"><span class="tag ' + it.tone + '">' + TONE_TAG[it.tone] + '</span><span>' +
          (r.span && it.t ? '<span class="muted">' + it.t + '개월차 · </span>' : '') + esc(it.text) + '</span></li>';
      }).join('')
      : '<li><span class="tag info">알림</span><span>조용한 달이었습니다.</span></li>';
    var nc = r.netChange != null
      ? '<div class="net-change">순자산 변화 <span class="num ' + cls(r.netChange) + '">' + esc(fmt(r.netChange, { plus: true })) + '</span><span class="muted">집값 변동 포함</span></div>'
      : '';
    $('report').innerHTML =
      '<div class="panel-head"><h2>' + esc(title) + '</h2><span class="aside">월간 정산서</span></div>' +
      '<div class="report-grid"><table class="ledger"><tbody>' + rows + '</tbody></table><ul class="feed">' + items + '</ul></div>' + nc;
  }

  /* ---------- 내 부동산 ---------- */

  function leaseInfo(p) {
    var chips = [];
    var text;
    var L = p.lease;
    if (!L) {
      if (p.seeking) {
        chips.push(['세입자 구하는 중', 'warn']);
        text = '공실 · ' + LEASE_LABEL[p.seeking.kind] + ' ' + E.leaseAsk(p.seeking.ask).label + ' · 이번 달 확률 ' + prob(E.pTenant(st, p, p.seeking.kind, p.seeking.ask));
      } else {
        chips.push(['공실', 'bad']);
        text = '공실 · 세입자를 구하지 않고 있습니다';
      }
    } else {
      chips.push([LEASE_LABEL[L.kind] + ' 중', 'good']);
      text = (L.kind === 'jeonse' ? '전세 보증금 ' + fmt(L.deposit) : '보증금 ' + fmt(L.deposit) + ' · 월 ' + fmt(L.rent)) +
        ' · 만기 ' + Math.max(0, L.end - st.turn) + '개월 후';
      if (L.renew === true) chips.push(['재계약 예정', 'good']);
      if (L.renew === false) chips.push(p.nextLease ? ['다음 세입자 확정', 'good'] : ['퇴거 예정', 'warn']);
      if (L.renew === false && !p.nextLease && p.seeking) {
        text += ' · 다음 세입자 구하는 중 (이번 달 확률 ' + prob(E.pTenant(st, p, p.seeking.kind, p.seeking.ask)) + ')';
      }
      if (p.defaultLeft > 0) chips.push(['월세 미납', 'bad']);
    }
    if (p.selling) chips.push(['매도 중 · ' + E.saleAsk(p.selling.ask).label, 'info']);
    if (p.redev) chips.push(['재개발 구역', 'good']);
    return { chips: chips, text: text };
  }

  function chipHtml(c) { return '<span class="chip ' + (c[1] || '') + '">' + esc(c[0]) + '</span>'; }

  function renderProps() {
    var tot = E.totals(st);
    $('props-aside').textContent = st.props.length ? st.props.length + '채 · 시세 합계 ' + fmt(tot.value) : '';
    if (!st.props.length) {
      $('props').innerHTML = '<div class="empty-state"><b>아직 가진 집이 없습니다.</b><span>이번 달 매물에서 집을 고르세요. 대출을 받아 사고, 전세 세입자가 들어오면 보증금으로 대출을 갚는 갭투자가 기본입니다.</span></div>';
      return;
    }
    var rate = E.gameRate(st, st.turn);
    $('props').innerHTML = '<div class="props">' + st.props.map(function (p) {
      var v = E.value(st, p);
      var gain = v / p.buyPrice - 1;
      var info = leaseInfo(p);
      var held = st.turn - p.buyT;
      return '<article class="deed">' +
        '<div class="deed-head"><div class="deed-sub">' + esc(placeLabel(p)) + '</div>' +
        '<div class="deed-title">' + esc(E.TYPE_LABEL[p.type]) + ' · ' + esc(specLabel(p)) + '</div>' +
        '<div class="chips">' + info.chips.map(chipHtml).join('') + '</div></div>' +
        '<div class="deed-rows">' +
        '<div class="lab">시세</div><div class="val">' + money(v) + '<span class="' + cls(gain) + '">' + pct(gain) + '</span></div>' +
        '<div class="lab">소유권</div><div class="val"><span>매수 ' + money(p.buyPrice) + '</span><span class="muted">' + held + '개월 보유</span></div>' +
        '<div class="lab">근저당</div><div class="val">' + (p.loan ? money(p.loan) + '<span class="muted">월 이자 ' + esc(fmt(p.loan * rate / 1200)) + '</span>' : '<span class="muted">대출 없음</span>') + '</div>' +
        '<div class="lab">임차권</div><div class="val"><span>' + esc(info.text) + '</span></div>' +
        '</div>' +
        '<div class="deed-foot"><div class="eq">내 몫 (시세 − 대출 − 보증금)' + '<span class="num">' + esc(fmt(E.equity(st, p))) + '</span></div>' +
        '<button class="btn" type="button" data-manage="' + p.id + '"' + (st.over ? ' disabled' : '') + '>관리</button></div>' +
        '</article>';
    }).join('') + '</div>';
  }

  /* ---------- 시세판 ---------- */

  function renderMarket() {
    var m = E.market(st);
    var names = { gn: ['강남권', '한강 이남 11개 구'], gb: ['강북권', '한강 이북 14개 구'] };
    var html = '<div class="regions">';
    ['gn', 'gb'].forEach(function (r) {
      var row = m.regions[r];
      html += '<div class="region"><div class="region-head"><span><b>' + names[r][0] + '</b> <span class="muted">' + names[r][1] + '</span></span>' +
        '<span class="chip heat-' + row.heat.id + '">' + row.heat.label + '</span></div><div class="region-cells">';
      [['apt', '아파트'], ['villa', '빌라'], ['jeonse', '전세']].forEach(function (c) {
        var x = row[c[0]];
        html += '<div class="cell"><div class="k">' + c[1] + '</div><div class="v num">' + x.idx.toFixed(1) + '</div>' +
          '<div class="c num"><span class="' + cls(x.chg1) + '">' + pct(x.chg1) + '</span> <span class="muted">지난달</span></div>' +
          '<div class="c num"><span class="' + cls(x.chg3) + '">' + pct(x.chg3) + '</span> <span class="muted">3개월</span></div></div>';
      });
      html += '</div></div>';
    });
    html += '</div><div class="rates">' +
      '<div class="cell"><div class="k">대출 금리</div><div class="v num">' + m.rate.toFixed(2) + '%</div></div>' +
      '<div class="cell"><div class="k">예금 금리</div><div class="v num">' + m.depositRate.toFixed(2) + '%</div></div>' +
      '<div class="cell"><div class="k">LTV 한도</div><div class="v num">' + Math.round(m.ltv * 100) + '%</div></div></div>';
    if (m.mods.length) {
      html += '<div class="mods chips">' + m.mods.map(function (x) {
        return chipHtml([x.label + ' · ' + x.left + '개월', x.tone]);
      }).join('') + '</div>';
    }
    $('market').innerHTML = html;
    drawMarketChart();
  }

  function drawMarketChart() {
    var H = E.CONFIG.history;
    var gn = [], gb = [];
    for (var t = -H; t <= st.turn; t++) { gn.push(E.S(st, 'gnApt', t)); gb.push(E.S(st, 'gbApt', t)); }
    var ticks = [];
    for (var y = 0; y <= st.turn; y += 12) ticks.push({ i: y + H, label: y === 0 ? '시작' : y / 12 + '년' });
    lineChart($('market-chart'), {
      series: [
        { label: '강남', color: '--series-gn', values: gn },
        { label: '강북', color: '--series-gb', values: gb }
      ],
      xTicks: ticks,
      mark: H,
      yFmt: function (v, d) { return v.toFixed(d); },
      tipFmt: function (v) { return v.toFixed(1); },
      xFmt: function (i) { var t = i - H; return t < 0 ? '시작 ' + (-t) + '개월 전' : t === 0 ? '시작' : t + '개월차'; },
      endLabels: true,
      height: window.innerWidth > 880 ? 250 : 170,
      label: '강남·강북 아파트 시세 지수 추이'
    });
  }

  /* ---------- 매물 ---------- */

  function renderListings() {
    if (st.over) {
      $('listings-aside').textContent = '';
      $('listings').innerHTML = '<div class="empty-state">게임이 끝났습니다.</div>';
      return;
    }
    $('listings-aside').textContent = '현금 ' + fmt(st.cash) + '으로 살 수 있는 매물';
    if (!st.listings.length) {
      $('listings').innerHTML = '<div class="empty-state"><b>지금 현금으로 살 수 있는 매물이 없습니다.</b><span>가장 싼 매물도 대출을 한도까지 받았을 때 현금이 최소 ' +
        esc(fmt(E.cheapestNeed(st))) + ' 필요합니다. 집을 팔거나, 추가 대출을 받거나, 세입자 보증금이 들어오면 매물이 다시 나옵니다.</span></div>';
      return;
    }
    $('listings').innerHTML = st.listings.map(function (l) {
      var j = E.jeonseValue(st, E.preview(st, l.id));
      var hope = l.redevHope ? ' · 재개발 기대' : l.rebuildHope ? ' · 재건축 기대' : '';
      var need = E.minCash(st, l.price);
      var can = need <= st.cash;
      return '<article class="flyer' + (l.tag ? ' special' : '') + '">' +
        (l.tag ? '<span class="stamp">' + esc(l.tag) + '</span>' : '') +
        '<div class="where">' + esc(placeLabel(l)) + '</div>' +
        '<div class="what">' + esc(E.TYPE_LABEL[l.type]) + ' · 전용 ' + l.m2 + '㎡ · ' + esc(l.py) + '<br><span class="muted">' + esc(l.age + hope) + '</span></div>' +
        '<div class="price">매매' + money(l.price) + (l.tag ? '<span>시세 ' + esc(fmt(l.fair)) + '</span>' : '') + '</div>' +
        '<dl class="facts"><dt>전세 시세</dt><dd>' + money(j) + '</dd><dt>갭</dt><dd>' + money(l.price - j) + '</dd>' +
        '<dt' + (can ? '' : ' class="short"') + '>' + (can ? '최소 필요 현금' : '현금 부족') + '</dt><dd' + (can ? '' : ' class="short"') + '>' + money(need) + '</dd></dl>' +
        '<button class="btn" type="button" data-buy="' + l.id + '"' + (can ? '' : ' disabled') + '>매수 검토</button>' +
        '</article>';
    }).join('');
  }

  /* ---------- 기록 / 진행 바 ---------- */

  function renderLog() {
    $('log').innerHTML = st.log.slice(0, 80).map(function (x) {
      return '<li><span class="t">' + x.t + '월</span><span>' + esc(x.text) + '</span></li>';
    }).join('') || '<li><span class="t">0월</span><span>게임을 시작했습니다.</span></li>';
  }

  function renderBar() {
    var tot = E.totals(st);
    var vac = st.props.reduce(function (a, p) { return a + (p.lease ? 0 : E.value(st, p) * E.CONFIG.vacancyCost); }, 0);
    var flow = tot.rent - tot.interest - vac;
    var info;
    if (st.over) {
      info = '<b>게임 종료</b> · 결과를 확인하세요';
    } else if (st.cash < 0) {
      info = '<b style="color: var(--danger)">현금 부족 · 연체 ' + st.arrears + '개월째</b><br>' +
        (E.CONFIG.arrearsLimit - st.arrears) + '개월 안에 메우지 못하면 경매. 추가 대출·급매로 막으세요.';
    } else {
      info = '<b>' + (st.turn + 1) + '개월차로</b> · 매달 현금흐름 <span class="num ' + cls(flow) + '">' + esc(fmt(flow, { plus: true })) + '</span>' +
        '<br><span class="muted">월세 ' + esc(fmt(tot.rent)) + ' · 이자 ' + esc(fmt(tot.interest)) + (vac ? ' · 공실비 ' + esc(fmt(vac)) : '') + '</span>';
    }
    $('ab-info').innerHTML = info;
    $('btn-next').textContent = st.over ? '결과 보기' : st.pending.length ? '사건 처리' : '다음 달';
    $('btn-auto').disabled = st.over || st.pending.length > 0;
  }

  function render() {
    renderTop();
    renderReport();
    renderProps();
    renderMarket();
    renderListings();
    renderLog();
    renderBar();
    if (dlg.open && dlgView) dlgView();
  }

  /* ---------- 진행 ---------- */

  function mergeReports(list) {
    if (list.length === 1) return list[0];
    var m = { t: list[list.length - 1].t, span: [list[0].t, list[list.length - 1].t], ledger: [], items: [], netChange: 0 };
    list.forEach(function (r) {
      r.ledger.forEach(function (x) {
        var row = m.ledger.filter(function (y) { return y.label === x.label; })[0];
        if (row) row.amount += x.amount; else m.ledger.push({ label: x.label, amount: x.amount });
      });
      r.items.forEach(function (it) { m.items.push({ text: it.text, tone: it.tone, important: it.important, t: r.t }); });
      m.netChange += r.netChange || 0;
    });
    return m;
  }

  function step(max) {
    var list = [];
    for (var i = 0; i < max; i++) {
      var r = E.advance(st);
      if (!r) break;
      list.push(r);
      if (st.over || st.pending.length || r.items.some(function (x) { return x.important; })) break;
    }
    if (!list.length) return;
    st.report = mergeReports(list);
    save();
    render();
    var rep = $('report');
    rep.classList.remove('flash');
    void rep.offsetWidth;
    rep.classList.add('flash');
    if (window.innerWidth <= 880) document.querySelector('.market-panel').scrollIntoView({ block: 'start', behavior: 'smooth' });
    afterStep();
  }

  function afterStep() {
    if (st.pending.length) openEvent();
    else if (st.over) openResult();
  }

  function onNext() {
    if (st.over) { openResult(); return; }
    if (st.pending.length) { openEvent(); return; }
    step(1);
  }

  /* ---------- 대화상자 ---------- */

  function openDialog(view, locked) {
    dlgLocked = !!locked;
    dlgView = view;
    view();
    if (!dlg.open) dlg.showModal();
    dlg.scrollTop = 0;
  }
  function closeDialog() {
    dlgView = null;
    dlgLocked = false;
    if (dlg.open) dlg.close();
  }
  dlg.addEventListener('cancel', function (e) { if (dlgLocked) e.preventDefault(); else dlgView = null; });
  dlg.addEventListener('click', function (e) { if (e.target === dlg && !dlgLocked) closeDialog(); });
  dlg.addEventListener('close', function () { dlgView = null; dlgLocked = false; });

  function seg(name, options, value) {
    return '<div class="seg" role="radiogroup">' + options.map(function (o) {
      var id = name + '-' + o.id;
      return '<label for="' + id + '"><input type="radio" name="' + name + '" id="' + id + '" value="' + o.id + '"' +
        (o.id === value ? ' checked' : '') + (o.disabled ? ' disabled' : '') + '><span>' + esc(o.label) +
        (o.sub ? '<small>' + esc(o.sub) + '</small>' : '') + '</span></label>';
    }).join('') + '</div>';
  }
  function radioValue(name) {
    var el = dlgBody.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : null;
  }

  /* 매수 */

  function openBuy(id) {
    var l = st.listings.filter(function (x) { return x.id === id; })[0];
    if (!l) return;
    var q0 = E.buyQuote(st, id, 0);
    var loan = q0.ok ? 0 : Math.min(q0.loanMax, Math.ceil((q0.need - st.cash) / 1e6) * 1e6);
    var form = { loan: loan, kind: 'jeonse', ask: 'market' };

    function dyn() {
      var q = E.buyQuote(st, id, form.loan);
      if (!q) { closeDialog(); return; }
      var pv = E.preview(st, id, q.loan);
      var lease = '';
      if (form.kind !== 'none') {
        var terms = E.leaseTerms(st, pv, form.kind, form.ask);
        var pt = E.pTenant(st, pv, form.kind, form.ask);
        lease = '<div class="note">' + (form.kind === 'jeonse'
          ? '전세 보증금 ' + money(terms.deposit)
          : '보증금 ' + money(terms.deposit) + ' · 월세 ' + money(terms.rent)) +
          ' · 이번 달 세입자 구할 확률 <b>' + prob(pt) + '</b>';
        if (form.kind === 'jeonse' && q.loan) {
          var rep = Math.min(q.loan, terms.deposit);
          lease += '<br>들어오면 보증금으로 대출 ' + money(rep) + '을 갚고 ' + (terms.deposit > rep ? money(terms.deposit - rep) + '이 현금으로 돌아옵니다. ' : '') +
            '실투자금 ' + money(q.need - (terms.deposit - rep)) + '.';
        } else if (form.kind === 'jeonse') {
          lease += '<br>들어오면 보증금 ' + money(terms.deposit) + '이 현금으로 돌아옵니다. 실투자금 ' + money(q.need - terms.deposit) + '.';
        }
        lease += '</div>';
      } else {
        lease = '<div class="note">세입자 없이 비워둡니다. 공실 관리비와 대출 이자가 나갑니다.</div>';
      }
      var warn = '';
      if (!q.ok) warn = '<div class="note bad">' + esc(q.reason) + '</div>';
      else if (q.cashAfter < q.interest * 3 + 1e6 && q.loan) warn = '<div class="note warn">매수 후 현금이 ' + esc(fmt(q.cashAfter)) + '뿐입니다. 세입자를 못 구하면 이자를 못 낼 수 있습니다.</div>';
      $('buy-loan-out').innerHTML = '<span>대출 ' + money(q.loan) + ' <span class="muted">(매매가의 ' + Math.round(q.loan / l.price * 100) + '%)</span></span><span class="muted">월 이자 ' + esc(fmt(q.interest)) + '</span>';
      $('buy-lease').innerHTML = lease;
      $('buy-cost').innerHTML =
        '<tr><td>매매가</td><td>' + money(l.price) + '</td></tr>' +
        '<tr><td>취득세 (' + q.count + '주택째 ' + Math.round(q.taxRate * 100) + '%)</td><td>' + money(q.tax) + '</td></tr>' +
        '<tr><td>중개수수료</td><td>' + money(q.fee) + '</td></tr>' +
        '<tr><td>대출</td><td>' + money(-q.loan) + '</td></tr>' +
        '<tr class="total"><td>필요한 현금</td><td>' + money(q.need) + '</td></tr>' +
        '<tr><td>매수 후 남는 현금</td><td class="' + (q.cashAfter < 0 ? 'down' : '') + '">' + money(q.cashAfter) + '</td></tr>';
      $('buy-warn').innerHTML = warn;
      $('buy-ok').disabled = !q.ok;
      var askDisabled = form.kind === 'none';
      dlgBody.querySelectorAll('input[name="buy-ask"]').forEach(function (el) { el.disabled = askDisabled; });
    }

    function view() {
      var q = E.buyQuote(st, id, form.loan);
      if (!q) { closeDialog(); return; }
      var note = l.tag === '경매' ? '<div class="note warn">경매 물건입니다. 30% 확률로 유치권 등 정리 비용(시세의 3~7%)이 추가로 듭니다. 이번 달에만 입찰할 수 있습니다.</div>'
        : l.tag === '급매' ? '<div class="note">급매물입니다. 이번 달에만 살 수 있습니다.</div>' : '';
      dlgBody.innerHTML = '<form class="dlg" id="buy-form">' +
        '<div><div class="eyebrow">매수 검토 · ' + esc(placeLabel(l)) + '</div><h3>' + esc(E.TYPE_LABEL[l.type]) + ' ' + money(l.price) + '</h3>' +
        '<div class="sub">' + esc(specLabel(l)) + (l.tag ? ' · 시세 ' + esc(fmt(l.fair)) : '') + '</div></div>' + note +
        '<div class="dlg-section"><div class="eyebrow">대출 (LTV 한도 ' + Math.round(E.ltv(st) * 100) + '% · 금리 ' + E.gameRate(st, st.turn).toFixed(2) + '%)</div>' +
        '<input type="range" id="buy-loan" min="0" max="' + q.loanMax + '" step="1000000" value="' + q.loan + '" aria-label="대출 금액">' +
        '<div class="loan-out" id="buy-loan-out"></div></div>' +
        '<div class="dlg-section"><div class="eyebrow">임대 계획</div>' +
        seg('buy-kind', [{ id: 'jeonse', label: '전세' }, { id: 'wolse', label: '월세' }, { id: 'none', label: '비워두기' }], form.kind) +
        seg('buy-ask', E.LEASE_ASKS.map(function (a) { return { id: a.id, label: a.label }; }), form.ask) +
        '<div id="buy-lease"></div></div>' +
        '<div class="dlg-section"><div class="eyebrow">비용</div><table class="kv"><tbody id="buy-cost"></tbody></table></div>' +
        '<div id="buy-warn"></div>' +
        '<div class="dlg-actions"><button class="btn" type="button" id="buy-cancel">취소</button><button class="btn primary" type="submit" id="buy-ok">매수 계약</button></div>' +
        '</form>';
      $('buy-loan').addEventListener('input', function (e) { form.loan = Number(e.target.value); dyn(); });
      dlgBody.querySelectorAll('input[name="buy-kind"]').forEach(function (el) {
        el.addEventListener('change', function () { form.kind = radioValue('buy-kind'); dyn(); });
      });
      dlgBody.querySelectorAll('input[name="buy-ask"]').forEach(function (el) {
        el.addEventListener('change', function () { form.ask = radioValue('buy-ask'); dyn(); });
      });
      $('buy-cancel').addEventListener('click', closeDialog);
      $('buy-form').addEventListener('submit', function (e) {
        e.preventDefault();
        var res = E.buy(st, id, { loan: form.loan, leaseKind: form.kind === 'none' ? null : form.kind, ask: form.ask });
        if (!res.ok) { $('buy-warn').innerHTML = '<div class="note bad">' + esc(res.msg) + '</div>'; return; }
        closeDialog();
        save();
        render();
      });
      dyn();
    }
    openDialog(view);
  }

  /* 관리 */

  function openManage(id) {
    var form = { kind: null, ask: 'market', sale: null, repay: 0, borrow: 0 };

    function view() {
      var p = E.findProp(st, id);
      if (!p) { closeDialog(); return; }
      var v = E.value(st, p);
      var rate = E.gameRate(st, st.turn);
      var info = leaseInfo(p);
      var canSeek = !p.lease || (p.lease.renew === false && !p.nextLease);
      if (!form.kind) form.kind = p.seeking ? p.seeking.kind : (p.lease ? p.lease.kind : 'jeonse');
      if (p.seeking && form.ask === 'market' && !form.touched) form.ask = p.seeking.ask;
      if (!form.sale) form.sale = p.selling ? p.selling.ask : 'market';

      var leaseHtml = '<div class="note">' + esc(info.text) + '</div>';
      if (canSeek) {
        var terms = E.leaseTerms(st, p, form.kind, form.ask);
        leaseHtml += seg('m-kind', [{ id: 'jeonse', label: '전세' }, { id: 'wolse', label: '월세' }], form.kind) +
          seg('m-ask', E.LEASE_ASKS.map(function (a) { return { id: a.id, label: a.label }; }), form.ask) +
          '<div class="loan-out"><span>' + (form.kind === 'jeonse' ? '보증금 ' + money(terms.deposit) : '보증금 ' + money(terms.deposit) + ' · 월 ' + money(terms.rent)) +
          '</span><span class="muted">이번 달 확률 ' + prob(E.pTenant(st, p, form.kind, form.ask)) + '</span></div>' +
          '<div class="dlg-actions">' + (p.seeking ? '<button class="btn" type="button" id="m-seek-stop">구하기 중단</button>' : '') +
          '<button class="btn primary" type="button" id="m-seek">' + (p.seeking ? '조건 변경' : '세입자 구하기') + '</button></div>';
      }

      var saleRows = E.SALE_ASKS.map(function (a) {
        var e = E.saleEstimate(st, p, a.id);
        return '<tr class="' + (form.sale === a.id ? 'on' : '') + '"><td><label><input type="radio" name="m-sale" value="' + a.id + '"' +
          (form.sale === a.id ? ' checked' : '') + '> ' + esc(a.label) + '</label></td><td>' + money(e.price) + '</td><td>' + money(e.tax) +
          '</td><td class="' + (e.net < 0 ? 'down' : '') + '">' + money(e.net) + '</td><td>' + prob(e.prob) + '</td></tr>';
      }).join('');
      var est = E.saleEstimate(st, p, form.sale);

      var maxRepay = Math.max(0, Math.min(p.loan, Math.floor(Math.max(0, st.cash) / 1e6) * 1e6));
      var maxBorrow = Math.max(0, E.maxBorrow(st, p));
      form.repay = Math.min(form.repay || maxRepay, maxRepay);
      form.borrow = Math.min(form.borrow || maxBorrow, maxBorrow);

      dlgBody.innerHTML = '<div class="dlg">' +
        '<div><div class="eyebrow">' + esc(placeLabel(p)) + '</div><h3>' + esc(E.TYPE_LABEL[p.type]) + ' · 전용 ' + p.m2 + '㎡</h3>' +
        '<div class="chips" style="margin-top: 8px">' + info.chips.map(chipHtml).join('') + '</div></div>' +
        '<table class="kv"><tbody>' +
        '<tr><td>시세</td><td>' + money(v) + ' <span class="' + cls(v / p.buyPrice - 1) + '">' + pct(v / p.buyPrice - 1) + '</span></td></tr>' +
        '<tr><td>매수가 · 보유</td><td>' + money(p.buyPrice) + ' · ' + (st.turn - p.buyT) + '개월</td></tr>' +
        '<tr><td>대출</td><td>' + money(p.loan) + '</td></tr>' +
        '<tr><td>보증금</td><td>' + money(E.deposit(p)) + '</td></tr>' +
        '<tr class="total"><td>내 몫</td><td>' + money(E.equity(st, p)) + '</td></tr>' +
        '</tbody></table>' +

        '<div class="dlg-section"><div class="eyebrow">임대</div>' + leaseHtml + '</div>' +

        '<div class="dlg-section"><div class="eyebrow">매도' + (p.selling ? ' · 현재 ' + esc(E.saleAsk(p.selling.ask).label) + '로 내놓은 상태' : '') + '</div>' +
        '<div class="table-scroll"><table class="sale-table"><thead><tr><th>호가</th><th>매도가</th><th>양도세</th><th>손에 쥘 돈</th><th>월 체결</th></tr></thead><tbody>' + saleRows + '</tbody></table></div>' +
        '<div class="sub">' + esc(est.taxLabel) + '. 손에 쥘 돈 = 매도가 − 수수료 − 양도세 − 대출 − 보증금(매수자가 승계)</div>' +
        '<div class="dlg-actions">' + (p.selling ? '<button class="btn" type="button" id="m-sell-stop">매물 거두기</button>' : '') +
        '<button class="btn primary" type="button" id="m-sell">' + (p.selling ? '호가 변경' : '매물로 내놓기') + '</button></div></div>' +

        '<div class="dlg-section"><div class="eyebrow">대출 · 금리 ' + rate.toFixed(2) + '% · 월 이자 ' + esc(fmt(p.loan * rate / 1200)) + '</div>' +
        (p.loan && maxRepay ? '<input type="range" id="m-repay" min="0" max="' + maxRepay + '" step="1000000" value="' + form.repay + '" aria-label="상환 금액">' +
          '<div class="loan-out"><span>상환 <span id="m-repay-out">' + money(form.repay) + '</span></span><button class="btn small" type="button" id="m-repay-btn">상환</button></div>'
          : '<div class="sub">' + (p.loan ? '상환할 현금이 없습니다.' : '대출이 없습니다.') + '</div>') +
        (maxBorrow ? '<input type="range" id="m-borrow" min="0" max="' + maxBorrow + '" step="1000000" value="' + form.borrow + '" aria-label="추가 대출 금액">' +
          '<div class="loan-out"><span>추가 대출 <span id="m-borrow-out">' + money(form.borrow) + '</span> <span class="muted">한도 ' + esc(fmt(maxBorrow)) + '</span></span><button class="btn small" type="button" id="m-borrow-btn">대출받기</button></div>'
          : '<div class="sub">추가 대출 한도가 없습니다. (시세 × LTV − 기존 대출 − 보증금)</div>') +
        '</div>' +

        '<div class="dlg-actions"><button class="btn" type="button" id="m-close">닫기</button></div>' +
        '</div>';

      function on(idx, ev, fn) { var el = $(idx); if (el) el.addEventListener(ev, fn); }
      dlgBody.querySelectorAll('input[name="m-kind"]').forEach(function (el) {
        el.addEventListener('change', function () { form.kind = radioValue('m-kind'); view(); });
      });
      dlgBody.querySelectorAll('input[name="m-ask"]').forEach(function (el) {
        el.addEventListener('change', function () { form.ask = radioValue('m-ask'); form.touched = true; view(); });
      });
      dlgBody.querySelectorAll('input[name="m-sale"]').forEach(function (el) {
        el.addEventListener('change', function () { form.sale = radioValue('m-sale'); view(); });
      });
      on('m-seek', 'click', function () { E.setSeeking(st, id, form.kind, form.ask); commit(); });
      on('m-seek-stop', 'click', function () { E.setSeeking(st, id, null); commit(); });
      on('m-sell', 'click', function () { E.setSelling(st, id, form.sale); commit(); });
      on('m-sell-stop', 'click', function () { E.setSelling(st, id, null); commit(); });
      on('m-repay', 'input', function (e) { form.repay = Number(e.target.value); $('m-repay-out').innerHTML = money(form.repay); });
      on('m-borrow', 'input', function (e) { form.borrow = Number(e.target.value); $('m-borrow-out').innerHTML = money(form.borrow); });
      on('m-repay-btn', 'click', function () { if (form.repay > 0) { E.repay(st, id, form.repay); form.repay = 0; commit(); } });
      on('m-borrow-btn', 'click', function () { if (form.borrow > 0) { E.borrow(st, id, form.borrow); form.borrow = 0; commit(); } });
      on('m-close', 'click', closeDialog);
    }
    function commit() { save(); render(); }
    openDialog(view);
  }

  /* 사건 */

  function openEvent() {
    function view() {
      var ev = st.pending[0];
      if (!ev) { closeDialog(); return; }
      dlgBody.innerHTML = '<div class="dlg">' +
        '<div><div class="eyebrow">사건 · ' + st.turn + '개월차' + (st.pending.length > 1 ? ' · ' + st.pending.length + '건 남음' : '') + '</div><h3>' + esc(ev.title) + '</h3></div>' +
        '<p>' + esc(ev.body) + '</p>' +
        '<div class="dlg-section">' + ev.choices.map(function (c) {
          return '<button class="btn choice" type="button" data-choice="' + c.id + '">' + esc(c.label) + (c.hint ? '<small>' + esc(c.hint) + '</small>' : '') + '</button>';
        }).join('') + '</div></div>';
      dlgBody.querySelectorAll('[data-choice]').forEach(function (b) {
        b.addEventListener('click', function () {
          E.resolveEvent(st, b.getAttribute('data-choice'));
          save();
          if (st.pending.length) { render(); view(); }
          else { closeDialog(); render(); if (st.over) openResult(); }
        });
      });
    }
    openDialog(view, true);
  }

  /* 결과 */

  function openResult() {
    var r = st.result || E.result(st);
    if (!st.bestSaved) { saveBest(r); st.bestSaved = true; save(); }
    var best = loadBest();
    function view() {
      var long = r.grade.length > 1;
      var rows = [
        ['나', r.net, true],
        ['예금만 했다면', r.benchmarks.deposit],
        ['강남 아파트 갭투자 후 버텼다면', r.benchmarks.gangnamHold]
      ].sort(function (a, b) { return b[1] - a[1]; }).map(function (x) {
        return '<tr class="' + (x[2] ? 'me' : '') + '"><td>' + esc(x[0]) + '</td><td>' + money(x[1]) + '</td><td class="num">' + (x[1] / E.CONFIG.startCash).toFixed(2) + '배</td></tr>';
      }).join('');
      dlgBody.innerHTML = '<div class="dlg">' +
        '<div class="result-hero"><div class="grade' + (long ? ' long' : '') + '">' + esc(r.grade) + '</div>' +
        '<div class="result-net"><div class="eyebrow">' + (st.bankrupt ? '파산 · ' + st.turn + '개월차' : '60개월 후 최종 순자산') + '</div>' +
        '<span class="num">' + esc(fmt(r.net)) + '</span><span class="muted">종잣돈 ' + esc(fmt(E.CONFIG.startCash)) + '의 ' + r.mult.toFixed(2) + '배</span></div></div>' +
        '<div class="reveal"><div class="eyebrow">이번 판의 서울은</div><div class="when">' + r.from.y + '년 ' + r.from.m + '월 ~ ' + r.to.y + '년 ' + r.to.m + '월</div>' +
        '<div class="chips">' + r.eras.map(function (e) { return chipHtml([e, '']); }).join('') + '</div>' +
        '<div class="sub">같은 기간 강남 아파트 <span class="' + cls(r.gnChange) + '">' + pct(r.gnChange) + '</span>, 강북 아파트 <span class="' + cls(r.gbChange) + '">' + pct(r.gbChange) + '</span></div></div>' +
        '<div class="legend"><span><i style="background: var(--series-gn)"></i>강남 아파트</span><span><i style="background: var(--series-gb)"></i>강북 아파트</span></div>' +
        '<div class="chart" id="result-chart"></div>' +
        '<div class="dlg-section"><div class="eyebrow">내 순자산 추이</div><div class="chart" id="net-chart"></div></div>' +
        '<table class="bench"><tbody>' + rows + '</tbody></table>' +
        (best ? '<div class="sub">최고 기록: ' + esc(fmt(best.net)) + ' (' + Number(best.mult).toFixed(2) + '배 · ' + esc(best.grade) + ' · ' + esc(best.from) + '~)</div>' : '') +
        '<div class="dlg-actions"><button class="btn" type="button" id="r-close">판 다시 보기</button><button class="btn primary" type="button" id="r-new">새 게임</button></div>' +
        '</div>';
      $('r-close').addEventListener('click', closeDialog);
      $('r-new').addEventListener('click', function () { newGame(); });
      requestAnimationFrame(drawResultCharts);
    }
    function drawResultCharts() {
      var H = E.CONFIG.history;
      var end = st.turn;
      var gn = [], gb = [];
      for (var t = 0; t <= st.turns; t++) { gn.push(E.S(st, 'gnApt', t)); gb.push(E.S(st, 'gbApt', t)); }
      var bands = [];
      E.ERAS.forEach(function (e) {
        var from = monthIndex(e[0]) - st.startIdx, to = monthIndex(e[1]) - st.startIdx;
        if (to < 0 || from > st.turns) return;
        bands.push({ from: Math.max(0, from), to: Math.min(st.turns, to), label: e[2] });
      });
      var ticks = [];
      for (var y = 0; y <= st.turns; y += 12) {
        var d = E.ym(st.startIdx + y);
        ticks.push({ i: y, label: d.y + '.' + String(d.m).padStart(2, '0') });
      }
      lineChart($('result-chart'), {
        series: [{ label: '강남', color: '--series-gn', values: gn }, { label: '강북', color: '--series-gb', values: gb }],
        xTicks: ticks, bands: bands, endLabels: true, height: 190,
        yFmt: function (v, d) { return v.toFixed(d); }, tipFmt: function (v) { return v.toFixed(1); },
        xFmt: function (i) { var d = E.ym(st.startIdx + i); return d.y + '년 ' + d.m + '월'; },
        label: '이번 판 기간의 강남·강북 아파트 시세 지수'
      });
      var net = st.hist.map(function (x) { return x.net; });
      lineChart($('net-chart'), {
        series: [{ label: '순자산', color: '--accent', values: net }],
        xTicks: ticks.filter(function (t) { return t.i <= end; }).map(function (t) { return { i: t.i, label: t.i === 0 ? '시작' : t.i / 12 + '년' }; }),
        area: true, height: 150,
        yFmt: short, tipFmt: function (v) { return fmt(v); },
        xFmt: function (i) { return i === 0 ? '시작' : i + '개월차'; },
        label: '내 순자산 추이'
      });
      void H;
    }
    openDialog(view);
  }

  function monthIndex(key) {
    var y = parseInt(key.slice(0, 4), 10), m = parseInt(key.slice(5, 7), 10);
    return (y - parseInt(E.DATA.start.slice(0, 4), 10)) * 12 + (m - 1);
  }

  function confirmNew() {
    if (st.over || st.turn === 0) { newGame(); return; }
    openDialog(function () {
      dlgBody.innerHTML = '<div class="dlg"><h3>새 게임을 시작할까요?</h3><p>지금 판(' + st.turn + '개월차, 순자산 ' + esc(fmt(E.netWorth(st))) + ')은 사라집니다.</p>' +
        '<div class="dlg-actions"><button class="btn" type="button" id="n-cancel">계속하기</button><button class="btn primary" type="button" id="n-ok">새 게임</button></div></div>';
      $('n-cancel').addEventListener('click', closeDialog);
      $('n-ok').addEventListener('click', newGame);
    });
  }

  function newGame() {
    st = E.newGame();
    save();
    closeDialog();
    render();
    window.scrollTo({ top: 0 });
  }

  /* ---------- 선 그래프 ---------- */

  function niceTicks(lo, hi, count) {
    if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
    var raw = (hi - lo) / Math.max(1, count - 1);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
    var start = Math.floor(lo / step) * step;
    var end = Math.ceil(hi / step) * step;
    var out = [];
    for (var v = start; v <= end + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
    return out;
  }

  function lineChart(el, cfg) {
    if (!el) return;
    var W = Math.max(260, Math.round(el.clientWidth || 320));
    var H = cfg.height || 170;
    var pad = { l: 40, r: cfg.endLabels ? 74 : 14, t: cfg.bands ? 24 : 10, b: 22 };
    var n = cfg.series[0].values.length;
    var all = [];
    cfg.series.forEach(function (s) { all = all.concat(s.values); });
    var ticks = niceTicks(Math.min.apply(null, all), Math.max.apply(null, all), 4);
    var lo = ticks[0], hi = ticks[ticks.length - 1];
    var tickStep = ticks.length > 1 ? ticks[1] - ticks[0] : 1;
    var decimals = Math.abs(tickStep - Math.round(tickStep)) > 1e-9 ? 1 : 0; // 2.5 간격이면 97.5처럼 소수 표시
    var iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    function x(i) { return pad.l + (n <= 1 ? iw / 2 : i * iw / (n - 1)); }
    function y(v) { return pad.t + (hi - v) / (hi - lo) * ih; }
    var o = [];
    o.push('<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="' + esc(cfg.label || '') + '">');
    (cfg.bands || []).forEach(function (b, k) {
      var x0 = x(b.from), x1 = x(b.to);
      if (k % 2 === 0) o.push('<rect class="band" x="' + x0.toFixed(1) + '" y="' + pad.t + '" width="' + Math.max(1, x1 - x0).toFixed(1) + '" height="' + ih + '"></rect>');
      if (x1 - x0 >= b.label.length * 10.5 + 6) {
        o.push('<text class="band-text" x="' + (x0 + 4).toFixed(1) + '" y="' + (pad.t - 8) + '">' + esc(b.label) + '</text>');
      }
    });
    ticks.forEach(function (tv) {
      var yy = y(tv).toFixed(1);
      o.push('<line class="grid-line" x1="' + pad.l + '" x2="' + (W - pad.r) + '" y1="' + yy + '" y2="' + yy + '"></line>');
      o.push('<text class="axis-text" x="' + (pad.l - 6) + '" y="' + (Number(yy) + 3.5) + '" text-anchor="end">' + esc(cfg.yFmt(tv, decimals)) + '</text>');
    });
    var lastTickX = -Infinity;
    (cfg.xTicks || []).forEach(function (t) {
      if (t.i < 0 || t.i >= n) return;
      if (x(t.i) - lastTickX < t.label.length * 6.5 + 10) return; // 좁은 화면에서는 눈금을 솎아낸다
      lastTickX = x(t.i);
      var anchor = t.i === 0 ? 'start' : t.i === n - 1 ? 'end' : 'middle';
      o.push('<text class="axis-text" x="' + x(t.i).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="' + anchor + '">' + esc(t.label) + '</text>');
    });
    if (cfg.mark != null && cfg.mark < n) {
      o.push('<line class="start-line" x1="' + x(cfg.mark).toFixed(1) + '" x2="' + x(cfg.mark).toFixed(1) + '" y1="' + pad.t + '" y2="' + (pad.t + ih) + '"></line>');
    }
    cfg.series.forEach(function (s) {
      var d = s.values.map(function (v, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); }).join(' ');
      if (cfg.area && n > 1) {
        o.push('<path d="' + d + ' L' + x(n - 1).toFixed(1) + ' ' + (pad.t + ih) + ' L' + x(0).toFixed(1) + ' ' + (pad.t + ih) + ' Z" style="fill: var(' + s.color + '); opacity: 0.12"></path>');
      }
      o.push('<path d="' + d + '" fill="none" style="stroke: var(' + s.color + ')" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>');
    });
    // 끝점 라벨 (겹치지 않게 벌린다)
    var ends = cfg.series.map(function (s) { var v = s.values[n - 1]; return { s: s, v: v, y: y(v) }; });
    cfg.series.forEach(function (s, k) {
      o.push('<circle class="dot-ring" cx="' + x(n - 1).toFixed(1) + '" cy="' + ends[k].y.toFixed(1) + '" r="4" style="fill: var(' + s.color + ')"></circle>');
    });
    if (cfg.endLabels) {
      var sorted = ends.slice().sort(function (a, b) { return a.y - b.y; });
      for (var k = 1; k < sorted.length; k++) {
        if (sorted[k].y - sorted[k - 1].y < 14) sorted[k].ly = (sorted[k - 1].ly || sorted[k - 1].y) + 14;
      }
      sorted.forEach(function (e) {
        var ly = e.ly || e.y;
        o.push('<text class="end-label" x="' + (x(n - 1) + 8).toFixed(1) + '" y="' + (ly + 4).toFixed(1) + '">' + esc(e.s.label + ' ' + cfg.tipFmt(e.v)) + '</text>');
      });
    }
    o.push('<line class="cross" id="' + el.id + '-cross" x1="0" x2="0" y1="' + pad.t + '" y2="' + (pad.t + ih) + '" visibility="hidden"></line>');
    cfg.series.forEach(function (s, k) {
      o.push('<circle class="dot-ring" id="' + el.id + '-hd' + k + '" r="4" cx="0" cy="0" style="fill: var(' + s.color + ')" visibility="hidden"></circle>');
    });
    o.push('<rect x="' + pad.l + '" y="0" width="' + iw + '" height="' + H + '" fill="transparent" class="hit"></rect>');
    o.push('</svg><div class="chart-tip" hidden></div>');
    el.innerHTML = o.join('');

    var svg = el.querySelector('svg');
    var tip = el.querySelector('.chart-tip');
    var cross = el.querySelector('.cross');
    function show(ev) {
      var rect = svg.getBoundingClientRect();
      var px = (ev.clientX - rect.left) * W / rect.width;
      var i = Math.round((px - pad.l) / iw * (n - 1));
      i = Math.max(0, Math.min(n - 1, i));
      var cx = x(i);
      cross.setAttribute('x1', cx);
      cross.setAttribute('x2', cx);
      cross.setAttribute('visibility', 'visible');
      var html = '<div><b>' + esc(cfg.xFmt(i)) + '</b></div>';
      cfg.series.forEach(function (s, k) {
        var dot = el.querySelector('#' + el.id + '-hd' + k);
        dot.setAttribute('cx', cx);
        dot.setAttribute('cy', y(s.values[i]));
        dot.setAttribute('visibility', 'visible');
        html += '<div class="row"><span class="sw" style="background: var(' + s.color + ')"></span>' + esc(s.label) + ' <span class="num">' + esc(cfg.tipFmt(s.values[i])) + '</span></div>';
      });
      tip.innerHTML = html;
      tip.hidden = false;
      var scale = rect.width / W;
      var left = cx * scale + 12;
      if (left + tip.offsetWidth > rect.width) left = cx * scale - tip.offsetWidth - 12;
      tip.style.left = Math.max(0, left) + 'px';
      tip.style.top = (pad.t * scale) + 'px';
    }
    function hide() {
      tip.hidden = true;
      cross.setAttribute('visibility', 'hidden');
      el.querySelectorAll('[id^="' + el.id + '-hd"]').forEach(function (d) { d.setAttribute('visibility', 'hidden'); });
    }
    svg.addEventListener('pointermove', show);
    svg.addEventListener('pointerdown', show);
    svg.addEventListener('pointerleave', hide);
  }

  /* ---------- 시작 ---------- */

  function bind() {
    $('btn-next').addEventListener('click', onNext);
    $('btn-auto').addEventListener('click', function () { if (!st.over && !st.pending.length) step(12); });
    $('btn-new').addEventListener('click', confirmNew);
    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-buy]');
      if (b) { openBuy(b.getAttribute('data-buy')); return; }
      var m = e.target.closest('[data-manage]');
      if (m) openManage(m.getAttribute('data-manage'));
    });
    var timer = null;
    window.addEventListener('resize', function () {
      clearTimeout(timer);
      timer = setTimeout(function () { drawMarketChart(); }, 120);
    });
  }

  function start(data) {
    st = (data && data.st && data.st.version === 2) ? data.st : (load() || E.newGame());
    E.syncListings(st); // 이전 버전 저장본의 못 사는 매물 정리
    var howtoPref = null;
    try { howtoPref = localStorage.getItem(HOWTO_KEY); } catch (e) { /* 저장 불가 환경 */ }
    $('howto').open = howtoPref ? howtoPref === 'open' : st.turn === 0;
    $('howto').addEventListener('toggle', function () {
      try { localStorage.setItem(HOWTO_KEY, $('howto').open ? 'open' : 'closed'); } catch (e) { /* 무시 */ }
    });
    bind();
    render();
    afterStep();
  }

  var hot = window.claude && window.claude.hot;
  if (hot && hot.snapshot) hot.snapshot(function () { return { st: st }; });
  if (hot && hot.ready) hot.ready(start);
  else start((hot && hot.data) || {});
})();
