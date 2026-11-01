#!/usr/bin/env node
/*
 * build_graph.js — ルートファインダー v7 「方向付きランプDB」生成器（小グラフ region:"small"）
 * 仕様の出典：ルートファインダー v7 計画 v5.1（追補が本文に優先）、探索器 engine.js の README（§2 データモデル・§13 必須スキーマ・§14 未確定事項）。
 * 外部依存なし（Node 標準のみ）。ネット接続しない。入力・出力のパスはすべて引数で受ける。
 *
 * 使い方:
 *   node build_graph.js --osm <osm_small.json> --n06 <n06_small.json> --out <出力ディレクトリ> [--sapa <osm_sapa.json>]
 *   --sapa（任意、段階5a-1′）：SA/PA 6施設の場内通路（service・motorway_link、geometry 付き）。指定すると SA/PA 接続辺の geom を
 *   実在する場内通路の形状で SA/PA 側の端点まで延ばす。指定しない場合の出力は 5a-1 時点と同一（バイト一致）
 *
 * 出力（--out 配下）:
 *   graph_small.osm-only.json  OSM のみから作ったグラフ（N06 照合前、ODbL）
 *   graph_small.json           N06 照合後（ic_id・koj 付与、結合後は ODbL として扱う）。辺に geom・via_heading を含む
 *   graph_small.app.json       アプリ用の軽量版（osm サブオブジェクト等を落とし、geom・via_heading を残す。整形なし）。
 *                              配布名は graph-small.app.json（地域ファイル名規約 graph-<region>.app.json）
 *   ic_match.json              OSM側IC群 ⇔ N06 接合部の対応表（N06の名称・IDを含む照合結果）
 *   unmatched.json             N06 と照合できなかったランプ（理由付き）
 *   build_report.json          除外・境界・異常・パラメータの記録（検証用）
 *
 * 辺ジオメトリ geom と via_heading（段階5a-1 追補）:
 *   geom        辺の道路形状。OSM way の形状を 5 m 許容（Douglas-Peucker）で簡略化し、辺の from→to の進行方向順に並べ、
 *               Google 符号化ポリライン（精度 1e5）の文字列にしたもの。--sapa なしでは SA/PA 端は OSM 上の接続点で終わる
 *               （SA/PA ノードの代表点までは含めない。length_m にはその近似距離が加わっている）。
 *               --sapa あり：SA/PA 接続辺（16 本）は接続点から場内通路（service・motorway_link）を一方通行の向きに従ってたどった
 *               実形状で SA/PA 側の端点（代表点に最も近い到達可能な通路上の頂点）まで続く。直線補間はしない
 *   geom_gap    --sapa ありのみ。場内通路の形状で埋まらない区間がある辺に true（区間の長さ・理由は geom_gap_info）。なければ項目なし
 *   via_heading via 点の前後 30 m の OSM way 形状から求めた進行方向の方位（度、北=0 の時計回り、整数 0〜359）。via を持つ辺のみ
 */
'use strict';
const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------------ 引数
function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) { a[k.slice(2)] = argv[i + 1]; i++; }
  }
  if (!a.osm || !a.n06 || !a.out) {
    console.error('usage: node build_graph.js --osm <osm_small.json> --n06 <n06_small.json> --out <outdir> [--sapa <osm_sapa.json>]');
    process.exit(2);
  }
  return a;
}

// ------------------------------------------------------------------ 定数（除外基準・範囲）
const PARAMS = Object.freeze({
  // 対象路線（本線 way の判定）
  roads: {
    tomei: { label: '東名高速道路', n06: '第一東海自動車道', operator: 'NEXCO中日本', dirPos: '上り', dirNeg: '下り',
             // 「上り」方向ベクトル：厚木IC付近 → 東京IC付近
             a: { lat: 35.4237, lng: 139.3630 }, b: { lat: 35.6280, lng: 139.6202 } },
    ken:   { label: '首都圏中央連絡自動車道（圏央道）', n06: '首都圏中央連絡自動車道', operator: 'NEXCO中日本', dirPos: '外回り', dirNeg: '内回り',
             // 「外回り」方向ベクトル：寒川北IC → 相模原愛川IC（北向き）。OSM の「厚木PA/スマートIC（外回り）」分流点の向きで検証する
             a: { lat: 35.3846, lng: 139.3786 }, b: { lat: 35.5231, lng: 139.3538 } },
    c3:    { label: '首都高速3号渋谷線', n06: '首都高速3号渋谷線', operator: '首都高速道路', dirPos: '上り', dirNeg: '下り',
             // 「上り」方向ベクトル：用賀 → 谷町JCT（都心方向）
             a: { lat: 35.6268, lng: 139.6291 }, b: { lat: 35.6666, lng: 139.7385 } },
  },
  // 本線ノードの範囲（範囲外ノードを含む本線区間は除外）
  range: {
    tomei: { lngMin: 139.30 },                 // bbox 西端。伊勢原JCT 分合流（139.3033）を含む
    ken:   { latMin: 35.375, latMax: 35.535 }, // 寒川北IC最南の接続点 35.3814 の南、相模原愛川IC最北の接続点 35.5249 の北
    c3:    {},                                 // 谷町JCT（都心環状線との境界）で終わる
  },
  bbox: { latMin: 35.38, lngMin: 139.30, latMax: 35.68, lngMax: 139.76 },
  // 一般道として扱う touch way の highway 値（アクセス no/private は除外）
  surfaceHighway: ['primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'trunk', 'primary_link',
                   'secondary_link', 'tertiary_link', 'trunk_link', 'living_street', 'road'],
  serviceHighway: ['service'],
  ignoredAccess: ['no', 'private'],
  sapaMergeM: 800,       // 入口のみ／出口のみの service 群を同一SA/PAとみなす最大距離（中間通路がOverpass抽出外のため）
  pathCapPerStart: 400,  // ランプ経路列挙の上限（1始点あたり）
  icMatch: { nameMaxM: 3000, distOnlyMaxM: 1500, ambiguityRatio: 1.5, primaryRouteM: 50 },
  minUniqueViaM: 30,     // 区別用 via を置く固有区間の最小長
  geom: { simplifyM: 5, precision: 5 },   // 辺ジオメトリ：Douglas-Peucker の許容誤差[m]、符号化ポリラインの精度（1e-5 度）
  headingWindowM: 30,    // via_heading：via 点の前後この距離の形状から方位を求める
});
// 地域分割（Tak 決定 2026-11-01）：地域キー・版・配布名は meta に持たせる。将来 graph-kanto.app.json 等を追加し、アプリは必要地域だけ読む
const REGION = 'small';
const GRAPH_REV = 1;     // 生成ロジックの改訂番号（出力が変わる変更をしたら上げる）
const APP_FORMAT = 'rf-graph-app/1';
const APP_FILE = 'graph-' + REGION + '.app.json';

const ID_RE = /^[A-Za-z0-9_.:\-]+$/;

// ------------------------------------------------------------------ 幾何
function hav(a, b) { // engine.js と同じ式（R=6371008.8）
  const R = 6371008.8, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
function vec(a, b) { const k = Math.cos((a.lat + b.lat) / 2 * Math.PI / 180); return { x: (b.lng - a.lng) * k, y: b.lat - a.lat }; }
function dot(u, v) { return u.x * v.x + u.y * v.y; }
function polyLen(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += hav(pts[i - 1], pts[i]); return s; }
function pointAt(pts, dist) { // 折れ線上で始点から dist[m] の点
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = hav(pts[i - 1], pts[i]);
    if (acc + d >= dist && d > 0) {
      const t = (dist - acc) / d;
      return { lat: +(pts[i - 1].lat + t * (pts[i].lat - pts[i - 1].lat)).toFixed(7), lng: +(pts[i - 1].lng + t * (pts[i].lng - pts[i - 1].lng)).toFixed(7) };
    }
    acc += d;
  }
  const p = pts[pts.length - 1]; return { lat: p.lat, lng: p.lng };
}
const r1 = x => Math.round(x * 10) / 10;

// ------------------------------------------------------------------ 辺ジオメトリ（geom）と via_heading
const M_PER_DEG = 6371008.8 * Math.PI / 180;   // hav と同じ地球半径
/** Douglas-Peucker（反復版）。両端は必ず残す。除いた点はすべて、残した折れ線から tolM 以内 */
function simplifyDP(pts, tolM) {
  const n = pts.length; if (n <= 2) return pts.slice();
  const k = Math.cos(pts[0].lat * Math.PI / 180);
  const xy = pts.map(p => ({ x: (p.lng - pts[0].lng) * k * M_PER_DEG, y: (p.lat - pts[0].lat) * M_PER_DEG }));
  const keep = new Uint8Array(n); keep[0] = 1; keep[n - 1] = 1;
  const st = [[0, n - 1]];
  while (st.length) {
    const [i, j] = st.pop(); const a = xy[i], b = xy[j];
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    let md = -1, mi = -1;
    for (let m = i + 1; m < j; m++) {
      const p = xy[m]; let d;
      if (L2 === 0) d = Math.hypot(p.x - a.x, p.y - a.y);
      else { const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)); d = Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy); }
      if (d > md) { md = d; mi = m; }
    }
    if (md > tolM) { keep[mi] = 1; st.push([i, mi], [mi, j]); }
  }
  return pts.filter((_, i) => keep[i]);
}
/** Google 符号化ポリライン（精度 10^prec）。連続する同一点（丸め後）は1点にまとめる（2点未満にはしない） */
function encodePolyline(pts, prec) {
  const f = Math.pow(10, prec == null ? 5 : prec);
  const ll = pts.map(p => [Math.round(p.lat * f), Math.round(p.lng * f)]);
  const u = ll.filter((q, i) => i === 0 || q[0] !== ll[i - 1][0] || q[1] !== ll[i - 1][1]);
  if (u.length < 2) u.push(u[0].slice());
  const enc = v => { v = v < 0 ? ~(v << 1) : (v << 1); let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  let out = '', pa = 0, pb = 0;
  for (const q of u) { out += enc(q[0] - pa) + enc(q[1] - pb); pa = q[0]; pb = q[1]; }
  return { str: out, points: u.length };
}
/** 折れ線上で点 pt に最も近い位置の、始点からの距離[m]（局所平面近似の射影） */
function alongPolyline(pts, pt) {
  let acc = 0, best = Infinity, bestS = 0;
  const k = Math.cos(pt.lat * Math.PI / 180);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const ax = (a.lng - pt.lng) * k * M_PER_DEG, ay = (a.lat - pt.lat) * M_PER_DEG, bx = (b.lng - pt.lng) * k * M_PER_DEG, by = (b.lat - pt.lat) * M_PER_DEG;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2));
    const d = Math.hypot(ax + t * dx, ay + t * dy), seg = hav(a, b);
    if (d < best) { best = d; bestS = acc + t * seg; }
    acc += seg;
  }
  return { s: bestS, d: best, total: acc };
}
/** 方位[度]（北=0、時計回り、0 以上 360 未満の整数）。a→b */
function bearingDeg(a, b) {
  const k = Math.cos((a.lat + b.lat) / 2 * Math.PI / 180);
  const x = (b.lng - a.lng) * k, y = b.lat - a.lat;
  const deg = Math.atan2(x, y) * 180 / Math.PI;
  return Math.round((deg + 360) % 360) % 360;
}
/** via 点での進行方向の方位：折れ線上の via の前後 windowM の2点を結ぶ（端は折れ線の端で打ち切る） */
function headingAtVia(pts, via, windowM) {
  const al = alongPolyline(pts, via);
  const p1 = pointAt(pts, Math.max(0, al.s - windowM)), p2 = pointAt(pts, Math.min(al.total, al.s + windowM));
  return { heading: bearingDeg(p1, p2), via_offset_m: al.d, span_m: Math.min(al.total, al.s + windowM) - Math.max(0, al.s - windowM) };
}

