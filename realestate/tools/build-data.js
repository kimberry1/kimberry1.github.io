#!/usr/bin/env node
/*
 * 시세 데이터 생성기 (근사치)
 *
 * 서울 아파트 매매·전세 연간 변동률과 가계대출 금리 추이를 공개 통계(KB 주택가격동향,
 * 한국은행)의 대략적인 흐름에 맞춰 손으로 옮긴 표를 월별 지수로 펼친다.
 * 정확한 공식 수치가 아니다. 실제 월별 데이터를 구하면 data.js를 같은 형식으로
 * 교체하면 된다 (각 배열 = 1986-01부터 월별 값).
 *
 * 실행: node realestate/tools/build-data.js
 */
const fs = require('fs');
const path = require('path');

// [연도, 강남 아파트 %, 강북 아파트 %, 서울 아파트 전세 %]
const ANNUAL = [
  [1986, 0.0, -1.0, 5],
  [1987, 8.0, 6.0, 15],
  [1988, 20.0, 16.0, 13],
  [1989, 19.0, 17.0, 20],
  [1990, 38.0, 36.0, 20],
  [1991, -5.0, -4.0, 2],
  [1992, -5.0, -4.0, 8],
  [1993, -3.0, -2.5, 3],
  [1994, -0.5, -0.5, 8],
  [1995, 0.0, -0.4, 6],
  [1996, 2.5, 1.5, 8],
  [1997, 4.5, 3.5, 0],
  [1998, -16.0, -13.0, -22],
  [1999, 15.0, 10.0, 27],
  [2000, 4.0, 2.0, 14],
  [2001, 23.0, 15.0, 20],
  [2002, 35.0, 25.0, 10],
  [2003, 13.0, 7.0, -3],
  [2004, 0.0, -1.0, -6],
  [2005, 13.0, 4.5, 6],
  [2006, 27.0, 21.0, 8],
  [2007, 0.5, 7.0, 2],
  [2008, -2.0, 9.0, -1],
  [2009, 4.5, 0.5, 8],
  [2010, -2.0, -2.0, 7],
  [2011, -1.0, 0.0, 13],
  [2012, -5.0, -4.0, 2],
  [2013, -1.5, -1.5, 9],
  [2014, 1.5, 0.5, 5],
  [2015, 5.5, 5.5, 10],
  [2016, 4.5, 3.5, 5],
  [2017, 6.0, 4.0, 3],
  [2018, 16.0, 11.0, 0],
  [2019, 4.0, 2.0, -1],
  [2020, 12.0, 13.0, 11],
  [2021, 15.0, 17.0, 10],
  [2022, -6.0, -8.0, -10],
  [2023, -2.5, -3.5, -6],
  [2024, 6.0, 2.0, 4],
  [2025, 12.0, 4.0, 3],
];

// 위기 국면처럼 연중 흐름이 뚜렷한 해는 분기별 변동률(%)로 덮어쓴다.
const QUARTERLY = {
  gnApt: {
    1997: [2, 2, 1.5, -1], 1998: [-7, -7, -3, 0.5],
    2008: [1, 0.5, -0.5, -3], 2022: [1, 0, -2, -5],
  },
  gbApt: {
    1997: [1.5, 1.5, 1.5, -1], 1998: [-6, -6, -2, 0.5],
    2008: [4, 4, 1.5, -0.5], 2022: [0.5, -0.5, -2.5, -5.5],
  },
  jeonse: {
    1997: [2, 1, 0, -3], 1998: [-12, -8, -3, 0],
    2008: [1, 0.5, 0, -2.5], 2022: [0, 0, -3, -7],
  },
};

