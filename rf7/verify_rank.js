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
  var VERSION = 'rf7-verify-rank-1.0.0';

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function cmpStr(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

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
    if (!base) return { baseOk: false, ranking: [], comparable: 0, reasons: {} };
    var Tb = base.response.durationSec / 60;
    var candById = {};
    (search.candidates || []).forEach(function (c) { candById[c.id] = c; });
    var last = {};
    recs.forEach(function (r) { if (r.kind === 'full' && r.candidateId != null) last[r.candidateId] = r; });
    var rows = [], reasons = {};
    Object.keys(last).forEach(function (id) {
      var r = last[id], x = r.response || {}, c = candById[id] || {};
      var why = null;
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
    return { baseOk: true, ranking: rows.slice(0, topN).map(function (r) { return r.id; }), comparable: comparable, reasons: reasons };
  }

  // 機械検査：独立再計算とアプリ表示の一致、世代分離、予算、R1、比較可能候補数
  // input: { search, appRanking:[候補ID...], graph?, budgetB?, maxRetries? }
  // 戻り値は合否・理由コード・候補ID・件数のみ（Google 由来の数値を含めない）
  function verify(input, opts) {
    opts = opts || {};
    var s = input.search, out = { version: VERSION, searchId: s.searchId, generation: s.generation, checks: [] };
    function chk(code, pass, detail) { out.checks.push({ code: code, pass: !!pass, detail: detail || null }); }
    var rc = recompute(s, opts);
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