// ------------------------------------------------------------------ SA/PA 場内通路（段階5a-1′、--sapa 指定時のみ）
// 入力 osm_sapa.json：6 施設×半径 600 m の service・motorway_link（geometry 付き）。osm_small.json の service way は geometry を持たないため、
// 本体とは別に読み、SA/PA 接続辺の geom を場内通路の実形状で延ばすためだけに使う（本体のグラフ構築ロジックには入れない）
const SAPA_QUERY = 'osm_query_sapa.overpassql';
const SAPA_PARAMS = Object.freeze({
  usableHighway: ['service', 'motorway_link'],   // 場内通路として使う way
  deniedAccess: ['no', 'private'],               // access / motor_vehicle / motorcar / vehicle がこれらの way は使わない
  candidateRadiusM: 250,   // SA/PA 側の端点の候補（場内通路の頂点）を探す、SA/PA ノード（代表点）からの半径[m]
  ratioMin: 0.9, ratioMax: 1.1,   // 辺の長さの整合範囲：(geom の長さ)/length_m。端点を選ぶとき、この範囲に入る辺が最も多い頂点を優先する（verify_graph の検査と同じ範囲）
  gapEndM: 100,            // 端点から代表点までの直線距離がこれを超えたら geom_gap（計画の FAR_M＝100 m。これ以内なら照合の「遠い」判定に影響しない）
  gapJointM: 25,           // 同一施設で辺ごとに端点が分かれ、実在経路が両方を経由するとき、端点間距離がこれを超えたら geom_gap
});
/** osm_sapa.json から場内通路の有向グラフを作る。way の向きは build と同じ規則（oneway タグ、motorway_link は未指定なら順方向、service は未指定なら双方向） */
function buildPassages(doc) {
  const pos = new Map(), fwd = new Map(), rev = new Map(), used = new Map(), skipped = [];
  const push = (m, k, v) => { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); };
  for (const w of doc.elements) {
    if (w.type !== 'way' || !Array.isArray(w.geometry) || !w.tags || !SAPA_PARAMS.usableHighway.includes(w.tags.highway)) continue;
    const t = w.tags;
    if ([t.access, t.motor_vehicle, t.motorcar, t.vehicle].some(x => SAPA_PARAMS.deniedAccess.includes(x))) { skipped.push(w.id); continue; }
    used.set(w.id, w);
    const ow = t.oneway;
    const ds = (ow === 'yes' || ow === 'true' || ow === '1') ? [1] : (ow === '-1' || ow === 'reverse') ? [-1] : (ow === 'no' || ow === 'false' || ow === '0') ? [1, -1] : (t.highway === 'motorway_link' ? [1] : [1, -1]);
    w.nodes.forEach((n, i) => pos.set(n, { lat: w.geometry[i].lat, lng: w.geometry[i].lon }));
    for (let i = 1; i < w.nodes.length; i++) {
      const a = w.nodes[i - 1], b = w.nodes[i], l = hav(pos.get(a), pos.get(b));
      for (const d of ds) { const [x, y] = d === 1 ? [a, b] : [b, a]; push(fwd, x, { to: y, l, way: w.id }); push(rev, y, { to: x, l, way: w.id }); }
    }
  }
  return { pos, fwd, rev, ways: used, skippedWays: skipped };
}
/** 単一始点の最短距離（隣接表 adj：node → [{to, l, way}]）。同距離は節点 ID の小さい順で確定する。戻り値 dist: Map(node → m)、pred: Map(node → {from, way}) */
function shortestFrom(adj, src) {
  const dist = new Map([[src, 0]]), pred = new Map(), done = new Set();
  const heap = [[0, src]];
  const less = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  const up = i => { while (i > 0) { const p = (i - 1) >> 1; if (less(heap[i], heap[p])) { [heap[i], heap[p]] = [heap[p], heap[i]]; i = p; } else break; } };
  const down = i => { for (;;) { let m = i; const l = 2 * i + 1, r = l + 1; if (l < heap.length && less(heap[l], heap[m])) m = l; if (r < heap.length && less(heap[r], heap[m])) m = r; if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; } };
  while (heap.length) {
    const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; down(0); }
    const [d, u] = top; if (done.has(u)) continue; done.add(u);
    for (const x of (adj.get(u) || [])) {
      const nd = d + x.l;
      if (!dist.has(x.to) || nd < dist.get(x.to) - 1e-9) { dist.set(x.to, nd); pred.set(x.to, { from: u, way: x.way }); heap.push([nd, x.to]); up(heap.length - 1); }
    }
  }
  return { dist, pred };
}
/**
 * SA/PA ノードに接する辺（edges のうち from か to が type:'sapa'）の geom を場内通路の実形状で延ばす計画を作る。
 *  - 辺ごとに接続点（OSM ノード）を求める：SA/PA へ入る辺は osm.end_node、SA/PA から出る辺は osm.start_node
 *  - 入る辺は接続点から前方（一方通行の向きに従う）、出る辺は後方（その点から接続点へ行ける）に通路をたどる
 *  - SA/PA 側の端点は、通路上の頂点のうち SA/PA ノード（代表点）から半径 candidateRadiusM 以内で、向きの条件（入る辺なら到達でき、出る辺なら
 *    接続点へ行ける）を満たす辺が同一施設で最も多い頂点を選ぶ（同数なら、辺の長さ比 geom/length_m が [ratioMin, ratioMax] に入る辺が多い順、
 *    さらに代表点に近い順）。満たせない辺が残れば、残りだけでもう一度選ぶ（端点が分かれる）。長さ比は verify_graph で報告
 *  - 端点から代表点までの直線区間は通路ではないので geom に入れない（直線補間はしない）。その距離が gapEndM を超える辺、
 *    端点が分かれて実在経路が端点間を渡る辺（端点間 > gapJointM）、通路をたどれない辺は geom_gap
 * 戻り値 plan: Map(edgeId → { ext: [{lat,lng}...], info, gap })（ext は接続点を含まない通路上の点列。入る辺は接続点の次から端点まで、出る辺は端点から接続点の手前まで）
 */
function planSapaGeom(edges, nodes, P, passages) {
  const plan = new Map();
  const rep = { facilities: [], max_conn_pos_diff_m: 0 };
  const byFac = new Map();
  for (const e of edges) {
    const a = nodes.get(e.from), b = nodes.get(e.to);
    if (!a || !b || (a.type !== 'sapa' && b.type !== 'sapa')) continue;
    const isOut = a.type === 'sapa', sp = isOut ? a : b;
    const conn = isOut ? e.osm.start_node : e.osm.end_node;
    if (!byFac.has(sp.id)) byFac.set(sp.id, { sp, es: [] });
    byFac.get(sp.id).es.push({ e, isOut, conn });
  }
  const connOk = c => passages.pos.has(c);
  for (const fid of [...byFac.keys()].sort()) {
    const { sp, es } = byFac.get(fid);
    es.sort((x, y) => x.e.id < y.e.id ? -1 : 1);
    for (const x of es) { x.fd = connOk(x.conn) ? shortestFrom(passages.fwd, x.conn) : null; x.rd = connOk(x.conn) ? shortestFrom(passages.rev, x.conn) : null; }
    for (const x of es) if (connOk(x.conn)) rep.max_conn_pos_diff_m = Math.max(rep.max_conn_pos_diff_m, hav(P(x.conn), passages.pos.get(x.conn)));
    const cands = [...passages.pos.keys()].filter(n => hav(passages.pos.get(n), sp) <= SAPA_PARAMS.candidateRadiusM).sort((p, q) => p - q);
    // 端点の選択：頂点 v まで（または v から）通路で行ける辺の数が最も多い v を選ぶ（同数なら、辺の長さ比 (接続点までの形状＋通路)/length_m が
    // [ratioMin, ratioMax] に入る辺の数が多い順、さらに同じなら代表点に近い順、さらに同じなら節点 ID の小さい順）。選ばれた辺は 1 グループ。
    // 残った辺だけで同じ選択を繰り返す。通路で行ける頂点が候補にない辺は unreachable（geom_gap）。同じ施設の辺は、できるだけ 1 つの端点を共有させる
    // （端点が分かれると入る辺と出る辺の geom が端点間で途切れるため）
    const ratioAt = (x, v) => { const d = (x.isOut ? x.rd : x.fd).dist.get(v); return d === undefined ? null : (x.e.length_m - (x.e.osm.approx_service_m || 0) + d) / x.e.length_m; };
    const okAt = (x, v) => { const r = ratioAt(x, v); return r !== null && r >= SAPA_PARAMS.ratioMin && r <= SAPA_PARAMS.ratioMax; };
    let remaining = es.filter(x => x.fd), groups = [];
    const unreachable = es.filter(x => !x.fd);
    while (remaining.length) {
      let best = null;
      for (const v of cands) {
        const comp = remaining.filter(x => (x.isOut ? x.rd : x.fd).dist.has(v));
        if (!comp.length) continue;
        const ok = comp.filter(x => okAt(x, v)).length, dc = hav(passages.pos.get(v), sp);
        if (!best || comp.length > best.comp.length || (comp.length === best.comp.length && (ok > best.ok || (ok === best.ok && dc < best.dc - 1e-9)))) best = { v, comp, ok, dc };
      }
      if (!best) break;
      groups.push({ end: best.v, dc: best.dc, members: best.comp, fit: best.ok === best.comp.length }); remaining = remaining.filter(x => !best.comp.includes(x));
    }
    unreachable.push(...remaining);
    const grpOf = new Map(); groups.forEach((g, i) => g.members.forEach(x => grpOf.set(x, i)));
    // 辺ごとの通路（接続点→端点）
    for (const x of es) {
      const gi = grpOf.get(x);
      const rec = { id: x.e.id, kind: x.e.kind, conn: x.conn, isOut: x.isOut, gap: [], group: gi === undefined ? null : gi };
      if (gi === undefined) {
        rec.gap.push({ length_m: x.e.osm.approx_service_m, reason: '接続点（OSM ノード ' + x.conn + '）から場内通路（service・motorway_link）を一方通行の向きに従ってたどって、代表点から ' + SAPA_PARAMS.candidateRadiusM + ' m 以内の頂点に行ける経路がない' });
        plan.set(x.e.id, { ext: [], info: null, gap: rec.gap, rec }); continue;
      }
      const g = groups[gi];
      const nodesSeq = [], waysSeq = [];
      if (!x.isOut) { // 接続点 → 端点（前方）
        let cur = g.end; const back = [];
        while (cur !== x.conn) { const pr = x.fd.pred.get(cur); back.push({ n: cur, way: pr.way }); cur = pr.from; }
        back.reverse(); for (const b of back) { nodesSeq.push(b.n); waysSeq.push(b.way); }
      } else { // 端点 → 接続点（後方。rd は逆向きグラフなので pred.from は接続点側の次の頂点）
        let cur = g.end; nodesSeq.push(cur);
        while (cur !== x.conn) { const pr = x.rd.pred.get(cur); nodesSeq.push(pr.from); waysSeq.push(pr.way); cur = pr.from; }
        nodesSeq.pop(); // 接続点自身は含めない
      }
      const pathM = (x.isOut ? x.rd : x.fd).dist.get(g.end);
      const ext = nodesSeq.map(n => ({ lat: passages.pos.get(n).lat, lng: passages.pos.get(n).lng }));
      rec.end_node = g.end; rec.path_m = pathM; rec.end_to_sapa_m = g.dc;
      const info = { end_node: g.end, end_lat: passages.pos.get(g.end).lat, end_lng: passages.pos.get(g.end).lng, path_m: r1(pathM), ways: [...new Set(waysSeq)], end_to_sapa_m: r1(g.dc), group: gi };
      if (g.dc > SAPA_PARAMS.gapEndM) rec.gap.push({ length_m: g.dc, reason: '場内通路上の端点（OSM ノード ' + g.end + '）から SA/PA の代表点まで ' + r1(g.dc) + ' m（>' + SAPA_PARAMS.gapEndM + ' m）通路がない' });
      plan.set(x.e.id, { ext, info, gap: rec.gap, rec });
    }
    // 端点が分かれる施設：実在経路（入る辺の接続点から出る辺の接続点へ通路で行ける組）が端点間を渡る長さ
    const joints = [];
    if (groups.length > 1) {
      for (const xi of es.filter(q => !q.isOut && q.fd)) for (const xo of es.filter(q => q.isOut && q.fd)) {
        const d = xi.fd.dist.get(xo.conn); const gi = grpOf.get(xi), go = grpOf.get(xo);
        if (d === undefined || gi === undefined || go === undefined || gi === go) continue;
        const jump = hav(passages.pos.get(groups[gi].end), passages.pos.get(groups[go].end));
        joints.push({ in_edge: xi.e.id, out_edge: xo.e.id, real_route_m: r1(d), end_in: groups[gi].end, end_out: groups[go].end, jump_m: r1(jump) });
        if (jump > SAPA_PARAMS.gapJointM) for (const q of [xi, xo]) plan.get(q.e.id).gap.push({ length_m: jump, reason: '同じ SA/PA の入る辺と出る辺で場内通路上の端点が分かれ（' + groups[gi].end + ' と ' + groups[go].end + '）、実在経路（接続点間 ' + r1(d) + ' m）が端点間 ' + r1(jump) + ' m（>' + SAPA_PARAMS.gapJointM + ' m）を渡る' });
      }
    }
    rep.facilities.push({ sapa: fid, name: sp.name, edges: es.map(q => q.e.id), groups: groups.map(g => ({ end_node: g.end, end_to_sapa_m: r1(g.dc), all_edges_ratio_in_range: g.fit, edges: g.members.map(q => q.e.id) })),
      unreachable: unreachable.map(q => q.e.id), joints,
      // 入る辺と出る辺の組ごとの、場内通路上の最短経路（接続点間）と、geom をつないだときの経路の長さ・遠回り（端点が分かれる場合は端点間の直線を含む）
      pairs: es.filter(q => !q.isOut && q.fd).flatMap(xi => es.filter(q => q.isOut).map(xo => {
        const d = xi.fd.dist.get(xo.conn), pi = plan.get(xi.e.id), po = plan.get(xo.e.id);
        if (d === undefined) return { in_edge: xi.e.id, out_edge: xo.e.id, passage_m: null, note: '場内通路（一方通行の向き）で接続点間をつなげない' };
        if (!pi || !po || !pi.info || !po.info) return { in_edge: xi.e.id, out_edge: xo.e.id, passage_m: r1(d) };
        const jump = pi.info.end_node === po.info.end_node ? 0 : hav(passages.pos.get(pi.info.end_node), passages.pos.get(po.info.end_node));
        return { in_edge: xi.e.id, out_edge: xo.e.id, passage_m: r1(d), geom_route_m: r1(pi.info.path_m + po.info.path_m + jump), detour_m: r1(pi.info.path_m + po.info.path_m + jump - d) };
      })) });
  }
  for (const p of plan.values()) if (p.gap.length) {
    const len = Math.max(...p.gap.map(q => q.length_m));
    p.gapInfo = { length_m: r1(len), reason: p.gap.map(q => q.reason).join('；') };
  }
  return { plan, rep };
}

// ------------------------------------------------------------------ 名称正規化
function nfkc(s) { return (s || '').normalize('NFKC').replace(/\s+/g, ''); }
/** OSM/N06 の名称から照合用の基底名を作る（例：「厚木PA/スマートIC（内回り）」→ ['厚木']、「東京IC」→ ['東京']） */
function baseNames(raw) {
  if (!raw) return [];
  let s = nfkc(raw).replace(/\([^)]*\)/g, '');
  const parts = s.split(/[\/・;]/).map(x => x.trim()).filter(Boolean);
  const out = new Set();
  for (let p of parts) {
    for (let k = 0; k < 3; k++) {
      p = p.replace(/(スマートインターチェンジ|インターチェンジ|ジャンクション|スマートIC|SIC|IC|JCT|出入口|出口|入口|料金所|北側|南側|PA|SA|パーキングエリア|サービスエリア)$/u, '');
    }
    if (p && !/^(スマート|第[0-9１-９]+出口)$/.test(p)) out.add(p);
  }
  return [...out];
}
/** ランプの IC 名根拠用：「…JCT」の部分は IC 名ではないので除く（例：「横浜青葉JCT/横浜青葉出口」→ ['横浜青葉']、「海老名JCT」→ []） */
function rampNameBases(raw) {
  if (!raw) return [];
  const parts = nfkc(raw).replace(/\([^)]*\)/g, '').split(/[\/・;]/).filter(p => p && !/(JCT|ジャンクション)$/.test(p));
  return [...new Set(parts.flatMap(p => baseNames(p)))];
}
function isSmartName(raw) { return /スマート|SIC/.test(nfkc(raw)); }

