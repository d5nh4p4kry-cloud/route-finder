/*
 * RFEngine — ルートファインダー v7 段階4b 探索器（論理試験版）
 * 仕様：route-finder-v7-plan-v5.1.md（冒頭 v5.1 追補が本文に優先）＋ route-finder-v7-plan-v5.2.1.md（差分、冒頭の監査反映表が最優先）
 * - DOM 非依存・外部依存なし・ES2020
 * - 候補の削除は一切しない。推定値は API 評価の順序付けにだけ使う
 * - 列挙：優先度付きキュー（最良優先）によるラベル展開。停止はラベル数上限・時間上限のみ
 * - v5.2.1：C1 遅延生成（添字だけの生成器）、C2 優先度補正 pen（estSec と分離）、C3 種まき、
 *   C4 上限 20,000、C5 多様性キー（IC・方向単位）、C6 統計、C7 直行評価枠（共通予算 B の内数）
 */
(function (root) {
  'use strict';

  const VERSION = 'v7-stage5-1.2.0';
  const SCHEMA = 'rf-graph/1';
  const NODE_TYPES = ['mainline', 'ramp_mainline_end', 'ramp_surface_end', 'jct', 'sapa', 'smartic_gate'];
  const SURFACE_TYPES = ['ramp_surface_end', 'smartic_gate'];
  const EDGE_KINDS = ['mainline', 'on_ramp', 'off_ramp', 'jct_link'];
  const ID_RE = /^[A-Za-z0-9_.:\-]+$/;

  const DEFAULTS = Object.freeze({
    maxLabels: 20000,       // ラベル生成上限（v5.2.1 C4：既定20,000。生成器ラベルは数えない）
    maxMs: 3000,            // 列挙の時間上限（ms）
    highwayKmh: 80,         // 順序推定：高速＝辺長÷80km/h
    surfaceKmh: 30,         // 順序推定：一般道＝大圏距離÷30km/h
    heuristicKmh: 80,       // 最良優先の残り推定（順序のみ）
    pointsPerRide: 4,       // 境界non-via方式：乗車1回あたりの中間地点数（v5.1追補#3）
    maxIntermediates: 25,   // 全中間地点合計の上限
    budget: 23,             // 共通予算B
    maxRetries: 2,          // 1検索全体の再試行上限（Bの内数）
    retryBaseMs: 1000,      // 指数的待機の基準（1回目1s、2回目2s）
    topN: 5,
    profile: 'user',        // 'user'（利用者用配分）｜'verification'（検証用配分）
    tollTerminalJpy: 150,   // 料金概算（順序付け専用の仮値）
    tollPerKmJpy: 24.6,
    tollTaxRate: 1.1,
    lazyGeneration: true,   // C1：S ラベルの子を1本ずつ遅延生成（false＝v1.0 の一括生成。不変性試験 T2 用）
    lambdaSec: 300,         // C2：乗換1回あたりの優先度補正λ（順序専用。estSec・推定円/分には入れない。推測値）
    lambdaSameIcSec: 600,   // C2：同一IC・同方向／同一一般道側ノードへの即時乗り直しの追加補正λ_same（同上）
    seedIcCount: 3,         // C3：種まきの最寄りIC数（0＝種まきなし）
    directSlots: 2,         // C7：直行評価枠の最大件数（共通予算Bの内数。0＝枠なし）
    splitReserve: 0,        // 1.2.0 混合方式（計画 v2.6.2）：②′分割再評価の予約回数（3 の倍数に切下げ。0＝混合方式なし＝1.1.0 と同じ動作）
    exposeGenerators: false,// 試験用：未消化の生成器を結果に含める（メモリ構造の検査用）
  });

  const RETRYABLE = ['TRANSIENT', 'NETWORK', 'SERVER', 'TIMEOUT', 'UNAVAILABLE'];
  const FATAL = ['AUTH_DENIED', 'DAILY_LIMIT'];
  const FATAL_LABEL = { AUTH_DENIED: '認証・利用元制限により拒否', DAILY_LIMIT: '日次上限に到達' };

  // ---------------------------------------------------------------- 基本関数
  function haversineM(a, b) {
    const R = 6371008.8, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function cmpStr(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  function cmpNum(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  function isFiniteNum(x) { return typeof x === 'number' && Number.isFinite(x); }
  function isPt(p) { return p && isFiniteNum(p.lat) && isFiniteNum(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180; }

  /** 経路ID：乗車ごとに 入口>出口[料金影響辺,...] を | で連結 */
  function canonicalId(rides) {
    return rides.map(r => r.on + '>' + r.off + '[' + r.fare.join(',') + ']').join('|');
  }

  function isImpassable(e) {
    return !!(e.restriction && e.restriction.resolved === true && e.restriction.passable === false);
  }
  function isUnresolved(e) {
    return !!(e.restriction && e.restriction.resolved !== true);
  }

  // ---------------------------------------------------------------- グラフ検証
  function validateGraph(g) {
    const errors = [], warnings = [];
    if (!g || typeof g !== 'object') return { ok: false, errors: ['グラフがオブジェクトではない'], warnings };
    if (g.schema !== SCHEMA) errors.push('schema が ' + SCHEMA + ' ではない: ' + g.schema);
    if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) {
      errors.push('nodes / edges が配列ではない');
      return { ok: false, errors, warnings };
    }
    const nodes = new Map();
    for (const n of g.nodes) {
      if (!n || typeof n.id !== 'string' || !ID_RE.test(n.id)) { errors.push('ノードID不正: ' + (n && n.id)); continue; }
      if (nodes.has(n.id)) errors.push('ノードID重複: ' + n.id);
      if (!NODE_TYPES.includes(n.type)) errors.push('ノード種別不正: ' + n.id + ' type=' + n.type);
      if (!isPt(n)) errors.push('ノード座標不正: ' + n.id);
      nodes.set(n.id, n);
    }
    const eids = new Set();
    const surf = id => nodes.has(id) && SURFACE_TYPES.includes(nodes.get(id).type);
    for (const e of g.edges) {
      if (!e || typeof e.id !== 'string' || !ID_RE.test(e.id)) { errors.push('辺ID不正（英数字と _ . : - のみ）: ' + (e && e.id)); continue; }
      if (eids.has(e.id)) errors.push('辺ID重複: ' + e.id);
      eids.add(e.id);
      if (!EDGE_KINDS.includes(e.kind)) errors.push('辺種別不正: ' + e.id + ' kind=' + e.kind);
      if (!nodes.has(e.from)) errors.push('辺の始点が存在しない: ' + e.id + ' from=' + e.from);
      if (!nodes.has(e.to)) errors.push('辺の終点が存在しない: ' + e.id + ' to=' + e.to);
      if (e.from === e.to) errors.push('自己ループ辺: ' + e.id);
      if (!isFiniteNum(e.length_m) || e.length_m < 0) errors.push('length_m 不正: ' + e.id);
      if (!(e.toll === true || e.toll === false || e.toll === null)) errors.push('toll は true/false/null: ' + e.id);
      if (typeof e.fare_relevant !== 'boolean') errors.push('fare_relevant は boolean: ' + e.id);
      if (typeof e.road !== 'string') warnings.push('road 欠落: ' + e.id);
      if (typeof e.operator !== 'string') warnings.push('operator 欠落: ' + e.id);
      if (e.kind === 'on_ramp') {
        if (!surf(e.from)) errors.push('入口ランプの始点が一般道側端点でない: ' + e.id);
        if (surf(e.to)) errors.push('入口ランプの終点が一般道側端点: ' + e.id);
      } else if (e.kind === 'off_ramp') {
        if (!surf(e.to)) errors.push('出口ランプの終点が一般道側端点でない: ' + e.id);
        if (surf(e.from)) errors.push('出口ランプの始点が一般道側端点: ' + e.id);
      } else if (surf(e.from) || surf(e.to)) {
        errors.push((e.kind === 'jct_link' ? 'JCT連絡路' : '本線') + 'が一般道側端点に接続: ' + e.id);
      }
      if ((e.kind === 'on_ramp' || e.kind === 'off_ramp') && typeof e.ic_id !== 'string') errors.push('ランプに ic_id がない: ' + e.id);
      if ((e.kind === 'on_ramp' || e.kind === 'off_ramp' || e.fare_relevant) && !isPt(e.via)) errors.push('経由点 via がない（ランプ・料金影響辺は必須）: ' + e.id);
      if (e.restriction !== undefined) {
        const r = e.restriction;
        if (!r || typeof r !== 'object' || typeof r.resolved !== 'boolean') errors.push('restriction.resolved は boolean: ' + e.id);
        else if (r.resolved && typeof r.passable !== 'boolean') errors.push('解決済み restriction には passable が必要: ' + e.id);
      }
    }
    return { ok: errors.length === 0, errors, warnings };
  }

  function buildIndex(g) {
    const nodes = new Map(g.nodes.map(n => [n.id, n]));
    const edges = new Map(g.edges.map(e => [e.id, e]));
    const out = new Map();
    for (const n of g.nodes) out.set(n.id, []);
    const onRamps = [], offRamps = [];
    for (const e of g.edges) {
      if (isImpassable(e)) continue;
      out.get(e.from).push(e);
      if (e.kind === 'on_ramp') onRamps.push(e);
      else if (e.kind === 'off_ramp') offRamps.push(e);
    }
    for (const l of out.values()) l.sort((a, b) => cmpStr(a.id, b.id));
    onRamps.sort((a, b) => cmpStr(a.id, b.id));
    offRamps.sort((a, b) => cmpStr(a.id, b.id));
    const icName = new Map((g.ics || []).map(i => [i.ic_id, i.name]));
    return { nodes, edges, out, onRamps, offRamps, icName };
  }

  // ---------------------------------------------------------------- 最小ヒープ
  class MinHeap {
    constructor(less) { this.a = []; this.less = less; }
    get size() { return this.a.length; }
    push(x) {
      const a = this.a; a.push(x);
      let i = a.length - 1;
      while (i > 0) { const p = (i - 1) >> 1; if (!this.less(a[i], a[p])) break; [a[i], a[p]] = [a[p], a[i]]; i = p; }
    }
    pop() {
      const a = this.a, top = a[0], last = a.pop();
      if (a.length) {
        a[0] = last; let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1; let m = i;
          if (l < a.length && this.less(a[l], a[m])) m = l;
          if (r < a.length && this.less(a[r], a[m])) m = r;
          if (m === i) break;
          [a[i], a[m]] = [a[m], a[i]]; i = m;
        }
      }
      return top;
    }
  }

  // ---------------------------------------------------------------- 料金概算（順序付け専用）
  function defaultRideToll(rideEdges, o) {
    let km = 0;
    for (const e of rideEdges) if (e.toll === true) km += e.length_m / 1000;
    if (km <= 0) return 0;
    return Math.round((o.tollTerminalJpy + o.tollPerKmJpy * km) * o.tollTaxRate / 10) * 10;
  }

  // ---------------------------------------------------------------- 列挙
  /**
   * 乗降ランプ列＋料金影響列の候補を列挙する（削除なし）。
   * label.ph: 'S'＝一般道側（出発地または出口直後）、'R'＝乗車中、'G'＝生成器（S ラベルの未生成の子。C1）
   * f＝g（推定経過時間）＋h（残り推定）＋pen（優先度補正。列挙の順序専用で estSec には入れない：C2）
   */
  function icKey(e) { return (e.ic_id === undefined ? '' : e.ic_id) + '|' + (e.dir === undefined ? '' : e.dir); }
  /** 出口 off から一般道を経て入口 on に乗り直すのが「即時の乗り直し」か（C2：同一ノード、または同一IC・同方向。dir が無ければ同一IC判定のみ） */
  function isImmediateReride(off, on) {
    if (off.to === on.from) return true;
    if (off.ic_id !== on.ic_id) return false;
    if (off.dir === undefined || on.dir === undefined) return true;
    return off.dir === on.dir;
  }

  function enumerate(graph, origin, destination, options) {
    const o = Object.assign({}, DEFAULTS, options || {});
    const idx = buildIndex(graph);
    const now = o.now || (() => Date.now());
    const t0 = now();
    const vH = o.highwayKmh / 3.6, vS = o.surfaceKmh / 3.6, vh = o.heuristicKmh / 3.6;
    const rideToll = o.estimateRideToll || (edges => defaultRideToll(edges, o));
    const pt = id => idx.nodes.get(id);
    const hRem = p => haversineM(p, destination) / vh;
    const surfLen = (fromNode, fromPt, toNode) => (fromNode !== null && fromNode === toNode) ? 0 : haversineM(fromPt, pt(toNode));
    const onRamps = idx.onRamps, nOn = onRamps.length;
    const lam = o.lambdaSec, lamSame = o.lambdaSameIcSec;

    const heap = new MinHeap((a, b) => a.f < b.f || (a.f === b.f && a.seq < b.seq));
    const cands = new Map();
    const seedSigs = new Map();     // 種まき候補ID → 種まきで登録した実現経路（辺列）の署名（二重計数の防止）
    let seq = 0, created = 0, popped = 0, genPops = 0, iter = 0, maxFrontier = 0, realizations = 0;
    let truncated = null, seedStat = null;

    function push(l) {
      if (created >= o.maxLabels) { truncated = truncated || 'labels'; return false; }
      created++; l.seq = seq++; heap.push(l);
      if (heap.size > maxFrontier) maxFrontier = heap.size;
      return true;
    }
    function pushGen(gn) {            // 生成器は maxLabels に数えない
      gn.seq = seq++; heap.push(gn);
      if (heap.size > maxFrontier) maxFrontier = heap.size;
    }
    function visitedInRide(L, nodeId) {
      for (let p = L; p; p = p.up) if (p.node === nodeId) return true;
      return false;
    }
    function rideEdges(L, offEdge) {
      const es = [offEdge];
      for (let p = L; p; p = p.up) es.push(p.edge);
      es.reverse();
      return es;
    }
    /** 乗車（入口〜出口の辺列）から ride を作る。列挙と種まきで共有する */
    function makeRide(es) {
      const on = es[0], off = es[es.length - 1];
      return {
        on: on.id, off: off.id, path: es.map(e => e.id),
        fare: es.filter(e => e.fare_relevant).map(e => e.id),
        highwayM: es.reduce((a, e) => a + e.length_m, 0), estTollJpy: rideToll(es),
        onKey: icKey(on), offKey: icKey(off),
      };
    }
    /** 候補の登録。列挙の emit と種まきで共有する（同一ID・同一の代表経路規則）。seeded＝種まきからの登録 */
    function emit(rides, estSec, restr, surfaceM, pen, seeded) {
      const id = canonicalId(rides);
      if (!seeded && rides.length === 1) {
        const ss = seedSigs.get(id);
        if (ss && ss.has(rides[0].path.join(','))) return;         // 種まきで登録済みの同一辺列は二重に数えない
      }
      realizations++;
      let fareCount = 0, tollJpy = 0, hwM = 0;
      for (const r of rides) { fareCount += r.fare.length; tollJpy += r.estTollJpy; hwM += r.highwayM; }
      const c = {
        id, n: rides.length, rides, estSec, estTollJpy: tollJpy, highwayM: hwM, surfaceM,
        fareCount, intermediates: o.pointsPerRide * rides.length + fareCount,
        restrictionUnresolved: restr, firstOn: rides[0].on, lastOff: rides[rides.length - 1].off,
        pen, seeded: !!seeded, divKey: rides[0].onKey + '>' + rides[rides.length - 1].offKey,
      };
      if (seeded) { const ss = seedSigs.get(id) || new Set(); ss.add(rides[0].path.join(',')); seedSigs.set(id, ss); }
      const ex = cands.get(id);
      if (!ex) { c.realizations = 1; cands.set(id, c); return; }
      c.realizations = ex.realizations + 1;
      c.seeded = ex.seeded || c.seeded;
      // 代表経路：未解決規制なしを優先、次に推定所要時間が短いもの（IDの同一性には影響しない）
      const better = (ex.restrictionUnresolved && !restr) || (ex.restrictionUnresolved === restr && estSec < ex.estSec);
      if (better) cands.set(id, c); else { ex.realizations = c.realizations; ex.seeded = c.seeded; }
    }

    // ---- S ラベル L から入口ランプ e への遷移（遷移規則は v1.0 から不変）。可能なら M に結果を入れて true
    const M = { s: 0, g2: 0, pen: 0, f: 0, np: null };
    function surfTransition(L, e) {
      for (let i = 0; i < L.rides.length; i++) if (L.rides[i].on === e.id) return false;   // 同一方向付きランプ辺の再利用禁止
      const s = surfLen(L.node, L.p, e.from);
      if (s === 0 && L.lastZero) return false;                                              // ゼロ長の連続遷移禁止
      if (e.length_m === 0 && s === 0) return false;
      const g2 = L.g + s / vS + e.length_m / vH;
      let pen = L.pen;
      if (L.rides.length) { pen += lam; if (L.lastOff && isImmediateReride(L.lastOff, e)) pen += lamSame; }
      const np = pt(e.to);
      M.s = s; M.g2 = g2; M.pen = pen; M.np = np; M.f = g2 + hRem(np) + pen;
      return true;
    }
    function surfChild(L, e) {        // surfTransition(L, e) が true の直後に呼ぶ
      return {
        ph: 'R', node: e.to, edge: e, up: null, p: M.np, rides: L.rides, onId: e.id,
        g: M.g2, lastZero: e.length_m === 0, restr: L.restr || isUnresolved(e), surfM: L.surfM + M.s, pen: M.pen, f: M.f,
      };
    }

    // ---- C3 種まき：最寄り IC の入口×出口の各（入口,出口）について推定最短の乗車を Dijkstra で求め、候補として先に登録する
    function seedPhase() {
      const ts = now();
      const nearest = (ramps, ptOf, from) => {
        const m = new Map();
        for (const e of ramps) { const d = haversineM(from, ptOf(e)); const c = m.get(e.ic_id); if (c === undefined || d < c) m.set(e.ic_id, d); }
        return Array.from(m.entries()).sort((a, b) => cmpNum(a[1], b[1]) || cmpStr(a[0], b[0])).slice(0, o.seedIcCount).map(x => x[0]);
      };
      const onIcs = nearest(onRamps, e => pt(e.from), origin);
      const offIcs = nearest(idx.offRamps, e => pt(e.to), destination);
      const onSet = new Set(onIcs), offSet = new Set(offIcs);
      const onSel = onRamps.filter(e => onSet.has(e.ic_id));
      const offIdSet = new Set(idx.offRamps.filter(e => offSet.has(e.ic_id)).map(e => e.id));
      const nodeIdx = new Map(); graph.nodes.forEach((n, i) => nodeIdx.set(n.id, i));
      const N = graph.nodes.length;
      const dist = new Float64Array(2 * N), prevSt = new Int32Array(2 * N), prevE = new Array(2 * N);
      let relax = 0, registered = 0, skippedNonSimple = 0;
      for (const on of onSel) {
        const s0 = surfLen(null, origin, on.from);
        if (on.length_m === 0 && s0 === 0) continue;                    // 列挙と同じ：ゼロ長の入口はゼロ長の一般道区間の後に置かない
        const g0 = 0 + s0 / vS + on.length_m / vH;                      // 列挙の g と同じ加算順（estSec をビット単位で一致させる）
        dist.fill(Infinity); prevSt.fill(-1);
        const st0 = nodeIdx.get(on.to) * 2 + (on.length_m === 0 ? 1 : 0);
        dist[st0] = g0;
        const Q = new MinHeap((a, b) => a.d < b.d || (a.d === b.d && a.st < b.st));
        Q.push({ d: g0, st: st0 });
        const bestOff = new Map();                                      // 出口辺ID → {g, st, x}
        while (Q.size) {
          const cur = Q.pop();
          if (cur.d > dist[cur.st]) continue;
          const node = graph.nodes[cur.st >> 1].id, z = cur.st & 1;
          for (const x of idx.out.get(node)) {
            relax++;
            if (x.length_m === 0 && z) continue;                        // ゼロ長の連続遷移禁止（列挙と同じ規則）
            const nd = cur.d + x.length_m / vH;
            if (x.kind === 'off_ramp') {
              if (!offIdSet.has(x.id)) continue;
              const b = bestOff.get(x.id);
              if (!b || nd < b.g) bestOff.set(x.id, { g: nd, st: cur.st, x });
            } else if (x.kind === 'mainline' || x.kind === 'jct_link') {
              const ns = nodeIdx.get(x.to) * 2 + (x.length_m === 0 ? 1 : 0);
              if (nd < dist[ns]) { dist[ns] = nd; prevSt[ns] = cur.st; prevE[ns] = x; Q.push({ d: nd, st: ns }); }
            }
          }
        }
        for (const offId of Array.from(bestOff.keys()).sort(cmpStr)) {
          const b = bestOff.get(offId), x = b.x;
          const chain = []; let cs = b.st;
          while (cs !== st0) { chain.push(prevE[cs]); cs = prevSt[cs]; }
          chain.reverse();
          const seen = new Set([on.to]); let simple = true;             // 乗車内は単純路
          for (const e2 of chain) { if (seen.has(e2.to)) { simple = false; break; } seen.add(e2.to); }
          if (!simple) { skippedNonSimple++; continue; }
          const es = [on].concat(chain, [x]);
          const restr = es.some(isUnresolved);
          const lz = x.length_m === 0, sp = pt(x.to), d = haversineM(sp, destination);
          if (d === 0 && lz) continue;                                  // 列挙と同じ：ゼロ長の出口の直後にゼロ長の一般道区間を置かない
          emit([makeRide(es)], b.g + d / vS, restr, s0 + d, 0, true);
          registered++;
        }
      }
      seedStat = { icCount: o.seedIcCount, onIcs, offIcs, onRamps: onSel.length, offRamps: offIdSet.size, relaxations: relax, registered, skippedNonSimple, ms: now() - ts };
    }

    const tmpI = new Int32Array(nOn), tmpF = new Float64Array(nOn);
    if (o.seedIcCount > 0) seedPhase();
    push({ ph: 'S', node: null, p: origin, rides: [], g: 0, lastZero: false, restr: false, surfM: 0, pen: 0, lastOff: null, f: hRem(origin) });

    while (heap.size && !truncated) {
      if ((iter++ & 63) === 0 && now() - t0 > o.maxMs) { truncated = 'time'; break; }
      const L = heap.pop();
      if (L.ph === 'G') {                                                // 生成器：次の1本だけ子ラベルを生成し、残りがあれば自分を再投入
        genPops++;
        const par = L.parent, e = onRamps[L.idx[L.pos]]; L.pos++;
        if (!surfTransition(par, e)) throw new Error('内部エラー：生成器の子が遷移規則を満たさない');
        const child = surfChild(par, e);
        if (L.pos < L.idx.length) { L.f = L.fs[L.pos]; pushGen(L); }
        if (!push(child)) break;
        continue;
      }
      popped++;
      if (L.ph === 'S') {
        if (!o.lazyGeneration) {                                         // v1.0 方式：全入口ランプの子を一度に生成
          let ok = true;
          for (const e of onRamps) {
            if (!surfTransition(L, e)) continue;
            if (!push(surfChild(L, e))) { ok = false; break; }
          }
          if (!ok) break;
        } else {
          let k = 0;
          for (let i = 0; i < nOn; i++) { if (!surfTransition(L, onRamps[i])) continue; tmpI[k] = i; tmpF[k] = M.f; k++; }
          if (k === 0) continue;
          const ord = new Array(k); for (let j = 0; j < k; j++) ord[j] = j;
          ord.sort((a, b) => cmpNum(tmpF[a], tmpF[b]) || (tmpI[a] - tmpI[b]));
          const first = onRamps[tmpI[ord[0]]];
          if (k > 1) {                                                   // 生成器：親への参照・入口添字(Int32Array)・優先度(Float64Array)・取り出し位置だけを保持
            const gi = new Int32Array(k - 1), gf = new Float64Array(k - 1);
            for (let j = 1; j < k; j++) { gi[j - 1] = tmpI[ord[j]]; gf[j - 1] = tmpF[ord[j]]; }
            pushGen({ ph: 'G', parent: L, idx: gi, fs: gf, pos: 0, f: gf[0], seq: 0 });
          }
          surfTransition(L, first);
          if (!push(surfChild(L, first))) break;
        }
      } else {
        for (const x of idx.out.get(L.node)) {
          if (x.length_m === 0 && L.lastZero) continue;                   // ゼロ長の連続遷移禁止
          const g2 = L.g + x.length_m / vH;
          const restr = L.restr || isUnresolved(x);
          if (x.kind === 'off_ramp') {
            if (L.rides.some(r => r.off === x.id)) continue;              // 同一方向付きランプ辺の再利用禁止
            const rides = L.rides.concat([makeRide(rideEdges(L, x))]);
            const lz = x.length_m === 0;
            const sp = pt(x.to);
            const d = haversineM(sp, destination);
            if (!(d === 0 && lz)) emit(rides, g2 + d / vS, restr, L.surfM + d, L.pen, false);
            if (!push({ ph: 'S', node: x.to, p: sp, rides, g: g2, lastZero: lz, restr, surfM: L.surfM, pen: L.pen, lastOff: x, f: g2 + hRem(sp) + L.pen })) break;
          } else if (x.kind === 'mainline' || x.kind === 'jct_link') {
            if (visitedInRide(L, x.to)) continue;                         // 乗車内は単純路（循環禁止）
            const np = pt(x.to);
            const child = {
              ph: 'R', node: x.to, edge: x, up: L, p: np, rides: L.rides, onId: L.onId,
              g: g2, lastZero: x.length_m === 0, restr, surfM: L.surfM, pen: L.pen, f: g2 + hRem(np) + L.pen,
            };
            if (!push(child)) break;
          }
        }
      }
    }
    const list = Array.from(cands.values());
    const byRides = {};
    for (const c of list) byRides[c.n] = (byRides[c.n] || 0) + 1;
    let gens = 0, genSlots = 0;
    for (const l of heap.a) if (l.ph === 'G') { gens++; genSlots += l.idx.length - l.pos; }
    const res = {
      complete: !truncated && heap.size === 0,
      truncated, // null | 'labels' | 'time'
      candidates: list,
      stats: {
        nodes: graph.nodes.length, edges: graph.edges.length,
        labelsCreated: created, labelsExpanded: popped, generatorPops: genPops, frontierLeft: heap.size, maxFrontier,
        realizations, candidates: list.length, byRides,
        generatorsPending: gens, generatorSlotsPending: genSlots,
        seed: seedStat, elapsedMs: now() - t0,
      },
      icName: idx.icName, edgeIndex: idx.edges,
    };
    if (o.exposeGenerators) res.pendingGenerators = heap.a.filter(l => l.ph === 'G');
    return res;
  }

  // ---------------------------------------------------------------- 比較条件・世代
  function normCond(c) {
    return {
      origin: { lat: c.origin.lat, lng: c.origin.lng },
      destination: { lat: c.destination.lat, lng: c.destination.lng },
      departureTime: c.departureTime,
      etc: c.etc === undefined ? true : !!c.etc,
      routingPreference: c.routingPreference || 'TRAFFIC_AWARE_OPTIMAL',
    };
  }
  /** 比較条件キー（取得時刻は含めない：v5.1追補#1） */
  function condKey(c) {
    return JSON.stringify([c.origin.lat, c.origin.lng, c.destination.lat, c.destination.lng, c.departureTime, c.etc, c.routingPreference]);
  }

  function createSearch(params) {
    const o = Object.assign({}, DEFAULTS, params.options || {});
    const v = validateGraph(params.graph);
    if (!v.ok) throw new Error('グラフ検証失敗: ' + v.errors.slice(0, 5).join(' / '));
    const en = params.enumeration || enumerate(params.graph, params.origin, params.destination, o);
    return {
      searchId: params.searchId || ('s' + Math.random().toString(36).slice(2, 10)),
      generation: 1,
      cond: normCond(Object.assign({}, params.cond, { origin: params.origin, destination: params.destination })),
      graph: params.graph, options: o, enumeration: en,
      budget: { B: o.budget, used: 0, reserved: 0, retriesUsed: 0, waitsMs: [] },
      store: [], gens: { 1: { prioritized: false } }, stopped: null,
    };
  }
  /** 出発時刻の変更：評価世代を+1（旧世代の結果は新ランキングに混在させない） */
  function updateDepartureTime(s, departureTime) {
    s.generation += 1;
    s.cond = normCond(Object.assign({}, s.cond, { departureTime }));
    s.gens[s.generation] = { prioritized: false };
    return s.generation;
  }

  // ---------------------------------------------------------------- 判定
  function validDur(r) { return isFiniteNum(r.durationSec) && r.durationSec > 0; }
  function isRetryable(rec) { return !!rec && !rec.ok && RETRYABLE.includes(rec.failReason); }

  function baseAcceptance(r) {
    if (!validDur(r)) return { ok: false, tollPresent: false, reason: '基準経路の所要時間が無効' };
    const st = r.toll && r.toll.state;
    if (st === 'priced' || st === 'unknown') return { ok: false, tollPresent: true, reason: '基準経路に有料道路を含む' };
    if (st !== 'free') return { ok: false, tollPresent: false, reason: '基準経路の料金未検証' };
    if (r.condition === 'fallback') return { ok: false, tollPresent: false, reason: '基準経路がfallback' };
    if (r.condition !== '要求充足') return { ok: false, tollPresent: false, reason: '基準経路の評価条件未充足' };
    return { ok: true };
  }

  function tdLabel(td) {
    if (td === 'なし') return null;
    if (td === '時刻依存') return '時刻依存：割引適用未確認（API推定値による順位）';
    return '時刻依存：未確認（割引制度未調査・API推定値による順位）';
  }

  /** 主ランキング入場判定（3軸＋全旅程料金＋同梱データの通行条件） */
  function entryCheck(rec, c) {
    const reasons = [];
    if (!rec.ok) { reasons.push('料金未検証（API評価失敗：' + rec.failReason + '）'); return { reasons }; }
    const r = rec.response;
    if (r.match !== '一致') reasons.push('経路を確認できず（照合：' + (r.match || '不明') + '）');
    if (r.condition === 'fallback') reasons.push('評価条件未充足（fallback）');
    else if (r.condition === '通行条件未確認') reasons.push('通行条件未確認');
    else if (r.condition !== '要求充足') reasons.push('評価条件不明');
    if (c.restrictionUnresolved) reasons.push('通行条件未確認（同梱データに未解決の通行条件）');
    let C = null;
    const st = r.toll && r.toll.state;
    if (st === 'free') C = 0;
    else if (st === 'priced' && isFiniteNum(r.toll.jpy) && r.toll.jpy >= 0) C = r.toll.jpy;
    else if (st === 'priced' || st === 'unknown') reasons.push('料金不明');
    else reasons.push('料金未検証');
    if (r.fullTripFare !== true) reasons.push('全旅程料金未検証');
    if (!validDur(r)) reasons.push('所要時間未検証');
    return { reasons, C, durationSec: r.durationSec, td: tdLabel(r.timeDependency) };
  }

  // ---------------------------------------------------------------- 評価順序（推定値は順序だけに使う）
  /** 推定円/分＝推定料金÷(T_base−estSec/60)。分母≤0は∞（最後尾に置くが削除しない）。pen・λ は含めない（C2） */
  function estRatio(c, baseMin) {
    const d = baseMin - c.estSec / 60;
    return d > 0 ? c.estTollJpy / d : Infinity;
  }
  /**
   * API 評価順（C5）。キーの優先順：(1) priorityIds、(2) 直行代表 directIds、(3) 多様性鍵〈(最初の入口IC,方向),(最後の出口IC,方向)〉内の順位、
   * (4) 推定円/分（pen なし）、(5) 優先度補正 pen の小さい順、(6) estSec、(7) ID。
   * 多様性鍵内の順位は (4)→(5)→(6)→(7) の順で付ける。
   */
  function orderCandidates(cands, baseMin, priorityIds, directIds) {
    const pri = new Map((priorityIds || []).map((id, i) => [id, i]));
    const dset = new Set(directIds || []);
    const items = cands.map(c => ({ c, r: estRatio(c, baseMin), pen: c.pen || 0, key: c.divKey || (c.firstOn + '>' + c.lastOff), div: 0 }));
    const base = (a, b) => cmpNum(a.r, b.r) || cmpNum(a.pen, b.pen) || cmpNum(a.c.estSec, b.c.estSec) || cmpStr(a.c.id, b.c.id);
    items.sort(base);
    const seen = new Map();
    for (const it of items) { const k = seen.get(it.key) || 0; it.div = k; seen.set(it.key, k + 1); }
    const P = id => pri.has(id) ? pri.get(id) : 1e15;
    const D = id => dset.has(id) ? 0 : 1;
    items.sort((a, b) => cmpNum(P(a.c.id), P(b.c.id)) || cmpNum(D(a.c.id), D(b.c.id)) || cmpNum(a.div, b.div) || base(a, b));
    return items.map(it => it.c);
  }

  /** C7 直行評価枠の母集団：種まき候補のうち、未解決規制を通らず、中間地点数が上限以下のもの */
  function directPopulation(cands, o) {
    return cands.filter(c => c.seeded && !c.restrictionUnresolved && c.intermediates <= o.maxIntermediates);
  }
  /** C7 直行代表（最大 directSlots 件）：(a) 母集団で estSec 最小、(b) 母集団で推定円/分最小（(a)と同じなら1件） */
  function directRepresentatives(cands, baseMin, o) {
    const slots = o.directSlots === undefined ? DEFAULTS.directSlots : o.directSlots;
    const pop = directPopulation(cands, o);
    if (!pop.length || slots <= 0) return [];
    const byTime = pop.slice().sort((a, b) => cmpNum(a.estSec, b.estSec) || cmpStr(a.id, b.id));
    const byRatio = pop.slice().sort((a, b) => cmpNum(estRatio(a, baseMin), estRatio(b, baseMin)) || cmpNum(a.estSec, b.estSec) || cmpStr(a.id, b.id));
    const reps = [byTime[0]];
    if (byRatio[0].id !== byTime[0].id) reps.push(byRatio[0]);
    return reps.slice(0, slots);
  }

  // ---------------------------------------------------------------- 評価（共通予算B）
  async function evaluate(s, ctx) {
    ctx = ctx || {};
    const o = s.options, bud = s.budget, gen = s.generation, cond = s.cond, ck = condKey(cond);
    const sleep = ctx.sleep || (ms => new Promise(res => setTimeout(res, ms)));
    const now = ctx.now || (() => Date.now());
    const profile = ctx.profile || o.profile;
    const free = () => bud.B - bud.used - bud.reserved;
    let hold = 0;                                   // 1.2.0：②′分割再評価のために②で使わずに取っておく回数
    const avail = () => free() - hold;
    const tryReserve = () => {
      if (bud.retriesUsed + bud.reserved < o.maxRetries && avail() >= 1) { bud.reserved++; return true; }
      return false;
    };
    if (ctx.priorityIds && ctx.priorityIds.length) s.gens[gen].prioritized = true;

    async function call(req, isRetry) {
      if (s.stopped) return null;
      if (isRetry) {
        if (bud.reserved < 1) throw new Error('内部エラー：枠未確保の再試行');
        bud.reserved--; bud.retriesUsed++;
        const w = o.retryBaseMs * Math.pow(2, bud.retriesUsed - 1);
        bud.waitsMs.push(w);
        await sleep(w);
      } else if (free() < 1) return null;
      bud.used++;
      if (bud.used > bud.B || bud.retriesUsed > o.maxRetries) throw new Error('不変条件違反：予算Bまたは再試行上限を超過');
      const q = Object.assign({}, req, { searchId: s.searchId, generation: gen, cond, retry: !!isRetry });
      let res;
      try { res = await ctx.api(q); } catch (e) { res = { error: 'NETWORK', message: String((e && e.message) || e) }; }
      if (!res || typeof res !== 'object') res = { error: 'BAD_RESPONSE' };
      const rec = {
        seq: s.store.length, searchId: s.searchId, generation: gen, condKey: ck,
        kind: req.kind, candidateId: req.candidateId || null, attempt: req.attempt || null, slot: req.slot || null,
        section: req.section === undefined ? null : req.section, sections: req.sections === undefined ? null : req.sections,
        retry: !!isRetry, fetchedAt: now(), method: ctx.method || 'mock', purpose: req.purpose || null,
        ok: !res.error, failReason: res.error || null, response: res,
      };
      s.store.push(rec);
      if (res.error && FATAL.includes(res.error)) s.stopped = res.error;
      return rec;
    }
    async function callRetryNow(req) {
      let rec = await call(req, false);
      while (rec && isRetryable(rec) && tryReserve()) rec = await call(req, true);
      return rec;
    }
    const directIds = new Set();
    const fullReq = c => (directIds.has(c.id)
      ? { kind: 'full', candidateId: c.id, candidate: c, intermediates: c.intermediates, slot: 'direct' }
      : { kind: 'full', candidateId: c.id, candidate: c, intermediates: c.intermediates });
    async function runSplit(c) {
      const k = 2 * c.n + 1;
      if (free() < k) return false;
      for (let i = 0; i < k; i++) {
        const rec = await callRetryNow({ kind: 'split', candidateId: c.id, section: i, sections: k, sectionType: i % 2 === 0 ? 'surface' : 'highway', candidate: c });
        if (!rec || !rec.ok) return false;
      }
      return true;
    }

    // ① 基準経路の成立確認
    let st = classify(s);
    if (!st.base.ok) {
      if (st.base.tried && st.base.final) return finish();
      for (const attempt of ['avoidTolls', 'avoidHighways']) {
        const rec = await callRetryNow({ kind: 'base', attempt });
        if (!rec || !rec.ok) break;
        const a = baseAcceptance(rec.response);
        if (a.ok || !a.tollPresent) break;
      }
      st = classify(s);
      if (!st.base.ok) return finish();
    }
    const baseMin = st.base.durationSec / 60;
    const pending = s.enumeration.candidates.filter(c => !st.byId.get(c.id).evaluated);
    // ①′ 直行評価枠（C7）：基準経路の直後に直行代表（最大 directSlots 件）を評価する。Bの内数で、評価済みの代表は再評価しない
    const reps = directRepresentatives(s.enumeration.candidates, baseMin, o).filter(c => !st.byId.get(c.id).evaluated);
    reps.forEach(c => directIds.add(c.id));
    const rest = orderCandidates(pending.filter(c => !directIds.has(c.id)), baseMin, ctx.priorityIds);
    const order = reps.concat(rest);

    if (profile === 'verification') {
      // 検証用配分（段階2・5）：分割優先。各候補で診断分割→全旅程評価
      for (const c of order) {
        if (s.stopped) break;
        const over = c.intermediates > o.maxIntermediates;
        if (free() < 2 * c.n + 1 + (over ? 0 : 1)) continue;
        await runSplit(c);
        if (!over) await callRetryNow(fullReq(c));
      }
    } else {
      // ② 全旅程評価・有効候補を増やす追加評価（1.2.0：②′の予約 hold を除いた範囲で）
      const retryQ = [], splitQ = [];
      hold = Math.floor(Math.max(0, Math.min(o.splitReserve || 0, free())) / 3) * 3;
      let idx = 0;
      const runSecond = async () => {
        for (; idx < order.length; idx++) {
          const c = order[idx];
          if (s.stopped || avail() < 1) break;
          if (c.intermediates > o.maxIntermediates) { splitQ.push(c); continue; } // 25点超過は分割扱い
          const rec = await call(fullReq(c), false);
          if (!rec) break;
          if (isRetryable(rec) && tryReserve()) retryQ.push(c);                 // 回復対象の発生時点で枠確保
        }
      };
      // ③ 回復見込みのある一時障害への限定的再試行
      const runRetries = async () => {
        while (retryQ.length && !s.stopped) {
          const c = retryQ.shift();
          const rec = await call(fullReq(c), true);
          if (rec && isRetryable(rec) && tryReserve()) retryQ.push(c);
        }
      };
      await runSecond(); await runRetries();
      // ②′ 分割再評価（混合方式）：対象が予約に満たなければ余りを②に返し、その後で対象を分割評価する
      if (hold > 0 && !s.stopped) {
        let tg = resplitTargets(s, baseMin);
        const back = hold - 3 * Math.min(tg.length, hold / 3);
        if (back > 0) { hold -= back; await runSecond(); await runRetries(); tg = resplitTargets(s, baseMin); }
        const k = Math.min(tg.length, hold / 3);
        hold = 0;
        for (const c of tg.slice(0, k)) {
          if (s.stopped || free() < 3) break;
          for (let i = 0; i < 3; i++) {
            const rec = await callRetryNow({ kind: 'split', purpose: 'resplit', candidateId: c.id, section: i, sections: 3, sectionType: i % 2 === 0 ? 'surface' : 'highway', candidate: c });
            if (!rec || !rec.ok) break;
          }
        }
        if (free() > 0 && !s.stopped) { await runSecond(); await runRetries(); }     // ②′で使い残した分は②に戻す
      }
      // ④ 残予算での診断用分割（2n+1区間）
      for (const c of splitQ) { if (s.stopped) break; await runSplit(c); }
    }
    return finish();

    function finish() {
      bud.reserved = 0; // 停止時に未使用の確保枠を解放
      return rank(s);
    }
  }

  // ---------------------------------------------------------------- 1.2.0 混合方式（計画 v2.6.2）
  /** 首都高（事業者名に「首都高」）の辺を含む乗車か */
  function rideHasShutoko(s, ride) {
    if (!s._edgeMap) s._edgeMap = new Map(s.graph.edges.map(e => [e.id, e]));
    return ride.path.some(id => { const e = s._edgeMap.get(id); return !!e && /首都高/.test(e.operator || ''); });
  }
  /** ②′の対象の基本条件（全旅程評価の記録 rec と候補 c）：判定不能・理由が SURF_TOLL だけ・乗車 1 回・25 点以下・首都高なし */
  function resplitEligible(s, rec, c) {
    return !!rec && rec.ok && rec.kind === 'full' && rec.response && rec.response.match === '判定不能' && rec.response.surfTollOnly === true &&
      c.n === 1 && c.intermediates <= s.options.maxIntermediates && !rideHasShutoko(s, c.rides[0]);
  }
  /** ②′の対象：推定短縮（=基準−推定所要）の大きい順、同じ入口 IC・出口 IC の対は 1 件、同点は推定円/分→ID。既に分割再評価した候補は除く */
  function resplitTargets(s, baseMin) {
    const st = classify(s);
    if (!s._edgeMap) s._edgeMap = new Map(s.graph.edges.map(e => [e.id, e]));
    const tried = new Set(s.store.filter(r => r.generation === s.generation && r.purpose === 'resplit').map(r => r.candidateId));
    const list = [];
    for (const e of st.byId.values()) {
      if (!e.evaluated || !e.rec || e.rec.kind !== 'full' || tried.has(e.c.id) || !resplitEligible(s, e.rec, e.c)) continue;
      list.push(e.c);
    }
    list.sort((a, b) => cmpNum(a.estSec, b.estSec) || cmpNum(estRatio(a, baseMin), estRatio(b, baseMin)) || cmpStr(a.id, b.id));
    const seen = new Set(), out = [];
    for (const c of list) {
      const r = c.rides[0], k = (s._edgeMap.get(r.on) || {}).ic_id + '>' + (s._edgeMap.get(r.off) || {}).ic_id;
      if (seen.has(k)) continue;
      seen.add(k); out.push(c);
    }
    return out;
  }
  /** split1 の判定（計画 v2.6.1 §C）：同じ候補・同じ世代の分割再評価 3 区間がそろい、各区間が正常、検査 A・B・D・J1・J2 合格（splitEval.verdict＝一致）。元の全旅程応答の正常性は流用しない */
  function split1Of(s, fr, sp, c) {
    if (!resplitEligible(s, fr, c) || !sp || sp.size !== 3) return null;
    const rs = [0, 1, 2].map(i => sp.get(i));
    const durOk = (r, i) => (i === 1 ? validDur(r.response) : isFiniteNum(r.response.durationSec) && r.response.durationSec >= 0);   // 一般道区間は確認できたゼロ区間（0 秒）を許す
    if (rs.some((r, i) => !r || r.purpose !== 'resplit' || !r.ok || !r.response || !durOk(r, i) || r.response.condition !== '要求充足' || r.response.fallback)) return { ok: false, why: '区間の応答不備' };
    const t = rs.map(r => r.response.toll && r.response.toll.state);
    if (t[0] !== 'free' || t[2] !== 'free') return { ok: false, why: '一般道区間に料金' };
    let C = null;
    if (t[1] === 'free') C = 0; else if (t[1] === 'priced' && isFiniteNum(rs[1].response.toll.jpy) && rs[1].response.toll.jpy >= 0) C = rs[1].response.toll.jpy;
    if (C === null) return { ok: false, why: '高速区間の料金不明' };
    const ev = rs[2].response.splitEval;
    if (!ev || ev.verdict !== '一致') return { ok: false, why: '分割評価の検査不合格' };
    return { ok: true, C, durationSec: rs.reduce((a, r) => a + r.response.durationSec, 0), rec: rs[2] };
  }

  // ---------------------------------------------------------------- 分類（ストアから現世代・同一比較条件だけを使う）
  function classify(s) {
    const o = s.options, gen = s.generation, ck = condKey(s.cond);
    const recs = s.store.filter(r => r.searchId === s.searchId && r.generation === gen && r.condKey === ck);
    const base = { ok: false, tried: false, final: false, reason: null, durationSec: null };
    let tollTried = false;
    for (const r of recs) {
      if (r.kind !== 'base') continue;
      base.tried = true;
      if (!r.ok) { base.reason = '基準経路の取得失敗（' + r.failReason + '）'; base.final = !isRetryable(r); continue; }
      const a = baseAcceptance(r.response);
      if (a.ok) { base.ok = true; base.durationSec = r.response.durationSec; base.reason = null; break; }
      base.reason = a.reason;
      if (a.tollPresent && r.attempt === 'avoidHighways') { base.reason = 'avoidHighwaysでも有料道路を含む'; base.final = true; }
      else if (a.tollPresent) tollTried = true;
      else base.final = true;
    }
    const full = new Map(), splits = new Map(), touched = new Set();
    for (const r of recs) {
      if (r.kind === 'full') { full.set(r.candidateId, r); touched.add(r.candidateId); }
      else if (r.kind === 'split') {
        touched.add(r.candidateId);
        if (!splits.has(r.candidateId)) splits.set(r.candidateId, new Map());
        splits.get(r.candidateId).set(r.section, r);
      }
    }
    const byId = new Map();
    for (const c of s.enumeration.candidates) {
      const fr = full.get(c.id);
      const sp = splits.get(c.id);
      const k = 2 * c.n + 1;
      let splitOk = false, splitSec = 0;
      if (sp && sp.size === k) {
        splitOk = true;
        for (let i = 0; i < k; i++) { const r = sp.get(i); if (!r || !r.ok || !validDur(r.response)) { splitOk = false; break; } splitSec += r.response.durationSec; }
      }
      const e = { c, attempted: touched.has(c.id), evaluated: false, kind: null, reasons: [], pendingReason: null };
      if (fr && !isRetryable(fr)) {
        e.evaluated = true; e.kind = 'full'; e.rec = fr;
        Object.assign(e, entryCheck(fr, c));
        const s1 = sp && Array.from(sp.values()).some(r => r.purpose === 'resplit') ? split1Of(s, fr, sp, c) : null;   // 1.2.0 混合方式
        if (s1 && s1.ok) {
          e.kind = 'split1'; e.split1 = true; e.rec = s1.rec; e.C = s1.C; e.durationSec = s1.durationSec; e.td = tdLabel(fr.response.timeDependency);
          e.reasons = c.restrictionUnresolved ? ['通行条件未確認（同梱データに未解決の通行条件）'] : [];
        } else if (s1) e.reasons = e.reasons.concat(['分割再評価で確認できず（' + s1.why + '）']);
      } else if (splitOk) {
        e.evaluated = true; e.kind = 'split'; e.durationSec = splitSec;
        e.reasons = ['全旅程料金未検証（分割評価・診断用：中間地点' + c.intermediates + '点＞' + o.maxIntermediates + '）'];
      } else if (fr) e.pendingReason = '一時障害（再試行上限または予算到達）';
      else if (sp) e.pendingReason = '分割評価未完了';
      else if (c.intermediates > o.maxIntermediates) e.pendingReason = '分割扱い（中間地点' + c.intermediates + '点）・予算内で未実施';
      else e.pendingReason = '未評価';
      byId.set(c.id, e);
    }
    return { base, byId, tollTried, recs };
  }

  // ---------------------------------------------------------------- 順位
  function rank(s) {
    const o = s.options;
    const st = classify(s);
    const en = s.enumeration;
    const all = Array.from(st.byId.values());
    const attempted = all.filter(e => e.attempted).length;
    const evaluated = all.filter(e => e.evaluated);
    const unevaluated = all.length - evaluated.length;
    const rep = {
      searchId: s.searchId, generation: s.generation, cond: s.cond,
      baseOk: st.base.ok, baseReason: st.base.reason, baseMin: st.base.ok ? st.base.durationSec / 60 : null,
      enumComplete: en.complete, truncated: en.truncated, enumerated: all.length,
      attempted, evaluated: evaluated.length, unevaluated, comparable: 0, unverified: 0,
      main: [], beyondTop: [], others: [], pending: all.filter(e => !e.evaluated).map(e => ({ id: e.c.id, reason: e.pendingReason })),
      budget: Object.assign({}, s.budget, { waitsMs: s.budget.waitsMs.slice() }), stopped: s.stopped,
      prioritized: !!(s.gens[s.generation] && s.gens[s.generation].prioritized), status: null,
    };
    if (!st.base.ok) {
      rep.status = 'base_failed';
      rep.lines = formatLines(s, rep);
      return rep;
    }
    const Tb = rep.baseMin;
    const dpop = directPopulation(en.candidates, o);
    rep.direct = { population: dpop.length, reps: directRepresentatives(en.candidates, Tb, o).map(c => c.id) };
    const ranked = [];
    for (const e of evaluated) {
      if (e.reasons.length) { rep.others.push({ id: e.c.id, reasons: e.reasons.slice(), durationSec: e.durationSec || null }); continue; }
      rep.comparable++;
      const Tc = e.durationSec / 60;
      const d = Tb - Tc;
      if (!(d > 0)) { rep.others.push({ id: e.c.id, reasons: ['短縮なし（分母≤0のため円/分の対象外）'], durationSec: e.durationSec, comparable: true }); continue; }
      ranked.push({ id: e.c.id, C: e.C, Tmin: Tc, savingMin: d, yenPerMin: e.C / d, td: e.td, generation: e.rec.generation, recSeq: e.rec.seq, split1: !!e.split1 });
    }
    ranked.sort((a, b) => cmpNum(a.yenPerMin, b.yenPerMin) || cmpNum(b.savingMin, a.savingMin) || cmpStr(a.id, b.id));
    rep.main = ranked.slice(0, o.topN);
    rep.beyondTop = ranked.slice(o.topN);
    rep.unverified = attempted - rep.comparable;
    if (s.stopped) rep.status = 'stopped';
    else if (!en.complete) rep.status = 'incomplete_enum';
    else if (unevaluated > 0) rep.status = 'partial_eval';
    else rep.status = 'complete';
    rep.lines = formatLines(s, rep);
    return rep;
  }

  // ---------------------------------------------------------------- 表示文言
  function candidateLabel(s, id) {
    const en = s.enumeration;
    const c = en.candidates.find(x => x.id === id);
    if (!c) return id;
    const ic = eid => { const e = en.edgeIndex.get(eid); return (e && (en.icName.get(e.ic_id) || e.ic_id)) || eid; };
    return c.rides.map(r => {
      const via = r.fare.filter(f => f !== r.on && f !== r.off).map(f => { const e = en.edgeIndex.get(f); return (e && e.road) || f; });
      const uniq = via.filter((v, i) => via.indexOf(v) === i);
      return ic(r.on) + '→' + ic(r.off) + (uniq.length ? '〔経由：' + uniq.join('・') + '〕' : '');
    }).join(' ／ ');
  }
  function hhmm(t) { const m = /T(\d{2}:\d{2})/.exec(String(t || '')); return m ? m[1] : String(t); }
  function fmtRatio(x) { return x.toFixed(2); }

  function formatLines(s, rep) {
    const L = [];
    const m = s.graph.meta || {};
    L.push('対象：同梱高速道路網（基準日' + (m.baseDate || '不明') + '・路線数' + (m.roads == null ? '不明' : m.roads) + '・乗降点数' + (m.rampPoints == null ? '不明' : m.rampPoints) + '）。収録外の道路は検討していません');
    L.push('出発' + hhmm(s.cond.departureTime) + 'におけるAPI推定値（評価世代' + rep.generation + '）');
    L.push('一般道接続区間はGoogle最速1本に集約する近似方式です（失われる選択肢があります）');
    if (rep.status === 'base_failed') {
      L.push('基準経路不成立：円/分ランキングを生成しません（' + (rep.baseReason || '基準経路未取得') + '）');
      return L;
    }
    if (rep.stopped) L.push('評価停止：' + (FATAL_LABEL[rep.stopped] || rep.stopped) + '。以降のAPI評価を行っていません');
    if (!rep.enumComplete) {
      L.push('探索未完了（' + (rep.truncated === 'time' ? '時間上限' : 'ラベル上限' + s.options.maxLabels) + 'に到達）：未探索部分あり。残り経路数は未算定');
      L.push('列挙済み' + rep.enumerated + '経路中、評価済み' + rep.evaluated + '経路の暫定上位' + Math.min(rep.main.length, s.options.topN) + '件');
    } else if (rep.unevaluated > 0) {
      if (rep.generation > 1 && rep.prioritized) L.push('新時刻で再評価した' + rep.evaluated + '件の順位（未再評価候補あり）');
      else L.push('評価済み' + rep.evaluated + '経路中の暫定上位' + s.options.topN + '件（未評価' + rep.unevaluated + '件）');
    } else {
      L.push('探索範囲内で完了');
    }
    if (rep.direct && rep.direct.population === 0 && (s.options.directSlots === undefined ? DEFAULTS.directSlots : s.options.directSlots) > 0) {
      L.push('直行候補なし（最寄りIC間の乗車は通行条件未確認のため主ランキング対象外）');
    }
    L.push('同一条件で比較可能な' + rep.comparable + '経路中の暫定上位' + rep.main.length + '件（評価試行' + rep.attempted + '件、比較可能' + rep.comparable + '件、未検証' + rep.unverified + '件）');
    rep.main.forEach((r, i) => {
      L.push((i + 1) + '. ' + candidateLabel(s, r.id) + '　' + fmtRatio(r.yenPerMin) + '円/分（¥' + r.C + '・' + (Math.round(r.Tmin * 10) / 10) + '分・短縮' + (Math.round(r.savingMin * 10) / 10) + '分）' + (r.td ? '［' + r.td + '］' : '') + (r.split1 ? '［分割評価で確認（区間料金）］' : ''));
    });
    if (rep.main.length < s.options.topN) {
      const why = ['比較可能で短縮のある候補が' + rep.main.length + '件のみ'];
      if (rep.others.length) why.push('別枠' + rep.others.length + '件');
      if (rep.unevaluated) why.push('未評価' + rep.unevaluated + '件');
      L.push('主ランキングは' + rep.main.length + '件（' + s.options.topN + '件に満たない理由：' + why.join('、') + '）');
    }
    if (rep.others.length) {
      L.push('別枠（主ランキング外）：');
      for (const x of rep.others) L.push('- ' + candidateLabel(s, x.id) + '：' + x.reasons.join('／'));
    }
    return L;
  }

  const api = {
    VERSION, SCHEMA, DEFAULTS, NODE_TYPES, SURFACE_TYPES, EDGE_KINDS, RETRYABLE, FATAL,
    haversineM, canonicalId, validateGraph, enumerate, createSearch, updateDepartureTime,
    evaluate, rank, classify, condKey, orderCandidates, directRepresentatives, directPopulation, candidateLabel, baseAcceptance,
    resplitTargets, resplitEligible, split1Of, rideHasShutoko,
  };
  root.RFEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
