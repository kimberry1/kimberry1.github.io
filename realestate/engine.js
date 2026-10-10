/*
 * 블라인드 서울 — 게임 엔진
 * 화면과 무관한 순수 로직. 상태(st)는 JSON 직렬화 가능한 객체이고
 * 난수는 st.rng 시드로만 뽑으므로 같은 시드면 같은 판이 재현된다.
 */
(function (root) {
  'use strict';

  var DATA = root.MARKET_DATA;
  if (!DATA && typeof require === 'function') DATA = require('./data.js');

  var CONFIG = {
    startCash: 1e8,
    turns: 60,
    history: 3,            // 시작 전 추세 계산용 개월 수
    baseRate: 4.0,         // 시작 금리 고정 (실제 금리는 변동 폭만 반영)
    minRate: 1.0,
    ltv: 0.6,
    leaseMonths: 24,
    noticeMonths: 2,       // 만기 몇 달 전에 재계약 여부를 통보받는지
    noise: 0.0025,         // 판마다 다른 월간 시세 잡음 (표준편차)
    villaBeta: 0.6,        // 빌라는 아파트 변동의 60%만 따라간다
    buyFee: 0.005,
    sellFee: 0.005,
    leaseFee: 0.003,
    vacancyCost: 0.0002,   // 공실 관리비·공과금 (시세 대비 월)
    arrearsLimit: 3,
    auctionRatio: 0.7,
    penaltyRate: 12,       // 연체 이자율 (연 %)
    listingCount: 4,
    maxEventsPerTurn: 2
  };

  var KINDS = {
    'gn-apt':   { region: 'gn', type: 'apt',   label: '강남 아파트', base: 2.0e8, jeonseRatio: 0.55, sale: 1.0,  tenant: 1.0, rentDefault: 0.008, repair: 1.0 },
    'gb-apt':   { region: 'gb', type: 'apt',   label: '강북 아파트', base: 1.2e8, jeonseRatio: 0.65, sale: 1.0,  tenant: 1.0, rentDefault: 0.008, repair: 1.0 },
    'gn-villa': { region: 'gn', type: 'villa', label: '강남 빌라',   base: 0.9e8, jeonseRatio: 0.75, sale: 0.55, tenant: 0.8, rentDefault: 0.018, repair: 1.6 },
    'gb-villa': { region: 'gb', type: 'villa', label: '강북 빌라',   base: 0.6e8, jeonseRatio: 0.80, sale: 0.55, tenant: 0.8, rentDefault: 0.018, repair: 1.6 }
  };
  var KIND_ORDER = ['gn-apt', 'gb-apt', 'gn-villa', 'gb-villa'];
  var REGION_LABEL = { gn: '강남', gb: '강북' };
  var TYPE_LABEL = { apt: '아파트', villa: '빌라' };

  var DONGS = {
    gn: ['강남구 대치동', '강남구 개포동', '서초구 반포동', '서초구 방배동', '송파구 잠실동', '송파구 가락동',
      '강동구 명일동', '양천구 목동', '영등포구 여의도동', '동작구 사당동', '관악구 봉천동', '강서구 화곡동'],
    gb: ['도봉구 창동', '도봉구 쌍문동', '노원구 상계동', '노원구 중계동', '강북구 미아동', '성북구 길음동',
      '마포구 아현동', '용산구 이촌동', '성동구 금호동', '광진구 자양동', '은평구 불광동', '중랑구 면목동']
  };
  var SIZES = {
    apt: [{ m2: 59, py: '25평형', f: 0.8 }, { m2: 84, py: '34평형', f: 1.0 }, { m2: 114, py: '45평형', f: 1.35 }],
    villa: [{ m2: 40, py: '15평', f: 0.8 }, { m2: 52, py: '19평', f: 1.0 }, { m2: 66, py: '24평', f: 1.25 }]
  };
  var AGES = {
    apt: [{ label: '신축', f: 1.12, jf: 1.05 }, { label: '준신축', f: 1.0, jf: 1.0 }, { label: '구축', f: 0.9, jf: 0.92, rebuild: true }],
    villa: [{ label: '신축', f: 1.1, jf: 1.05 }, { label: '구축', f: 1.0, jf: 0.97 }, { label: '노후', f: 0.85, jf: 0.85, redev: true }]
  };

  var SALE_ASKS = [
    { id: 'quick', label: '급매', f: 0.9, p: 2.2 },
    { id: 'market', label: '시세', f: 1.0, p: 1.0 },
    { id: 'high', label: '고가', f: 1.05, p: 0.45 }
  ];
  var LEASE_ASKS = [
    { id: 'low', label: '시세 -10%', f: 0.9, p: 1.8 },
    { id: 'market', label: '시세', f: 1.0, p: 1.0 },
    { id: 'high', label: '시세 +10%', f: 1.1, p: 0.45 }
  ];

  // 게임 종료 후 공개하는 시기 설명
  var ERAS = [
    ['1986-01', '1987-12', '3저 호황 초입'],
    ['1988-01', '1990-12', '80년대 말 폭등기'],
    ['1991-01', '1996-12', '200만 호 공급 후 장기 안정기'],
    ['1997-11', '1998-12', 'IMF 외환위기'],
    ['1999-01', '2000-12', '외환위기 회복기'],
    ['2001-01', '2006-12', '2000년대 대세 상승장'],
    ['2007-01', '2008-08', '강북 키 맞추기 상승'],
    ['2008-09', '2009-03', '글로벌 금융위기'],
    ['2009-04', '2013-12', '하우스푸어 침체기'],
    ['2014-01', '2021-12', '저금리 대세 상승장'],
    ['2022-01', '2023-06', '금리 급등 하락장'],
    ['2023-07', '2025-12', '반등과 강남 쏠림']
  ];

  /* ---------- 유틸 ---------- */

  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function money(x) { return Math.round(x / 1e4) * 1e4; }
  function down(x, unit) { return Math.max(0, Math.floor(x / unit) * unit); }

  function rand(st) {
    var a = st.rng = (st.rng + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function uni(st, a, b) { return a + (b - a) * rand(st); }
  function pick(st, arr) { return arr[Math.floor(rand(st) * arr.length)]; }
  function gauss(st) {
    var u = 1 - rand(st), v = rand(st);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function fmt(n, opts) {
    var sign = n < 0 ? '-' : (opts && opts.plus && n > 0 ? '+' : '');
    var a = Math.abs(Math.round(n / 1e4) * 1e4);
    if (a === 0) return '0원';
    var eok = Math.floor(a / 1e8);
    var man = Math.round((a - eok * 1e8) / 1e4);
    var s;
    if (eok > 0) s = eok + '억' + (man ? ' ' + man.toLocaleString('ko-KR') + '만' : '');
    else s = man.toLocaleString('ko-KR') + '만';
    return sign + s;
  }
  function pct(x, digits) {
    var d = digits == null ? 1 : digits;
    var v = (x * 100).toFixed(d);
    return (x > 0 ? '+' : '') + v + '%';
  }
  function monthNo(key) {
    return (parseInt(key.slice(0, 4), 10) - parseInt(DATA.start.slice(0, 4), 10)) * 12 + parseInt(key.slice(5, 7), 10) - 1;
  }
  function ym(i) {
    var y = parseInt(DATA.start.slice(0, 4), 10) + Math.floor(i / 12);
    return { y: y, m: (i % 12) + 1, key: y + '-' + String((i % 12) + 1).padStart(2, '0') };
  }

  /* ---------- 시세 ---------- */

  function S(st, key, t) { return st.series[key][t + CONFIG.history]; }
  function chg(st, key, t, months) {
    var from = Math.max(-CONFIG.history, t - months);
    return S(st, key, t) / S(st, key, from) - 1;
  }
  function priceKey(p) { return p.region + (p.type === 'apt' ? 'Apt' : 'Villa'); }
  function jKey(p) { return p.region + 'J'; }

  function gameRate(st, t) {
    var r = st.series.rate;
    var H = CONFIG.history;
    var v = CONFIG.baseRate + (r[t + H] - r[H]);
    return Math.max(CONFIG.minRate, Math.round(v * 100) / 100);
  }
  function depositRate(st, t) { return Math.max(0.5, gameRate(st, t) - 1.5); }

  function activeMods(st) { return st.mods.filter(function (m) { return st.turn <= m.until; }); }
  function modMult(st, name, region, type) {
    return activeMods(st).reduce(function (acc, m) {
      if (m.name !== name) return acc;
      if (m.region && m.region !== region) return acc;
      if (m.type && m.type !== type) return acc;
      return acc * m.mult;
    }, 1);
  }
  function ltv(st) {
    var v = CONFIG.ltv;
    activeMods(st).forEach(function (m) { if (m.name === 'ltv') v = m.value; });
    return v;
  }

  function value(st, p, t) {
    t = t == null ? st.turn : t;
    return p.basePrice * S(st, priceKey(p), t) / S(st, priceKey(p), p.baseT) * p.premium;
  }
  function jeonseValue(st, p, t) {
    t = t == null ? st.turn : t;
    return p.baseJeonse * S(st, jKey(p), t) / S(st, jKey(p), p.baseT) * p.jPremium *
      modMult(st, 'jeonse', p.region, p.type);
  }
  function deposit(p) { return p.lease ? p.lease.deposit : 0; }
  function equity(st, p) { return value(st, p) - p.loan - deposit(p); }

  function netWorth(st) {
    return st.cash + st.props.reduce(function (a, p) { return a + equity(st, p); }, 0);
  }
  function totals(st) {
    var t = { value: 0, loan: 0, deposit: 0, rent: 0, interest: 0 };
    var rate = gameRate(st, st.turn);
    st.props.forEach(function (p) {
      t.value += value(st, p);
      t.loan += p.loan;
      t.deposit += deposit(p);
      if (p.lease && p.lease.kind === 'wolse') t.rent += p.lease.rent;
    });
    t.interest = t.loan * rate / 100 / 12;
    t.net = st.cash + t.value - t.loan - t.deposit;
    return t;
  }

  function heat(c3) {
    if (c3 > 0.04) return { id: 'hot', label: '과열' };
    if (c3 > 0.01) return { id: 'up', label: '상승' };
    if (c3 >= -0.01) return { id: 'flat', label: '보합' };
    if (c3 >= -0.04) return { id: 'down', label: '하락' };
    return { id: 'crash', label: '급락' };
  }

  function market(st) {
    var t = st.turn;
    var out = { rate: gameRate(st, t), depositRate: depositRate(st, t), ltv: ltv(st), regions: {} };
    out.rateChange = gameRate(st, t) - gameRate(st, Math.max(0, t - 1));
    ['gn', 'gb'].forEach(function (r) {
      var row = {};
      [['apt', r + 'Apt'], ['villa', r + 'Villa'], ['jeonse', r + 'J']].forEach(function (pair) {
        var k = pair[1];
        row[pair[0]] = { idx: S(st, k, t), chg1: chg(st, k, t, 1), chg3: chg(st, k, t, 3), chg12: chg(st, k, t, 12) };
      });
      row.heat = heat(row.apt.chg3);
      out.regions[r] = row;
    });
    out.mods = activeMods(st).map(function (m) { return { label: m.label, left: m.until - t + 1, tone: m.tone }; });
    return out;
  }

  /* ---------- 확률 ---------- */

  function saleAsk(id) { return SALE_ASKS.filter(function (a) { return a.id === id; })[0] || SALE_ASKS[1]; }
  function leaseAsk(id) { return LEASE_ASKS.filter(function (a) { return a.id === id; })[0] || LEASE_ASKS[1]; }

  function pSale(st, p, askId) {
    var k = KINDS[p.kind];
    var m = clamp(1 + 12 * chg(st, p.region + 'Apt', st.turn, 3), 0.15, 2.0);
    var pr = 0.3 * k.sale * m * saleAsk(askId).p * modMult(st, 'sale', p.region, p.type);
    return clamp(pr, 0.02, 0.95);
  }

  function leaseTerms(st, p, kind, askId) {
    var a = leaseAsk(askId);
    var j = jeonseValue(st, p);
    if (kind === 'jeonse') return { kind: kind, deposit: money(j * a.f), rent: 0 };
    var dep = money(j * 0.15);
    var conv = (gameRate(st, st.turn) + 2.5) / 100;
    return { kind: kind, deposit: dep, rent: money((j - dep) * conv / 12 * a.f) };
  }

  function pTenant(st, p, kind, askId) {
    var k = KINDS[p.kind];
    var m = clamp(1 + 10 * chg(st, jKey(p), st.turn, 3), 0.3, 1.6);
    var base = kind === 'jeonse' ? 0.5 : 0.42;
    var pr = base * k.tenant * m * leaseAsk(askId).p * modMult(st, 'tenant', p.region, p.type);
    if (kind === 'jeonse' && !p.lease) {
      var remain = p.loan - leaseTerms(st, p, kind, askId).deposit;
      if (remain > value(st, p) * 0.1) pr *= 0.5; // 근저당이 많이 남는 집은 전세 세입자가 꺼린다
    }
    return clamp(pr, 0.03, 0.92);
  }

  /* ---------- 세금 ---------- */

  function acqTaxRate(count) {
    if (count <= 1) return 0.01;
    if (count === 2) return 0.03;
    if (count === 3) return 0.08;
    return 0.12;
  }

  var BRACKETS = [[14e6, 0.06], [50e6, 0.15], [88e6, 0.24], [150e6, 0.35], [300e6, 0.38], [500e6, 0.40], [1e9, 0.42], [Infinity, 0.45]];
  function progressive(gain) {
    var tax = 0, prev = 0;
    for (var i = 0; i < BRACKETS.length && gain > prev; i++) {
      var top = BRACKETS[i][0];
      tax += (Math.min(gain, top) - prev) * BRACKETS[i][1];
      prev = top;
    }
    return tax;
  }

  function gainsTax(st, p, salePrice, fee) {
    var gain = salePrice - fee - p.buyPrice - p.buyCosts;
    var held = st.turn - p.buyT;
    if (gain <= 0) return { tax: 0, label: '양도차익 없음', gain: gain };
    if (st.props.length === 1 && held >= 24) return { tax: 0, label: '1주택 2년 보유 비과세', gain: gain };
    if (held < 12) return { tax: money(gain * 0.7), label: '1년 미만 단기 70%', gain: gain };
    if (held < 24) return { tax: money(gain * 0.6), label: '2년 미만 단기 60%', gain: gain };
    var years = Math.floor(held / 12);
    var ded = years >= 3 ? Math.min(0.3, years * 0.02) : 0;
    var base = gain * (1 - ded);
    return { tax: money(progressive(base)), label: '기본세율' + (ded ? ' (장기보유공제 ' + Math.round(ded * 100) + '%)' : ''), gain: gain };
  }

  function saleEstimate(st, p, askId) {
    var price = money(value(st, p) * saleAsk(askId).f);
    var fee = money(price * CONFIG.sellFee);
    var tax = gainsTax(st, p, price, fee);
    return {
      price: price, fee: fee, tax: tax.tax, taxLabel: tax.label, gain: tax.gain,
      loan: p.loan, deposit: deposit(p),
      net: price - fee - tax.tax - p.loan - deposit(p),
      prob: pSale(st, p, askId)
    };
  }

  /* ---------- 매물 ---------- */

  function makeListing(st, kind, tag) {
    var k = KINDS[kind];
    var t = st.turn;
    var size = pick(st, SIZES[k.type]);
    var age = pick(st, AGES[k.type]);
    var noise = uni(st, 0.95, 1.05);
    var pk = k.region + (k.type === 'apt' ? 'Apt' : 'Villa');
    var fair = money(k.base * S(st, pk, t) / S(st, pk, 0) * size.f * age.f * noise);
    // 규제·사건 효과(modMult)는 jeonseValue에서 적용하므로 여기서는 원래 시세만 저장한다
    var jeonse = money(k.base * k.jeonseRatio * S(st, k.region + 'J', t) / S(st, k.region + 'J', 0) *
      size.f * age.jf * uni(st, 0.96, 1.04));
    var disc = tag === '급매' ? uni(st, 0.85, 0.9) : tag === '경매' ? uni(st, 0.75, 0.85) : 1;
    return {
      id: 'L' + (st.nextId++),
      kind: kind, region: k.region, type: k.type,
      dong: pick(st, DONGS[k.region]),
      m2: size.m2, py: size.py, age: age.label,
      fair: fair, price: money(fair * disc), jeonse: Math.min(jeonse, money(fair * 0.92)),
      tag: tag || null,
      redevHope: !!age.redev, rebuildHope: !!age.rebuild
    };
  }

  function refreshListings(st) {
    var specials = st.listings.filter(function (l) { return l.tag && l.until >= st.turn; });
    st.listings = KIND_ORDER.map(function (k) { return makeListing(st, k); }).concat(specials);
  }

  function listingName(l) { return l.dong + ' ' + TYPE_LABEL[l.type]; }

  // 매수 전 미리보기용 가상 물건 (상태에 추가하지 않는다)
  function preview(st, listingId, loan) {
    var l = st.listings.filter(function (x) { return x.id === listingId; })[0];
    if (!l) return null;
    return {
      id: 'preview', kind: l.kind, region: l.region, type: l.type, dong: l.dong,
      basePrice: l.fair, baseJeonse: l.jeonse, baseT: st.turn, premium: 1, jPremium: 1,
      loan: loan || 0, lease: null
    };
  }

  /* ---------- 상태 생성 ---------- */

  function newGame(seed) {
    if (seed == null) seed = (Date.now() ^ Math.floor(Math.random() * 4294967296)) | 0;
    var st = {
      version: 1,
      seed: seed, rng: seed,
      turn: 0, turns: CONFIG.turns,
      cash: CONFIG.startCash,
      arrears: 0,
      props: [], listings: [], mods: [], pending: [], log: [], hist: [],
      nextId: 1, used: {},
      over: false, bankrupt: false
    };
    var H = CONFIG.history;
    st.startIdx = H + Math.floor(rand(st) * (DATA.months - CONFIG.turns - H));
    st.series = buildSeries(st);
    refreshListings(st);
    st.report = { t: 0, ledger: [], items: [{ text: '종잣돈 1억으로 시작합니다. 몇 년도인지는 게임이 끝나야 공개됩니다.', tone: 'info' }] };
    st.hist.push({ t: 0, net: netWorth(st), cash: st.cash });
    return st;
  }

  function buildSeries(st) {
    var H = CONFIG.history, N = CONFIG.turns, s0 = st.startIdx;
    var keys = ['gnApt', 'gbApt', 'gnVilla', 'gbVilla', 'gnJ', 'gbJ'];
    var s = { rate: [] };
    keys.forEach(function (k) { s[k] = [100]; });
    for (var k = 0; k <= H + N; k++) {
      var di = s0 - H + k;
      s.rate.push(DATA.rate[di]);
      if (k === 0) continue;
      ['gn', 'gb'].forEach(function (r) {
        var a = DATA[r + 'Apt'][di] / DATA[r + 'Apt'][di - 1] - 1 + gauss(st) * CONFIG.noise;
        var v = a * CONFIG.villaBeta + gauss(st) * CONFIG.noise * 0.5;
        var j = DATA[r + 'Jeonse'][di] / DATA[r + 'Jeonse'][di - 1] - 1 + gauss(st) * CONFIG.noise * 0.6;
        s[r + 'Apt'].push(s[r + 'Apt'][k - 1] * (1 + a));
        s[r + 'Villa'].push(s[r + 'Villa'][k - 1] * (1 + v));
        s[r + 'J'].push(s[r + 'J'][k - 1] * (1 + j));
      });
    }
    keys.forEach(function (key) {
      var b = s[key][H];
      s[key] = s[key].map(function (v) { return Math.round(v / b * 100000) / 1000; });
    });
    return s;
  }

  /* ---------- 리포트 ---------- */

  function ledger(rep, label, amount) {
    if (!amount) return;
    var row = rep.ledger.filter(function (r) { return r.label === label; })[0];
    if (row) row.amount += amount; else rep.ledger.push({ label: label, amount: amount });
  }
  function note(st, rep, text, tone, important) {
    rep.items.push({ text: text, tone: tone || 'info', important: !!important });
    st.log.unshift({ t: st.turn, text: text, tone: tone || 'info' });
    if (st.log.length > 300) st.log.length = 300;
  }
  function findProp(st, id) { return st.props.filter(function (p) { return p.id === id; })[0]; }
  function propName(p) { return p.dong + ' ' + TYPE_LABEL[p.type]; }

  /* ---------- 플레이어 행동 ---------- */

  function buyQuote(st, listingId, loan) {
    var l = st.listings.filter(function (x) { return x.id === listingId; })[0];
    if (!l) return null;
    var count = st.props.length + 1;
    var taxRate = acqTaxRate(count);
    var tax = money(l.price * taxRate);
    var fee = money(l.price * CONFIG.buyFee);
    var loanMax = down(l.price * ltv(st), 1e6);
    loan = clamp(down(loan || 0, 1e6), 0, loanMax);
    var need = l.price + tax + fee - loan;
    var q = {
      listing: l, count: count, taxRate: taxRate, tax: tax, fee: fee,
      loan: loan, loanMax: loanMax, need: need, cashAfter: st.cash - need,
      interest: money(loan * gameRate(st, st.turn) / 100 / 12),
      ok: need <= st.cash && !st.over && st.turn < st.turns
    };
    if (!q.ok) q.reason = st.over ? '게임이 끝났습니다.' : '현금이 ' + fmt(need - st.cash) + ' 부족합니다. 대출을 늘리거나 다른 매물을 고르세요.';
    return q;
  }

  function buy(st, listingId, opts) {
    var q = buyQuote(st, listingId, opts.loan);
    if (!q || !q.ok) return { ok: false, msg: q ? q.reason : '매물이 없습니다.' };
    var l = q.listing;
    var p = {
      id: 'P' + (st.nextId++),
      kind: l.kind, region: l.region, type: l.type,
      dong: l.dong, m2: l.m2, py: l.py, age: l.age,
      basePrice: l.fair, baseJeonse: l.jeonse, baseT: st.turn,
      premium: 1, jPremium: 1,
      buyPrice: l.price, buyT: st.turn, buyCosts: q.tax + q.fee,
      loan: q.loan, lease: null, nextLease: null, seeking: null, selling: null,
      redevHope: l.redevHope, rebuildHope: l.rebuildHope, redev: false,
      defaultLeft: 0, unpaid: 0, noRenew: false
    };
    st.cash -= q.need;
    st.props.push(p);
    st.listings = st.listings.filter(function (x) { return x.id !== l.id; });
    var rep = st.report;
    note(st, rep, propName(p) + ' 매수 ' + fmt(l.price) + (q.loan ? ' (대출 ' + fmt(q.loan) + ')' : '') +
      ' · 취득세 ' + fmt(q.tax), 'info');
    if (l.tag === '경매' && rand(st) < 0.3) {
      var extra = money(l.fair * uni(st, 0.03, 0.07));
      st.cash -= extra;
      note(st, rep, '경매 물건에 유치권 신고가 있었습니다. 명도·정리 비용 ' + fmt(extra) + ' 지출.', 'bad', true);
    }
    if (opts.leaseKind) p.seeking = { kind: opts.leaseKind, ask: opts.ask || 'market' };
    return { ok: true, prop: p };
  }

  function setSeeking(st, propId, kind, askId) {
    var p = findProp(st, propId);
    if (!p) return;
    if (p.lease && (p.lease.renew !== false || p.nextLease)) return;
    p.seeking = kind ? { kind: kind, ask: askId || 'market' } : null;
  }

  function setSelling(st, propId, askId) {
    var p = findProp(st, propId);
    if (!p) return;
    p.selling = askId ? { ask: askId, since: st.turn } : null;
  }

  function maxBorrow(st, p) {
    return down(value(st, p) * ltv(st) - p.loan - deposit(p), 1e6);
  }

  function borrow(st, propId, amount) {
    var p = findProp(st, propId);
    if (!p) return { ok: false };
    var a = Math.min(down(amount, 1e6), maxBorrow(st, p));
    if (a <= 0) return { ok: false, msg: '추가 대출 한도가 없습니다.' };
    p.loan += a;
    st.cash += a;
    note(st, st.report, propName(p) + ' 담보 추가 대출 ' + fmt(a), 'info');
    return { ok: true, amount: a };
  }

  function repay(st, propId, amount) {
    var p = findProp(st, propId);
    if (!p) return { ok: false };
    var a = Math.min(money(amount), p.loan, Math.max(0, st.cash));
    if (a <= 0) return { ok: false, msg: '상환할 현금이 없습니다.' };
    p.loan -= a;
    st.cash -= a;
    note(st, st.report, propName(p) + ' 대출 상환 ' + fmt(a), 'info');
    return { ok: true, amount: a };
  }

  /* ---------- 월 진행 ---------- */

  function startLease(st, rep, p, terms, fromVacancy) {
    var fee = money((terms.deposit + terms.rent * 100) * CONFIG.leaseFee);
    p.lease = {
      kind: terms.kind, deposit: terms.deposit, rent: terms.rent,
      start: st.turn, end: st.turn + CONFIG.leaseMonths, renew: null
    };
    st.cash += terms.deposit;
    ledger(rep, '임대 중개수수료', -fee);
    st.cash -= fee;
    var text = propName(p) + (terms.kind === 'jeonse'
      ? ' 전세 계약: 보증금 ' + fmt(terms.deposit)
      : ' 월세 계약: 보증금 ' + fmt(terms.deposit) + ' / 월 ' + fmt(terms.rent));
    if (fromVacancy && terms.kind === 'jeonse' && p.loan > 0) {
      var r = Math.min(p.loan, terms.deposit, Math.max(0, st.cash));
      if (r > 0) {
        p.loan -= r;
        st.cash -= r;
        text += ' · 보증금으로 대출 ' + fmt(r) + ' 상환';
      }
    }
    note(st, rep, text, 'good', true);
  }

  function endLeaseMoveOut(st, rep, p) {
    var back = Math.max(0, p.lease.deposit - p.unpaid);
    st.cash -= back;
    note(st, rep, propName(p) + ' 세입자 퇴거: 보증금 ' + fmt(back) + ' 반환' +
      (p.unpaid ? ' (밀린 월세 ' + fmt(p.unpaid) + ' 공제)' : ''), back > 0 ? 'bad' : 'info', true);
    var kind = p.lease.kind;
    p.lease = null;
    p.nextLease = null;
    p.unpaid = 0;
    p.defaultLeft = 0;
    p.noRenew = false;
    if (!p.seeking) p.seeking = { kind: kind, ask: 'market' };
    if (rand(st) < 0.12) {
      var cost = money(value(st, p) * uni(st, 0.005, 0.02) * KINDS[p.kind].repair);
      st.cash -= cost;
      ledger(rep, '수리비', -cost);
      note(st, rep, propName(p) + ': 퇴거 후 집 상태가 엉망입니다. 원상복구 비용 ' + fmt(cost), 'bad');
    }
  }

  function processLeases(st, rep) {
    var t = st.turn;
    st.props.forEach(function (p) {
      var L = p.lease;
      if (!L) return;
      if (L.renew === null && t >= L.end - CONFIG.noticeMonths) {
        var pr = p.noRenew ? 0 : (L.kind === 'wolse' ? 0.55 : 0.5);
        L.renew = rand(st) < pr;
        if (L.renew) {
          note(st, rep, propName(p) + ': 세입자가 만기 후 재계약하겠다고 알려왔습니다.', 'info');
        } else {
          p.seeking = { kind: L.kind, ask: 'market' };
          note(st, rep, propName(p) + ': 세입자가 ' + (L.end - t) + '개월 뒤 만기에 나갑니다. 다음 세입자를 구하기 시작합니다. 못 구하면 보증금 ' +
            fmt(L.deposit) + '을 현금으로 돌려줘야 합니다.', 'warn', true);
        }
      }
      if (t < L.end) return;
      if (L.renew) {
        if (L.kind === 'jeonse') {
          var mkt = money(jeonseValue(st, p));
          var nd = mkt >= L.deposit ? Math.min(money(L.deposit * 1.05), mkt) : mkt;
          var diff = nd - L.deposit;
          st.cash += diff;
          if (diff < 0) note(st, rep, propName(p) + ' 역전세: 전세 시세가 떨어져 재계약하며 보증금 차액 ' + fmt(-diff) + '을 돌려줬습니다.', 'bad', true);
          else note(st, rep, propName(p) + ' 전세 재계약: 보증금 ' + fmt(L.deposit) + ' → ' + fmt(nd) + ' (5% 상한)', 'good');
          L.deposit = nd;
        } else {
          var terms = leaseTerms(st, p, 'wolse', 'market');
          var nr = terms.rent >= L.rent ? Math.min(money(L.rent * 1.05), terms.rent) : terms.rent;
          note(st, rep, propName(p) + ' 월세 재계약: 월 ' + fmt(L.rent) + ' → ' + fmt(nr), nr >= L.rent ? 'good' : 'bad');
          L.rent = nr;
        }
        L.start = t;
        L.end = t + CONFIG.leaseMonths;
        L.renew = null;
        return;
      }
      if (p.nextLease) {
        var n = p.nextLease;
        // 새 보증금을 받고, 기존 보증금에서 밀린 월세를 뺀 만큼 돌려준다
        var delta = n.deposit - L.deposit + p.unpaid;
        st.cash += delta;
        p.lease = { kind: n.kind, deposit: n.deposit, rent: n.rent, start: t, end: t + CONFIG.leaseMonths, renew: null };
        p.nextLease = null;
        p.unpaid = 0;
        p.defaultLeft = 0;
        p.noRenew = false;
        note(st, rep, propName(p) + ' 세입자 교체 완료: 보증금 차액 ' + fmt(delta, { plus: true }),
          delta >= 0 ? 'good' : 'bad', true);
        return;
      }
      endLeaseMoveOut(st, rep, p);
    });
  }

  function processSearch(st, rep) {
    st.props.forEach(function (p) {
      if (!p.seeking) return;
      if (p.lease && (p.lease.renew !== false || p.nextLease)) { p.seeking = null; return; }
      var s = p.seeking;
      if (rand(st) >= pTenant(st, p, s.kind, s.ask)) return;
      var terms = leaseTerms(st, p, s.kind, s.ask);
      p.seeking = null;
      if (p.lease) {
        p.nextLease = terms;
        var fee = money((terms.deposit + terms.rent * 100) * CONFIG.leaseFee);
        st.cash -= fee;
        ledger(rep, '임대 중개수수료', -fee);
        note(st, rep, propName(p) + ': 다음 세입자 계약 완료 (' + (terms.kind === 'jeonse' ? '전세 ' + fmt(terms.deposit)
          : '보증금 ' + fmt(terms.deposit) + ' / 월 ' + fmt(terms.rent)) + '). 만기 때 바로 교체됩니다.', 'good', true);
      } else {
        startLease(st, rep, p, terms, true);
      }
    });
  }

  function sellProp(st, p, price, fee, tax) {
    var net = price - fee - tax - p.loan - deposit(p);
    st.cash += net;
    st.props = st.props.filter(function (x) { return x.id !== p.id; });
    return net;
  }

  function processSales(st, rep) {
    st.props.slice().forEach(function (p) {
      if (!p.selling) return;
      if (rand(st) >= pSale(st, p, p.selling.ask)) return;
      var e = saleEstimate(st, p, p.selling.ask);
      var gain = e.price - p.buyPrice;
      sellProp(st, p, e.price, e.fee, e.tax);
      ledger(rep, '매도 중개수수료', -e.fee);
      if (e.tax) ledger(rep, '양도소득세', -e.tax);
      note(st, rep, propName(p) + ' 매도 체결 ' + fmt(e.price) + ' (매수가 대비 ' + fmt(gain, { plus: true }) + ') · ' +
        e.taxLabel + (e.tax ? ' ' + fmt(e.tax) : '') + ' · 손에 쥔 돈 ' + fmt(e.net), gain >= 0 ? 'good' : 'bad', true);
    });
  }

  function forceAuction(st, rep) {
    var target = st.props.slice().sort(function (a, b) {
      return (b.loan + deposit(b)) / value(st, b) - (a.loan + deposit(a)) / value(st, a);
    })[0];
    if (!target) return false;
    var price = money(value(st, target) * CONFIG.auctionRatio);
    var fee = money(price * 0.01);
    var net = sellProp(st, target, price, fee, 0);
    note(st, rep, '경매 진행: ' + propName(target) + '이(가) 시세의 70%인 ' + fmt(price) + '에 낙찰됐습니다. 대출·보증금 정리 후 ' +
      fmt(net, { plus: true }), 'bad', true);
    return true;
  }

  function addMod(st, m) { st.mods.push(m); }

  /* ---------- 이벤트 ---------- */

  var PROP_EVENTS = {
    leak: {
      chance: function (st, p) { return 0.01 * KINDS[p.kind].repair; },
      make: function (st, p) {
        var cost = money(value(st, p) * uni(st, 0.004, 0.012) * KINDS[p.kind].repair);
        return {
          title: '누수·보일러 고장',
          body: propName(p) + '에서 ' + (p.lease ? '세입자가 누수와 보일러 고장을 알려왔습니다.' : '빈집 점검 중 누수를 발견했습니다.') +
            ' 수리비 견적은 ' + fmt(cost) + '입니다.',
          data: { cost: cost },
          choices: [
            { id: 'fix', label: '바로 수리한다', hint: fmt(cost) + ' 지출' },
            { id: 'delay', label: '미룬다', hint: '절반 확률로 피해가 두 배로 커지고 세입자가 재계약을 거부합니다' }
          ]
        };
      },
      resolve: function (st, ev, choice, rep, p) {
        var cost = ev.data.cost;
        if (choice === 'fix') {
          st.cash -= cost;
          ledger(rep, '수리비', -cost);
          note(st, rep, propName(p) + ' 수리 완료 (' + fmt(cost) + ')', 'info');
        } else if (rand(st) < 0.5) {
          note(st, rep, propName(p) + ': 다행히 피해가 더 커지지 않았습니다.', 'good');
        } else {
          st.cash -= cost * 2;
          ledger(rep, '수리비', -cost * 2);
          if (p.lease) p.noRenew = true;
          note(st, rep, propName(p) + ': 아랫집까지 물이 샜습니다. 수리·배상 ' + fmt(cost * 2) + (p.lease ? ', 세입자는 재계약하지 않겠다고 합니다.' : ''), 'bad', true);
        }
      }
    },
    rentDefault: {
      chance: function (st, p) {
        return p.lease && p.lease.kind === 'wolse' && !p.defaultLeft ? KINDS[p.kind].rentDefault : 0;
      },
      make: function (st, p) {
        return {
          title: '월세 미납',
          body: propName(p) + ' 세입자가 이번 달 월세 ' + fmt(p.lease.rent) + '를 내지 않았습니다. 연락도 잘 닿지 않습니다.',
          choices: [
            { id: 'wait', label: '기다린다', hint: '보통 두어 달이면 해결되지만 반년 넘게 끌 수도 있습니다' },
            { id: 'evict', label: '명도소송을 건다', hint: '소송비 ' + fmt(money(value(st, p) * 0.004)) + ', 4개월 뒤 퇴거' }
          ]
        };
      },
      resolve: function (st, ev, choice, rep, p) {
        if (!p.lease) return;
        if (choice === 'wait') {
          p.defaultLeft = rand(st) < 0.6 ? 2 : 6;
          note(st, rep, propName(p) + ': 일단 기다리기로 했습니다.', 'warn');
        } else {
          var cost = money(value(st, p) * 0.004);
          st.cash -= cost;
          ledger(rep, '소송비', -cost);
          p.defaultLeft = 4;
          p.lease.end = st.turn + 4;
          p.lease.renew = false;
          p.seeking = { kind: 'wolse', ask: 'market' };
          note(st, rep, propName(p) + ': 명도소송 제기 (' + fmt(cost) + '). 4개월 뒤 퇴거합니다. 밀린 월세는 보증금에서 공제합니다.', 'warn', true);
        }
      }
    },
    earlyLeave: {
      chance: function (st, p) {
        return p.lease && p.lease.kind === 'jeonse' && p.lease.renew === null && p.lease.end - st.turn > 4 ? 0.005 : 0;
      },
      make: function (st, p) {
        return {
          title: '전세 세입자 중도 퇴거 요청',
          body: propName(p) + ' 세입자가 급하게 이사해야 한다며 보증금 ' + fmt(p.lease.deposit) + '을 지금 돌려달라고 합니다. 만기는 ' +
            (p.lease.end - st.turn) + '개월 남았습니다.',
          choices: [
            { id: 'accept', label: '보증금을 돌려준다', hint: '현금으로 즉시 반환하고 새 세입자를 구합니다' },
            { id: 'refuse', label: '계약대로 거절한다', hint: '대부분 받아들이지만 소송으로 갈 수 있습니다' }
          ]
        };
      },
      resolve: function (st, ev, choice, rep, p) {
        if (!p.lease) return;
        if (choice === 'accept' || rand(st) < 0.3) {
          if (choice !== 'accept') {
            var cost = money(value(st, p) * 0.003);
            st.cash -= cost;
            ledger(rep, '소송비', -cost);
            note(st, rep, propName(p) + ': 세입자가 임차권등기 후 소송을 걸었습니다. 보증금 반환 판결, 소송비 ' + fmt(cost), 'bad', true);
          }
          endLeaseMoveOut(st, rep, p);
        } else {
          note(st, rep, propName(p) + ': 세입자가 만기까지 살기로 했습니다.', 'good');
        }
      }
    },
    redev: {
      chance: function (st, p) { return p.type === 'villa' && !p.redev ? (p.redevHope ? 0.006 : 0.0015) : 0; },
      auto: function (st, p, rep) {
        var m = uni(st, 1.3, 1.6);
        p.premium *= m;
        p.redev = true;
        note(st, rep, '재개발 구역 지정: ' + propName(p) + ' 시세가 ' + pct(m - 1, 0) + ' 뛰었습니다. 전세 시세는 그대로라 갭이 벌어집니다.', 'good', true);
      }
    },
    redevCancel: {
      chance: function (st, p) { return p.redev ? 0.01 : 0; },
      auto: function (st, p, rep) {
        p.premium *= 0.77;
        p.redev = false;
        note(st, rep, '재개발 무산: 주민 반대로 ' + propName(p) + ' 일대 재개발이 해제됐습니다. 시세 -23%.', 'bad', true);
      }
    },
    rebuild: {
      chance: function (st, p) { return p.rebuildHope ? 0.004 : 0; },
      auto: function (st, p, rep) {
        var m = uni(st, 1.12, 1.25);
        p.premium *= m;
        p.rebuildHope = false;
        note(st, rep, '재건축 안전진단 통과: ' + propName(p) + ' 시세 ' + pct(m - 1, 0), 'good', true);
      }
    },
    station: {
      chance: function () { return 0.002; },
      auto: function (st, p, rep) {
        p.premium *= 1.08;
        note(st, rep, '역 신설 확정: ' + propName(p) + ' 인근에 지하철역이 들어섭니다. 시세 +8%.', 'good', true);
      }
    },
    noise: {
      chance: function (st, p) { return p.lease && !p.noRenew ? 0.006 : 0; },
      auto: function (st, p, rep) {
        p.noRenew = true;
        note(st, rep, propName(p) + ': 층간소음 분쟁으로 세입자가 만기에 나가겠다고 합니다.', 'warn');
      }
    },
    fire: {
      chance: function () { return 0.0006; },
      auto: function (st, p, rep) {
        var cost = money(value(st, p) * 0.05);
        st.cash -= cost;
        ledger(rep, '화재 복구비', -cost);
        note(st, rep, '화재: ' + propName(p) + '에 불이 났습니다. 복구비 ' + fmt(cost), 'bad', true);
        if (p.lease) endLeaseMoveOut(st, rep, p);
      }
    }
  };

  var GLOBAL_EVENTS = {
    ltvTight: {
      weight: function (st) {
        var c = Math.max(chg(st, 'gnApt', st.turn, 3), chg(st, 'gbApt', st.turn, 3));
        return c > 0.02 && !activeMods(st).some(function (m) { return m.name === 'ltv'; }) ? 1.5 : 0;
      },
      run: function (st, rep) {
        addMod(st, { name: 'ltv', value: 0.4, until: st.turn + 12, label: '대출 규제 (LTV 40%)', tone: 'bad' });
        addMod(st, { name: 'sale', mult: 0.7, until: st.turn + 6, label: '거래 위축', tone: 'bad' });
        note(st, rep, '정부 대책 발표: 집값 과열로 LTV가 40%로 줄어듭니다(12개월). 거래도 얼어붙습니다.', 'bad', true);
      }
    },
    ltvEase: {
      weight: function (st) {
        var c = Math.min(chg(st, 'gnApt', st.turn, 3), chg(st, 'gbApt', st.turn, 3));
        return c < -0.015 && !activeMods(st).some(function (m) { return m.name === 'ltv'; }) ? 1.5 : 0;
      },
      run: function (st, rep) {
        addMod(st, { name: 'ltv', value: 0.7, until: st.turn + 12, label: '규제 완화 (LTV 70%)', tone: 'good' });
        addMod(st, { name: 'sale', mult: 1.3, until: st.turn + 6, label: '거래 활성화', tone: 'good' });
        note(st, rep, '부동산 경기 부양책: LTV가 70%로 늘어납니다(12개월). 매수 문의가 늘었습니다.', 'good', true);
      }
    },
    fraud: {
      weight: function (st) { return st.used.fraud ? 0 : 0.5; },
      run: function (st, rep) {
        st.used.fraud = true;
        addMod(st, { name: 'tenant', mult: 0.45, type: 'villa', until: st.turn + 12, label: '빌라 전세 기피', tone: 'bad' });
        addMod(st, { name: 'jeonse', mult: 0.88, type: 'villa', until: st.turn + 12, label: '빌라 전세가 하락', tone: 'bad' });
        note(st, rep, '빌라 전세사기 사태: 빌라 전세 수요가 급감합니다(12개월). 세입자 구하기가 어렵고 전세 시세가 12% 내립니다.', 'bad', true);
      }
    },
    supply: {
      weight: function () { return 0.8; },
      run: function (st, rep) {
        var r = rand(st) < 0.5 ? 'gn' : 'gb';
        addMod(st, { name: 'tenant', mult: 0.6, region: r, until: st.turn + 6, label: REGION_LABEL[r] + ' 입주 폭탄', tone: 'bad' });
        addMod(st, { name: 'jeonse', mult: 0.93, region: r, until: st.turn + 6, label: REGION_LABEL[r] + ' 전세가 약세', tone: 'bad' });
        note(st, rep, REGION_LABEL[r] + '에 대단지 입주가 몰립니다(6개월). 세입자 구하기가 어렵고 전세 시세가 7% 내립니다.', 'warn', true);
      }
    },
    urgent: {
      weight: function () { return 1; },
      run: function (st, rep) {
        var l = makeListing(st, pick(st, KIND_ORDER), '급매');
        l.until = st.turn;
        st.listings.push(l);
        note(st, rep, '급매물 등장: ' + listingName(l) + ' ' + fmt(l.price) + ' (시세 ' + fmt(l.fair) + '). 이번 달에만 살 수 있습니다.', 'good', true);
      }
    },
    auction: {
      weight: function (st) { return chg(st, 'gnApt', st.turn, 3) < 0 ? 1.5 : 0.5; },
      run: function (st, rep) {
        var l = makeListing(st, pick(st, KIND_ORDER), '경매');
        l.until = st.turn;
        st.listings.push(l);
        note(st, rep, '경매 물건: ' + listingName(l) + ' 최저가 ' + fmt(l.price) + ' (시세 ' + fmt(l.fair) + '). 권리관계에 하자가 있을 수 있습니다.', 'info', true);
      }
    }
  };

  function rollEvents(st, rep) {
    var count = 0;
    var props = st.props.slice();
    for (var i = 0; i < props.length && count < CONFIG.maxEventsPerTurn; i++) {
      var p = props[i];
      if (st.props.indexOf(p) < 0) continue;
      for (var key in PROP_EVENTS) {
        var e = PROP_EVENTS[key];
        if (rand(st) >= e.chance(st, p)) continue;
        count++;
        if (e.auto) {
          e.auto(st, p, rep);
        } else {
          var ev = e.make(st, p);
          ev.key = key;
          ev.propId = p.id;
          ev.id = 'E' + (st.nextId++);
          st.pending.push(ev);
          note(st, rep, ev.title + ': ' + propName(p), 'warn', true);
        }
        break;
      }
    }
    if (count >= CONFIG.maxEventsPerTurn || rand(st) >= 0.12) return;
    var pool = [];
    var total = 0;
    for (var g in GLOBAL_EVENTS) {
      var w = GLOBAL_EVENTS[g].weight(st);
      if (w > 0) { pool.push([g, w]); total += w; }
    }
    var x = rand(st) * total;
    for (var j = 0; j < pool.length; j++) {
      x -= pool[j][1];
      if (x <= 0) { GLOBAL_EVENTS[pool[j][0]].run(st, rep); break; }
    }
  }

  function resolveEvent(st, choiceId) {
    var ev = st.pending.shift();
    if (!ev) return;
    var p = findProp(st, ev.propId);
    if (!p) return;
    PROP_EVENTS[ev.key].resolve(st, ev, choiceId, st.report, p);
  }

  /* ---------- 한 달 진행 ---------- */

  function advance(st) {
    if (st.over || st.pending.length) return null;
    var prevNet = netWorth(st);
    st.turn += 1;
    var t = st.turn;
    var rep = { t: t, ledger: [], items: [] };
    st.report = rep;

    var expired = st.mods.filter(function (m) { return m.until === t - 1; });
    expired.forEach(function (m) { note(st, rep, m.label + ' 종료', 'info'); });
    st.mods = activeMods(st);

    var rate = gameRate(st, t);
    var prevRate = gameRate(st, t - 1);
    if (Math.abs(rate - prevRate) >= 0.25) {
      note(st, rep, '대출 금리 ' + prevRate.toFixed(2) + '% → ' + rate.toFixed(2) + '%', rate > prevRate ? 'bad' : 'good', rate - prevRate >= 1);
    }

    // 연체 이자 (지난달 현금 마이너스)
    if (st.cash < 0) {
      var pen = money(-st.cash * CONFIG.penaltyRate / 100 / 12);
      st.cash -= pen;
      ledger(rep, '연체 이자', -pen);
    }

    var interest = 0, rent = 0, vacancy = 0;
    st.props.forEach(function (p) {
      interest += p.loan * rate / 100 / 12;
      if (p.lease && p.lease.kind === 'wolse') {
        if (p.defaultLeft > 0) {
          p.defaultLeft -= 1;
          p.unpaid += p.lease.rent;
          if (p.defaultLeft === 0 && p.lease.renew !== false) note(st, rep, propName(p) + ': 세입자가 다시 월세를 내기 시작했습니다. 밀린 돈은 보증금에서 정산합니다.', 'info');
        } else {
          rent += p.lease.rent;
        }
      }
      if (!p.lease) vacancy += value(st, p) * CONFIG.vacancyCost;
    });
    interest = money(interest);
    vacancy = money(vacancy);
    ledger(rep, '월세 수입', rent);
    ledger(rep, '대출 이자', -interest);
    ledger(rep, '공실 관리비', -vacancy);
    st.cash += rent - interest - vacancy;

    if (st.cash > 0) {
      var di = money(st.cash * depositRate(st, t) / 100 / 12);
      ledger(rep, '예금 이자', di);
      st.cash += di;
    }

    if (t % 12 === 0 && st.props.length) {
      var hr = st.props.length >= 2 ? 0.005 : 0.0025;
      var htax = money(st.props.reduce(function (a, p) { return a + value(st, p); }, 0) * hr);
      ledger(rep, '보유세 (재산세·종부세)', -htax);
      st.cash -= htax;
    }

    processSales(st, rep);
    processSearch(st, rep);
    processLeases(st, rep);
    rollEvents(st, rep);

    if (st.cash < 0) {
      st.arrears += 1;
      if (st.arrears >= CONFIG.arrearsLimit) {
        if (!forceAuction(st, rep)) {
          st.over = true;
          st.bankrupt = true;
          note(st, rep, '파산: 남은 집이 없고 빚을 갚을 수 없습니다.', 'bad', true);
        }
      } else {
        note(st, rep, '현금 ' + fmt(st.cash) + ': 이자·보증금을 못 막고 있습니다. 연체 ' + st.arrears + '개월째. ' +
          CONFIG.arrearsLimit + '개월이 되면 집이 경매로 넘어갑니다.', 'bad', true);
      }
    } else {
      st.arrears = 0;
    }

    refreshListings(st);
    var net = netWorth(st);
    st.hist.push({ t: t, net: net, cash: st.cash });
    rep.netChange = net - prevNet;
    if (t >= st.turns && !st.over) {
      st.over = true;
      st.pending = [];
    }
    if (st.over) st.result = result(st);
    return rep;
  }

  /* ---------- 결과 ---------- */

  function benchmarks(st) {
    var N = st.turns;
    var dep = CONFIG.startCash;
    for (var t = 1; t <= N; t++) dep *= 1 + depositRate(st, t) / 100 / 12;

    var k = KINDS['gn-apt'];
    var price = k.base, jeonse = k.base * k.jeonseRatio;
    var cash = CONFIG.startCash - (price - jeonse) - price * (0.01 + CONFIG.buyFee);
    for (t = 1; t <= N; t++) {
      if (cash > 0) cash *= 1 + depositRate(st, t) / 100 / 12;
      if (t % CONFIG.leaseMonths === 0) {
        var mkt = k.base * k.jeonseRatio * S(st, 'gnJ', t) / S(st, 'gnJ', 0);
        var nd = mkt >= jeonse ? Math.min(jeonse * 1.05, mkt) : mkt;
        cash += nd - jeonse;
        jeonse = nd;
      }
    }
    var hold = price * S(st, 'gnApt', N) / S(st, 'gnApt', 0) - jeonse + cash;
    return { deposit: money(dep), gangnamHold: money(hold) };
  }

  function grade(mult, bankrupt) {
    if (bankrupt) return '파산';
    if (mult >= 3) return 'S';
    if (mult >= 2) return 'A';
    if (mult >= 1.5) return 'B';
    if (mult >= 1.2) return 'C';
    if (mult >= 1.0) return 'D';
    return 'F';
  }

  function result(st) {
    var net = st.bankrupt ? Math.min(0, st.cash) : netWorth(st);
    var from = ym(st.startIdx), to = ym(st.startIdx + st.turns);
    // 게임 기간과 3개월 이상 겹치는 시기만 보여준다
    var eras = ERAS.filter(function (e) {
      var a = Math.max(monthNo(e[0]), st.startIdx), z = Math.min(monthNo(e[1]), st.startIdx + st.turns);
      return z - a >= 2;
    }).map(function (e) { return e[2]; });
    var b = benchmarks(st);
    return {
      net: net,
      mult: net / CONFIG.startCash,
      grade: grade(net / CONFIG.startCash, st.bankrupt),
      from: from, to: to, eras: eras,
      benchmarks: b,
      gnChange: S(st, 'gnApt', st.turns) / 100 - 1,
      gbChange: S(st, 'gbApt', st.turns) / 100 - 1
    };
  }

  /* ---------- 내보내기 ---------- */

  var Engine = {
    CONFIG: CONFIG, KINDS: KINDS, KIND_ORDER: KIND_ORDER, REGION_LABEL: REGION_LABEL, TYPE_LABEL: TYPE_LABEL,
    SALE_ASKS: SALE_ASKS, LEASE_ASKS: LEASE_ASKS, ERAS: ERAS, DATA: DATA,
    newGame: newGame, advance: advance, resolveEvent: resolveEvent,
    buyQuote: buyQuote, buy: buy, setSeeking: setSeeking, setSelling: setSelling,
    borrow: borrow, repay: repay, maxBorrow: maxBorrow,
    value: value, jeonseValue: jeonseValue, equity: equity, deposit: deposit,
    netWorth: netWorth, totals: totals, market: market, S: S,
    gameRate: gameRate, depositRate: depositRate, ltv: ltv,
    pSale: pSale, pTenant: pTenant, leaseTerms: leaseTerms, saleEstimate: saleEstimate,
    acqTaxRate: acqTaxRate, result: result, propName: propName, listingName: listingName, preview: preview,
    saleAsk: saleAsk, leaseAsk: leaseAsk, findProp: findProp,
    fmt: fmt, pct: pct, ym: ym
  };

  root.Engine = Engine;
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