// ------------------------------------------------------------------ 本体
function build(osmPath, n06Path, sapaPath) {
  const raw = fs.readFileSync(osmPath);
  const osm = JSON.parse(raw);
  const n06raw = fs.readFileSync(n06Path);
  const n06 = JSON.parse(n06raw.toString('utf8'));
  const report = { params: PARAMS, anomalies: [], excludedBoundaries: [], ignoredPaths: {}, notes: [] };
  // SA/PA 場内通路（--sapa 指定時のみ）。本体の索引（W・N・coord）には混ぜない（service way の geometry の有無で分類が変わるため）
  let sapaRaw = null, sapaDoc = null, passages = null;
  if (sapaPath) { sapaRaw = fs.readFileSync(sapaPath); sapaDoc = JSON.parse(sapaRaw); passages = buildPassages(sapaDoc); }

  // ---- 索引
  const W = new Map(), N = new Map(), RELS = [], nodeWays = new Map(), coord = new Map();
  for (const e of osm.elements) {
    if (e.type === 'way') {
      W.set(e.id, e);
      e.nodes.forEach((n, i) => {
        if (!nodeWays.has(n)) nodeWays.set(n, []);
        nodeWays.get(n).push(e.id);
        if (e.geometry) coord.set(n, { lat: e.geometry[i].lat, lng: e.geometry[i].lon });
      });
    } else if (e.type === 'node') { N.set(e.id, e); if (!coord.has(e.id)) coord.set(e.id, { lat: e.lat, lng: e.lon }); }
    else if (e.type === 'relation') RELS.push(e);
  }
  const P = n => coord.get(n);

  // ---- way 分類
  const tok = s => (s || '').split(';').map(x => x.trim()).filter(Boolean);
  const isGeom = w => Array.isArray(w.geometry);
  const isLinkW = w => isGeom(w) && /_link$/.test(w.tags.highway || '');
  const isMainW = w => isGeom(w) && /^(motorway|trunk)$/.test(w.tags.highway || '');
  function baseRoad(w) {
    const t = w.tags, r = tok(t.ref), nm = t.name || '';
    if (r.includes('E1') || nm === '東名高速道路') return 'tomei';
    if (r.includes('C4') && /首都圏中央連絡/.test(nm)) return 'ken';
    if (nm === '首都高速3号渋谷線' || (r.includes('3') && /^首都高速/.test(nm))) return 'c3';
    if (!t.name && !t.ref) return null; // 無名：接続から推定
    return 'other';
  }
  const roadOf = new Map(); const inferred = [];
  const mains = [...W.values()].filter(isMainW);
  for (const w of mains) roadOf.set(w.id, baseRoad(w));
  // 無名本線：本線同士の接続先が単一の対象路線だけなら、その路線とみなす（反復）
  for (let it = 0; it < 10; it++) {
    let changed = false;
    for (const w of mains) {
      if (roadOf.get(w.id) !== null) continue;
      const nb = new Set();
      for (const n of w.nodes) for (const o of nodeWays.get(n)) {
        if (o === w.id) continue; const ow = W.get(o);
        if (isMainW(ow)) { const r = roadOf.get(o); if (r !== null) nb.add(r); }
      }
      if (nb.size === 1) { const r = [...nb][0]; roadOf.set(w.id, r); inferred.push({ way: w.id, road: r }); changed = true; }
      else if (nb.size > 1) { roadOf.set(w.id, 'other'); inferred.push({ way: w.id, road: 'other', reason: '複数路線に接続' }); changed = true; }
    }
    if (!changed) break;
  }
  for (const w of mains) if (roadOf.get(w.id) === null) { roadOf.set(w.id, 'other'); inferred.push({ way: w.id, road: 'other', reason: '接続なし' }); }
  report.inferredRoads = inferred.map(x => Object.assign({ name: W.get(x.way).tags.name || null, ref: W.get(x.way).tags.ref || null }, x));

  // 対象外本線の有料・無料（路線キー＝name|ref。toll タグが付いた way がすべて toll=no なら無料）
  const otherKey = w => w.tags.name || ('ref:' + (w.tags.ref || '?')); // 路線名単位（無名は ref）
  const otherToll = new Map();
  for (const w of mains) if (roadOf.get(w.id) === 'other') {
    const k = otherKey(w); const s = otherToll.get(k) || { yes: 0, no: 0, none: 0, ways: 0 };
    s.ways++; if (w.tags.toll === 'yes') s.yes++; else if (w.tags.toll === 'no') s.no++; else s.none++;
    otherToll.set(k, s);
  }
  const otherIsFree = w => { const s = otherToll.get(otherKey(w)); return s && s.yes === 0 && s.no > 0; };
  report.otherRoads = [...otherToll.entries()].map(([k, s]) => ({ key: k, ...s, treatedAs: (s.yes === 0 && s.no > 0) ? '無料道路（一般道側として扱う）' : '対象外の有料（または不明）道路：境界として除外' }));

  // ---- 本線ノードの範囲
  function inRange(road, p) {
    const r = PARAMS.range[road] || {};
    if (r.lngMin !== undefined && p.lng < r.lngMin) return false;
    if (r.latMin !== undefined && p.lat < r.latMin) return false;
    if (r.latMax !== undefined && p.lat > r.latMax) return false;
    return true;
  }

  // ---- 有向区間（node レベル）
  // oneway: yes/true/1 → 順方向、-1 → 逆方向、no → 双方向、未指定 → motorway/motorway_link は yes、trunk は双方向
  function dirs(w) {
    const ow = w.tags.oneway, hw = w.tags.highway;
    if (ow === 'yes' || ow === 'true' || ow === '1') return [1];
    if (ow === '-1' || ow === 'reverse') return [-1];
    if (ow === 'no' || ow === 'false' || ow === '0') return [1, -1];
    if (hw === 'motorway' || hw === 'motorway_link') return [1];
    return [1, -1];
  }
  const onewayLog = [];
  const Tout = new Map(), Tin = new Map(), Lout = new Map(), Lin = new Map();
  const tNodeRoad = new Map();   // 範囲内の対象本線ノード → road
  const cutNodes = new Set();    // 範囲外で切った本線ノード（境界）
  function addSeg(mapOut, mapIn, a, b, w) {
    const s = { from: a, to: b, way: w.id, len: hav(P(a), P(b)) };
    if (!mapOut.has(a)) mapOut.set(a, []); mapOut.get(a).push(s);
    if (!mapIn.has(b)) mapIn.set(b, []); mapIn.get(b).push(s);
  }
  for (const w of W.values()) {
    if (!isGeom(w)) continue;
    const ds = dirs(w);
    if (w.tags.oneway !== 'yes') onewayLog.push({ way: w.id, highway: w.tags.highway, oneway: w.tags.oneway || null, dirs: ds });
    const ns = w.nodes;
    if (isMainW(w)) {
      const road = roadOf.get(w.id);
      if (!PARAMS.roads[road]) continue;
      for (let i = 0; i + 1 < ns.length; i++) {
        const a = ns[i], b = ns[i + 1];
        const ia = inRange(road, P(a)), ib = inRange(road, P(b));
        if (!ia) cutNodes.add(a); if (!ib) cutNodes.add(b);
        if (!(ia && ib)) continue;
        tNodeRoad.set(a, road); tNodeRoad.set(b, road);
        for (const d of ds) d === 1 ? addSeg(Tout, Tin, a, b, w) : addSeg(Tout, Tin, b, a, w);
      }
    } else if (isLinkW(w)) {
      for (let i = 0; i + 1 < ns.length; i++) {
        const a = ns[i], b = ns[i + 1];
        for (const d of ds) d === 1 ? addSeg(Lout, Lin, a, b, w) : addSeg(Lout, Lin, b, a, w);
      }
    }
  }
  for (const n of tNodeRoad.keys()) cutNodes.delete(n);
  report.onewayNonYes = onewayLog;

  // ---- ノードの分類（ランプ経路の停止点）
  const surfInfo = new Map();   // node → [{way, highway, name}]
  const xInfo = new Map();      // node → [{way, name}]（対象外有料本線・範囲外）
  const svcWaysAt = new Map();  // node → [service way id]
  for (const [n, ws] of nodeWays) {
    for (const wid of ws) {
      const w = W.get(wid), t = w.tags;
      if (isGeom(w)) {
        if (isMainW(w) && roadOf.get(wid) === 'other') {
          if (otherIsFree(w)) { if (!surfInfo.has(n)) surfInfo.set(n, []); surfInfo.get(n).push({ way: wid, highway: t.highway, name: t.name || null, free_motorway: true }); }
          else { if (!xInfo.has(n)) xInfo.set(n, []); xInfo.get(n).push({ way: wid, name: t.name || t.ref || null }); }
        }
        continue;
      }
      if (PARAMS.ignoredAccess.includes(t.access)) continue;
      if (PARAMS.surfaceHighway.includes(t.highway)) {
        if (!surfInfo.has(n)) surfInfo.set(n, []);
        surfInfo.get(n).push({ way: wid, highway: t.highway, name: t.name || null });
      } else if (PARAMS.serviceHighway.includes(t.highway)) {
        if (!svcWaysAt.has(n)) svcWaysAt.set(n, []);
        svcWaysAt.get(n).push(wid);
      }
    }
  }
  const linkNodes = new Set([...Lout.keys(), ...Lin.keys()]);
  const isT = n => tNodeRoad.has(n);
  const isX = n => xInfo.has(n) || cutNodes.has(n);
  const isS = n => surfInfo.has(n);

  // service 群（service way を共有ノードで union-find）
  const par = new Map();
  const find = x => { while (par.get(x) !== x) { par.set(x, par.get(par.get(x))); x = par.get(x); } return x; };
  const unite = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) par.set(ra, rb); };
  for (const w of W.values()) if (!isGeom(w) && PARAMS.serviceHighway.includes(w.tags.highway) && !PARAMS.ignoredAccess.includes(w.tags.access)) par.set(w.id, w.id);
  const nodeSvc = new Map();
  for (const w of W.values()) {
    if (!par.has(w.id)) continue;
    for (const n of w.nodes) { if (nodeSvc.has(n)) unite(w.id, nodeSvc.get(n)); else nodeSvc.set(n, w.id); }
  }
  const clusterOf = n => { const ws = svcWaysAt.get(n); return ws ? find(ws[0]) : null; };

  // 行き止まり／行き始まりの link ノードが属する service 群 → SA/PA 候補群
  const deadSvc = new Map(); // cluster → {deadEnds:[], deadStarts:[]}
  const deadOrphans = [];
  for (const n of linkNodes) {
    if (isT(n) || isX(n) || isS(n)) continue;
    const outs = Lout.get(n) || [], ins = Lin.get(n) || [];
    const c = clusterOf(n);
    if (outs.length === 0 || ins.length === 0) {
      if (c === null) { deadOrphans.push({ type: outs.length === 0 ? 'link_dead_end' : 'link_dead_start', node: n, lat: P(n).lat, lng: P(n).lng, note: 'service・一般道・本線のいずれにも接しない link の端' }); continue; }
      if (!deadSvc.has(c)) deadSvc.set(c, { deadEnds: [], deadStarts: [] });
      (outs.length === 0 ? deadSvc.get(c).deadEnds : deadSvc.get(c).deadStarts).push(n);
    }
  }
  const sapaCluster = c => c !== null && deadSvc.has(c);
  const tPts = [...tNodeRoad.keys()].map(P);
  const nearTarget = p => tPts.some(q => hav(q, p) <= 2000);
  { // 対象路線の本線ノードから 2km 以内の異常だけを記録（他は件数のみ）
    let far = 0;
    for (const a of deadOrphans) { if (nearTarget(a)) report.anomalies.push(a); else far++; }
    report.notes.push('対象路線から2km超の link 端の孤立 ' + far + ' 件は対象外として記録しない');
  }
  const isC = n => sapaCluster(clusterOf(n));
  const cls = n => isT(n) ? 'T' : isX(n) ? 'X' : isS(n) ? 'S' : isC(n) ? 'C' : null;

  // ---- ランプ経路の列挙（link 区間のみをたどる単純路）
  const startNodes = [];
  for (const n of linkNodes) {
    if (!(Lout.get(n) || []).length) continue;
    const c = cls(n);
    if (c) startNodes.push(n);
    else if (!(Lin.get(n) || []).length) startNodes.push(n); // 孤立した行き始まり（異常として後で記録）
  }
  startNodes.sort((a, b) => a - b);
  const paths = []; const capped = [];
  for (const s0 of startNodes) {
    let count = 0;
    const stack = [{ node: s0, segs: [], seen: new Set([s0]) }];
    while (stack.length) {
      const cur = stack.pop();
      const outs = (Lout.get(cur.node) || []).slice().sort((a, b) => a.to - b.to || a.way - b.way);
      for (const s of outs) {
        if (cur.seen.has(s.to)) continue;
        const segs = cur.segs.concat([s]);
        const c = cls(s.to);
        const dead = !(Lout.get(s.to) || []).length;
        if (c || dead) {
          paths.push({ start: s0, end: s.to, startCls: cls(s0), endCls: c || 'D', segs });
          count++;
          if (count >= PARAMS.pathCapPerStart) break;
        } else {
          const seen = new Set(cur.seen); seen.add(s.to);
          stack.push({ node: s.to, segs, seen });
        }
      }
      if (count >= PARAMS.pathCapPerStart) { capped.push(s0); break; }
    }
  }
  if (capped.length) report.anomalies.push({ type: 'path_cap', nodes: capped });

  // ---- 経路の属性
  const junctionAt = n => { const x = N.get(n); return x && x.tags && x.tags.highway === 'motorway_junction' ? x : null; };
  const boothAt = n => { const x = N.get(n); return x && x.tags && x.tags.barrier === 'toll_booth' ? x : null; };
  function pathInfo(p) {
    const nodes = [p.start].concat(p.segs.map(s => s.to));
    const pts = nodes.map(P);
    const len = p.segs.reduce((a, s) => a + s.len, 0);
    const ways = [...new Set(p.segs.map(s => s.way))];
    const tolls = ways.map(w => W.get(w).tags.toll || null);
    const booths = nodes.map(boothAt).filter(Boolean).map(b => ({ osm_node: b.id, name: b.tags.name || null, lat: b.lat, lng: b.lon }));
    const junctions = nodes.map(junctionAt).filter(Boolean).map(j => ({ osm_node: j.id, name: j.tags.name || null, ref: j.tags.ref || null }));
    const wayNames = ways.map(w => W.get(w).tags.name).filter(Boolean);
    const dest = [...new Set(ways.map(w => W.get(w).tags.destination).filter(Boolean))];
    const access = ways.map(w => { const t = W.get(w).tags; const o = {}; for (const k of ['access', 'motor_vehicle', 'motorcar', 'access:conditional', 'motor_vehicle:conditional', 'hgv:conditional']) if (t[k]) o[k] = t[k]; return Object.keys(o).length ? { way: w, ...o } : null; }).filter(Boolean);
    return Object.assign(p, { nodes, pts, len, ways, tolls, booths, junctions, wayNames, dest, access });
  }
  paths.forEach(pathInfo);

  // ---- SA/PA 群の確定（本線から入り、本線へ出る群。入口のみ・出口のみの群は近接で統合）
  // service 群どうしを結ぶ link 経路（C>C、SA/PA 場内からスマートIC側への連絡など）は同一施設として統合する
  const gpar = new Map(); const gf = x => { if (!gpar.has(x)) gpar.set(x, x); while (gpar.get(x) !== x) { gpar.set(x, gpar.get(gpar.get(x))); x = gpar.get(x); } return x; };
  for (const p of paths) if (p.startCls === 'C' && p.endCls === 'C') { const a = gf(clusterOf(p.start)), b = gf(clusterOf(p.end)); if (a !== b) gpar.set(a, b); }
  const rawCluster = clusterOf;
  const groupOf = n => { const c = rawCluster(n); return c === null ? null : gf(c); };
  const cIn = new Map(), cOut = new Map(), cSurf = new Map(); // group → paths
  for (const p of paths) {
    if (p.startCls === 'T' && p.endCls === 'C') { const c = groupOf(p.end); (cIn.get(c) || cIn.set(c, []).get(c)).push(p); }
    if (p.startCls === 'C' && p.endCls === 'T') { const c = groupOf(p.start); (cOut.get(c) || cOut.set(c, []).get(c)).push(p); }
    if ((p.startCls === 'C' && p.endCls === 'S') || (p.startCls === 'S' && p.endCls === 'C')) { const c = groupOf(p.startCls === 'C' ? p.start : p.end); (cSurf.get(c) || cSurf.set(c, []).get(c)).push(p); }
  }
  const clusterIds = [...new Set([...cIn.keys(), ...cOut.keys(), ...[...deadSvc.keys()].map(gf)])].sort((a, b) => a - b);
  const sapaOf = new Map(); // cluster → sapa group
  const groups = [];
  const touchNodesOf = cs => { const ns = []; for (const n of linkNodes) if (cs.includes(groupOf(n))) ns.push(n); return ns; };
  const centroidOf = cs => {
    const ns = touchNodesOf(cs);
    const lat = ns.reduce((a, n) => a + P(n).lat, 0) / ns.length, lng = ns.reduce((a, n) => a + P(n).lng, 0) / ns.length;
    return { lat: +lat.toFixed(7), lng: +lng.toFixed(7), touchNodes: ns.length };
  };
  for (const c of clusterIds) {
    if (sapaOf.has(c)) continue;
    const g = { clusters: [c], merged: false };
    groups.push(g); sapaOf.set(c, g);
  }
  // 近接統合：入口だけ（cIn あり cOut なし）の群と出口だけの群
  for (const g of groups) {
    const c = g.clusters[0];
    if (g.dead) continue;
    if (cIn.has(c) && !cOut.has(c)) {
      const pc = centroidOf([c]);
      let best = null, bd = Infinity;
      for (const h of groups) {
        if (h === g || h.dead) continue; const d0 = h.clusters[0];
        if (!(cOut.has(d0) && !cIn.has(d0))) continue;
        const d = hav(pc, centroidOf([d0]));
        if (d < bd) { bd = d; best = h; }
      }
      if (best && bd <= PARAMS.sapaMergeM) {
        g.clusters.push(...best.clusters); g.merged = true; g.mergeDistM = r1(bd);
        for (const c2 of best.clusters) sapaOf.set(c2, g);
        best.dead = true;
      }
    }
  }
  // スマートIC側だけの群（本線と直接つながらない service 群）：最寄りの SA/PA 群へ統合（接続ノード間の最短距離 ≤300m、次点が2倍以上遠い場合のみ）
  const isSapaG = g => g.clusters.some(c => cIn.has(c)) && g.clusters.some(c => cOut.has(c));
  report.sapaOrphanMerge = [];
  for (const g of groups) {
    if (g.dead || isSapaG(g) || !g.clusters.some(c => cSurf.has(c))) continue;
    const mine = touchNodesOf(g.clusters);
    const scored = groups.filter(h => h !== g && !h.dead && isSapaG(h)).map(h => {
      const th = touchNodesOf(h.clusters); let d = Infinity;
      for (const a of mine) for (const b of th) d = Math.min(d, hav(P(a), P(b)));
      return { h, d };
    }).sort((x, y) => x.d - y.d);
    const rec = { clusters: g.clusters, best: scored[0] ? { clusters: scored[0].h.clusters, d: r1(scored[0].d) } : null, second: scored[1] ? { clusters: scored[1].h.clusters, d: r1(scored[1].d) } : null };
    if (scored[0] && scored[0].d <= 300 && (!scored[1] || scored[1].d >= 2 * scored[0].d)) {
      scored[0].h.clusters.push(...g.clusters); scored[0].h.orphanMerged = (scored[0].h.orphanMerged || []).concat([{ clusters: g.clusters, d: r1(scored[0].d) }]);
      for (const c of g.clusters) sapaOf.set(c, scored[0].h); g.dead = true; rec.merged = true;
    } else rec.merged = false;
    report.sapaOrphanMerge.push(rec);
  }
  const sapaGroups = groups.filter(g => !g.dead);
  for (const g of sapaGroups) {
    const ins = g.clusters.flatMap(c => cIn.get(c) || []), outs = g.clusters.flatMap(c => cOut.get(c) || []);
    g.surf = g.clusters.flatMap(c => cSurf.get(c) || []);
    g.ins = ins; g.outs = outs;
    g.isSapa = ins.length > 0 && outs.length > 0;
    const ce = centroidOf(g.clusters); g.lat = ce.lat; g.lng = ce.lng;
    const names = new Set();
    for (const p of ins.concat(outs)) for (const j of p.junctions) if (j.name) names.add(j.name);
    g.names = [...names];
  }

  // ---- 経路の分類
  const dirOf = (road, segFromTo) => {
    const R = PARAMS.roads[road]; const u = vec(R.a, R.b); const v = vec(P(segFromTo[0]), P(segFromTo[1]));
    return dot(u, v) >= 0 ? R.dirPos : R.dirNeg;
  };
  function mainDirAt(n, mode) { // mode 'in'：n へ入る本線区間、'out'：n から出る本線区間
    const segs = (mode === 'in' ? Tin.get(n) : Tout.get(n)) || [];
    const alt = (mode === 'in' ? Tout.get(n) : Tin.get(n)) || [];
    const s = segs[0] || alt[0];
    if (!s) return null;
    return dirOf(tNodeRoad.get(n), [s.from, s.to]);
  }
  const accepted = []; // {kind, from, to, path, ...}
  const ignoredCount = {};
  const ign = (k, p) => { ignoredCount[k] = (ignoredCount[k] || 0) + 1; };
  for (const p of paths) {
    const k = p.startCls + '>' + p.endCls;
    if (k === 'T>S') accepted.push({ kind: 'off_ramp', p });
    else if (k === 'S>T') accepted.push({ kind: 'on_ramp', p });
    else if (k === 'T>T') {
      const ra = tNodeRoad.get(p.start), rb = tNodeRoad.get(p.end);
      if (ra !== rb) accepted.push({ kind: 'jct_link', p });
      else {
        const da = mainDirAt(p.start, 'in'), db = mainDirAt(p.end, 'out');
        accepted.push({ kind: 'mainline', p, sub: da === db ? 'same_road_link' : 'uturn_link', dirFrom: da, dirTo: db });
      }
      // 同一路線の T>T は後で、対象外JCTの連絡路と way を共有するかを判定する（境界一覧の確定後）
    } else if (k === 'T>C' || k === 'C>T' || k === 'C>S' || k === 'S>C') {
      const c = groupOf(k[0] === 'C' ? p.start : p.end);
      const g = sapaOf.get(c);
      if (!g || !g.isSapa) { ign('service_not_sapa:' + k, p); if (nearTarget(P(p.start))) report.anomalies.push({ type: 'service_cluster_not_sapa', path: k, start: p.start, end: p.end, ways: p.ways }); continue; }
      if (k === 'T>C' || k === 'C>T') accepted.push({ kind: 'mainline', p, sub: k === 'T>C' ? 'sapa_in' : 'sapa_out', sapa: g });
      else accepted.push({ kind: k === 'C>S' ? 'off_ramp' : 'on_ramp', p, sapa: g, smartFromSapa: true });
    } else if (k === 'T>X' || k === 'X>T') {
      report.excludedBoundaries.push({ type: 'link_to_excluded', dir: k, start: p.start, end: p.end, len_m: r1(p.len), ways: p.ways,
        excluded: (xInfo.get(k === 'T>X' ? p.end : p.start) || []).map(x => x.name), cut: cutNodes.has(k === 'T>X' ? p.end : p.start),
        junctions: p.junctions.map(j => j.name), road: tNodeRoad.get(k === 'T>X' ? p.start : p.end) });
    } else if (k === 'T>D' || k === 'S>D' || k === 'null>T' || k.includes('null') || k.endsWith('>D')) {
      if (k.startsWith('T') || k.endsWith('T')) report.anomalies.push({ type: 'dangling_link_path', path: k, start: p.start, end: p.end, ways: p.ways });
      ign(k, p);
    } else ign(k, p);
  }
  report.ignoredPaths = ignoredCount;
  // 同一路線 T>T のうち、対象外路線へのJCT連絡路と way を共有するもの・転回するものは「対象外JCT経由の連絡」とし、
  // jct_link（料金影響・未解決の通行条件）にする。料金所レーン等（共有なし・同方向）は mainline のまま
  const boundaryWays = new Set(report.excludedBoundaries.filter(b => b.type === 'link_to_excluded').flatMap(b => b.ways));
  for (const a of accepted) {
    if (a.kind !== 'mainline' || !(a.sub === 'same_road_link' || a.sub === 'uturn_link')) continue;
    const shared = a.p.ways.filter(w => boundaryWays.has(w));
    if (shared.length || a.sub === 'uturn_link') {
      a.kind = 'jct_link'; a.viaExcluded = { shared_ways_with_excluded_jct: shared, uturn: a.sub === 'uturn_link' };
      a.sub = shared.length ? (a.sub === 'uturn_link' ? 'uturn_via_excluded_jct' : 'same_road_via_excluded_jct') : 'uturn_link';
    }
  }

  // ---- 同一 (kind, from, to) の並行経路を統合（料金所レーン等。最短を代表）
  const keyOf = a => {
    const from = a.kind === 'mainline' && a.sub === 'sapa_out' ? 'sapa' : a.p.start;
    const to = a.kind === 'mainline' && a.sub === 'sapa_in' ? 'sapa' : a.p.end;
    const fromK = a.p.startCls === 'C' ? 'C' + sapaGroups.indexOf(a.sapa) : String(a.p.start);
    const toK = a.p.endCls === 'C' ? 'C' + sapaGroups.indexOf(a.sapa) : String(a.p.end);
    return a.kind + '|' + fromK + '|' + toK + '|' + (from === to ? '' : '');
  };
  const merged = new Map();
  for (const a of accepted) {
    const k = keyOf(a);
    const ex = merged.get(k);
    if (!ex) { a.alts = [a.p]; merged.set(k, a); continue; }
    ex.alts.push(a.p);
    if (a.p.len < ex.p.len) { a.alts = ex.alts; merged.set(k, a); }
  }
  const links = [...merged.values()];

  // ---- 区別用 via：同じ始点（入口）／終点（出口）を共有する他経路と重ならない区間の中点
  function segKey(s) { return s.from + '>' + s.to; }
  for (const a of links) {
    const p = a.p;
    // 比較対象：入口は同じ一般道側端点（始点）から出る入口、出口は同じ一般道側端点（終点）へ入る出口、JCT連絡路は始点か終点を共有するもの
    // （一般道側端点は non-via 点として別に指定されるため、via は同じ端点から分かれる方向別の区間に置く）
    const others = links.filter(b => b !== a && b.kind === a.kind && (a.kind === 'on_ramp' ? b.p.start === p.start : a.kind === 'off_ramp' ? b.p.end === p.end : (b.p.start === p.start || b.p.end === p.end)));
    const shared = new Set(); for (const b of others) for (const s of b.p.segs) shared.add(segKey(s));
    // 固有区間の最長連続部分
    let best = null, cur = null;
    p.segs.forEach((s, i) => {
      if (!shared.has(segKey(s))) { if (!cur) cur = { i0: i, i1: i, len: 0 }; cur.i1 = i; cur.len += s.len; if (!best || cur.len > best.len) best = Object.assign({}, cur); }
      else cur = null;
    });
    if (best && best.len >= PARAMS.minUniqueViaM && others.length) {
      const pts = p.pts.slice(best.i0, best.i1 + 2);
      a.via = pointAt(pts, best.len / 2); a.viaBasis = 'unique_section_mid'; a.uniqueLen = best.len;
    } else { a.via = pointAt(p.pts, p.len / 2); a.viaBasis = others.length ? 'path_mid(固有区間なし)' : 'path_mid'; a.uniqueLen = others.length ? (best ? best.len : 0) : p.len; }
  }

  // ---- 本線の縮約
  const keyNodes = new Set();
  for (const a of links) { if (isT(a.p.start)) keyNodes.add(a.p.start); if (isT(a.p.end)) keyNodes.add(a.p.end); }
  for (const n of tNodeRoad.keys()) {
    const o = Tout.get(n) || [], i = Tin.get(n) || [];
    if (o.length !== 1 || i.length !== 1) keyNodes.add(n);
    else if (roadOf.get(o[0].way) !== roadOf.get(i[0].way)) keyNodes.add(n);   // 路線（事業者）境界
    if (xInfo.has(n) || [...(nodeWays.get(n) || [])].some(w => isMainW(W.get(w)) && roadOf.get(w) === 'other')) keyNodes.add(n);
  }
  const mlChains = [];
  for (const k of [...keyNodes].sort((a, b) => a - b)) {
    for (const s0 of (Tout.get(k) || [])) {
      const segs = [s0]; const seen = new Set([k, s0.to]); let cur = s0.to; let ok = true;
      while (!keyNodes.has(cur)) {
        const o = Tout.get(cur) || [];
        if (o.length !== 1 || seen.has(o[0].to)) { ok = false; break; }
        segs.push(o[0]); cur = o[0].to; seen.add(cur);
      }
      if (!ok) { report.anomalies.push({ type: 'mainline_chain_break', from: k, at: cur }); continue; }
      mlChains.push({ from: k, to: cur, segs });
    }
  }

  // ---- 本線境界（対象外路線への本線直結・範囲外）
  for (const n of keyNodes) {
    const xs = (nodeWays.get(n) || []).filter(w => isMainW(W.get(w)) && roadOf.get(w) === 'other');
    if (xs.length) report.excludedBoundaries.push({ type: 'mainline_to_excluded', node: n, lat: P(n).lat, lng: P(n).lng, road: tNodeRoad.get(n), excluded: [...new Set(xs.map(w => W.get(w).tags.name || W.get(w).tags.ref || '?'))] });
  }
  for (const w of mains) { // 範囲内ノードと way 上で隣接する範囲外ノード＝切断点
    const road = roadOf.get(w.id); if (!PARAMS.roads[road]) continue;
    const ns = w.nodes;
    for (let i = 0; i + 1 < ns.length; i++) {
      const a = ns[i], b = ns[i + 1];
      if (tNodeRoad.has(a) !== tNodeRoad.has(b)) { const out = tNodeRoad.has(a) ? b : a, inn = tNodeRoad.has(a) ? a : b;
        report.excludedBoundaries.push({ type: 'range_cut', road, way: w.id, inside_node: inn, outside_node: out, lat: P(out).lat, lng: P(out).lng }); }
    }
  }

  // ---- toll 判定
  const ROAD_TOLL = { tomei: true, ken: true, c3: true }; // NEXCO・首都高は有料（路線規則）
  function tollFrom(waysTolls, road, hasBooth) {
    const yes = waysTolls.filter(t => t === 'yes').length, no = waysTolls.filter(t => t === 'no').length, none = waysTolls.filter(t => t === null).length;
    if (yes > 0) return { toll: true, toll_source: no ? 'osm_tag(yes/no混在→true)' : (none ? 'osm_tag(一部タグなし)' : 'osm_tag') };
    if (hasBooth) return { toll: true, toll_source: 'toll_booth' };
    if (no > 0 && none === 0) return { toll: null, toll_source: 'osm_tag=no だが有料路線のランプ：矛盾のため不明' };
    if (road && ROAD_TOLL[road] === true) return { toll: true, toll_source: 'road_rule(' + road + ')' };
    return { toll: null, toll_source: 'unknown' };
  }

  // ---- ノード・辺の生成（OSM のみ）
  const nodes = new Map(); // id → node
  const nid = n => (isS(n) ? 's.' : 'n.') + n;
  function addNode(id, o) { if (!ID_RE.test(id)) throw new Error('bad node id ' + id); const ex = nodes.get(id); if (ex) { ex.typesSeen.add(o.type); return ex; } o.typesSeen = new Set([o.type]); nodes.set(id, o); return o; }
  const sapaNodes = sapaGroups.filter(g => g.isSapa).map((g, i) => {
    g.id = 'sapa.' + Math.min(...g.clusters);
    const road = g.ins[0] ? tNodeRoad.get(g.ins[0].start) : tNodeRoad.get(g.outs[0].end);
    const dirIn = [...new Set(g.ins.map(p => mainDirAt(p.start, 'in')))], dirOut = [...new Set(g.outs.map(p => mainDirAt(p.end, 'out')))];
    g.road = road; g.dirIn = dirIn; g.dirOut = dirOut;
    addNode(g.id, { id: g.id, type: 'sapa', lat: g.lat, lng: g.lng, name: g.names.find(x => /SA|PA|ＳＡ|ＰＡ/.test(x)) || g.names[0] || null,
      road, osm: { service_ways: g.clusters, merged_by_proximity: g.merged, merge_dist_m: g.mergeDistM || null, dir_in: dirIn, dir_out: dirOut } });
    return g;
  });
  for (const a of links) {
    for (const end of ['start', 'end']) {
      const n = a.p[end], c = a.p[end + 'Cls'];
      if (c === 'T') addNode(nid(n), { id: nid(n), type: a.kind === 'jct_link' ? 'jct' : a.kind === 'mainline' ? 'mainline' : 'ramp_mainline_end', lat: P(n).lat, lng: P(n).lng, road: tNodeRoad.get(n), osm_node: n });
      if (c === 'S') addNode(nid(n), { id: nid(n), type: 'ramp_surface_end', lat: P(n).lat, lng: P(n).lng, osm_node: n, surface_ways: surfInfo.get(n) });
    }
  }
  for (const ch of mlChains) for (const n of [ch.from, ch.to]) addNode(nid(n), { id: nid(n), type: 'mainline', lat: P(n).lat, lng: P(n).lng, road: tNodeRoad.get(n), osm_node: n });
  // 型の優先：ramp_mainline_end > jct > mainline
  for (const nd of nodes.values()) {
    if (nd.type === 'sapa' || nd.type === 'ramp_surface_end') continue;
    nd.type = nd.typesSeen.has('ramp_mainline_end') ? 'ramp_mainline_end' : nd.typesSeen.has('jct') ? 'jct' : 'mainline';
  }

  const edges = [];
  const eidSet = new Set();
  function addEdge(e) {
    let id = e.id; let k = 2; while (eidSet.has(id)) id = e.id + '.' + (k++);
    if (!ID_RE.test(id)) throw new Error('bad edge id ' + id);
    e.id = id; eidSet.add(id); edges.push(e); return e;
  }
  // 本線辺（縮約）
  for (const ch of mlChains) {
    const nodesSeq = [ch.from].concat(ch.segs.map(s => s.to));
    const pts = nodesSeq.map(P);
    const len = ch.segs.reduce((a, s) => a + s.len, 0);
    const ways = [...new Set(ch.segs.map(s => s.way))];
    const roads = [...new Set(ways.map(w => roadOf.get(w)))];
    const road = roads.length === 1 ? roads[0] : roads.join('+');
    const booths = nodesSeq.slice(1, -1).map(boothAt).filter(Boolean).map(b => ({ osm_node: b.id, name: b.tags.name || null }));
    const tt = tollFrom(ways.map(w => W.get(w).tags.toll || null), roads[0], booths.length > 0);
    const e = addEdge({ id: 'ml.' + ch.from + '.' + ch.to, from: nid(ch.from), to: nid(ch.to), kind: 'mainline', length_m: r1(len),
      toll: tt.toll, toll_source: tt.toll_source, road, operator: PARAMS.roads[roads[0]].operator, fare_relevant: false,
      dir: dirOf(roads[0], [ch.from, ch.segs[0].to]),
      osm: { ways, nodes: nodesSeq.length, toll_booths: booths, inferred_road_ways: ways.filter(w => inferred.some(x => x.way === w)) } });
    e._nodesSeq = nodesSeq; e._pts = pts;
  }
  // 事業者境界（東名⇄首都高）：境界ノードから出る辺を料金影響辺にする
  for (const n of keyNodes) {
    const i = Tin.get(n) || [], o = Tout.get(n) || [];
    for (const si of i) for (const so of o) {
      const ra = roadOf.get(si.way), rb = roadOf.get(so.way);
      if (ra !== rb && PARAMS.roads[ra] && PARAMS.roads[rb] && PARAMS.roads[ra].operator !== PARAMS.roads[rb].operator) {
        for (const e of edges) if (e.kind === 'mainline' && e.from === nid(n) && e._nodesSeq[1] === so.to) {
          e.fare_relevant = true; e.fare_reason = '事業者境界（' + PARAMS.roads[ra].operator + '→' + PARAMS.roads[rb].operator + '、' + PARAMS.roads[ra].label + '→' + PARAMS.roads[rb].label + '）';
          e.via = pointAt(e._pts, Math.min(e.length_m / 2, 100)); e.via_basis = 'boundary_after_100m_or_mid';
          e.boundary_node = { osm_node: n, lat: P(n).lat, lng: P(n).lng };
        }
      }
    }
  }
  // ランプ・JCT・SA/PA 辺
  const rampRecs = [];
  for (const a of links) {
    const p = a.p;
    const fromId = p.startCls === 'C' ? a.sapa.id : nid(p.start);
    const toId = p.endCls === 'C' ? a.sapa.id : nid(p.end);
    let len = p.len, approx = 0;
    if (p.startCls === 'C') { approx += hav(P(p.start), a.sapa); }
    if (p.endCls === 'C') { approx += hav(P(p.end), a.sapa); }
    len += approx;
    const tNode = a.kind === 'on_ramp' ? p.end : p.start;
    const road = isT(tNode) ? tNodeRoad.get(tNode) : (a.sapa ? a.sapa.road : (isT(p.end) ? tNodeRoad.get(p.end) : null));
    const tt = tollFrom(p.tolls, road, p.booths.length > 0);
    const prefix = { on_ramp: 'on', off_ramp: 'off', jct_link: 'jl', mainline: 'ml' }[a.kind];
    const dir = a.kind === 'off_ramp' ? (isT(p.start) ? mainDirAt(p.start, 'in') : (a.sapa.dirIn.join('/') || null))
      : a.kind === 'on_ramp' ? (isT(p.end) ? mainDirAt(p.end, 'out') : (a.sapa.dirOut.join('/') || null))
      : a.kind === 'jct_link' ? (mainDirAt(p.start, 'in') + '→' + mainDirAt(p.end, 'out'))
      : (isT(p.start) ? mainDirAt(p.start, 'in') : null) || (isT(p.end) ? mainDirAt(p.end, 'out') : null);
    const restr = [];
    for (const acc of p.access) restr.push({ source: 'way_access', ...acc });
    const e = {
      id: prefix + '.' + (p.startCls === 'C' ? 'sapa' + Math.min(...a.sapa.clusters) : p.start) + '.' + (p.endCls === 'C' ? 'sapa' + Math.min(...a.sapa.clusters) : p.end),
      from: fromId, to: toId, kind: a.kind, length_m: r1(len), toll: tt.toll, toll_source: tt.toll_source,
      road: road ? (a.kind === 'jct_link' ? tNodeRoad.get(p.start) + '>' + tNodeRoad.get(p.end) : road) : 'unknown',
      operator: road ? PARAMS.roads[road].operator : 'unknown',
      fare_relevant: a.kind === 'jct_link', dir,
      osm: { ways: p.ways, start_node: p.start, end_node: p.end, junctions: p.junctions, toll_booths: p.booths, way_names: [...new Set(p.wayNames)],
             destination: p.dest, alt_paths: a.alts.length, alt_lengths_m: a.alts.map(q => r1(q.len)).sort((x, y) => x - y), approx_service_m: approx ? r1(approx) : undefined },
    };
    if (a.sub) e.sub = a.sub;
    if (a.kind === 'on_ramp' || a.kind === 'off_ramp' || a.kind === 'jct_link') { e.via = a.via; e.via_basis = a.viaBasis; e.via_unique_len_m = r1(a.uniqueLen); }
    if (a.kind === 'jct_link') e.fare_reason = 'JCT連絡路（v5.1追補#3「必要なJCT経由点(via)」）';
    if (a.viaExcluded) {
      e.fare_reason = '対象外路線のJCT連絡路を通る同一路線の連絡（首都高JCT・料金影響）';
      e.via_excluded = a.viaExcluded;
      (e._preRestr = e._preRestr || []).push({ kind: a.sub, resolved: false, note: '対象外路線（' + [...new Set(report.excludedBoundaries.filter(b => b.type === 'link_to_excluded' && b.ways.some(w => a.viaExcluded.shared_ways_with_excluded_jct.includes(w))).flatMap(b => b.excluded))].join('・') + '）のJCT連絡路と区間を共有する同一路線の連絡' + (a.viaExcluded.uturn ? '（転回）' : '') + '。OSM上は接続しているが、実際に通行できるか・料金の扱いは未確認' });
    }
    if (restr.length) e._wayAccess = restr;
    e._nodesSeq = p.nodes; e._pts = p.pts; e._a = a;
    addEdge(e);
    if (a.kind === 'on_ramp' || a.kind === 'off_ramp') rampRecs.push(e);
  }
  // ---- 縮約の追加：料金所レーン等の並行路（同一路線・同方向の link で、本線だけで同じ2点を結べるもの）を除去し、度数2の本線ノードを再縮約
  report.parallelRemoved = [];
  {
    const ml = () => edges.filter(e => e.kind === 'mainline');
    const dijkstra = (src, dst, skip) => {
      const dist = new Map([[src, 0]]); const done = new Set(); const out = new Map();
      for (const e of ml()) { if (skip(e)) continue; (out.get(e.from) || out.set(e.from, []).get(e.from)).push(e); }
      while (true) {
        let u = null, du = Infinity; for (const [k, v] of dist) if (!done.has(k) && v < du) { du = v; u = k; }
        if (u === null) return Infinity; if (u === dst) return du; done.add(u);
        for (const e of (out.get(u) || [])) { const nd = du + e.length_m; if (nd < (dist.has(e.to) ? dist.get(e.to) : Infinity)) dist.set(e.to, nd); }
      }
    };
    for (const e of ml().filter(e => e.sub === 'same_road_link')) {
      const alt = dijkstra(e.from, e.to, x => x === e || x.sub === 'same_road_link' || x.sub === 'sapa_in' || x.sub === 'sapa_out');
      if (alt <= Math.max(1.5 * e.length_m, e.length_m + 500)) {
        report.parallelRemoved.push({ id: e.id, from: e.from, to: e.to, length_m: e.length_m, mainline_alt_m: r1(alt), toll_booths: e.osm.toll_booths.map(b => b.name), ways: e.osm.ways, reason: '同一路線・同方向の並行レーン（料金所レーン等）。本線で同じ2点を ' + r1(alt) + 'm で結べるため縮約で除去' });
        edges.splice(edges.indexOf(e), 1); eidSet.delete(e.id);
      }
    }
    // 同一 (kind,from,to) の並行辺：最短を残す
    const seen = new Map();
    for (const e of edges.slice().sort((a, b) => a.length_m - b.length_m)) {
      const k = e.kind + '|' + e.from + '|' + e.to;
      if (!seen.has(k)) { seen.set(k, e); continue; }
      const keep = seen.get(k);
      if (e.fare_relevant || keep.fare_relevant || e._preRestr || keep._preRestr) continue;
      report.parallelRemoved.push({ id: e.id, kept: keep.id, length_m: e.length_m, kept_m: keep.length_m, reason: '同じ2ノード間の並行辺。最短を代表として残す' });
      keep.osm.parallel_alternatives = (keep.osm.parallel_alternatives || []).concat([{ id: e.id, length_m: e.length_m, ways: e.osm.ways }]);
      edges.splice(edges.indexOf(e), 1); eidSet.delete(e.id);
    }
    // 度数2の本線ノード（ランプ・JCT・SA/PA・境界に関係しない）を再縮約
    let merged = 0;
    for (let guard = 0; guard < 1000; guard++) {
      let did = false;
      for (const nd of [...nodes.values()]) {
        if (nd.type !== 'mainline') continue;
        const ins = edges.filter(e => e.to === nd.id), outs = edges.filter(e => e.from === nd.id);
        if (ins.length !== 1 || outs.length !== 1) continue;
        const a = ins[0], b = outs[0];
        if (a.kind !== 'mainline' || b.kind !== 'mainline' || a.sub || b.sub || a.fare_relevant || b.fare_relevant || a.road !== b.road || a.from === b.to) continue;
        const ne = { id: 'ml.' + a.id.split('.')[1] + '.' + b.id.split('.').slice(-1)[0], from: a.from, to: b.to, kind: 'mainline', length_m: r1(a.length_m + b.length_m),
          toll: a.toll === true && b.toll === true ? true : (a.toll === null || b.toll === null ? null : a.toll && b.toll), toll_source: [...new Set(a.toll_source.split('+').concat(b.toll_source.split('+')))].join('+'),
          road: a.road, operator: a.operator, fare_relevant: false, dir: a.dir,
          osm: { ways: [...new Set(a.osm.ways.concat(b.osm.ways))], nodes: a.osm.nodes + b.osm.nodes - 1, toll_booths: a.osm.toll_booths.concat(b.osm.toll_booths),
                 inferred_road_ways: [...new Set(a.osm.inferred_road_ways.concat(b.osm.inferred_road_ways))], merged_at: (a.osm.merged_at || []).concat([nd.osm_node], b.osm.merged_at || []) } };
        ne.id = 'ml.' + String(a.from).replace(/^[a-z]+\./, '') + '.' + String(b.to).replace(/^[a-z]+\./, '');
        ne._nodesSeq = a._nodesSeq.concat(b._nodesSeq.slice(1)); ne._pts = a._pts.concat(b._pts.slice(1));
        edges.splice(edges.indexOf(a), 1); eidSet.delete(a.id); edges.splice(edges.indexOf(b), 1); eidSet.delete(b.id);
        addEdge(ne); nodes.delete(nd.id); merged++; did = true;
      }
      if (!did) break;
    }
    report.notes.push('並行路除去 ' + report.parallelRemoved.length + ' 本、度数2本線ノードの再縮約 ' + merged + ' 個');
    // 使われないノードを除く
    const used = new Set(edges.flatMap(e => [e.from, e.to]));
    for (const id of [...nodes.keys()]) if (!used.has(id)) { report.notes.push('未使用ノード除去 ' + id); nodes.delete(id); }
  }

  // smartic_gate：スマートIC（OSM 名称にスマート/SIC、または SA/PA から一般道へ出る）の一般道側ノード
  for (const e of rampRecs) {
    const nm = e.osm.junctions.map(j => j.name).concat(e.osm.toll_booths.map(b => b.name), e.osm.way_names).filter(Boolean);
    const smart = nm.some(isSmartName) || !!(e._a.smartFromSapa);
    e._smartOsm = smart;
    if (smart) { const sid = e.kind === 'on_ramp' ? e.from : e.to; nodes.get(sid).type = 'smartic_gate'; nodes.get(sid).smart_basis = nm.filter(isSmartName)[0] || 'SA/PA から一般道'; }
  }

  // ---- 通行条件（way の access と restriction 関係）
  const restrLog = [];
  const edgeById = new Map(edges.map(e => [e.id, e]));
  const graphWays = new Set(); for (const e of edges) for (const w of e.osm.ways) graphWays.add(w);
  function pushRestr(e, r) { (e._restr || (e._restr = [])).push(r); }
  for (const e of edges) for (const r of (e._preRestr || [])) pushRestr(e, r);
  for (const e of edges) for (const acc of (e._wayAccess || [])) {
    const deny = ['no', 'private'].includes(acc.access) || ['no', 'private'].includes(acc.motor_vehicle) || ['no', 'private'].includes(acc.motorcar);
    const cond = acc['access:conditional'] || acc['motor_vehicle:conditional'];
    if (deny) pushRestr(e, { kind: 'access', resolved: true, passable: false, note: 'OSM way ' + acc.way + ' のアクセス制限 ' + JSON.stringify(acc) });
    else if (cond) pushRestr(e, { kind: 'access:conditional', resolved: false, note: 'OSM way ' + acc.way + ' の条件付き規制 ' + cond });
    else if (acc['hgv:conditional']) e.osm.hgv_conditional = (e.osm.hgv_conditional || []).concat([{ way: acc.way, value: acc['hgv:conditional'] }]); // 普通車には適用しない（記録のみ）
  }
  for (const rel of RELS) {
    const t = rel.tags || {};
    const kind = t.restriction || t['restriction:conditional'] || null;
    const from = rel.members.filter(m => m.role === 'from' && m.type === 'way').map(m => m.ref);
    const to = rel.members.filter(m => m.role === 'to' && m.type === 'way').map(m => m.ref);
    const viaN = rel.members.filter(m => m.role === 'via' && m.type === 'node').map(m => m.ref);
    const viaW = rel.members.filter(m => m.role === 'via' && m.type === 'way').map(m => m.ref);
    const rec = { relation: rel.id, tags: t, from, via_node: viaN, via_way: viaW, to, mapped: [], status: null };
    const touches = from.concat(to, viaW).filter(w => graphWays.has(w));
    const viaInGraph = viaN.filter(n => nodes.has(nid(n)) || edges.some(e => e._nodesSeq.includes(n)));
    if (!touches.length && !viaInGraph.length) { rec.status = '対象外（グラフの辺・ノードに関係しない）'; restrLog.push(rec); continue; }
    const conditional = !!t['restriction:conditional'] || !!t['except'];
    if (viaW.length || conditional || !kind) {
      for (const e of edges) if (e.osm.ways.some(w => to.includes(w) || viaW.includes(w))) { pushRestr(e, { kind: kind || '?', resolved: false, note: 'OSM relation ' + rel.id + (conditional ? '（条件付き）' : '（via way）') }); rec.mapped.push(e.id); }
      rec.status = 'resolved:false（' + (conditional ? '時間条件付き' : viaW.length ? 'via が way' : '種別不明') + '）'; restrLog.push(rec); continue;
    }
    const v = viaN[0];
    const fromIn = from.every(w => graphWays.has(w)), toIn = to.every(w => graphWays.has(w));
    const onSeq = (e, wa, wb) => { // e の node 列に [x, v, y] があり x→v が wa、v→y が wb
      const s = e._nodesSeq; const i = s.indexOf(v); if (i <= 0 || i >= s.length - 1) return false;
      const W1 = W.get(wa), W2 = W.get(wb);
      const has = (w, a, b) => { const ns = w.nodes; for (let k = 0; k + 1 < ns.length; k++) if ((ns[k] === a && ns[k + 1] === b) || (ns[k] === b && ns[k + 1] === a)) return true; return false; };
      return has(W1, s[i - 1], v) && has(W2, v, s[i + 1]);
    };
    if (fromIn && toIn) {
      const isNo = /^no_/.test(kind), isOnly = /^only_/.test(kind);
      let found = false;
      for (const e of edges) {
        const s = e._nodesSeq; const i = s.indexOf(v); if (i <= 0 || i >= s.length - 1) continue;
        const prevOnFrom = from.some(wa => { const ns = W.get(wa).nodes; for (let k = 0; k + 1 < ns.length; k++) if ((ns[k] === s[i - 1] && ns[k + 1] === v) || (ns[k] === v && ns[k + 1] === s[i - 1])) return true; return false; });
        if (!prevOnFrom) continue;
        const toMatch = to.some(wb => onSeq(e, from[0], wb));
        if (isNo && toMatch) { pushRestr(e, { kind, resolved: true, passable: false, note: 'OSM relation ' + rel.id }); rec.mapped.push(e.id); found = true; }
        if (isOnly) { found = true; if (toMatch) { pushRestr(e, { kind, resolved: true, passable: true, note: 'OSM relation ' + rel.id + '（指定方向）' }); rec.mapped.push(e.id); } else { pushRestr(e, { kind, resolved: true, passable: false, note: 'OSM relation ' + rel.id + '（指定外の方向）' }); rec.mapped.push(e.id); } }
      }
      if (!found) {
        // 縮約辺の境界（グラフノード）で転回する場合：辺単位では表せない
        for (const e of edges) if (e.osm.ways.some(w => to.includes(w)) && e._nodesSeq[0] === v) { pushRestr(e, { kind, resolved: false, note: 'OSM relation ' + rel.id + '：転回点がグラフノード上で辺単位に表せない' }); rec.mapped.push(e.id); }
        rec.status = rec.mapped.length ? 'resolved:false（グラフノード上の転回規制）' : '対象外（辺の内部に該当する転回なし）';
      } else rec.status = 'resolved:true（辺内部の転回として変換）';
    } else {
      // 一般道側の way を含む規制：ランプ端点での進入・退出方向の規制。ランプ自体は通行可能（接続区間は Google 経路で扱う）
      for (const e of edges) {
        const sn = e.kind === 'on_ramp' ? e.osm.start_node : e.kind === 'off_ramp' ? e.osm.end_node : null;
        if (sn === v && e.osm.ways.some(w => from.includes(w) || to.includes(w))) { pushRestr(e, { kind, resolved: true, passable: true, note: 'OSM relation ' + rel.id + '：一般道側端点での進入・退出方向の規制（ランプは通行可、一般道接続区間でGoogleが扱う）' }); rec.mapped.push(e.id); }
      }
      rec.status = rec.mapped.length ? 'resolved:true, passable:true（一般道側端点の方向規制）' : '対象外（グラフ辺を通らない一般道間の規制）';
    }
    restrLog.push(rec);
  }
  for (const e of edges) if (e._restr) {
    const imp = e._restr.find(r => r.resolved && r.passable === false);
    const unr = e._restr.find(r => !r.resolved);
    e.restriction = imp ? { kind: imp.kind, resolved: true, passable: false, note: imp.note } : unr ? { kind: unr.kind, resolved: false, note: unr.note } : { kind: e._restr[0].kind, resolved: true, passable: true, note: e._restr[0].note };
    if (e._restr.length > 1) e.restriction.all = e._restr;
  }

  // ---- 辺ジオメトリ geom と via_heading（段階5a-1。_pts＝OSM way のノード列から作った辺の折れ線、from→to の進行方向順）
  // --sapa あり（段階5a-1′）：SA/PA 接続辺は _pts（接続点まで）に場内通路の実形状を継ぎ足して geom にする。via_heading は継ぎ足し前の _pts で求める（5a-1 と同じ）
  let sapaPlan = null;
  if (passages) {
    sapaPlan = planSapaGeom(edges, nodes, P, passages);
    for (const e of edges) {
      const pl = sapaPlan.plan.get(e.id); if (!pl) continue;
      const toSapa = nodes.get(e.to).type === 'sapa';
      e._gpts = toSapa ? e._pts.concat(pl.ext) : pl.ext.concat(e._pts);
    }
  }
  report.geom = { simplifyM: PARAMS.geom.simplifyM, precision: PARAMS.geom.precision, edges: 0, points_before: 0, points_after: 0, chars: 0, per_kind: {} };
  report.heading = { windowM: PARAMS.headingWindowM, edges: 0, max_via_offset_m: 0, min_span_m: Infinity, short_span: [] };
  for (const e of edges) {
    const pts = e._pts;
    if (!pts || pts.length < 2) throw new Error('辺の折れ線がない: ' + e.id);
    const gpts = e._gpts || pts;
    const enc = encodePolyline(simplifyDP(gpts, PARAMS.geom.simplifyM), PARAMS.geom.precision);
    e.geom = enc.str;
    if (sapaPlan && sapaPlan.plan.has(e.id)) {
      const pl = sapaPlan.plan.get(e.id);
      if (pl.gapInfo) { e.geom_gap = true; e.geom_gap_info = pl.gapInfo; }
      if (pl.info) e.osm.sapa_geom = pl.info;
    }
    const gk = report.geom.per_kind[e.kind] || (report.geom.per_kind[e.kind] = { edges: 0, points: 0, chars: 0 });
    gk.edges++; gk.points += enc.points; gk.chars += enc.str.length;
    report.geom.edges++; report.geom.points_before += gpts.length; report.geom.points_after += enc.points; report.geom.chars += enc.str.length;
    if (e.via) {
      const h = headingAtVia(pts, e.via, PARAMS.headingWindowM);
      e.via_heading = h.heading;
      report.heading.edges++; report.heading.max_via_offset_m = Math.max(report.heading.max_via_offset_m, r1(h.via_offset_m));
      report.heading.min_span_m = Math.min(report.heading.min_span_m, r1(h.span_m));
      if (h.span_m < 2 * PARAMS.headingWindowM - 1) report.heading.short_span.push({ id: e.id, span_m: r1(h.span_m) });
    }
  }

  // ---- OSM 側 IC 群（N06 なしで作る。名称・ref・link 連結成分・近接から）
  // link 連結成分
  const lpar = new Map(); const lf = x => { while (lpar.get(x) !== x) { lpar.set(x, lpar.get(lpar.get(x))); x = lpar.get(x); } return x; };
  for (const w of W.values()) if (isLinkW(w)) lpar.set(w.id, w.id);
  const nodeL = new Map();
  for (const w of W.values()) if (isLinkW(w)) for (const n of w.nodes) { if (nodeL.has(n)) { const a = lf(w.id), b = lf(nodeL.get(n)); if (a !== b) lpar.set(a, b); } else nodeL.set(n, w.id); }
  const compOf = e => lf(e.osm.ways[0]);
  const compNames = new Map();
  for (const e of rampRecs.concat(edges.filter(x => x.kind === 'jct_link'))) {
    const c = compOf(e); const s = compNames.get(c) || new Set();
    for (const j of e.osm.junctions) for (const b of rampNameBases(j.name)) s.add(b);
    for (const b of e.osm.toll_booths) for (const x of rampNameBases(b.name)) s.add(x);
    compNames.set(c, s);
  }
  for (const e of rampRecs) {
    const direct = new Set();
    // 入口ランプの本線側端点（合流点）にある motorway_junction は分流の名称なので使わない
    const js = e.kind === 'on_ramp' ? e.osm.junctions.filter(j => j.osm_node !== e.osm.end_node) : e.osm.junctions;
    e.osm.junctions_used_for_name = js.map(j => j.osm_node);
    for (const j of js) for (const b of rampNameBases(j.name)) direct.add(b);
    if (e._a.sapa) for (const nm of e._a.sapa.names) for (const b of rampNameBases(nm)) direct.add(b);
    for (const b of e.osm.toll_booths) for (const x of rampNameBases(b.name)) direct.add(x);
    for (const n of e.osm.way_names) for (const x of rampNameBases(n)) if (!/高速|道路|線$/.test(x)) direct.add(x);
    e._direct = [...direct];
    e._comp = [...(compNames.get(compOf(e)) || [])];
    e._refs = [...new Set(e.osm.junctions.map(j => j.ref).filter(Boolean))];
  }
  // OSM IC キー：直接名 → 成分名（1つのとき）→ 同一路線で最寄りの名前付きランプ（1.5km以内）
  const named = rampRecs.filter(e => e._direct.length === 1 || (e._direct.length === 0 && e._comp.length === 1));
  for (const e of rampRecs) {
    if (e._direct.length === 1) { e._osmName = e._direct[0]; e._osmBasis = 'direct'; }
    else if (e._direct.length > 1) { e._osmName = e._direct.slice().sort().join('/'); e._osmBasis = 'direct(複数名)'; }
    else if (e._comp.length === 1) { e._osmName = e._comp[0]; e._osmBasis = 'component'; }
    else {
      let best = null, bd = Infinity;
      for (const f of named) { if (f === e || f.road !== e.road || f._smartOsm !== e._smartOsm) continue; if (e._comp.length > 1 && !e._comp.includes(f._direct[0] || f._comp[0])) continue; const d = hav(e.via, f.via); if (d < bd) { bd = d; best = f; } }
      if (best && bd <= PARAMS.icMatch.distOnlyMaxM) { e._osmName = best._direct[0] || best._comp[0]; e._osmBasis = 'nearest_named(' + Math.round(bd) + 'm)'; }
      else { e._osmName = null; e._osmBasis = 'none'; }
    }
  }
  const osmIcs = new Map(); let icSeq = 0;
  for (const e of rampRecs.slice().sort((a, b) => (a.road + a._osmName).localeCompare(b.road + b._osmName) || a.id.localeCompare(b.id))) {
    const key = e.road + '|' + (e._osmName || ('?' + compOf(e)));
    if (!osmIcs.has(key)) osmIcs.set(key, { ic_id: 'osm-ic:' + e.road + ':' + String(++icSeq).padStart(2, '0'), name: e._osmName, road: e.road, ramps: [], smart_osm: false });
    const ic = osmIcs.get(key); ic.ramps.push(e.id); if (e._smartOsm) ic.smart_osm = true;
    e.ic_id = ic.ic_id; e.osm.ic_name_basis = e._osmBasis;
  }
  for (const ic of osmIcs.values()) {
    const es = ic.ramps.map(id => edgeById.get(id));
    ic.lat = +(es.reduce((s, e) => s + e.via.lat, 0) / es.length).toFixed(6); ic.lng = +(es.reduce((s, e) => s + e.via.lng, 0) / es.length).toFixed(6);
    ic.movements = es.map(e => e.kind + ':' + e.dir).sort();
    ic.refs = [...new Set(es.flatMap(e => e._refs))];
  }

  // ---- 出力整形
  function finalize(edgeList, nodeMap, extraIc) {
    const outNodes = [...nodeMap.values()].map(n => { const o = Object.assign({}, n); delete o.typesSeen; return o; }).sort((a, b) => a.id.localeCompare(b.id));
    const outEdges = edgeList.map(e => { const o = {}; for (const k of Object.keys(e)) if (!k.startsWith('_')) o[k] = e[k]; return o; }).sort((a, b) => a.id.localeCompare(b.id));
    return { outNodes, outEdges };
  }
  // ノードへ ic_id を付与（ランプ端点）
  function tagNodeIcs(icField) {
    for (const nd of nodes.values()) { delete nd.ic_id; delete nd.koj; }
    for (const e of rampRecs) {
      const sid = e.kind === 'on_ramp' ? e.from : e.to;
      const nd = nodes.get(sid); if (!nd) continue;
      const v = icField(e);
      if (v.ic_id) { if (nd.ic_id && nd.ic_id !== v.ic_id) nd.ic_id_conflict = (nd.ic_id_conflict || [nd.ic_id]).concat([v.ic_id]); else nd.ic_id = v.ic_id; }
      if (v.koj !== undefined && v.koj !== null) nd.koj = v.koj;
    }
  }
  const surfaceNodeCount = () => [...nodes.values()].filter(n => n.type === 'ramp_surface_end' || n.type === 'smartic_gate').length;
  const sha = require('crypto').createHash('sha256').update(raw).digest('hex');
  const osmBase = osm.osm3s && osm.osm3s.timestamp_osm_base;
  const baseDate = osmBase ? osmBase.slice(0, 10) : null;
  const OSM_SOURCE = '© OpenStreetMap contributors, ODbL 1.0, https://www.openstreetmap.org/copyright, Overpass(kumi.systems) osm_base ' + baseDate;

  // OSM のみ
  tagNodeIcs(e => ({ ic_id: e.ic_id }));
  const osmOnlyIcs = [...osmIcs.values()].map(ic => ({ ic_id: ic.ic_id, name: ic.name, koj: null, road: ic.road, lat: ic.lat, lng: ic.lng, smart_osm: ic.smart_osm, osm_refs: ic.refs, movements: ic.movements }));
  const f1 = finalize(edges, nodes);
  const metaCommon = {
    baseDate, baseYear: 2025,
    roads: 3, road_list: Object.entries(PARAMS.roads).map(([k, r]) => ({ key: k, name: r.label, operator: r.operator, dir_pos: r.dirPos, dir_neg: r.dirNeg })),
    rampPoints: surfaceNodeCount(), rampPoints_definition: '一般道側端点ノード数（ramp_surface_end＋smartic_gate）',
    ramps: rampRecs.length,
    // 地域分割（Tak 決定 2026-11-01）：地域キー・範囲・版。地域またぎの接続設計は 5b 前に決める（今回は項目だけ置く）
    region: REGION, bbox: PARAMS.bbox,
    cross_region: null, cross_region_note: '地域またぎの接続（地域間の境界ノードの対応など）は未設計。5b 前に決める。今回は項目だけを置いている',
    geom: { encoding: 'Google 符号化ポリライン（精度 1e5）', order: '辺の from→to の進行方向順', source: 'OSM way の形状', simplify_tolerance_m: PARAMS.geom.simplifyM,
            note: 'SA/PA ノードに接する辺は、OSM 上の接続点で終わる（SA/PA ノードの代表点までは含めない）' },
    via_heading: { unit: '度（北=0、時計回り、整数 0〜359）', definition: 'via 点の前後 ' + PARAMS.headingWindowM + ' m の OSM way 形状（辺の進行方向）から求めた方位', applies_to: 'via を持つ辺' },
    osm: { file: path.basename(osmPath), sha256: sha, osm_base: osmBase, query: 'osm_query.overpassql', bbox: PARAMS.bbox },
    builder: 'build_graph.js', built_with: 'Node ' + process.version,
  };
  const REV = sapaDoc ? GRAPH_REV + 1 : GRAPH_REV;   // --sapa ありは出力が変わるので改訂番号を 1 上げる（なしは 5a-1 と同じ）
  if (sapaDoc) {
    const sapaBase = sapaDoc.osm3s && sapaDoc.osm3s.timestamp_osm_base;
    const filled = [...sapaPlan.plan.values()].filter(q => q.info), gapped = [...sapaPlan.plan.entries()].filter(([, q]) => q.gapInfo).map(([id]) => id).sort();
    if (sapaBase !== osmBase) report.anomalies.push({ type: 'osm_base_mismatch', osm_small: osmBase, osm_sapa: sapaBase, note: '本体と SA/PA 場内通路で OSM の鮮度が異なる' });
    metaCommon.geom = Object.assign({}, metaCommon.geom, {
      note: 'SA/PA ノードに接する辺（' + sapaPlan.plan.size + ' 本）の geom は、接続点から場内通路（OSM の service・motorway_link。osm_sapa）を一方通行の向きにたどった実形状で、SA/PA 側の端点（代表点に近い通路上の頂点）まで続く。' +
            '端点から代表点までの直線区間は含めない（直線補間はしない。length_m にはその近似距離が加わっている）。形状で埋まらない区間がある辺は geom_gap:true（geom_gap_info に区間の長さ[m]と理由）',
    });
    metaCommon.osm_sapa = { file: path.basename(sapaPath), sha256: require('crypto').createHash('sha256').update(sapaRaw).digest('hex'), osm_base: sapaBase || null, osm_base_same_as_main: sapaBase === osmBase,
      query: SAPA_QUERY, generator: sapaDoc.generator || null, ways: sapaDoc.elements.filter(q => q.type === 'way').length, usable_ways: passages.ways.size, excluded_by_access: passages.skippedWays };
    metaCommon.sapa_geom = { params: SAPA_PARAMS, edges_with_sapa_node: sapaPlan.plan.size, edges_filled: filled.length, geom_gap_edges: gapped.length, geom_gap_ids: gapped,
      no_passage_pairs: sapaPlan.rep.facilities.flatMap(f => f.pairs.filter(q => q.passage_m === null).map(q => q.in_edge + ' → ' + q.out_edge)),
      no_passage_pairs_note: 'SA/PA ノードを介して辺がつながるが、場内通路（OSM の service・motorway_link、一方通行の向き）では入る辺の接続点から出る辺の接続点へ行けない組（グラフ上の接続は実在経路の裏付けがない）',
      method: '接続点（OSM ノード）から場内通路を最短距離でたどる。SA/PA 側の端点は、代表点から ' + SAPA_PARAMS.candidateRadiusM + ' m 以内の通路頂点のうち、向き条件（入る辺は到達でき、出る辺は接続点へ行ける）を満たす辺が同一施設で最も多いものを選ぶ（同数なら長さ比 [' + SAPA_PARAMS.ratioMin + ', ' + SAPA_PARAMS.ratioMax + '] に入る辺が多い順、さらに代表点に近い順）。満たせない辺が残れば残りだけで選び直す' };
  }
  const graphOsm = {
    schema: 'rf-graph/1',
    meta: Object.assign({ name: 'rf-graph small (OSM only, N06照合前)' }, metaCommon, {
      version: REGION + '-osm' + (baseDate || 'unknown').replace(/-/g, '') + '-r' + REV,
      source: OSM_SOURCE, license: 'ODbL 1.0（OpenStreetMap 派生データベース）。抽出条件は meta.osm.query と meta.params を参照',
      n06: null, params: PARAMS }),
    ics: osmOnlyIcs, nodes: f1.outNodes, edges: f1.outEdges,
  };

  // ---- N06 照合
  const n06Road = {}; for (const [k, r] of Object.entries(PARAMS.roads)) n06Road[r.n06] = k;
  const joints = n06.joints.map(j => {
    const prim = Object.entries(j.routes).filter(([, d]) => d <= PARAMS.icMatch.primaryRouteM).map(([rn]) => n06Road[rn]).filter(Boolean);
    return Object.assign({}, j, { koj: Number(j.koj), primaryRoads: prim, bases: baseNames(j.name), smart: Number(j.koj) === 2 });
  });
  const matchRows = [];
  const unmatched = [];
  for (const e of rampRecs) {
    // 名称照合は他路線の接合部も候補にする（JCT経由で直接出入りするランプ。例：圏央道→海老名JCT→東名 厚木IC）。距離のみの照合は同一路線に限る
    const candsAll = joints.filter(j => j.koj !== 3).map(j => ({ j, d: hav(e.via, { lat: j.lat, lng: j.lng }), sameRoad: j.primaryRoads.includes(e.road) })).sort((a, b) => a.d - b.d);
    const cands = candsAll.filter(x => x.sameRoad);
    let pick = null, method = null, reason = null;
    const tryNames = (names, label) => {
      if (!names.length) return false;
      let c = candsAll.filter(x => x.d <= PARAMS.icMatch.nameMaxM && x.j.bases.some(b => names.includes(b)));
      if (c.some(x => x.sameRoad)) c = c.filter(x => x.sameRoad);
      { const sm = c.filter(x => x.j.smart === e._smartOsm); if (sm.length) c = sm; else if (c.length && label !== 'name(direct)+distance') c = []; }
      if (c.length) { pick = c[0]; method = label; return true; }
      return false;
    };
    if (!tryNames(e._direct, 'name(direct)+distance') && !tryNames(e._comp, 'name(component)+distance') && !tryNames(e._osmName ? [e._osmName] : [], 'name(nearest_named)+distance')) {
      const c = cands.filter(x => x.d <= PARAMS.icMatch.distOnlyMaxM && x.j.smart === e._smartOsm);
      if (c.length === 1 || (c.length > 1 && c[1].d >= c[0].d * PARAMS.icMatch.ambiguityRatio)) { pick = c[0]; method = 'distance_only'; }
      else reason = c.length ? '距離のみで候補が複数（' + c.slice(0, 2).map(x => x.j.name + ' ' + Math.round(x.d) + 'm').join('、') + '）' : ('同一路線の N06 接合部が ' + PARAMS.icMatch.distOnlyMaxM + 'm 以内になく、名称でも照合できない（OSM名：' + (e._direct.concat(e._comp).join('/') || 'なし') + '）');
    }
    if (pick && e._direct.length && !pick.j.bases.some(b => e._direct.includes(b)) && method !== 'name(direct)+distance') {
      // 直接名がある（＝OSMが別名を示す）のに別の N06 を選んだ場合は不採用
      reason = 'OSM 直接名（' + e._direct.join('/') + '）と N06 名（' + pick.j.name + '）が不一致'; pick = null;
    }
    if (pick) {
      e._n06 = pick.j; e._n06d = pick.d; e._n06method = method + (pick.sameRoad ? '' : '（他路線の接合部：JCT経由で直接出入り）');
      matchRows.push({ edge: e.id, kind: e.kind, dir: e.dir, road: e.road, osm_ic_id: e.ic_id, osm_name: e._osmName, n06_id: pick.j.n06_id, n06_name: pick.j.name, koj: pick.j.koj, method, dist_m: r1(pick.d) });
    } else {
      unmatched.push({ edge: e.id, kind: e.kind, dir: e.dir, road: e.road, osm_ic_id: e.ic_id, osm_names: { direct: e._direct, component: e._comp, refs: e._refs },
        via: e.via, surface_node: e.kind === 'on_ramp' ? e.osm.start_node : e.osm.end_node, osm_ways: e.osm.ways, reason,
        graph_handling: 'graph_small.json では ic_id に OSM 側 IC 群ID（' + e.ic_id + '）を残し、ics に n06_id:null・koj:null で載せる。探索対象からは外さない' });
    }
  }
  // JCT（koj3）と接続部（koj4）の対応（jct_link・境界）
  const jctRows = [];
  for (const j of joints.filter(j => j.koj === 3 || j.koj === 4)) {
    const pt = { lat: j.lat, lng: j.lng };
    const jl = edges.filter(e => e.kind === 'jct_link').map(e => ({ e, d: hav(e.via, pt) })).filter(x => x.d <= 2000 && x.e.osm.junctions.some(q => baseNames(q.name).some(b => j.bases.includes(b))) || x.d <= 800);
    const bd = report.excludedBoundaries.filter(b => b.type === 'link_to_excluded').map(b => ({ b, d: hav(P(b.start), pt) })).filter(x => x.d <= 2000);
    const bn = edges.filter(e => e.boundary_node).map(e => ({ e, d: hav(e.boundary_node, pt) })).filter(x => x.d <= 500);
    const mb = report.excludedBoundaries.filter(b => b.type === 'mainline_to_excluded').map(b => ({ b, d: hav(b, pt) })).filter(x => x.d <= 1500);
    jctRows.push({ n06_id: j.n06_id, name: j.name, koj: j.koj, jct_links: jl.map(x => ({ edge: x.e.id, dir: x.e.dir, dist_m: r1(x.d) })),
      boundary_links: bd.map(x => ({ start: x.b.start, end: x.b.end, excluded: x.b.excluded, dir: x.b.dir, dist_m: r1(x.d) })),
      operator_boundary_edges: bn.map(x => ({ edge: x.e.id, dist_m: r1(x.d) })), mainline_boundaries: mb.map(x => ({ node: x.b.node, excluded: x.b.excluded, dist_m: r1(x.d) })) });
  }
  // 最終 IC：N06 照合済みは ic:<n06_id>、未照合は OSM 群IDを維持
  const finalIcs = new Map();
  for (const e of rampRecs) {
    if (e._n06) {
      const id = 'ic:' + e._n06.n06_id;
      if (!finalIcs.has(id)) finalIcs.set(id, { ic_id: id, name: e._n06.name, koj: e._n06.koj, n06_id: e._n06.n06_id, road: e._n06.primaryRoads[0] || e.road, lat: e._n06.lat, lng: e._n06.lng, osm_ic_ids: new Set(), ramps: [], n06_match: true });
      const ic = finalIcs.get(id); ic.osm_ic_ids.add(e.ic_id); ic.ramps.push(e.id);
      e._finalIc = id; e._koj = e._n06.koj;
    } else {
      const o = [...osmIcs.values()].find(x => x.ic_id === e.ic_id);
      if (!finalIcs.has(e.ic_id)) finalIcs.set(e.ic_id, { ic_id: e.ic_id, name: o.name, koj: null, n06_id: null, road: e.road, lat: o.lat, lng: o.lng, osm_ic_ids: new Set([e.ic_id]), ramps: [], n06_match: false });
      finalIcs.get(e.ic_id).ramps.push(e.id); e._finalIc = e.ic_id; e._koj = null;
    }
  }
  const finalIcList = [...finalIcs.values()].map(ic => Object.assign({}, ic, { osm_ic_ids: [...ic.osm_ic_ids], movements: ic.ramps.map(id => edgeById.get(id)).map(e => e.kind + ':' + e.dir).sort() })).sort((a, b) => a.ic_id.localeCompare(b.ic_id));
  // 最終グラフ用に辺を複製
  const edges2 = edges.map(e => { const o = Object.assign({}, e); o.osm = Object.assign({}, e.osm); return o; });
  for (const e of edges2) {
    if (e.kind !== 'on_ramp' && e.kind !== 'off_ramp') continue;
    const src = edgeById.get(e.id);
    e.osm_ic_id = src.ic_id; e.ic_id = src._finalIc; e.koj = src._koj;
    e.n06_match = src._n06 ? { n06_id: src._n06.n06_id, method: src._n06method, dist_m: r1(src._n06d) } : null;
  }
  // JCT 連絡路へ N06 JCT 名
  for (const e of edges2) if (e.kind === 'jct_link') {
    const row = jctRows.find(r => r.jct_links.some(x => x.edge === e.id));
    if (row) e.jct = { n06_id: row.n06_id, name: row.name, koj: row.koj };
  }
  tagNodeIcs(e => ({ ic_id: e._finalIc, koj: e._koj }));
  const f2 = finalize(edges2, nodes);
  const graphFinal = {
    schema: 'rf-graph/1',
    meta: Object.assign({ name: 'rf-graph small (OSM + N06照合)' }, metaCommon, {
      version: REGION + '-osm' + (baseDate || 'unknown').replace(/-/g, '') + '-n06y2025-r' + REV,
      source: OSM_SOURCE + ' ／ ' + n06.meta.source,
      license: 'ODbL 1.0（OpenStreetMap 派生データベースとして扱う）。N06 由来の名称・種別（koj）・接合部ID は CC BY 4.0（出典：' + n06.meta.source + '）。N06 単体は n06_small.json に別保持（CC BY 4.0）',
      n06: { year: 2025, filter: 'exp開始≤Y かつ 終了=9999（N06_014=9999）、同一rfid（N06_015）は最新の変遷のみ。対象3路線の線形から300m以内・bbox内', extractor_filter: n06.meta.filter,
             extractedAt: n06.meta.source.match(/（(\d{4})年(\d{1,2})月(\d{1,2})日取得）/) ? n06.meta.source.match(/（(\d{4})年(\d{1,2})月(\d{1,2})日取得）/).slice(1).map((x, i) => i ? x.padStart(2, '0') : x).join('-') : null,
             base_date: n06.meta.base_date, file: n06.meta.file, license: n06.meta.license, joints: n06.joints.length,
             extract_file: path.basename(n06Path), extract_sha256: require('crypto').createHash('sha256').update(n06raw).digest('hex') },
      ic_match: { matched_ramps: matchRows.length, unmatched_ramps: unmatched.length, params: PARAMS.icMatch },
      params: PARAMS }),
    ics: finalIcList.map(ic => ({ ic_id: ic.ic_id, name: ic.name, koj: ic.koj, n06_id: ic.n06_id, n06_match: ic.n06_match, road: ic.road, lat: ic.lat, lng: ic.lng, osm_ic_ids: ic.osm_ic_ids, movements: ic.movements })),
    nodes: f2.outNodes, edges: f2.outEdges,
  };

  report.sapa = sapaGroups.map(g => ({ id: g.id || null, isSapa: g.isSapa, names: g.names, lat: g.lat, lng: g.lng, clusters: g.clusters, merged: g.merged, mergeDistM: g.mergeDistM || null, ins: g.ins.length, outs: g.outs.length, road: g.road || null, dirIn: g.dirIn || null, dirOut: g.dirOut || null }));
  report.restrictions = restrLog;
  if (sapaPlan) {
    const eById = new Map(edges.map(q => [q.id, q]));
    report.sapa_geom = { params: SAPA_PARAMS, max_conn_pos_diff_m: r1(sapaPlan.rep.max_conn_pos_diff_m), facilities: sapaPlan.rep.facilities,
      edges: [...sapaPlan.plan.keys()].sort().map(id => {
        const e = eById.get(id), pl = sapaPlan.plan.get(id), ap = e.osm.approx_service_m || 0, link = e.length_m - ap, sp = pl.info ? pl.info.path_m : 0;
        return { id, kind: e.kind, length_m: e.length_m, approx_service_m: ap, link_m: r1(link), sapa_path_m: pl.info ? pl.info.path_m : null, end_to_sapa_m: pl.info ? pl.info.end_to_sapa_m : null,
          geom_len_m: r1(link + sp), ratio: +((link + sp) / e.length_m).toFixed(4), geom_gap: !!pl.gapInfo, geom_gap_info: pl.gapInfo || null };
      }) };
  }
  report.counts = { paths: paths.length, accepted: accepted.length, mergedLinks: links.length, mlChains: mlChains.length, keyNodes: keyNodes.size, nodes: nodes.size, edges: edges.length, ramps: rampRecs.length };
  report.jctRows = jctRows;
  report.osmIcs = [...osmIcs.values()];
  return { graphOsm, graphFinal, matchRows, unmatched, jctRows, report };
}

