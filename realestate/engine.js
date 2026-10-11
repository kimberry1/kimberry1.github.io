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
    startCash: 10e8,
    turns: 120,
    history: 3,            // 시작 전 추세 계산용 개월 수
    baseRate: 4.0,         // 시작 금리 고정 (실제 금리는 변동 폭만 반영)
    minRate: 1.5,
    ltvByHouse: [0.6, 0.4, 0.3], // 몇 번째 집이냐에 따른 LTV: 무주택 60%, 1주택자 40%, 2주택 이상 30%
    loanCap: 6e8,                // 주택담보대출 1건당 최대 한도
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
    listingCount: 6,
    maxEventsPerTurn: 3,
    troubleRate: 1.0,      // 골칫거리 이벤트 빈도 배수 (아래 확률은 연간 발생률을 월로 나눈 현실 기준치)
    marketEventChance: 0.25, // 매달 시장 전체 사건이 일어날 확률
    evictAfter: 3          // 월세가 이 개월 수만큼 밀리면 명도소송 여부를 묻는다
  };

  var KINDS = {
    // base: 동네 계수 1.0 기준 시작 시세 (아파트 전용 84㎡ 준신축, 빌라 52㎡ 구축)
    'gn-apt':   { region: 'gn', type: 'apt',   label: '강남 아파트', base: 15e8,  jeonseRatio: 0.45, sale: 1.0,  tenant: 1.0, rentDefault: 0.004, repair: 1.0 },
    'gb-apt':   { region: 'gb', type: 'apt',   label: '강북 아파트', base: 9e8,   jeonseRatio: 0.55, sale: 1.0,  tenant: 1.0, rentDefault: 0.004, repair: 1.0 },
    'gn-villa': { region: 'gn', type: 'villa', label: '강남 빌라',   base: 4.5e8, jeonseRatio: 0.72, sale: 0.55, tenant: 0.8, rentDefault: 0.009, repair: 1.3 },
    'gb-villa': { region: 'gb', type: 'villa', label: '강북 빌라',   base: 3e8,   jeonseRatio: 0.78, sale: 0.55, tenant: 0.8, rentDefault: 0.009, repair: 1.3 }
  };
  var KIND_ORDER = ['gn-apt', 'gb-apt', 'gn-villa', 'gb-villa'];
  var REGION_LABEL = { gn: '강남', gb: '강북' };
  var TYPE_LABEL = { apt: '아파트', villa: '빌라' };

  // 동네 계수 f: 아파트 시세 배수. 빌라는 격차를 절반만, 전세는 70%만 반영한다 (비싼 동네일수록 전세가율이 낮다).
  var DONGS = {
    gn: [
      { name: '서초구 반포동', f: 2.2 }, { name: '강남구 대치동', f: 1.8 }, { name: '강남구 개포동', f: 1.75 },
      { name: '송파구 잠실동', f: 1.6 }, { name: '영등포구 여의도동', f: 1.4 }, { name: '서초구 방배동', f: 1.3 },
      { name: '양천구 목동', f: 1.2 }, { name: '송파구 가락동', f: 1.0 }, { name: '강동구 명일동', f: 0.9 },
      { name: '동작구 사당동', f: 0.75 }, { name: '관악구 봉천동', f: 0.6 }, { name: '강서구 화곡동', f: 0.55 }
    ],
    gb: [
      { name: '용산구 이촌동', f: 2.2 }, { name: '마포구 아현동', f: 1.75 }, { name: '성동구 금호동', f: 1.6 },
      { name: '광진구 자양동', f: 1.3 }, { name: '성북구 길음동', f: 1.0 }, { name: '은평구 불광동', f: 0.9 },
      { name: '노원구 중계동', f: 0.85 }, { name: '도봉구 창동', f: 0.85 }, { name: '강북구 미아동', f: 0.85 },
      { name: '노원구 상계동', f: 0.75 }, { name: '중랑구 면목동', f: 0.75 }, { name: '도봉구 쌍문동', f: 0.65 }
    ]
  };
  function dongPriceF(type, d) { return type === 'apt' ? d.f : 1 + (d.f - 1) * 0.5; }
  function dongJeonseF(type, d) { return 1 + (dongPriceF(type, d) - 1) * 0.7; }
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

  // 금리 추세(앞뒤 30개월 이동평균). 게임 금리에는 추세에서 벗어난 폭(충격)만 반영해
  // 고금리 시대(1990년대)에 시작했다고 10년 내내 1%대가 되는 왜곡을 막는다.
  var RATE_GAP = (function () {
    var r = DATA.rate, w = 30, out = [];
    for (var i = 0; i < r.length; i++) {
      var a = Math.max(0, i - w), b = Math.min(r.length - 1, i + w), sum = 0;
      for (var j = a; j <= b; j++) sum += r[j];
      out.push(r[i] - sum / (b - a + 1));
    }
    return out;
  })();

  function gameRate(st, t) {
    var r = st.series.rate;
    var H = CONFIG.history;
    // 시작 시점의 충격(r[H])은 1년 시정수로 서서히 걷어낸다: 시작 금리는 늘 4%, 이후엔 추세 대비 충격만 남는다
    var v = CONFIG.baseRate + r[t + H] - r[H] * Math.exp(-t / 12);
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
  // nth번째 집을 살 때(또는 nth채를 가진 상태에서 추가 대출할 때)의 LTV. 규제·완화 사건은 배수로 작용한다.
  function ltvFor(st, nth) {
    var base = CONFIG.ltvByHouse[Math.min(Math.max(nth, 1), CONFIG.ltvByHouse.length) - 1];
    var mult = activeMods(st).reduce(function (a, m) { return m.name === 'ltv' ? a * m.mult : a; }, 1);
    return Math.min(0.8, Math.round(base * mult * 100) / 100);
  }
  function ltv(st) { return ltvFor(st, st.props.length + 1); } // 다음에 살 집 기준
  function loanLimit(st, price, nth) { return Math.min(CONFIG.loanCap, down(price * ltvFor(st, nth), 1e6)); }

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
    var t = { value: 0, loan: 0, deposit: 0, rent: 0, rentLost: 0, interest: 0, vacancy: 0, vacant: 0 };
    var rate = gameRate(st, st.turn);
    st.props.forEach(function (p) {
      var v = value(st, p);
      t.value += v;
      t.loan += p.loan;
      t.deposit += deposit(p);
      if (p.lease && p.lease.kind === 'wolse') {
        if (p.defaultLeft > 0) t.rentLost += p.lease.rent; else t.rent += p.lease.rent;
      }
      if (!p.lease) { t.vacancy += v * CONFIG.vacancyCost; t.vacant += 1; }
    });
    t.interest = t.loan * rate / 100 / 12;
    t.flow = t.rent - t.interest - t.vacancy;              // 다음 달 예상 현금흐름 (예금 이자 제외)
    t.net = st.cash + t.value - t.loan - t.deposit;
    t.holdingYear = st.props.length ? holdingTax(st) : 0;
    t.debtRatio = t.value ? (t.loan + t.deposit) / t.value : 0;
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
    var conv = (gameRate(st, st.turn) + 1.5) / 100; // 전월세 전환율 = 대출 금리 + 1.5%p
    return { kind: kind, deposit: dep, rent: money((j - dep) * conv / 12 * a.f) };
  }

  function pTenant(st, p, kind, askId) {
    var k = KINDS[p.kind];
    var m = clamp(1 + 14 * chg(st, jKey(p), st.turn, 3), 0.25, 1.6);
    var base = kind === 'jeonse' ? 0.4 : 0.33;
    var pr = base * k.tenant * m * leaseAsk(askId).p * modMult(st, 'tenant', p.region, p.type);
    if (kind === 'jeonse' && !p.lease) {
      var remain = p.loan - leaseTerms(st, p, kind, askId).deposit;
      if (remain > value(st, p) * 0.1) pr *= 0.5; // 근저당이 많이 남는 집은 전세 세입자가 꺼린다
    }
    return clamp(pr, 0.03, 0.92);
  }

  /* ---------- 세금 ---------- */

  // 취득세: 2주택까지는 가격 구간(6억 이하 1% · 9억 이하 2% · 초과 3%), 3주택 8%, 4주택 이상 12%
  function acqTaxRate(count, price) {
    if (count >= 4) return 0.12;
    if (count === 3) return 0.08;
    if (price <= 6e8) return 0.01;
    if (price <= 9e8) return 0.02;
    return 0.03;
  }

  // 보유세(재산세 + 종부세) 연간: 시세 0.15% + 종부세 기준 초과분 (1주택 18억 초과 0.6%, 다주택 13억 초과 1.5%)
  function holdingTax(st) {
    var total = st.props.reduce(function (a, p) { return a + value(st, p); }, 0);
    var multi = st.props.length >= 2;
    return money(total * 0.0015 + Math.max(0, total - (multi ? 13e8 : 18e8)) * (multi ? 0.015 : 0.006));
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
    if (st.props.length === 1 && held >= 24) {
      if (salePrice <= 12e8) return { tax: 0, label: '1주택 2년 보유 비과세', gain: gain };
      // 고가주택: 12억 초과분 비율만큼만 과세, 장기보유특별공제 연 8% (최대 80%)
      var yrs = Math.floor(held / 12);
      var ded1 = Math.min(0.8, yrs >= 3 ? yrs * 0.08 : 0);
      var taxable = gain * (salePrice - 12e8) / salePrice * (1 - ded1);
      return { tax: money(progressive(taxable)), label: '1주택 12억 초과분 과세' + (ded1 ? ' (장기보유공제 ' + Math.round(ded1 * 100) + '%)' : ''), gain: gain };
    }
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

  function estPrice(st, kind, dong, size, age) {
    var k = KINDS[kind];
    var pk = k.region + (k.type === 'apt' ? 'Apt' : 'Villa');
    return k.base * S(st, pk, st.turn) / S(st, pk, 0) * dongPriceF(k.type, dong) * size.f * age.f;
  }

  function makeListing(st, kind, tag, dong, size, age) {
    var k = KINDS[kind];
    var t = st.turn;
    dong = dong || pick(st, DONGS[k.region]);
    size = size || pick(st, SIZES[k.type]);
    age = age || pick(st, AGES[k.type]);
    var fair = money(estPrice(st, kind, dong, size, age) * uni(st, 0.95, 1.05));
    // 규제·사건 효과(modMult)는 jeonseValue에서 적용하므로 여기서는 원래 시세만 저장한다
    var jeonse = money(k.base * k.jeonseRatio * S(st, k.region + 'J', t) / S(st, k.region + 'J', 0) *
      dongJeonseF(k.type, dong) * size.f * age.jf * uni(st, 0.96, 1.04));
    var disc = tag === '급매' ? uni(st, 0.85, 0.9) : tag === '경매' ? uni(st, 0.75, 0.85) : 1;
    return {
      id: 'L' + (st.nextId++),
      kind: kind, region: k.region, type: k.type,
      dong: dong.name,
      m2: size.m2, py: size.py, age: age.label,
      fair: fair, price: money(fair * disc), jeonse: Math.min(jeonse, money(fair * 0.92)),
      tag: tag || null,
      redevHope: !!age.redev, rebuildHope: !!age.rebuild
    };
  }

  // 대출을 한도까지 받았을 때 매수에 필요한 최소 현금
  function minCash(st, price) {
    return price + money(price * acqTaxRate(st.props.length + 1, price)) + money(price * CONFIG.buyFee) - loanLimit(st, price, st.props.length + 1);
  }
  function affordable(st, l) { return minCash(st, l.price) <= st.cash; }

  function shuffle(st, arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rand(st) * (i + 1));
      var x = arr[i]; arr[i] = arr[j]; arr[j] = x;
    }
    return arr;
  }

  // 지금 현금으로 살 수 있는 동네·평형·연식 조합 중 하나로 매물을 만든다. 없으면 null.
  function makeAffordable(st, kind, tag) {
    var k = KINDS[kind];
    var disc = tag === '급매' ? 0.9 : tag === '경매' ? 0.85 : 1;
    var combos = [];
    DONGS[k.region].forEach(function (dong) {
      SIZES[k.type].forEach(function (size) {
        AGES[k.type].forEach(function (age) {
          if (minCash(st, estPrice(st, kind, dong, size, age) * 0.95 * disc) <= st.cash) combos.push([dong, size, age]);
        });
      });
    });
    shuffle(st, combos);
    for (var i = 0; i < combos.length && i < 12; i++) {
      var l = makeListing(st, kind, tag, combos[i][0], combos[i][1], combos[i][2]);
      if (affordable(st, l)) return l;
    }
    return null;
  }

  // 가장 싼 조합 기준 최소 필요 현금 (살 수 있는 매물이 없을 때 안내용)
  function cheapestNeed(st) {
    var best = Infinity;
    KIND_ORDER.forEach(function (kind) {
      var k = KINDS[kind];
      var pk = k.region + (k.type === 'apt' ? 'Apt' : 'Villa');
      var f = Math.min.apply(null, SIZES[k.type].map(function (x) { return x.f; })) *
        Math.min.apply(null, AGES[k.type].map(function (x) { return x.f; })) *
        Math.min.apply(null, DONGS[k.region].map(function (d) { return dongPriceF(k.type, d); })) * 0.95;
      best = Math.min(best, minCash(st, money(k.base * S(st, pk, st.turn) / S(st, pk, 0) * f)));
    });
    return best;
  }

  // 일반 매물을 '지금 살 수 있는 것'으로 맞춘다: 못 사는 건 빼고, 종류별로 하나씩 우선 채운 뒤 남는 자리를 채운다.
  function syncListings(st) {
    var regular = st.listings.filter(function (l) { return !l.tag && affordable(st, l); });
    var specials = st.listings.filter(function (l) { return l.tag && l.until >= st.turn; });
    if (!st.over) {
      var open = [];
      KIND_ORDER.forEach(function (kind) {
        if (regular.length >= CONFIG.listingCount) return;
        if (regular.some(function (l) { return l.kind === kind; })) { open.push(kind); return; }
        var l = makeAffordable(st, kind);
        if (l) { regular.push(l); open.push(kind); }
      });
      for (var guard = 0; open.length && regular.length < CONFIG.listingCount && guard < 8; guard++) {
        var extra = makeAffordable(st, pick(st, open));
        if (extra) regular.push(extra);
      }
      regular.sort(function (a, b) { return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind); });
    }
    st.listings = regular.concat(specials);
  }

  function refreshListings(st) {
    st.listings = st.listings.filter(function (l) { return l.tag; });
    syncListings(st);
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
      version: 6,
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
    st.report = { t: 0, ledger: [], items: [{ text: '종잣돈 ' + fmt(CONFIG.startCash) + '으로 시작합니다. 몇 년도인지는 게임이 끝나야 공개됩니다.', tone: 'info' }] };
    recordHist(st);
    return st;
  }

  function buildSeries(st) {
    var H = CONFIG.history, N = CONFIG.turns, s0 = st.startIdx;
    var keys = ['gnApt', 'gbApt', 'gnVilla', 'gbVilla', 'gnJ', 'gbJ'];
    var s = { rate: [] };
    keys.forEach(function (k) { s[k] = [100]; });
    for (var k = 0; k <= H + N; k++) {
      var di = s0 - H + k;
      s.rate.push(Math.round(RATE_GAP[di] * 100) / 100);
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

  function addRow(rows, label, amount) {
    if (!amount) return;
    var row = rows.filter(function (r) { return r.label === label; })[0];
    if (row) row.amount += amount; else rows.push({ label: label, amount: amount });
  }
  // 손익: 순자산을 실제로 늘리거나 줄이는 돈
  function ledger(rep, label, amount) { addRow(rep.ledger, label, amount); }
  // 현금 이동: 현금은 움직이지만 순자산은 그대로인 돈 (보증금, 대출, 매매 대금)
  function flow(rep, label, amount) {
    if (!rep.flows) rep.flows = [];
    addRow(rep.flows, label, amount);
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
    var taxRate = acqTaxRate(count, l.price);
    var tax = money(l.price * taxRate);
    var fee = money(l.price * CONFIG.buyFee);
    var loanMax = loanLimit(st, l.price, count);
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
      redevHope: l.redevHope, rebuildHope: l.rebuildHope, projStage: 0, projDead: false,
      defaultLeft: 0, unpaid: 0, missed: 0, evicting: false, noRenew: false
    };
    st.cash -= q.need;
    flow(st.report, '매수 대금 (대출 제외)', -(l.price - q.loan));
    ledger(st.report, '취득세', -q.tax);
    ledger(st.report, '매수 중개수수료', -q.fee);
    st.props.push(p);
    st.listings = st.listings.filter(function (x) { return x.id !== l.id; });
    var rep = st.report;
    note(st, rep, propName(p) + ' 매수 ' + fmt(l.price) + (q.loan ? ' (대출 ' + fmt(q.loan) + ')' : '') +
      ' · 취득세 ' + fmt(q.tax), 'info');
    if (l.tag === '경매' && rand(st) < 0.3) {
      var extra = money(l.fair * uni(st, 0.03, 0.07));
      st.cash -= extra;
      ledger(rep, '경매 정리 비용', -extra);
      note(st, rep, '경매 물건에 유치권 신고가 있었습니다. 명도·정리 비용 ' + fmt(extra) + ' 지출.', 'bad', true);
    }
    if (opts.leaseKind) p.seeking = { kind: opts.leaseKind, ask: opts.ask || 'market' };
    syncListings(st);
    recordHist(st);
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
    var byLtv = value(st, p) * ltvFor(st, st.props.length) - p.loan - deposit(p);
    return down(Math.min(byLtv, CONFIG.loanCap - p.loan), 1e6);
  }

  function borrow(st, propId, amount) {
    var p = findProp(st, propId);
    if (!p) return { ok: false };
    var a = Math.min(down(amount, 1e6), maxBorrow(st, p));
    if (a <= 0) return { ok: false, msg: '추가 대출 한도가 없습니다.' };
    p.loan += a;
    st.cash += a;
    flow(st.report, '추가 대출', a);
    note(st, st.report, propName(p) + ' 담보 추가 대출 ' + fmt(a), 'info');
    syncListings(st);
    recordHist(st);
    return { ok: true, amount: a };
  }

  function repay(st, propId, amount) {
    var p = findProp(st, propId);
    if (!p) return { ok: false };
    var a = Math.min(money(amount), p.loan, Math.max(0, st.cash));
    if (a <= 0) return { ok: false, msg: '상환할 현금이 없습니다.' };
    p.loan -= a;
    st.cash -= a;
    flow(st.report, '대출 상환', -a);
    note(st, st.report, propName(p) + ' 대출 상환 ' + fmt(a), 'info');
    syncListings(st);
    recordHist(st);
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
    flow(rep, '보증금 받음 (나중에 돌려줄 돈)', terms.deposit);
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
        flow(rep, '보증금으로 대출 상환', -r);
        text += ' · 보증금으로 대출 ' + fmt(r) + ' 상환';
        if (terms.deposit > r) text += ' · 남은 ' + fmt(terms.deposit - r) + '은 현금으로 (만기에 돌려줄 돈)';
      }
    }
    note(st, rep, text, 'good', true);
  }

  function endLeaseMoveOut(st, rep, p) {
    var back = Math.max(0, p.lease.deposit - p.unpaid);
    st.cash -= back;
    flow(rep, '보증금 반환', -back);
    note(st, rep, propName(p) + ' 세입자 퇴거: 보증금 ' + fmt(back) + ' 반환' +
      (p.unpaid ? ' (밀린 월세 ' + fmt(p.unpaid) + ' 공제)' : ''), back > 0 ? 'bad' : 'info', true);
    var kind = p.lease.kind;
    p.lease = null;
    p.nextLease = null;
    p.evicting = false;
    p.missed = 0;
    p.unpaid = 0;
    p.defaultLeft = 0;
    p.noRenew = false;
    if (!p.seeking) p.seeking = { kind: kind, ask: 'market' };
    if (rand(st) < 0.25) {
      var cost = money(p.m2 * uni(st, 0.5e4, 2.5e4) * KINDS[p.kind].repair); // 도배·청소 등 84㎡ 기준 40~210만
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
        var pr = p.noRenew ? 0 : 0.45;
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
          flow(rep, diff >= 0 ? '전세 보증금 증액분 받음' : '역전세 차액 반환', diff);
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
        var delta = n.deposit - Math.max(0, L.deposit - p.unpaid);
        st.cash += delta;
        flow(rep, '세입자 교체 보증금 차액', delta);
        p.lease = { kind: n.kind, deposit: n.deposit, rent: n.rent, start: t, end: t + CONFIG.leaseMonths, renew: null };
        p.nextLease = null;
        p.unpaid = 0;
        p.defaultLeft = 0;
        p.missed = 0;
        p.evicting = false;
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
      flow(rep, '매도 대금 (대출·보증금 정리 후)', e.price - e.loan - e.deposit);
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
    var debts = target.loan + deposit(target);
    var net = sellProp(st, target, price, fee, 0);
    flow(rep, '경매 낙찰 대금 (대출·보증금 정리 후)', price - debts);
    ledger(rep, '경매 비용', -fee);
    note(st, rep, '경매 진행: ' + propName(target) + '이(가) 시세의 70%인 ' + fmt(price) + '에 낙찰됐습니다. 대출·보증금 정리 후 ' +
      fmt(net, { plus: true }), 'bad', true);
    return true;
  }

  function addMod(st, m) { st.mods.push(m); }

  /* ---------- 이벤트 ---------- */

  // 정비사업 단계. p: 다음 단계로 갈 월 확률, up: 시세 배수, fail: 그 단계를 기다리는 동안 무산될 월 확률
  var REDEV_STAGES = [
    { name: '재개발 후보지 선정', p: 0.0005, up: [1.05, 1.08] },
    { name: '재개발 정비구역 지정', p: 0.012, up: [1.06, 1.10], fail: 0.006, failMult: 0.9, failText: '주민 동의율을 못 채워 후보지에서 철회됐습니다' },
    { name: '재개발 조합설립인가', p: 0.008, up: [1.04, 1.07], fail: 0.002, failMult: 0.88, failText: '조합 내분으로 정비구역이 해제됐습니다' }
  ];
  var REBUILD_STAGES = [
    { name: '재건축 안전진단 통과', p: 0.001, up: [1.04, 1.07] },
    { name: '재건축 정비구역 지정', p: 0.012, up: [1.04, 1.07], fail: 0.004, failMult: 0.93, failText: '정비계획이 반려돼 사업이 원점으로 돌아갔습니다' },
    { name: '재건축 관리처분인가', p: 0.008, up: [1.05, 1.08], fail: 0.002, failMult: 0.92, failText: '공사비 갈등으로 사업이 멈췄습니다', levy: true }
  ];
  function projectStages(p) {
    if (p.type === 'villa') return REDEV_STAGES;
    return p.rebuildHope ? REBUILD_STAGES : null; // 구축 아파트만 재건축 대상
  }
  // 지금 단계 이름 (화면 표시용). 진행 전이면 null
  function projectLabel(p) {
    if (p.projDead) return { text: (p.type === 'villa' ? '재개발' : '재건축') + ' 무산', tone: 'bad' };
    var stages = projectStages(p);
    if (!stages || !p.projStage) return null;
    return { text: stages[p.projStage - 1].name, tone: 'good' };
  }

  var EVICT_COST = 5e6;
  var LAWSUIT_COST = 3e6;

  var PROP_EVENTS = {
    boiler: {
      chance: function (st, p) { return 0.012 * CONFIG.troubleRate; }, // 연 14%
      make: function (st, p) {
        var replace = rand(st) < 0.4;
        var cost = money(replace ? uni(st, 80e4, 150e4) : uni(st, 15e4, 50e4));
        return {
          title: replace ? '보일러 교체' : '보일러 고장',
          body: propName(p) + (p.lease ? ' 세입자가 ' : ' 빈집 점검 중 ') + (replace
            ? '보일러가 아예 작동하지 않는다고 합니다. 연식이 오래돼 교체해야 하고 견적은 '
            : '보일러에서 온수가 안 나온다고 합니다. 부품 교체 견적은 ') + fmt(cost) + '입니다.',
          data: { cost: cost },
          choices: [
            { id: 'fix', label: '바로 고친다', hint: fmt(cost) + ' 지출' },
            { id: 'delay', label: '미룬다', hint: p.lease ? '세입자가 재계약을 거부하고, 결국 비용은 1.5배로 나갑니다' : '나중에 1.5배로 고칩니다' }
          ]
        };
      },
      resolve: function (st, ev, choice, rep, p) {
        var cost = choice === 'fix' ? ev.data.cost : money(ev.data.cost * 1.5);
        st.cash -= cost;
        ledger(rep, '수리비', -cost);
        if (choice === 'fix') {
          note(st, rep, propName(p) + ' 보일러 수리 완료 (' + fmt(cost) + ')', 'info');
        } else {
          if (p.lease) p.noRenew = true;
          note(st, rep, propName(p) + ': 수리를 미루다 세입자가 직접 고치고 비용 ' + fmt(cost) + '을 청구했습니다.' + (p.lease ? ' 만기에 나가겠다고 합니다.' : ''), 'bad', true);
        }
      }
    },
    leak: {
      chance: function (st, p) { return 0.0035 * KINDS[p.kind].repair * CONFIG.troubleRate; }, // 아파트 연 4%, 빌라 연 5.4%
      make: function (st, p) {
        var cost = money(uni(st, 50e4, 200e4));
        return {
          title: '누수',
          body: propName(p) + (p.lease ? '에서 세입자가 욕실 천장에 물이 샌다고 알려왔습니다.' : '을 점검하다 욕실 배관 누수를 발견했습니다.') +
            ' 배관 수리 견적은 ' + fmt(cost) + '입니다.',
          data: { cost: cost },
          choices: [
            { id: 'fix', label: '바로 수리한다', hint: fmt(cost) + ' 지출' },
            { id: 'delay', label: '미룬다', hint: '절반 확률로 아랫집까지 번져 배상금 200~600만이 추가됩니다' }
          ]
        };
      },
      resolve: function (st, ev, choice, rep, p) {
        var cost = ev.data.cost;
        if (choice === 'fix') {
          st.cash -= cost;
          ledger(rep, '수리비', -cost);
          note(st, rep, propName(p) + ' 누수 수리 완료 (' + fmt(cost) + ')', 'info');
        } else if (rand(st) < 0.5) {
          st.cash -= cost;
          ledger(rep, '수리비', -cost);
          note(st, rep, propName(p) + ': 피해가 번지기 전에 고쳤습니다 (' + fmt(cost) + ').', 'info');
        } else {
          var comp = money(uni(st, 200e4, 600e4));
          st.cash -= cost + comp;
          ledger(rep, '수리비', -cost);
          ledger(rep, '아랫집 배상', -comp);
          if (p.lease) p.noRenew = true;
          note(st, rep, propName(p) + ': 아랫집까지 물이 샜습니다. 수리 ' + fmt(cost) + ' + 배상 ' + fmt(comp) + (p.lease ? ', 세입자는 재계약하지 않겠다고 합니다.' : ''), 'bad', true);
        }
      }
    },
    rentDefault: {
      chance: function (st, p) {
        return p.lease && p.lease.kind === 'wolse' && !p.defaultLeft && p.lease.end - st.turn > 1 ? KINDS[p.kind].rentDefault * CONFIG.troubleRate : 0;
      },
      auto: function (st, p, rep) {
        var r = rand(st);
        p.defaultLeft = r < 0.55 ? 2 : r < 0.85 ? 5 : 999; // 999: 소송 전까지 계속 안 낸다
        p.missed = 0;
        note(st, rep, propName(p) + ' 월세 미납: 세입자가 다음 달부터 월세 ' + fmt(p.lease.rent) + '를 못 내겠다고 합니다. ' +
          CONFIG.evictAfter + '개월 넘게 밀리면 명도소송을 검토하게 됩니다.', 'warn', true);
      }
    },
    eviction: {
      chance: function () { return 0; }, // 무작위로 일어나지 않고, 월세가 밀린 개월 수로만 뜬다
      make: function (st, p) {
        var dep = p.lease.deposit;
        return {
          title: '월세 ' + p.missed + '개월 연체 · 명도소송',
          body: propName(p) + ' 세입자가 월세를 ' + p.missed + '개월째 내지 않았습니다. 밀린 월세는 ' + fmt(p.unpaid) + ', 보증금은 ' + fmt(dep) + '입니다.' +
            (p.unpaid >= dep ? ' 이미 보증금으로도 다 못 메웁니다.' : ' 보증금에서 공제할 수 있는 여유는 ' + fmt(dep - p.unpaid) + ' 남았습니다.'),
          choices: [
            { id: 'evict', label: '명도소송을 건다', hint: '소송비 ' + fmt(EVICT_COST) + ' · 4개월 뒤 퇴거 · 그동안 월세는 못 받습니다' },
            { id: 'wait', label: '조금 더 기다린다', hint: '40% 확률로 다음 달부터 다시 냅니다. 아니면 ' + CONFIG.evictAfter + '개월 뒤 다시 묻습니다' }
          ]
        };
      },
      resolve: function (st, ev, choice, rep, p) {
        if (!p.lease || !p.defaultLeft) return;
        if (choice === 'wait') {
          if (rand(st) < 0.4) {
            p.defaultLeft = 0;
            p.missed = 0;
            note(st, rep, propName(p) + ': 세입자가 다음 달부터 다시 월세를 내기로 했습니다. 밀린 ' + fmt(p.unpaid) + '은 보증금에서 정산합니다.', 'info');
          } else {
            p.defaultLeft = Math.max(p.defaultLeft, CONFIG.evictAfter);
            note(st, rep, propName(p) + ': 일단 더 기다리기로 했습니다.', 'warn');
          }
        } else {
          var cost = EVICT_COST;
          st.cash -= cost;
          ledger(rep, '소송비', -cost);
          p.evicting = true;
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
        return p.lease && p.lease.kind === 'jeonse' && p.lease.renew === null && p.lease.end - st.turn > 4 ? 0.004 * CONFIG.troubleRate : 0; // 연 5%
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
            var cost = LAWSUIT_COST;
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
    wallpaper: {
      chance: function (st, p) { return p.lease && !p.noRenew && !p.defaultLeft ? 0.007 * CONFIG.troubleRate : 0; }, // 연 8%
      make: function (st, p) {
        var cost = money(p.m2 * uni(st, 1.5e4, 3.5e4)); // 84㎡ 기준 130~290만
        return {
          title: '세입자 도배·장판 교체 요구',
          body: propName(p) + ' 세입자가 벽지 곰팡이와 들뜬 장판을 고쳐달라고 합니다. 견적은 ' + fmt(cost) + '입니다.',
          data: { cost: cost },
          choices: [
            { id: 'fix', label: '고쳐준다', hint: fmt(cost) + ' 지출 · 재계약 가능성 유지' },
            { id: 'refuse', label: '거절한다', hint: '세입자가 만기에 나갑니다' }
          ]
        };
      },
      resolve: function (st, ev, choice, rep, p) {
        if (choice === 'fix') {
          st.cash -= ev.data.cost;
          ledger(rep, '수리비', -ev.data.cost);
          note(st, rep, propName(p) + ' 도배·장판 교체 (' + fmt(ev.data.cost) + ')', 'info');
        } else {
          p.noRenew = true;
          note(st, rep, propName(p) + ': 수리를 거절하자 세입자가 만기에 나가겠다고 합니다.', 'warn');
        }
      }
    },
    buyOffer: {
      chance: function (st, p) {
        if (st.turn - p.buyT < 6) return 0;
        var c3 = chg(st, p.region + 'Apt', st.turn, 3);
        return c3 > 0.02 ? 0.012 : c3 > 0 ? 0.006 : 0.002;
      },
      make: function (st, p) {
        var price = money(value(st, p) * uni(st, 1.04, 1.1));
        var fee = money(price * CONFIG.sellFee);
        var tax = gainsTax(st, p, price, fee);
        var net = price - fee - tax.tax - p.loan - deposit(p);
        return {
          title: '매수 제안',
          body: '중개사무소에서 ' + propName(p) + '을(를) 시세(' + fmt(value(st, p)) + ')보다 비싼 ' + fmt(price) + '에 사겠다는 손님이 있다고 연락이 왔습니다. ' +
            '양도세 ' + fmt(tax.tax) + '(' + tax.label + ')와 대출·보증금을 정리하면 손에 쥐는 돈은 ' + fmt(net) + '입니다.',
          data: { price: price, fee: fee, tax: tax.tax, label: tax.label },
          choices: [
            { id: 'accept', label: '판다', hint: '이번 달 바로 계약합니다' },
            { id: 'refuse', label: '안 판다', hint: '계속 보유합니다' }
          ]
        };
      },
      resolve: function (st, ev, choice, rep, p) {
        if (choice !== 'accept') {
          note(st, rep, propName(p) + ' 매수 제안을 거절했습니다.', 'info');
          return;
        }
        var d = ev.data;
        var debts = p.loan + deposit(p);
        var net = sellProp(st, p, d.price, d.fee, d.tax);
        flow(rep, '매도 대금 (대출·보증금 정리 후)', d.price - debts);
        ledger(rep, '매도 중개수수료', -d.fee);
        if (d.tax) ledger(rep, '양도소득세', -d.tax);
        note(st, rep, propName(p) + ' 매수 제안 수락: ' + fmt(d.price) + '에 매도 · ' + d.label + (d.tax ? ' ' + fmt(d.tax) : '') + ' · 손에 쥔 돈 ' + fmt(net), 'good', true);
      }
    },
    projectUp: {
      chance: function (st, p) {
        var stages = projectStages(p);
        if (!stages || p.projDead || p.projStage >= stages.length) return 0;
        var pr = stages[p.projStage].p;
        // 노후 빌라·구축 아파트가 아니면 첫 단계에 오를 확률이 1/5
        if (p.projStage === 0 && !p.redevHope && !p.rebuildHope) pr *= 0.2;
        return pr;
      },
      auto: function (st, p, rep) {
        var stages = projectStages(p);
        var sg = stages[p.projStage];
        var m = uni(st, sg.up[0], sg.up[1]);
        p.premium *= m;
        p.projStage += 1;
        var next = stages[p.projStage];
        note(st, rep, sg.name + ': ' + propName(p) + ' 시세 ' + pct(m - 1, 0) + '.' +
          (next ? ' 다음 단계(' + next.name + ')까지 보통 몇 년이 걸리고, 그 사이 무산될 수도 있습니다.' : ''), 'good', true);
        if (sg.levy) pushEvent(st, rep, 'levy', p);
      }
    },
    projectFail: {
      chance: function (st, p) {
        var stages = projectStages(p);
        if (!stages || p.projDead || p.projStage === 0 || p.projStage >= stages.length) return 0;
        return stages[p.projStage].fail || 0;
      },
      auto: function (st, p, rep) {
        var sg = projectStages(p)[p.projStage];
        p.premium *= sg.failMult;
        p.projDead = true;
        note(st, rep, (p.type === 'villa' ? '재개발' : '재건축') + ' 무산: ' + propName(p) + ' — ' + sg.failText + '. 시세 ' + pct(sg.failMult - 1, 0) + '.', 'bad', true);
      }
    },
    levy: {
      chance: function () { return 0; }, // 관리처분인가 단계에 올라갈 때만 뜬다
      make: function (st, p) {
        var v = value(st, p);
        var cost = money(v * uni(st, 0.1, 0.2));
        return {
          title: '재건축 추가 분담금 통보',
          body: propName(p) + ' 재건축 조합이 관리처분계획을 확정하며 추가 분담금 ' + fmt(cost) + '을 통보했습니다. 내면 새 아파트 입주권을 지키고, ' +
            '안 내면 조합에 현금청산(시세의 85%)으로 넘겨야 합니다.',
          data: { cost: cost },
          choices: [
            { id: 'pay', label: '분담금을 낸다', hint: '현금 ' + fmt(cost) + ' 지출 · 시세가 분담금의 1.15배만큼 오릅니다' },
            { id: 'cashout', label: '현금청산 받는다', hint: '시세의 85%로 조합에 넘깁니다' }
          ]
        };
      },
      resolve: function (st, ev, choice, rep, p) {
        var cost = ev.data.cost;
        if (choice === 'pay') {
          var v = value(st, p);
          st.cash -= cost;
          flow(rep, '재건축 분담금 (집값에 반영)', -cost);
          p.premium *= 1 + cost * 1.15 / v;
          note(st, rep, propName(p) + ' 분담금 ' + fmt(cost) + ' 납부. 입주권을 지켰습니다.', 'info', true);
        } else {
          var price = money(value(st, p) * 0.85);
          var tax = gainsTax(st, p, price, 0);
          var debts = p.loan + deposit(p);
          var net = sellProp(st, p, price, 0, tax.tax);
          flow(rep, '현금청산 대금 (대출·보증금 정리 후)', price - debts);
          if (tax.tax) ledger(rep, '양도소득세', -tax.tax);
          note(st, rep, propName(p) + ' 현금청산: ' + fmt(price) + ' · 손에 쥔 돈 ' + fmt(net), 'warn', true);
        }
      }
    },
    station: {
      chance: function () { return 0.0003; }, // 10년에 3.5%
      auto: function (st, p, rep) {
        p.premium *= 1.05;
        note(st, rep, '역 신설 확정: ' + propName(p) + ' 인근에 지하철역이 들어섭니다. 시세 +5%.', 'good', true);
      }
    },
    noise: {
      chance: function (st, p) { return p.lease && !p.noRenew ? 0.0035 * CONFIG.troubleRate : 0; }, // 연 4%
      auto: function (st, p, rep) {
        p.noRenew = true;
        note(st, rep, propName(p) + ': 층간소음 분쟁으로 세입자가 만기에 나가겠다고 합니다.', 'warn');
      }
    },
    fire: {
      chance: function () { return 0.00005; }, // 연 0.06% (주택 화재율 수준)
      auto: function (st, p, rep) {
        var cost = money(p.m2 * uni(st, 20e4, 50e4)); // 84㎡ 기준 1,700~4,200만
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
        addMod(st, { name: 'ltv', mult: 0.67, until: st.turn + 12, label: '대출 규제 (LTV 2/3로 축소)', tone: 'bad' });
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
        addMod(st, { name: 'ltv', mult: 1.17, until: st.turn + 12, label: '규제 완화 (LTV 1.17배)', tone: 'good' });
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
        var l = makeAffordable(st, pick(st, KIND_ORDER), '급매');
        if (!l) return;
        l.until = st.turn;
        st.listings.push(l);
        note(st, rep, '급매물 등장: ' + listingName(l) + ' ' + fmt(l.price) + ' (시세 ' + fmt(l.fair) + '). 이번 달에만 살 수 있습니다.', 'good', true);
      }
    },
    auction: {
      weight: function (st) { return chg(st, 'gnApt', st.turn, 3) < 0 ? 1.5 : 0.5; },
      run: function (st, rep) {
        var l = makeAffordable(st, pick(st, KIND_ORDER), '경매');
        if (!l) return;
        l.until = st.turn;
        st.listings.push(l);
        note(st, rep, '경매 물건: ' + listingName(l) + ' 최저가 ' + fmt(l.price) + ' (시세 ' + fmt(l.fair) + '). 권리관계에 하자가 있을 수 있습니다.', 'info', true);
      }
    }
  };

  function pushEvent(st, rep, key, p) {
    var ev = PROP_EVENTS[key].make(st, p);
    ev.key = key;
    ev.propId = p.id;
    ev.id = 'E' + (st.nextId++);
    st.pending.push(ev);
    note(st, rep, ev.title + ': ' + propName(p), 'warn', true);
  }

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
        if (e.auto) e.auto(st, p, rep);
        else pushEvent(st, rep, key, p);
        break;
      }
    }
    if (count >= CONFIG.maxEventsPerTurn || rand(st) >= CONFIG.marketEventChance) return;
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
    if (p) PROP_EVENTS[ev.key].resolve(st, ev, choiceId, st.report, p);
    syncListings(st);
    recordHist(st);
  }

  // 이번 달 상태를 기록 (같은 달에 다시 부르면 덮어쓴다: 매수·사건 처리 후에도 최신으로 유지)
  function recordHist(st) {
    var tot = totals(st);
    var rec = {
      t: st.turn, net: tot.net, cash: st.cash, value: tot.value, loan: tot.loan, deposit: tot.deposit,
      pl: (st.report && st.report.t === st.turn ? st.report.ledger : []).reduce(function (a, x) { return a + x.amount; }, 0)
    };
    var last = st.hist[st.hist.length - 1];
    if (last && last.t === st.turn) st.hist[st.hist.length - 1] = rec; else st.hist.push(rec);
  }

  /* ---------- 한 달 진행 ---------- */

  function advance(st) {
    if (st.over || st.pending.length) return null;
    var prevNet = netWorth(st);
    st.turn += 1;
    var t = st.turn;
    var rep = { t: t, ledger: [], flows: [], items: [] };
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
    var evictionDue = [];
    st.props.forEach(function (p) {
      interest += p.loan * rate / 100 / 12;
      if (p.lease && p.lease.kind === 'wolse') {
        if (p.defaultLeft > 0) {
          p.defaultLeft -= 1;
          p.unpaid += p.lease.rent;
          p.missed = (p.missed || 0) + 1;
          if (p.defaultLeft === 0 && !p.evicting) {
            p.missed = 0;
            note(st, rep, propName(p) + ': 세입자가 다시 월세를 내기 시작했습니다. 밀린 ' + fmt(p.unpaid) + '은 보증금에서 정산합니다.', 'info');
          } else if (!p.evicting && p.missed % CONFIG.evictAfter === 0) {
            evictionDue.push(p);
          }
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
      var htax = holdingTax(st);
      ledger(rep, '보유세 (재산세·종부세)', -htax);
      st.cash -= htax;
    }

    processSales(st, rep);
    processSearch(st, rep);
    processLeases(st, rep);
    evictionDue.forEach(function (p) {
      if (st.props.indexOf(p) >= 0 && p.lease && p.defaultLeft > 0) pushEvent(st, rep, 'eviction', p);
    });
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
    recordHist(st);
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
    var cash = CONFIG.startCash - (price - jeonse) - price * (acqTaxRate(1, price) + CONFIG.buyFee);
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
    // 120개월 기준: 예금만 해도 약 1.2배
    if (mult >= 3) return 'S';
    if (mult >= 2) return 'A';
    if (mult >= 1.6) return 'B';
    if (mult >= 1.3) return 'C';
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
    newGame: newGame, advance: advance, holdingTax: holdingTax, resolveEvent: resolveEvent,
    buyQuote: buyQuote, buy: buy, setSeeking: setSeeking, setSelling: setSelling,
    borrow: borrow, repay: repay, maxBorrow: maxBorrow,
    value: value, jeonseValue: jeonseValue, equity: equity, deposit: deposit,
    netWorth: netWorth, totals: totals, market: market, S: S,
    gameRate: gameRate, depositRate: depositRate, ltv: ltv, ltvFor: ltvFor, loanLimit: loanLimit,
    pSale: pSale, pTenant: pTenant, leaseTerms: leaseTerms, saleEstimate: saleEstimate,
    acqTaxRate: acqTaxRate, result: result, grade: grade, propName: propName, listingName: listingName, preview: preview,
    saleAsk: saleAsk, leaseAsk: leaseAsk, findProp: findProp, projectLabel: projectLabel,
    minCash: minCash, affordable: affordable, cheapestNeed: cheapestNeed, syncListings: syncListings,
    fmt: fmt, pct: pct, ym: ym
  };

  root.Engine = Engine;
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
