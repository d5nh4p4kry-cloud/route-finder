/*
 * verify_rank.js — ルートファインダー v7 段階5a 独立再計算器（Opus 作成、5a-4）
 *
 * 目的：アプリ（engine.rank）が表示した主ランキングを、engine を使わずに
 *       セッション内の評価記録から再計算して突き合わせる。
 * 方針（計画 v2.3 §3）：Google 由来の値（所要秒・料金）はこの関数の中でだけ使い、
 *       戻り値には合否・理由コード・候補ID・件数だけを返す（数値は返さない）。
 * 独立性：engine.js・rf7-adapter.js を読み込まない（require/参照しない）。
 *         規則は engine README §6・adapter README §3.3・計画 v5.1 追補から Opus が直接実装。
 * 実行：ブラウザ（self.RF7VerifyRank）と Node（module.exports）両対応。外部依存なし。
 */
(function (root) {
  'use strict';
  var VERSION = 'rf7-verify-rank-1.2.0';

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function cmpStr(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  // 1.2.0：大圏距離（engine とは別に書く。地球半径は平均半径 6371008.8 m）
  function gcM(a, b) {
    var k = Math.PI / 180, x = Math.sin((b.lat - a.lat) * k / 2), y = Math.sin((b.lng - a.lng) * k / 2);
    var h = x * x + Math.cos(a.lat * k) * Math.cos(b.lat * k) * y * y;
    return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // グラフ（app 版）から ランプ辺ID → {ic, dir} の対応表を作る（R1 判定用）
  function rampIndex(graph) {
    var idx = {};
    if (!graph || !graph.edges) return idx;
    graph.edges.forEach(function (e) {
      if (e.kind === 'on_ramp' || e.kind === 'off_ramp') idx[e.id] = { ic: e.ic_id || null, dir: e.dir || null, kind: e.kind };
    });
    return idx;
  }

  // R1：同一IC・同一方向で入って出る乗車（計画 v2.1 §6、v2.2 §3、v2.3）。方向が不明なら判定しない（null）
  function isR1(ride, ridx) {
    var a = ridx[ride.on], b = ridx[ride.off];
    if (!a || !b || !a.ic || !b.ic) return null;
    if (a.ic !== b.ic) return false;
    if (a.dir == null || b.dir == null) return null;
    return a.dir === b.dir;
  }

  // 基準経路：kind=base・ok・料金 free・要求充足・所要秒>0・fallback なし の最初の記録
  function findBase(recs) {
    for (var i = 0; i < recs.length; i++) {
      var r = recs[i];
      if (r.kind !== 'base' || !r.ok || !r.response) continue;
      var x = r.response;
      if (x.toll && x.toll.state === 'free' && x.condition === '要求充足' && isNum(x.durationSec) && x.durationSec > 0 && !x.fallback) return r;
    }
    return null;
  }

  // 1 検索分の主ランキングを独立に再計算する（内部でのみ数値を使う）
  function recompute(search, opts) {
    opts = opts || {};
    var topN = opts.topN || 5;
    var gen = search.generation;
    var genInfo = (search.generations || []).filter(function (g) { return g.generation === gen; })[0];
    var condKey = genInfo ? genInfo.condKey : null;
    var recs = (search.store || []).filter(function (r) {
      return r.searchId === search.searchId && r.generation === gen && (condKey == null || r.condKey === condKey);
    }).sort(function (a, b) { return a.seq - b.seq; });
    var base = findBase(recs);
    if (!base) return { baseOk: false, ranking: [], comparable: 0, reasons: {}, split1: [] };
    var Tb = base.response.durationSec / 60;
    var candById = {};
    (search.candidates || []).forEach(function (c) { candById[c.id] = c; });
    var last = {};
    recs.forEach(function (r) { if (r.kind === 'full' && r.candidateId != null) last[r.candidateId] = r; });
    var rows = [], reasons = {};
    // 1.1.0 混合方式（計画 v2.6.2 §C）：分割再評価（purpose=resplit）の 3 区間を候補・区間ごとに最後の記録で集める（engine とは別に書く）
    var rsp = {};
    recs.forEach(function (r) { if (r.kind === 'split' && r.purpose === 'resplit' && r.candidateId != null) { (rsp[r.candidateId] = rsp[r.candidateId] || {})[r.section] = r; } });
    var opsOf = null, edgeOf = {}, nodeOf = {};
    if (opts.graph) { opsOf = {}; opts.graph.edges.forEach(function (e) { opsOf[e.id] = e.operator || ''; edgeOf[e.id] = e; }); opts.graph.nodes.forEach(function (n) { nodeOf[n.id] = n; }); }
    // 1.2.0（計画 v2.7.2）：②′の対象条件「高速の割合 ≥ lowShareBack」。割合＝乗車の辺長の合計 ÷（辺長＋出発地〜入口ランプ始点＋出口ランプ終点〜目的地の大圏距離）
    var lsb = (search.options && isNum(search.options.lowShareBack)) ? search.options.lowShareBack : 0;
    function shareOf(rd) {
      if (!rd.path || !rd.path.length || !search.cond) return null;
      var hw = 0;
      for (var i = 0; i < rd.path.length; i++) { var e = edgeOf[rd.path[i]]; if (!e || !isNum(e.length_m)) return null; hw += e.length_m; }
      var a = nodeOf[(edgeOf[rd.on] || {}).from], z = nodeOf[(edgeOf[rd.off] || {}).to];
      if (!a || !z) return null;
      var t = hw + gcM(search.cond.origin, a) + gcM(z, search.cond.destination);
      return t > 0 ? hw / t : 1;
    }
    var maxPts = (search.options && search.options.maxIntermediates) || 25;
    function split1(id, r, c) {
      var x = r.response || {};
      if (!r.ok || x.match !== '判定不能' || x.surfTollOnly !== true) return null;
      if (!c.rides || c.rides.length !== 1 || !(c.intermediates <= maxPts)) return null;
      var sec = rsp[id]; if (!sec) return null;
      if (!opsOf) return { bad: 'SPLIT1_NOGRAPH' };
      var rd = c.rides[0];
      if (/首都高/.test(opsOf[rd.on] || '') || /首都高/.test(opsOf[rd.off] || '') || (rd.fare || []).some(function (f) { return /首都高/.test(opsOf[f] || ''); })) return { bad: 'SPLIT1_SHUTOKO' };
      if (lsb > 0) { var sh = shareOf(rd); if (sh === null) return { bad: 'SPLIT1_NOSHARE' }; if (sh < lsb) return { bad: 'SPLIT1_LOWSHARE' }; }
      var a = sec[0], b = sec[1], z = sec[2];
      if (!a || !b || !z) return { bad: 'SPLIT1_INCOMPLETE' };
      var parts = [a, b, z];
      for (var i = 0; i < 3; i++) {
        var y = parts[i].response || {};
        if (!parts[i].ok || y.condition !== '要求充足' || y.fallback) return { bad: 'SPLIT1_SECTION' };
        if (!isNum(y.durationSec) || y.durationSec < 0 || (i === 1 && y.durationSec <= 0)) return { bad: 'SPLIT1_DURATION' };
      }
      if (!(a.response.toll && a.response.toll.state === 'free') || !(z.response.toll && z.response.toll.state === 'free')) return { bad: 'SPLIT1_SURF_TOLL' };
      var tb = b.response.toll || {};
      var C = tb.state === 'free' ? 0 : (tb.state === 'priced' && isNum(tb.jpy) && tb.jpy >= 0 ? tb.jpy : null);
      if (C === null) return { bad: 'SPLIT1_TOLL' };
      if (!(z.response.splitEval && z.response.splitEval.verdict === '一致')) return { bad: 'SPLIT1_EVAL' };
      return { C: C, sec: a.response.durationSec + b.response.durationSec + z.response.durationSec };
    }
    var split1Ids = [];
    Object.keys(last).forEach(function (id) {
      var r = last[id], x = r.response || {}, c = candById[id] || {};
      var why = null;
      var sp = split1(id, r, c);
      if (sp && !sp.bad) {
        if (c.restrictionUnresolved) { reasons[id] = 'RESTRICTION'; return; }
        var d1 = Tb - sp.sec / 60;
        if (!(d1 > 0)) { reasons[id] = 'NO_SAVING'; return; }
        rows.push({ id: id, y: sp.C / d1, d: d1 }); split1Ids.push(id); return;
      }
      if (!r.ok) why = 'API_FAIL';
      else if (x.match !== '一致') why = 'MATCH';
      else if (x.condition !== '要求充足') why = 'CONDITION';
      else if (c.restrictionUnresolved) why = 'RESTRICTION';
      else if (x.fullTripFare !== true) why = 'FULLTRIP';
      else if (!isNum(x.durationSec) || x.durationSec <= 0) why = 'DURATION';
      else if (!x.toll || (x.toll.state !== 'free' && x.toll.state !== 'priced')) why = 'TOLL_STATE';
      else if (x.toll.state === 'priced' && (!isNum(x.toll.jpy) || x.toll.jpy < 0)) why = 'TOLL_AMOUNT';
      if (why) { reasons[id] = why; return; }
      var C = x.toll.state === 'free' ? 0 : x.toll.jpy;
      var d = Tb - x.durationSec / 60;
      if (!(d > 0)) { reasons[id] = 'NO_SAVING'; return; }
      rows.push({ id: id, y: C / d, d: d });
    });
    var comparable = rows.length;
    rows.sort(function (a, b) { return (a.y - b.y) || (b.d - a.d) || cmpStr(a.id, b.id); });
    return { baseOk: true, ranking: rows.slice(0, topN).map(function (r) { return r.id; }), comparable: comparable, reasons: reasons, split1: split1Ids };
  }

  // 機械検査：独立再計算とアプリ表示の一致、世代分離、予算、R1、比較可能候補数
  // input: { search, appRanking:[候補ID...], graph?, budgetB?, maxRetries? }
  // 戻り値は合否・理由コード・候補ID・件数のみ（Google 由来の数値を含めない）
  function verify(input, opts) {
    opts = opts || {};
    var s = input.search, out = { version: VERSION, searchId: s.searchId, generation: s.generation, checks: [] };
    function chk(code, pass, detail) { out.checks.push({ code: code, pass: !!pass, detail: detail || null }); }
    var rc = recompute(s, Object.assign({}, opts, { graph: input.graph || opts.graph }));
    var app = (input.appRanking || []).slice();
    chk('RANK_MATCH', JSON.stringify(rc.ranking) === JSON.stringify(app),
      rc.ranking.length === app.length ? null : { recomputed: rc.ranking.length, app: app.length });
    if (JSON.stringify(rc.ranking) !== JSON.stringify(app)) {
      out.diff = { recomputed: rc.ranking, app: app };
    }
    chk('BASE_OK', rc.baseOk);
    out.comparable = rc.comparable;
    out.excludedByReason = {};
    Object.keys(rc.reasons).forEach(function (id) { var w = rc.reasons[id]; out.excludedByReason[w] = (out.excludedByReason[w] || 0) + 1; });
    // 世代分離：主ランキングの候補に、現世代の full 記録があること（旧世代のみの候補を含まない）
    var curFull = {};
    (s.store || []).forEach(function (r) { if (r.kind === 'full' && r.generation === s.generation && r.ok) curFull[r.candidateId] = true; });
    var stale = app.filter(function (id) { return !curFull[id]; });
    chk('GEN_SEPARATION', stale.length === 0, stale.length ? { staleIds: stale } : null);
    // 予算：検索全体の API 呼出数 ≤ B（store の記録数で数える）、再試行 ≤ maxRetries
    if (isNum(input.budgetB)) {
      var calls = (s.store || []).length;
      chk('BUDGET', calls <= input.budgetB, { calls: calls, B: input.budgetB });
    }
    var retries = (s.store || []).filter(function (r) { return r.retry; }).length;
    chk('RETRIES', retries <= (isNum(input.maxRetries) ? input.maxRetries : 2), { retries: retries });
    // R1：主ランキング・評価記録に R1 乗車を含む候補がない（v2.3：5a 対象外）
    if (input.graph) {
      var ridx = rampIndex(input.graph), r1 = [], unk = [];
      var evaluated = {};
      (s.store || []).forEach(function (r) { if (r.candidateId != null && (r.kind === 'full' || r.kind === 'split')) evaluated[r.candidateId] = true; });
      (s.candidates || []).forEach(function (c) {
        if (!evaluated[c.id]) return;
        (c.rides || []).forEach(function (rd) { var v = isR1(rd, ridx); if (v === true) r1.push(c.id); else if (v === null) unk.push(c.id); });
      });
      chk('NO_R1_EVALUATED', r1.length === 0, r1.length ? { ids: r1 } : null);
      if (unk.length) out.r1Unknown = unk.length;
    }
    // 1.1.0：アプリの split1 の印と独立再計算の split1 が一致（印のない候補を split1 として数えない／その逆もない）
    if (input.appSplit1) {
      var a1 = input.appSplit1.slice().sort(), b1 = rc.split1.filter(function (id) { return rc.ranking.indexOf(id) >= 0; }).sort();
      chk('SPLIT1_MATCH', JSON.stringify(a1) === JSON.stringify(b1), JSON.stringify(a1) === JSON.stringify(b1) ? null : { app: a1.length, recomputed: b1.length });
    }
    out.split1 = rc.split1.filter(function (id) { return rc.ranking.indexOf(id) >= 0; }).length;
    out.pass = out.checks.every(function (c) { return c.pass; });
    return out;
  }

  // 複数検索の集計（P1′：比較可能候補 ≥3 の検索が 1 件以上あるか）
  function summarize(results) {
    var s = { version: VERSION, searches: results.length, pass: 0, fail: 0, withComparableGe3: 0, failCodes: {} };
    results.forEach(function (r) {
      if (r.pass) s.pass++; else s.fail++;
      if (r.comparable >= 3) s.withComparableGe3++;
      r.checks.forEach(function (c) { if (!c.pass) s.failCodes[c.code] = (s.failCodes[c.code] || 0) + 1; });
    });
    s.p1prime = s.withComparableGe3 >= 1;
    return s;
  }

  var api = { VERSION: VERSION, recompute: recompute, verify: verify, summarize: summarize, isR1: isR1, rampIndex: rampIndex };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.RF7VerifyRank = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