// ------------------------------------------------------------------ アプリ用の軽量版（graph_small.app.json）
const APP_NODE_KEYS = ['id', 'type', 'lat', 'lng', 'name', 'ic_id', 'koj'];
// 計画 §5.1 の残す項目＋geom・via_heading。jct（JCT連絡路の N06 JCT 名）は表示名（A2 の「海老名JCT」）に要るため追加（計画の一覧にない追加項目）
const APP_EDGE_KEYS = ['id', 'from', 'to', 'kind', 'length_m', 'toll', 'road', 'operator', 'fare_relevant', 'ic_id', 'via', 'via_heading', 'restriction', 'dir', 'geom', 'geom_gap', 'geom_gap_info', 'jct'];
const sha256hex = buf => require('crypto').createHash('sha256').update(buf).digest('hex');
const pick = (o, keys) => { const r = {}; for (const k of keys) if (o[k] !== undefined) r[k] = o[k]; return r; };
/** full＝完全版グラフ（オブジェクト）、fullBytes＝その保存バイト列。osm サブオブジェクトなどを落とした軽量版を返す */
function makeAppGraph(full, fullBytes) {
  const fm = full.meta;
  const nodes = full.nodes.map(n => pick(n, APP_NODE_KEYS));
  const edges = full.edges.map(e => pick(e, APP_EDGE_KEYS));
  const ics = full.ics;
  const body = { nodes, edges, ics };
  let geomChars = 0, geomEdges = 0; for (const e of edges) if (e.geom) { geomChars += e.geom.length; geomEdges++; }
  const meta = {
    name: 'rf-graph small (app)', app_format: APP_FORMAT, region: fm.region, published_file: APP_FILE, version: fm.version,
    bbox: fm.bbox, baseDate: fm.baseDate, baseYear: fm.baseYear, roads: fm.roads, road_list: fm.road_list,
    rampPoints: fm.rampPoints, rampPoints_definition: fm.rampPoints_definition, ramps: fm.ramps,
    counts: Object.assign({ nodes: nodes.length, edges: edges.length, ics: ics.length, geom_edges: geomEdges, geom_chars: geomChars }, fm.sapa_geom ? { geom_gap_edges: edges.filter(e => e.geom_gap).length } : {}),
    geom: fm.geom, via_heading: fm.via_heading,
    source: fm.source, license: fm.license,
    osm: { sha256: fm.osm.sha256, osm_base: fm.osm.osm_base, query: fm.osm.query, bbox: fm.osm.bbox },
    ...(fm.osm_sapa ? { osm_sapa: { sha256: fm.osm_sapa.sha256, osm_base: fm.osm_sapa.osm_base, osm_base_same_as_main: fm.osm_sapa.osm_base_same_as_main, query: fm.osm_sapa.query } } : {}),
    n06: { year: fm.n06.year, base_date: fm.n06.base_date, file: fm.n06.file, license: fm.n06.license, joints: fm.n06.joints, extract_file: fm.n06.extract_file, extract_sha256: fm.n06.extract_sha256 },
    derived_from: { file: 'graph_small.json', sha256: sha256hex(fullBytes), bytes: fullBytes.length, builder: fm.builder, built_with: fm.built_with },
    content_sha256: sha256hex(Buffer.from(JSON.stringify(body), 'utf8')),
    content_sha256_definition: 'このファイルを読み込んだ後の JSON.stringify({nodes, edges, ics}) を UTF-8 にしたバイト列の SHA-256（meta を除く本体。ファイル全体の SHA-256 はファイル自身には埋め込めないため README に記載）',
    removed_from_full: '辺と点の osm サブオブジェクト、via_basis・via_unique_len_m・toll_source・fare_reason・sub・via_excluded・n06_match・osm_ic_id・koj（辺）など、探索・照合に使わない項目',
    cross_region: fm.cross_region, cross_region_note: fm.cross_region_note,
  };
  return { schema: full.schema, meta, ics, nodes, edges };
}