// 가계대출 금리(연 %) 기준점. 사이 월은 선형 보간.
const RATE_POINTS = [
  ['1986-01', 12.0], ['1990-01', 12.5], ['1991-06', 13.0], ['1993-06', 11.0],
  ['1996-01', 11.5], ['1997-10', 12.0], ['1997-12', 17.0], ['1998-02', 19.5],
  ['1998-06', 16.0], ['1998-12', 11.0], ['1999-06', 9.5], ['2000-06', 9.0],
  ['2001-06', 8.0], ['2002-06', 6.8], ['2003-06', 6.3], ['2004-06', 5.8],
  ['2005-06', 5.5], ['2006-06', 5.8], ['2007-06', 6.3], ['2008-06', 7.0],
  ['2008-11', 7.6], ['2009-03', 5.6], ['2010-06', 5.2], ['2011-06', 5.4],
  ['2012-06', 5.0], ['2013-06', 4.2], ['2014-06', 3.8], ['2015-06', 3.2],
  ['2016-06', 2.9], ['2017-06', 3.3], ['2018-06', 3.6], ['2019-06', 3.2],
  ['2020-06', 2.6], ['2021-06', 2.8], ['2022-01', 3.6], ['2022-12', 5.6],
  ['2023-06', 5.0], ['2024-06', 4.3], ['2025-06', 4.1], ['2025-12', 4.0],
];

const START_YEAR = ANNUAL[0][0];
const MONTHS = ANNUAL.length * 12;

function monthlyChanges(col, key) {
  const out = [];
  for (const row of ANNUAL) {
    const year = row[0];
    const quarters = (QUARTERLY[key] && QUARTERLY[key][year]) ||
      Array(4).fill((Math.pow(1 + row[col] / 100, 1 / 4) - 1) * 100);
    for (const q of quarters) {
      const m = Math.pow(1 + q / 100, 1 / 3) - 1;
      out.push(m, m, m);
    }
  }
  return out;
}

function toIndex(changes) {
  const idx = [100];
  for (let i = 1; i < changes.length; i++) idx.push(idx[i - 1] * (1 + changes[i]));
  return idx.map((v) => Math.round(v * 1000) / 1000);
}

function monthNo(ym) {
  const [y, m] = ym.split('-').map(Number);
  return (y - START_YEAR) * 12 + (m - 1);
}

function rateSeries() {
  const pts = RATE_POINTS.map(([ym, v]) => [monthNo(ym), v]);
  const out = [];
  for (let i = 0; i < MONTHS; i++) {
    let v = pts[pts.length - 1][1];
    for (let k = 0; k < pts.length - 1; k++) {
      const [a, va] = pts[k];
      const [b, vb] = pts[k + 1];
      if (i <= a) { v = va; break; }
      if (i <= b) { v = va + (vb - va) * (i - a) / (b - a); break; }
    }
    out.push(Math.round(v * 100) / 100);
  }
  return out;
}

const jeonse = toIndex(monthlyChanges(3, 'jeonse'));
const data = {
  approx: true,
  source: 'KB 주택가격동향·한국은행 금리 흐름을 연 단위로 근사한 값 (공식 통계 아님)',
  start: `${START_YEAR}-01`,
  months: MONTHS,
  gnApt: toIndex(monthlyChanges(1, 'gnApt')),
  gbApt: toIndex(monthlyChanges(2, 'gbApt')),
  gnJeonse: jeonse,
  gbJeonse: jeonse,
  rate: rateSeries(),
};

const body = `/* 자동 생성 파일: tools/build-data.js 로 다시 만든다. 직접 수정하지 말 것. */
(function (root) {
  var MARKET_DATA = ${JSON.stringify(data)};
  root.MARKET_DATA = MARKET_DATA;
  if (typeof module !== 'undefined' && module.exports) module.exports = MARKET_DATA;
})(typeof window !== 'undefined' ? window : globalThis);
`;

fs.writeFileSync(path.join(__dirname, '..', 'data.js'), body);
console.log(`data.js: ${MONTHS} months (${data.start} ~ ${START_YEAR + ANNUAL.length - 1}-12)`);