function main() {
  const a = parseArgs(process.argv);
  const r = build(a.osm, a.n06, a.sapa);
  fs.mkdirSync(a.out, { recursive: true });
  const ser = o => Buffer.from(JSON.stringify(o, null, 1) + '\n', 'utf8');
  const wb = (f, buf) => fs.writeFileSync(path.join(a.out, f), buf);
  const w = (f, o) => wb(f, ser(o));
  w('graph_small.osm-only.json', r.graphOsm);
  const fullBytes = ser(r.graphFinal);
  wb('graph_small.json', fullBytes);
  const app = makeAppGraph(r.graphFinal, fullBytes);
  wb('graph_small.app.json', Buffer.from(JSON.stringify(app) + '\n', 'utf8'));
  w('ic_match.json', { note: 'OSM側ランプ ⇔ N06接合部の照合結果。N06 の名称・ID（CC BY 4.0）と OSM 派生（ODbL）の結合表。結合物は ODbL として扱う', n06_source: r.graphFinal.meta.n06, ramps: r.matchRows, jct_and_boundaries: r.jctRows });
  w('unmatched.json', { note: 'N06 と照合できなかったランプ。graph_small.json では ic_id に OSM 側IC群ID（osm-ic:…）を残し、ics では n06_id:null・koj:null。探索からは除外しない', count: r.unmatched.length, ramps: r.unmatched });
  w('build_report.json', r.report);
  const c = r.report.counts;
  console.log('nodes', c.nodes, 'edges', c.edges, 'ramps', c.ramps, 'ics(final)', r.graphFinal.ics.length, 'unmatched', r.unmatched.length, 'anomalies', r.report.anomalies.length,
    'geom_points', r.report.geom.points_after, 'via_heading', r.report.heading.edges,
    ...(r.report.sapa_geom ? ['sapa_edges', r.report.sapa_geom.edges.length, 'geom_gap', r.report.sapa_geom.edges.filter(q => q.geom_gap).length] : []));
}

if (require.main === module) main();
module.exports = { build, makeAppGraph, baseNames, PARAMS, SAPA_PARAMS, simplifyDP, encodePolyline, headingAtVia, alongPolyline, bearingDeg, APP_NODE_KEYS, APP_EDGE_KEYS, APP_FILE, APP_FORMAT };
