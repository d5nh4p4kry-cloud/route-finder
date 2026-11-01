#!/usr/bin/env node
/*
 * verify_graph.js — 段階3 小グラフの検証
 *   (a) validateGraph 合格（OSMのみ版・N06照合版）＋追加の構造検査
 *   (b) 計画 v5.1 段階3の照合：片方向IC・スマートIC・SA/PA併設・JCT連絡路・restriction 各5件（なければ件数）
 *       一次データ（OSM 要素ID・座標・タグ）付き。公式の出入方向は記憶で断定せず「未確認（段階5で照合）」
 *   (c) N06 22件との対応表（OSM側ランプ数・方向・距離誤差）
 *   (d) 到達性：主要IC間で engine の列挙器を実グラフに対して実行（候補数・計算量・偽乗り直し・ゼロ長）
 *       ＋入口/出口だけに絞った部分グラフで engine と brute（独立全列挙）の一致
 *   (e) 各ランプが一般道側端点を必ず1つ持ち、その端点が OSM 上で一般道に接すること
 *   (f) 段階5a-1 追補：辺ジオメトリ geom・via_heading・軽量版 graph_small.app.json・再生成のバイト一致
 *   (g) 段階5a-1′：SA/PA 場内通路の形状（--sapa あり）。埋めた geom の各点が場内通路 way から ≤5 m・順序 from→to・一方通行の向き、
 *       geom_gap 辺の列挙、SA/PA 接続辺の長さ比（geom の長さ/length_m）が 0.9〜1.1 に入るか（外れる辺は NOTE で列挙）、
 *       --sapa なしの再生成が 5a-1 の出力とバイト一致、5a-1 の出力との差が意図した項目（SA/PA 接続辺の geom 等）だけであること
 *       ・符号化ポリライン（既知ベクトル）・heading が OSM way の進行方向と ±30° 以内
 *       ・geom の各点と線分が元 way から 5 m 以内・順序が from→to（OSM way の進行方向と一致）
 *       ・軽量版と完全版の辺集合一致・validateGraph・engine の列挙結果が同一・ハッシュ類
 *
 * 使い方:
 *   node verify_graph.js --dir <out> --osm <osm_small.json> --engine <engine.js のあるディレクトリ> [--n06 <n06_small.json>] [--n06raw <N06 UTF-8 dir>] [--tmp <再生成用の作業ディレクトリ>] [--sapa <osm_sapa.json>]
 *   --sapa：グラフを build_graph.js --sapa で作った場合（meta.osm_sapa がある場合）は必須。build_graph.js に渡したものと同じファイルを指定する
 *   --n06 を省くと <dir>/n06_small.json を使う（build_graph.js の --n06 に渡したものと同じファイルを指定する）
 *   --engine のディレクトリに brute.js があれば (d) で engine と独立全列挙（brute）の一致も検査する。なければその比較だけを省く
 *   --tmp を省くと OS の一時ディレクトリ内の rfgraph-verify-rebuild に再生成する（検証側ではファイルを削除しない。上書きのみ）
 * 出力: <dir>/verify_result.json、標準出力に要約。必須検査に失敗があれば終了コード1
 */
'use strict';
const fs = require('fs');
const path = require('path');

function args() {
  const a = {}; for (let i = 2; i < process.argv.length; i += 2) a[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
  if (!a.dir || !a.osm || !a.engine) { console.error('usage: node verify_graph.js --dir <out> --osm <osm_small.json> --engine <dir with engine.js> [--n06 <n06_small.json>] [--n06raw <dir>] [--tmp <dir>] [--sapa <osm_sapa.json>]'); process.exit(2); }
  return a;
}
const A = args();
const E = require(path.resolve(A.engine, 'engine.js'));
let B = null; try { B = require(path.resolve(A.engine, 'brute.js')); } catch (err) { B = null; } // brute.js がなければ engine＝brute の比較だけ省く
const load = f => JSON.parse(fs.readFileSync(path.join(A.dir, f), 'utf8'));
const G = load('graph_small.json'), GO = load('graph_small.osm-only.json'), UN = load('unmatched.json'), REP = load('build_report.json');
const N06_PATH = A.n06 || path.join(A.dir, 'n06_small.json');
const N06 = JSON.parse(fs.readFileSync(N06_PATH, 'utf8'));
const OSM = JSON.parse(fs.readFileSync(A.osm, 'utf8'));
// 段階5a-1′：SA/PA 場内通路（任意）。グラフが --sapa 付きで作られていれば必須
const HAS_SAPA = !!(G.meta && G.meta.osm_sapa);
if (HAS_SAPA && !A.sapa) { console.error('このグラフは build_graph.js --sapa で作られている（meta.osm_sapa あり）。--sapa <osm_sapa.json> を指定してください'); process.exit(2); }
if (!HAS_SAPA && A.sapa) { console.error('--sapa が指定されたが、このグラフには meta.osm_sapa がない（--sapa なしで作られている）'); process.exit(2); }
const SAPA_BYTES = HAS_SAPA ? fs.readFileSync(A.sapa) : null;
const SAPA = HAS_SAPA ? JSON.parse(SAPA_BYTES.toString('utf8')) : null;
const SW = new Map();   // 場内通路 way（geometry 付き）。本体の索引（OW・coord の既存分）は変えず、geom の検査にだけ使う
if (SAPA) for (const e of SAPA.elements) if (e.type === 'way') SW.set(e.id, e);
const OW = new Map(), ON = new Map(), ORel = new Map(), nodeWays = new Map(), coord = new Map();
for (const e of OSM.elements) {
  if (e.type === 'way') { OW.set(e.id, e); e.nodes.forEach((n, i) => { (nodeWays.get(n) || nodeWays.set(n, []).get(n)).push(e.id); if (e.geometry) coord.set(n, { lat: e.geometry[i].lat, lng: e.geometry[i].lon }); }); }
  else if (e.type === 'node') { ON.set(e.id, e); coord.set(e.id, { lat: e.lat, lng: e.lon }); }
  else ORel.set(e.id, e);
}
const hav = E.haversineM;
if (SAPA) for (const w of SW.values()) if (w.geometry) w.nodes.forEach((n, i) => { if (!coord.has(n)) coord.set(n, { lat: w.geometry[i].lat, lng: w.geometry[i].lon }); });
/** geom の検査で使う way：本体（geometry 付き）を優先し、なければ場内通路（osm_sapa）の way */
const GWAY = id => { const a = OW.get(id); if (a && a.geometry) return a; return SW.get(id) || a; };
const r1 = x => Math.round(x * 10) / 10;
const results = { generatedAt: new Date().toISOString(), node: process.version, checks: [], sections: {} };
let hardFail = 0;
function check(name, ok, detail, hard = true) { results.checks.push({ name, ok, hard, detail }); if (!ok && hard) hardFail++; console.log((ok ? 'PASS ' : (hard ? 'FAIL ' : 'NOTE ')) + name + (detail !== undefined ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300) : '')); }
const nodeById = new Map(G.nodes.map(n => [n.id, n]));
const edgeById = new Map(G.edges.map(e => [e.id, e]));
const icById = new Map(G.ics.map(i => [i.ic_id, i]));
const ramps = G.edges.filter(e => e.kind === 'on_ramp' || e.kind === 'off_ramp');
const SURF = ['ramp_surface_end', 'smartic_gate'];
const surfOf = e => e.kind === 'on_ramp' ? e.from : e.to;
const wayTags = (w, keys) => { const t = (OW.get(w) || {}).tags || {}; const o = {}; for (const k of keys) if (t[k] !== undefined) o[k] = t[k]; return o; };
const nodeRec = id => { const n = ON.get(id); const c = coord.get(id); return { osm_node: id, lat: c && +c.lat.toFixed(6), lng: c && +c.lng.toFixed(6), tags: n ? n.tags : undefined }; };
function segDist(p, a, b) { // 点と線分の距離（局所平面近似）
  const k = Math.cos(p.lat * Math.PI / 180) * 111320, ky = 110574;
  const ax = (a.lng - p.lng) * k, ay = (a.lat - p.lat) * ky, bx = (b.lng - p.lng) * k, by = (b.lat - p.lat) * ky;
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy; const t = L === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L));
  return Math.hypot(ax + t * dx, ay + t * dy);
}
function distToWays(p, ways) { let d = Infinity; for (const w of ways) { const g = (GWAY(w) || {}).geometry; if (!g) continue; for (let i = 1; i < g.length; i++) d = Math.min(d, segDist(p, { lat: g[i - 1].lat, lng: g[i - 1].lon }, { lat: g[i].lat, lng: g[i].lon })); } return d; }

// ================================================================ (a)
console.log('== (a) validateGraph と構造検査');
for (const [nm, g] of [['graph_small.osm-only.json', GO], ['graph_small.json', G]]) {
  const v = E.validateGraph(g);
  check('(a) validateGraph ' + nm, v.ok, { errors: v.errors.length, warnings: v.warnings.length, first: v.errors.slice(0, 3) });
}
check('(a) OSMのみ版と照合版でノード・辺の集合（ID・端点・種別・長さ）が同一', JSON.stringify(GO.edges.map(e => [e.id, e.from, e.to, e.kind, e.length_m])) === JSON.stringify(G.edges.map(e => [e.id, e.from, e.to, e.kind, e.length_m])) && GO.nodes.length === G.nodes.length);
check('(a) OSMのみ版に N06 由来の属性（koj・n06_id・N06名称）が含まれない', !GO.edges.some(e => e.koj !== undefined || e.n06_match !== undefined) && !GO.ics.some(i => i.koj !== null || i.n06_id) && !GO.nodes.some(n => n.koj !== undefined) && !JSON.stringify(GO).includes('EA03_'));
check('(a) 長さ0の辺なし', !G.edges.some(e => e.length_m <= 0), G.edges.filter(e => e.length_m <= 0).map(e => e.id));
check('(a) 自己ループ・重複IDなし', new Set(G.edges.map(e => e.id)).size === G.edges.length && !G.edges.some(e => e.from === e.to));
check('(a) 同一 (kind,from,to) の並行辺なし（料金所レーン等は最短に統合）', new Set(G.edges.map(e => e.kind + e.from + '>' + e.to)).size === G.edges.length);
check('(a) toll は true/false/null のみ、null を false に置換していない', G.edges.every(e => e.toll === true || e.toll === false || e.toll === null), { true: G.edges.filter(e => e.toll === true).length, false: G.edges.filter(e => e.toll === false).length, null: G.edges.filter(e => e.toll === null).length });
check('(a) meta 必須項目（schema・baseDate・baseYear=2025・roads・rampPoints・source・license・n06）', G.schema === 'rf-graph/1' && /^\d{4}-\d{2}-\d{2}$/.test(G.meta.baseDate) && G.meta.baseYear === 2025 && G.meta.roads === 3 && G.meta.rampPoints > 0 && /OpenStreetMap contributors, ODbL 1\.0/.test(G.meta.source) && /国土数値情報/.test(G.meta.source) && G.meta.license && G.meta.n06 && G.meta.n06.year === 2025,
  { baseDate: G.meta.baseDate, roads: G.meta.roads, rampPoints: G.meta.rampPoints, ramps: G.meta.ramps });
// via は該当ランプの OSM 折れ線上（1m以内）、一般道側端点と異なる
const viaBad = [];
for (const e of G.edges.filter(e => e.via)) {
  const d = distToWays(e.via, e.osm.ways);
  const sp = (e.kind === 'on_ramp' || e.kind === 'off_ramp') ? nodeById.get(surfOf(e)) : null;
  const ds = sp ? hav(sp, e.via) : null;
  if (!(d <= 1.0) || (sp && !(ds > 1))) viaBad.push({ id: e.id, d_to_way_m: r1(d), d_to_surface_m: ds === null ? null : r1(ds) });
}
check('(a) via が自辺の OSM way 上（≤1m）かつ一般道側端点と別の点', viaBad.length === 0, viaBad.length ? viaBad.slice(0, 5) : { checked: G.edges.filter(e => e.via).length });
const viaBasis = {}; for (const e of G.edges.filter(e => e.via_basis)) viaBasis[e.via_basis] = (viaBasis[e.via_basis] || 0) + 1;
results.sections.via_basis = viaBasis;
// 中間地点の順序（v5.1追補#3）：入口一般道側端点→入口via→JCT via→出口via→出口一般道側端点 の各点が別の点
check('(a) 経由点の順序付けに必要な点がすべてのランプにある（一般道側端点 non-via・ランプ中点 via）', ramps.every(e => e.via && SURF.includes(nodeById.get(surfOf(e)).type)));

// ================================================================ (e)
console.log('== (e) 一般道側端点');
const SURF_HW = ['primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'trunk', 'primary_link', 'secondary_link', 'tertiary_link', 'trunk_link', 'living_street', 'road'];
// 無料の自動車専用道路：路線名（無名は ref）単位で、toll タグ付き way がすべて toll=no（build とは独立に OSM 原本から算出）
const tollByRoad = new Map();
for (const w of OW.values()) { if (!w.geometry || !/^(motorway|trunk)$/.test(w.tags.highway)) continue; const k = w.tags.name || ('ref:' + (w.tags.ref || '?')); const s = tollByRoad.get(k) || { yes: 0, no: 0 }; if (w.tags.toll === 'yes') s.yes++; if (w.tags.toll === 'no') s.no++; tollByRoad.set(k, s); }
const isFreeMain = w => { const s = tollByRoad.get(w.tags.name || ('ref:' + (w.tags.ref || '?'))); return !!s && s.yes === 0 && s.no > 0; };
const eBad = [];
const surfaceUse = {};
for (const e of ramps) {
  const ends = [e.from, e.to].filter(id => SURF.includes(nodeById.get(id).type));
  const sn = nodeById.get(surfOf(e));
  const osmId = e.kind === 'on_ramp' ? e.osm.start_node : e.osm.end_node;
  const touch = (nodeWays.get(osmId) || []).map(w => OW.get(w)).filter(w => {
    const t = w.tags; if (['no', 'private'].includes(t.access)) return false;
    if (!w.geometry && SURF_HW.includes(t.highway)) return true;
    if (w.geometry && /^(motorway|trunk)$/.test(t.highway) && isFreeMain(w)) return true; // 無料の自動車専用道路（保土ヶ谷BP等）
    return false;
  });
  const onTargetMain = (nodeWays.get(osmId) || []).some(w => { const ww = OW.get(w); return ww.geometry && /^(motorway|trunk)$/.test(ww.tags.highway) && !isFreeMain(ww); });
  const kind = touch.some(w => w.geometry) ? 'free_motorway' : 'surface';
  surfaceUse[kind] = (surfaceUse[kind] || 0) + 1;
  if (ends.length !== 1 || !touch.length || onTargetMain || sn.osm_node !== osmId) eBad.push({ id: e.id, surfaceEnds: ends.length, touch: touch.length, onTollMain: onTargetMain });
}
check('(e) 全ランプ（' + ramps.length + '本）が一般道側端点をちょうど1つ持ち、その OSM ノードが一般道（または無料自専道）に接し、有料本線上にない', eBad.length === 0, eBad.length ? eBad.slice(0, 5) : surfaceUse);
check('(e) JCT連絡路・本線は一般道側端点に接続しない', !G.edges.some(e => (e.kind === 'jct_link' || e.kind === 'mainline') && (SURF.includes(nodeById.get(e.from).type) || SURF.includes(nodeById.get(e.to).type))));
const freeMw = ramps.filter(e => { const id = e.kind === 'on_ramp' ? e.osm.start_node : e.osm.end_node; return (nodeWays.get(id) || []).some(w => OW.get(w).geometry && /^(motorway|trunk)$/.test(OW.get(w).tags.highway)); });
results.sections.free_motorway_surface_ramps = freeMw.map(e => ({ id: e.id, ic: e.ic_id, roads: [...new Set((nodeWays.get(e.kind === 'on_ramp' ? e.osm.start_node : e.osm.end_node) || []).map(w => OW.get(w)).filter(w => w.geometry && /^(motorway|trunk)$/.test(w.tags.highway)).map(w => w.tags.name))] }));

// ================================================================ (b)
console.log('== (b) 段階3 照合（各5件）');
const R = G.meta.road_list.reduce((o, r) => (o[r.key] = r, o), {});
const EXPECT = '未確認（段階5で照合）';
const rampSummary = e => ({ edge: e.id, kind: e.kind, dir: e.dir, length_m: e.length_m, toll: e.toll, surface_node: nodeRec(e.kind === 'on_ramp' ? e.osm.start_node : e.osm.end_node),
  mainline_node: e.kind === 'on_ramp' ? (e.osm.end_node || null) : (e.osm.start_node || null),
  osm_ways: e.osm.ways.slice(0, 6).map(w => ({ way: w, ...wayTags(w, ['highway', 'oneway', 'toll', 'name', 'destination', 'ref']) })), osm_ways_total: e.osm.ways.length,
  junctions: e.osm.junctions, toll_booths: e.osm.toll_booths });
// 1. 片方向IC
const icMov = ic => { const s = new Set(ramps.filter(e => e.ic_id === ic.ic_id).map(e => e.kind + ':' + e.dir)); return s; };
const half = [];
for (const ic of G.ics) {
  const r = R[ic.road]; const need = ['off_ramp:' + r.dir_pos, 'off_ramp:' + r.dir_neg, 'on_ramp:' + r.dir_pos, 'on_ramp:' + r.dir_neg];
  const has = new Set(ramps.filter(e => e.ic_id === ic.ic_id && e.road === ic.road).map(e => e.kind + ':' + e.dir)); const missing = need.filter(x => !has.has(x));
  if (missing.length && !/[\/]/.test([...has].join())) half.push({ ic, has: [...has].sort(), missing });
}
results.sections.half_ic = { count: half.length, rows: half.slice(0, 5).map(h => ({ ic_id: h.ic.ic_id, name: h.ic.name, road: h.ic.road, koj: h.ic.koj,
  osm_observed: { present: h.has, missing: h.missing, other_road_ramps: ramps.filter(e => e.ic_id === h.ic.ic_id && e.road !== h.ic.road).map(e => e.road + ':' + e.kind + ':' + e.dir) }, expected_official: EXPECT, compare: 'OSM実態のみ記録（公式の出入方向は未照合）',
  primary_data: ramps.filter(e => e.ic_id === h.ic.ic_id).map(rampSummary) })), others: half.slice(5).map(h => h.ic.name) };
check('(b) 片方向（ハーフ）IC：' + half.length + '件（' + half.map(h => h.ic.name + '［' + h.has.join('/') + '］').join('、') + '）', true, '公式の出入方向：' + EXPECT, false);
// 東京IC＋用賀（N06「首都高速/東名高速道路接続部」をはさむ一体の出入口）の組合せ
const tk = half.find(h => h.ic.name === '東京'), yg = half.find(h => h.ic.name === '用賀');
if (tk && yg) results.sections.half_ic.note_tokyo_yoga = 'OSM上、東京IC（東名側）は ' + tk.has.join('/') + '、用賀（首都高側）は ' + yg.has.join('/') + '。両者を合わせると4方向がそろう（N06「首都高速/東名高速道路接続部」を挟む）。公式の出入方向は' + EXPECT;
// 2. スマートIC
const sics = G.ics.filter(i => i.koj === 2);
const sicRows = sics.map(ic => {
  const es = ramps.filter(e => e.ic_id === ic.ic_id);
  return { ic_id: ic.ic_id, name: ic.name, n06_koj: ic.koj, osm_smart_detected: es.every(e => nodeById.get(surfOf(e)).type === 'smartic_gate'),
    attached_to_sapa: es.some(e => e.from.startsWith('sapa') || e.to.startsWith('sapa')), osm_observed: [...icMov(ic)].sort(), expected_official: EXPECT,
    primary_data: es.map(rampSummary) };
});
results.sections.smart_ic = { count: sics.length, note: sics.length < 5 ? '対象範囲の現役スマートICは N06 で ' + N06.joints.filter(j => j.koj === '2').length + '件のみ（5件に満たない）' : '', rows: sicRows.slice(0, 5) };
check('(b) スマートIC：' + sics.length + '件（N06 koj=2 と OSM のスマート判定（料金所名・分流名・SA/PA経由）が全ランプで一致）', sicRows.every(r => r.osm_smart_detected), sicRows.map(r => r.name + '［' + r.osm_observed.join('/') + '］').join('、'));
// SA/PA の向きと OSM 分流名（上り/下り/内回り/外回り）の一致（方向ベクトルの検証）
const sapas = G.nodes.filter(n => n.type === 'sapa');
const dirName = s => (s.match(/（(上り|下り|内回り|外回り)）|\((上り|下り|内回り|外回り)\)/) || []).slice(1).find(Boolean);
const dirChecks = sapas.map(s => ({ id: s.id, name: s.name, name_dir: dirName(s.name || '') || null, dir_in: s.osm.dir_in, dir_out: s.osm.dir_out }));
check('(b) SA/PA の進行方向（本線ベクトルから算出）が OSM 分流名の（上り/下り/内回り/外回り）と一致（' + dirChecks.length + '施設）', dirChecks.every(d => d.name_dir && d.dir_in.length === 1 && d.dir_in[0] === d.name_dir && d.dir_out.length === 1 && d.dir_out[0] === d.name_dir), dirChecks.map(d => d.name + '=' + d.dir_in.join('/')).join('、'));
// 3. SA/PA 併設
const sapaRows = sapas.map(s => {
  const ins = G.edges.filter(e => e.to === s.id), outs = G.edges.filter(e => e.from === s.id);
  const sic = ins.concat(outs).filter(e => e.kind === 'on_ramp' || e.kind === 'off_ramp');
  return { sapa: s.id, name: s.name, road: s.road, lat: s.lat, lng: s.lng, dir: s.osm.dir_in, smart_ic_attached: sic.length ? [...new Set(sic.map(e => e.ic_id))].map(id => icById.get(id).name) : [],
    osm_service_ways: s.osm.service_ways, merged_by_proximity: s.osm.merged_by_proximity,
    edges_in: ins.map(e => ({ id: e.id, kind: e.kind, length_m: e.length_m, junctions: e.osm.junctions })), edges_out: outs.map(e => ({ id: e.id, kind: e.kind, length_m: e.length_m })),
    expected_official: EXPECT };
}).sort((a, b) => b.smart_ic_attached.length - a.smart_ic_attached.length || a.name.localeCompare(b.name));
results.sections.sapa = { count: sapaRows.length, rows: sapaRows.slice(0, 5), others: sapaRows.slice(5).map(r => r.name) };
check('(b) SA/PA：' + sapaRows.length + '施設（うちスマートIC併設 ' + sapaRows.filter(r => r.smart_ic_attached.length).length + '）。各施設に本線からの進入1・本線への退出1', sapaRows.every(r => r.edges_in.filter(e => e.kind === 'mainline').length >= 1 && r.edges_out.filter(e => e.kind === 'mainline').length >= 1), sapaRows.map(r => r.name + (r.smart_ic_attached.length ? '＋' + r.smart_ic_attached.join() : '')).join('、'));
// 4. JCT 連絡路
const jls = G.edges.filter(e => e.kind === 'jct_link');
const jlPick = jls.filter(e => !e.sub).slice(0, 4).concat(jls.filter(e => e.sub).slice(0, 1));
results.sections.jct_link = { count: jls.length, in_graph_breakdown: jls.reduce((o, e) => (o[(e.jct && e.jct.name || '?') + (e.sub ? '（' + e.sub + '）' : '')] = (o[(e.jct && e.jct.name || '?') + (e.sub ? '（' + e.sub + '）' : '')] || 0) + 1, o), {}),
  rows: jlPick.map(e => ({ edge: e.id, jct: e.jct || null, dir: e.dir, road: e.road, length_m: e.length_m, fare_relevant: e.fare_relevant, via: e.via, restriction: e.restriction || null,
    from: nodeRec(+e.from.slice(2)), to: nodeRec(+e.to.slice(2)), osm_ways: e.osm.ways.slice(0, 6).map(w => ({ way: w, ...wayTags(w, ['highway', 'oneway', 'toll', 'destination', 'name']) })), osm_ways_total: e.osm.ways.length, junctions: e.osm.junctions,
    expected_official: EXPECT })),
  excluded_boundary_links: REP.excludedBoundaries.filter(b => b.type === 'link_to_excluded').length };
const ebMov = REP.excludedBoundaries.filter(b => b.type === 'link_to_excluded');
check('(b) JCT連絡路：グラフ内 ' + jls.length + '本（海老名JCT 東名⇄圏央道 ' + jls.filter(e => !e.sub).length + '、大橋JCT経由の3号同一路線連絡 ' + jls.filter(e => e.sub).length + '［resolved:false］）、対象外路線への境界連絡路 ' + ebMov.length + '本（除外）', jls.filter(e => !e.sub).length > 0, '公式の接続方向：' + EXPECT, false);
// 海老名JCT の4×2方向がそろうか（OSM内部の整合）
const ebinaMov = new Set(jls.filter(e => !e.sub).map(e => e.dir));
check('(b) 海老名JCT：東名{上り,下り}→圏央{内回り,外回り}、圏央{内回り,外回り}→東名{上り,下り} の8方向が OSM 上すべて接続', ebinaMov.size === 8, [...ebinaMov].sort().join('、'), false);
// 5. restriction
const relRows = REP.restrictions;
const mappedRel = relRows.filter(r => r.mapped.length);
results.sections.restriction = { osm_relations_total: relRows.length, mapped_to_graph: mappedRel.length, not_applicable: relRows.length - mappedRel.length,
  rows: mappedRel.slice(0, 5).map(r => ({ relation: r.relation, tags: r.tags, from: r.from.map(w => ({ way: w, ...wayTags(w, ['highway', 'name', 'oneway']) })), via_node: r.via_node.map(nodeRec), to: r.to.map(w => ({ way: w, ...wayTags(w, ['highway', 'name', 'oneway']) })), status: r.status, edges: r.mapped.map(id => ({ id, restriction: edgeById.get(id).restriction })), expected_official: EXPECT })),
  derived_unresolved: G.edges.filter(e => e.restriction && !e.restriction.resolved).map(e => ({ id: e.id, kind: e.restriction.kind, note: e.restriction.note })),
  impassable: G.edges.filter(e => e.restriction && e.restriction.resolved && e.restriction.passable === false).map(e => e.id),
  not_applicable_list: relRows.filter(r => !r.mapped.length).map(r => ({ relation: r.relation, restriction: r.tags.restriction || r.tags['restriction:conditional'], status: r.status })) };
check('(b) restriction 関係：OSM ' + relRows.length + '件中、グラフに関係するもの ' + mappedRel.length + '件（5件に満たない）。他に OSM 接続から導いた未解決条件 ' + results.sections.restriction.derived_unresolved.length + '辺', true, mappedRel.map(r => r.relation + ' ' + (r.tags.restriction || '') + ' → ' + r.status).join('；'), false);
// destination タグと方向の整合（入口ランプの destination に路線の行先が書かれている場合）
const DEST_DIR = { tomei: { '東京': '上り', '名古屋': '下り' }, c3: {}, ken: {} };
const destRows = [];
for (const e of ramps.filter(e => e.kind === 'on_ramp')) {
  const ds = e.osm.destination.join(';'); const m = DEST_DIR[e.road] || {};
  for (const [k, d] of Object.entries(m)) if (ds.split(/[;／]/).some(x => x.trim() === k)) destRows.push({ id: e.id, destination: ds, expected_dir_from_osm_destination: d, dir: e.dir, ok: e.dir === d });
}
check('(b) 東名の入口ランプ destination（東京/名古屋）と算出方向（上り/下り）の一致（OSM内部整合）', destRows.every(r => r.ok), { checked: destRows.length, ng: destRows.filter(r => !r.ok).map(r => r.id) });
results.sections.destination_dir_check = destRows;

// ================================================================ (c)
console.log('== (c) N06 22件との対応');
const nrows = [];
for (const j of N06.joints) {
  const pt = { lat: j.lat, lng: j.lng }; const koj = Number(j.koj);
  const row = { n06_id: j.n06_id, name: j.name, koj, koj_label: j.koj_label, n06_lat: j.lat, n06_lng: j.lng };
  if (koj === 1 || koj === 2) {
    const es = ramps.filter(e => e.ic_id === 'ic:' + j.n06_id);
    const ds = es.map(e => hav(pt, e.via)).sort((a, b) => a - b);
    const mov = {}; for (const e of es) { const k = e.kind.replace('_ramp', '') + ':' + e.dir; mov[k] = (mov[k] || 0) + 1; }
    Object.assign(row, { osm_ramps: es.length, on: es.filter(e => e.kind === 'on_ramp').length, off: es.filter(e => e.kind === 'off_ramp').length, by_direction: mov,
      surface_nodes: new Set(es.map(surfOf)).size, dist_m: ds.length ? { min: r1(ds[0]), median: r1(ds[Math.floor(ds.length / 2)]), max: r1(ds[ds.length - 1]) } : null,
      match_methods: [...new Set(es.map(e => e.n06_match && e.n06_match.method))], status: es.length ? '対応あり' : '対応なし' });
  } else {
    const jr = (load('ic_match.json').jct_and_boundaries || []).find(x => x.n06_id === j.n06_id) || {};
    const jl = (jr.jct_links || []), bl = (jr.boundary_links || []), ob = (jr.operator_boundary_edges || []), mb = (jr.mainline_boundaries || []);
    const ds = jl.map(x => x.dist_m).concat(bl.map(x => x.dist_m), ob.map(x => x.dist_m), mb.map(x => x.dist_m)).sort((a, b) => a - b);
    Object.assign(row, { jct_links_in_graph: jl.length, jct_dirs: jl.map(x => x.dir), boundary_links_excluded: bl.length, excluded_roads: [...new Set(bl.flatMap(x => x.excluded).concat(mb.flatMap(x => x.excluded)).filter(Boolean))],
      operator_boundary_edges: ob, mainline_boundaries: mb.length, dist_m: ds.length ? { min: ds[0], max: ds[ds.length - 1] } : null,
      status: jl.length ? 'グラフ内JCT連絡路あり' + (bl.length ? '＋対象外路線への境界' : '') : ob.length ? '事業者境界（料金影響辺）' : (bl.length || mb.length) ? '対象外路線との境界（連絡路は除外）' : '対応なし' });
  }
  nrows.push(row);
}
results.sections.n06_table = nrows;
const noMatch = nrows.filter(r => r.status === '対応なし');
check('(c) N06 現役接合部 ' + N06.joints.length + '件すべてに OSM 側の対応（ランプ・JCT連絡路・境界）がある', noMatch.length === 0 && N06.joints.length === 22, noMatch.map(r => r.name));
const icRows = nrows.filter(r => r.koj === 1 || r.koj === 2);
const maxD = Math.max(...icRows.map(r => r.dist_m ? r.dist_m.max : 0));
check('(c) IC（koj1/2 ' + icRows.length + '件）のランプ中点と N06 点の距離：最大 ' + maxD + 'm（照合上限 ' + G.meta.ic_match.params.nameMaxM + 'm 以内）', maxD <= G.meta.ic_match.params.nameMaxM, icRows.map(r => r.name + ' ' + (r.dist_m && r.dist_m.median) + 'm').join('、'));
check('(c) 未照合ランプ ' + UN.count + '件', UN.count === 0, UN.ramps.map(r => r.edge + ':' + r.reason), false);
// N06 抽出条件（原本があれば再確認）
if (A.n06raw && fs.existsSync(path.join(A.n06raw, 'N06-25_Joint.geojson'))) {
  const J = JSON.parse(fs.readFileSync(path.join(A.n06raw, 'N06-25_Joint.geojson'), 'utf8')).features;
  const bad = [];
  for (const j of N06.joints) {
    const fs_ = J.filter(f => f.properties.N06_015 === j.n06_id);
    const cur = fs_.filter(f => f.properties.N06_014 === 9999);
    if (cur.length !== 1 || cur[0].properties.N06_012 > 2025 || cur[0].properties.N06_018 !== j.name) bad.push({ id: j.n06_id, versions: fs_.length, current: cur.length });
  }
  results.sections.n06_filter = { checked: N06.joints.length, history_versions: N06.joints.map(j => ({ id: j.n06_id, name: j.name, versions: J.filter(f => f.properties.N06_015 === j.n06_id).map(f => [f.properties.N06_018, f.properties.N06_012, f.properties.N06_014]) })).filter(x => x.versions.length > 1) };
  check('(c) N06 抽出条件：22件とも 設置期間開始(N06_012)≤2025・終了(N06_014)=9999、同一ID(N06_015)の現役変遷は1件のみ（原本で再確認）', bad.length === 0, bad.length ? bad : '旧変遷を持つID：' + results.sections.n06_filter.history_versions.map(x => x.name + '（' + x.versions.map(v => v[0] + ' ' + v[1] + '〜' + v[2]).join(' → ') + '）').join('、'));
} else check('(c) N06 抽出条件の原本再確認', false, '--n06raw 未指定のため未実施', false);

// ================================================================ (d)
console.log('== (d) 到達性（engine 列挙器を実グラフで実行）');
const icPt = id => { const i = icById.get(id); return { lat: i.lat, lng: i.lng }; };
const byName = nm => G.ics.find(i => i.name === nm).ic_id;
// expectZero：OSM 上の片方向構造から直行乗車がないと見込まれる組（高樹町は OSM 上 下り出口のみ＝都心側からのみ降りられる）
const PAIRS = [['東京', '厚木'], ['用賀', '圏央厚木'], ['渋谷', '相模原愛川'], ['東名川崎', '寒川北'], ['厚木PASIC', '渋谷'], ['綾瀬SIC', '海老名'], ['厚木PASIC', '高樹町', { expectZero: true }]];
function qualityOf(cands) {
  let zeroLen = 0, reuse = 0, sameIcSameDir = 0, sameIcOtherDir = 0, sameNodeTransfer = 0, jctBoard = 0;
  for (const c of cands) {
    const used = new Set();
    for (let i = 0; i < c.rides.length; i++) {
      const r = c.rides[i]; const on = edgeById.get(r.on), off = edgeById.get(r.off);
      for (const id of [r.on, r.off]) { if (used.has(id)) reuse++; used.add(id); }
      if (r.path.some(id => edgeById.get(id).length_m === 0)) zeroLen++;
      if (!SURF.includes(nodeById.get(on.from).type) || !SURF.includes(nodeById.get(off.to).type)) jctBoard++;
      if (i + 1 < c.rides.length) {
        const nx = edgeById.get(c.rides[i + 1].on);
        if (off.to === nx.from) sameNodeTransfer++;
        if (off.ic_id === nx.ic_id) { if (off.dir === nx.dir) sameIcSameDir++; else sameIcOtherDir++; }
      }
    }
  }
  return { zeroLen, rampReuse: reuse, jctBoarding: jctBoard, sameIcSameDirReride: sameIcSameDir, sameIcOtherDirReride: sameIcOtherDir, sameSurfaceNodeTransfer: sameNodeTransfer };
}
const reach = [];
for (const [a, b, opt] of PAIRS) {
  const expectZero = !!(opt && opt.expectZero);
  const ia = byName(a), ib = byName(b);
  const o = icPt(ia), d = icPt(ib);
  const full = E.enumerate(G, o, d, {});
  const q = qualityOf(full.candidates);
  const direct = full.candidates.filter(c => c.n === 1 && edgeById.get(c.rides[0].on).ic_id === ia && edgeById.get(c.rides[0].off).ic_id === ib);
  // 部分グラフ：A の入口ランプと B の出口ランプだけを残す（本線・JCT・SA/PA はすべて残す）
  const sub = Object.assign({}, G, { edges: G.edges.filter(e => (e.kind === 'on_ramp' ? e.ic_id === ia : e.kind === 'off_ramp' ? e.ic_id === ib : true)) });
  const usedNodes = new Set(sub.edges.flatMap(e => [e.from, e.to])); sub.nodes = G.nodes.filter(n => usedNodes.has(n.id));
  const es = E.enumerate(sub, o, d, { maxLabels: 200000, maxMs: 20000 });
  let bs = null, bErr = null;
  if (B) { try { bs = B.enumerateAll(sub, o, d); } catch (err) { bErr = String(err && err.message || err); } } else bErr = 'brute.js なし（比較を省略）';
  const eIds = new Set(es.candidates.map(c => c.id));
  const bIds = bs && !bs.aborted ? bs.ids : null; if (bs && bs.aborted) bErr = 'brute aborted (steps ' + bs.steps + ')';
  const same = bIds ? (eIds.size === bIds.size && [...eIds].every(x => bIds.has(x))) : null;
  const directSub = es.candidates.filter(c => c.n === 1);
  const fareSets = [...new Set(directSub.map(c => c.rides[0].fare.join(',')))];
  const row = { from: a, to: b, from_ic: ia, to_ic: ib,
    full_graph: { complete: full.complete, truncated: full.truncated, candidates: full.stats.candidates, labelsCreated: full.stats.labelsCreated, labelsExpanded: full.stats.labelsExpanded, maxFrontier: full.stats.maxFrontier, elapsedMs: r1(full.stats.elapsedMs),
      by_rides: full.candidates.reduce((o2, c) => (o2[c.n] = (o2[c.n] || 0) + 1, o2), {}), direct_found: direct.length, quality: q },
    subgraph: { nodes: sub.nodes.length, edges: sub.edges.length, complete: es.complete, candidates: es.stats.candidates, labelsCreated: es.stats.labelsCreated, elapsedMs: r1(es.stats.elapsedMs), direct_rides: directSub.length,
      direct_ride_fare_sets: fareSets, brute_candidates: bIds ? bIds.size : null, brute_error: bErr, engine_equals_brute: same,
      direct_examples: directSub.slice(0, 3).map(c => ({ id: c.id, highway_km: r1(c.highwayM / 1000) })), quality: qualityOf(es.candidates) } };
  reach.push(row);
  row.expectZero = expectZero;
  check('(d) ' + a + '→' + b + '：部分グラフで直行乗車 ' + directSub.length + '通り' + (expectZero ? '（OSM上の片方向構造により0を期待）' : '') + '（engine＝brute ' + (same === null ? '未実施' : same) + '、候補 ' + es.stats.candidates + '、列挙' + (es.complete ? '完了' : '未完了') + '・ラベル' + es.stats.labelsCreated + '）', (expectZero ? directSub.length === 0 : directSub.length > 0) && es.complete && (B ? same === true : true), { brute: bIds ? bIds.size : bErr });
  check('(d) ' + a + '→' + b + '：全グラフ（既定上限5,000ラベル）で候補 ' + full.stats.candidates + '件・' + (full.complete ? '完了' : '探索未完了(' + full.truncated + ')') + '・' + r1(full.stats.elapsedMs) + 'ms、ゼロ長0・ランプ再利用0・JCT乗降0', q.zeroLen === 0 && q.rampReuse === 0 && q.jctBoarding === 0,
    { direct_found: direct.length, sameIcSameDirReride: q.sameIcSameDirReride, sameSurfaceNodeTransfer: q.sameSurfaceNodeTransfer });
}
results.sections.reachability = reach;
// 参考（合否に使わない）：大橋JCT経由の同一路線連絡4辺（resolved:false）を除いたグラフでの列挙量
{
  const drop = new Set(G.edges.filter(e => e.via_excluded).map(e => e.id));
  const G2 = Object.assign({}, G, { edges: G.edges.filter(e => !drop.has(e.id)) });
  const rows = [];
  for (const [a, b] of PAIRS) {
    const ia = byName(a), ib = byName(b);
    const f = E.enumerate(G2, icPt(ia), icPt(ib), {});
    const sub = Object.assign({}, G2, { edges: G2.edges.filter(e => (e.kind === 'on_ramp' ? e.ic_id === ia : e.kind === 'off_ramp' ? e.ic_id === ib : true)) });
    const s2 = E.enumerate(sub, icPt(ia), icPt(ib), { maxLabels: 200000, maxMs: 20000 });
    rows.push({ from: a, to: b, full_candidates: f.stats.candidates, full_complete: f.complete, full_by_rides: f.candidates.reduce((o2, c) => (o2[c.n] = (o2[c.n] || 0) + 1, o2), {}), sub_labels: s2.stats.labelsCreated, sub_candidates: s2.stats.candidates, sub_complete: s2.complete });
  }
  results.sections.reachability_without_via_excluded = { dropped: [...drop], rows };
  check('(d) 参考：大橋JCT経由4辺を除くと部分グラフのラベル数 ' + reach.map((r, i) => r.subgraph.labelsCreated + '→' + rows[i].sub_labels).join('、'), true, rows.map(r => r.from + '→' + r.to + ' 全グラフ候補' + r.full_candidates).join('、'), false);
}
// グラフ全体の単一乗車の到達表（独立DFS：on_ramp→mainline/jct_link の単純路→off_ramp、通行不可辺は除外）
const outE = new Map(); for (const e of G.edges) { if (e.restriction && e.restriction.resolved && e.restriction.passable === false) continue; (outE.get(e.from) || outE.set(e.from, []).get(e.from)).push(e); }
const rideSet = new Map(); // "icA>icB" → count of (on,off,fare) rides
let rideCount = 0;
for (const on of ramps.filter(e => e.kind === 'on_ramp')) {
  const st = [{ n: on.to, seen: new Set([on.from, on.to]), fare: [] }];
  while (st.length) {
    const c = st.pop();
    for (const x of (outE.get(c.n) || [])) {
      if (x.kind === 'off_ramp') { rideCount++; const k = on.ic_id + '>' + x.ic_id; rideSet.set(k, (rideSet.get(k) || 0) + 1); continue; }
      if (x.kind !== 'mainline' && x.kind !== 'jct_link') continue;
      if (c.seen.has(x.to)) continue;
      const seen = new Set(c.seen); seen.add(x.to); st.push({ n: x.to, seen, fare: x.fare_relevant ? c.fare.concat([x.id]) : c.fare });
    }
  }
}
const icIds = G.ics.map(i => i.ic_id);
const pairsReach = []; for (const a of icIds) for (const b of icIds) if (a !== b) pairsReach.push({ a, b, rides: rideSet.get(a + '>' + b) || 0 });
const unreach = pairsReach.filter(p => !p.rides);
results.sections.single_ride_matrix = { on_ramps: ramps.filter(e => e.kind === 'on_ramp').length, rides_total: rideCount, ic_pairs: pairsReach.length, unreachable_pairs: unreach.length,
  unreachable_examples: unreach.slice(0, 20).map(p => icById.get(p.a).name + '→' + icById.get(p.b).name), self_pairs: icIds.map(a => ({ ic: icById.get(a).name, rides: rideSet.get(a + '>' + a) || 0 })).filter(x => x.rides) };
check('(d) 単一乗車の到達表（独立DFS）：IC組 ' + pairsReach.length + '中、直行乗車できない組 ' + unreach.length, true, unreach.slice(0, 12).map(p => icById.get(p.a).name + '→' + icById.get(p.b).name).join('、'), false);

// ================================================================ (f) 段階5a-1 追補
console.log('== (f) geom・via_heading・軽量版・再生成');
const crypto = require('crypto');
const zlib = require('zlib');
const os = require('os');
const { execFileSync } = require('child_process');
const BG = require(path.resolve(__dirname, 'build_graph.js'));
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const fileBytes = f => fs.readFileSync(path.join(A.dir, f));
const n06FileBytes = () => fs.readFileSync(N06_PATH);
const APP = load('graph_small.app.json');
// build_graph.js の SA/PA 場内通路の許容（geom_gap の基準）。検査側は値を builder の定数から読む（定義の二重管理を避ける）
const BG_SAPA_GAP_END_M = BG.SAPA_PARAMS.gapEndM, BG_SAPA_GAP_JOINT_M = BG.SAPA_PARAMS.gapJointM;
// 段階5a-1 の出力（--sapa なし）の SHA-256。--sapa なしの再生成がこれとバイト一致することを (g) で確認する
const BASELINE_5A1 = {
  'graph_small.json': '96e860d5d1ed5879f2c83fccf1fc2147deff741a36dfa09d8519fc8aabf004b7',
  'graph_small.osm-only.json': 'a0b8b9349333eaf074f4a31af562f628fa9ca85601a1087e9ddf3405f58b74e4',
  'graph_small.app.json': 'df7339aed15ad577c43ef1b376182772b57474f2807c815807d3fff94a492d0a',
  'ic_match.json': 'cf5c95b2cbfe42d48a11ba5238faaf4d09fe5c048598b4751715e940e3d77f02',
  'unmatched.json': '0a31dc2baea49020a76b4d75cae5aa0421fe08cb7ff66da26a88fd192d1e7e33',
  'build_report.json': '73bbdcf23ae2da01aee338f0f917ab8978d59d0f87901261bfb0a62054b6a8c7',
};
const FULL_FILES = ['graph_small.json', 'graph_small.osm-only.json', 'graph_small.app.json', 'ic_match.json', 'unmatched.json', 'build_report.json'];

// ---- 符号化ポリライン：検証側の独立実装（デコーダ）。Google の公開例「_p~iF~ps|U_ulLnnqC_mqNvxq`@」で builder のエンコーダと突合
function decodePolyline(str, prec) {
  const f = Math.pow(10, prec == null ? 5 : prec); const out = []; let i = 0, la = 0, lg = 0;
  while (i < str.length) {
    for (let k = 0; k < 2; k++) {
      let shift = 0, result = 0, b;
      do { if (i >= str.length) throw new Error('polyline が途中で終わっている'); b = str.charCodeAt(i++) - 63; result += (b & 0x1f) * Math.pow(2, shift); shift += 5; } while (b >= 0x20);
      const d = (result % 2) ? -((result + 1) / 2) : result / 2;
      if (k === 0) la += d; else lg += d;
    }
    out.push({ lat: la / f, lng: lg / f });
  }
  return out;
}
{
  const vec = [{ lat: 38.5, lng: -120.2 }, { lat: 40.7, lng: -120.95 }, { lat: 43.252, lng: -126.453 }];
  const known = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
  const dec = decodePolyline(known), enc = BG.encodePolyline(vec, 5).str;
  check('(f) 符号化ポリライン：公開例ベクトルのエンコード・デコードが一致（精度 1e5）', enc === known && dec.length === 3 && dec.every((p, i) => Math.abs(p.lat - vec[i].lat) < 1e-9 && Math.abs(p.lng - vec[i].lng) < 1e-9), { enc, dec });
}

// ---- 再生成でバイト一致（build_graph.js を別ディレクトリへ実行し、出力 6 ファイルを現行ファイルと比較）
{
  const tmp = path.join(A.tmp || os.tmpdir(), 'rfgraph-verify-rebuild');
  fs.mkdirSync(tmp, { recursive: true });
  let err = null;
  try { execFileSync(process.execPath, [path.join(__dirname, 'build_graph.js'), '--osm', A.osm, '--n06', N06_PATH, '--out', tmp].concat(HAS_SAPA ? ['--sapa', A.sapa] : []), { stdio: 'pipe' }); } catch (e) { err = String(e && e.message || e).slice(0, 200); }
  const diffs = [], hashes = {};
  for (const f of FULL_FILES) {
    const a = fileBytes(f), b = err ? null : fs.readFileSync(path.join(tmp, f));
    hashes[f] = sha256(a);
    if (!b || !a.equals(b)) diffs.push(f);
  }
  results.sections.rebuild = { files: FULL_FILES, sha256: hashes, diffs, error: err };
  check('(f) 再生成でバイト一致（' + FULL_FILES.length + 'ファイル：完全版・OSMのみ版・軽量版・ic_match・unmatched・build_report）', !err && diffs.length === 0, err || (diffs.length ? { differ: diffs } : hashes));
}

// ---- geom：全辺（完全版・OSMのみ版・軽量版で同一）
const wayDir = w => { const t = (GWAY(w) || {}).tags || {}; const ow = t.oneway; if (ow === 'yes' || ow === 'true' || ow === '1') return 1; if (ow === '-1' || ow === 'reverse') return -1; if (ow === 'no' || ow === 'false' || ow === '0') return 0; return /^(motorway|motorway_link)$/.test(t.highway) ? 1 : 0; };
const bearing = (a, b) => { const k = Math.cos((a.lat + b.lat) / 2 * Math.PI / 180); return (Math.atan2((b.lng - a.lng) * k, b.lat - a.lat) * 180 / Math.PI + 360) % 360; };
const angDiff = (x, y) => { const d = Math.abs(x - y) % 360; return d > 180 ? 360 - d : d; };
/** 点 p に最も近い、指定 way 群の線分と、その線分の進行方向の方位（一方通行の向きを考慮。双方向は dir=0） */
function nearestWaySeg(p, ways) {
  let best = null;
  for (const w of ways) {
    const g = (OW.get(w) || {}).geometry; if (!g) continue; const dir = wayDir(w);
    for (let i = 1; i < g.length; i++) {
      const a = { lat: g[i - 1].lat, lng: g[i - 1].lon }, b = { lat: g[i].lat, lng: g[i].lon };
      const d = segDist(p, a, b);
      if (!best || d < best.d) best = { d, way: w, dir, brg: dir >= 0 ? bearing(a, b) : bearing(b, a) };
    }
  }
  return best;
}
const polyLenM = pts => { let s = 0; for (let i = 1; i < pts.length; i++) s += hav(pts[i - 1], pts[i]); return s; };
/** builder の内部配列を使わず、辺の osm.ways・始点／終点の OSM ノード・length_m から OSM の有向道路上の単純路を再構成する
 *  （way の進行方向は oneway タグに従う。経路長が length_m（SA/PA 辺は近似距離を除く）と 0.3 m 以内のものだけ残す）。戻り値は OSM ノードID列の配列 */
function osmPaths(e, sOsm, eOsm) {
  const adj = new Map(); const add = (a, b) => { const l = hav(coord.get(a), coord.get(b)); (adj.get(a) || adj.set(a, []).get(a)).push({ to: b, l }); };
  const sg = e.osm.sapa_geom;
  for (const w of (sg ? e.osm.ways.concat(sg.ways) : e.osm.ways)) { const ow = GWAY(w); if (!ow || !ow.geometry) continue; const d = wayDir(w); for (let i = 1; i < ow.nodes.length; i++) { const a = ow.nodes[i - 1], b = ow.nodes[i]; if (d >= 0) add(a, b); if (d <= 0) add(b, a); } }
  const target = e.length_m - (e.osm.approx_service_m || 0) + (sg ? sg.path_m : 0), out = []; let steps = 0;
  const seen = new Set([sOsm]), path = [sOsm];
  (function dfs(n, acc) {
    if (++steps > 2000000 || out.length >= 50) return;
    if (n === eOsm) { if (Math.abs(acc - target) <= 0.3) out.push(path.slice()); return; }
    for (const x of (adj.get(n) || [])) { if (seen.has(x.to) || acc + x.l > target + 0.3) continue; seen.add(x.to); path.push(x.to); dfs(x.to, acc + x.l); path.pop(); seen.delete(x.to); }
  })(sOsm, 0);
  return out;
}
/** geom が path の頂点列の部分列か（座標丸め 0.9 m 以内）、始点・終点が path の両端か、省いた頂点が残した線分から 5 m＋丸め以内か */
function geomOnPath(pts, path) {
  const P = path.map(n => coord.get(n)); const idx = []; let j = 0;
  for (const g of pts) { while (j < P.length && hav(P[j], g) > 0.9) j++; if (j >= P.length) return { ok: false, why: '部分列でない（geom の ' + idx.length + ' 点目）' }; idx.push(j); j++; }
  if (idx[0] !== 0 || idx[idx.length - 1] !== P.length - 1) return { ok: false, why: '始点／終点が path の両端でない' };
  let worst = 0;
  for (let k = 1; k < idx.length; k++) for (let m = idx[k - 1] + 1; m < idx[k]; m++) worst = Math.max(worst, segDist(P[m], pts[k - 1], pts[k]));
  return { ok: worst <= 5.75, why: worst <= 5.75 ? null : '省いた頂点が残した線分から ' + r1(worst) + ' m', worst };
}
/** 辺の始点・終点に当たる OSM ノード。SA/PA ノードに接する辺は、接続点（OSM 上）か、--sapa あり（meta.osm_sapa）なら場内通路上の端点（osm.sapa_geom.end_node） */
const idOfNode = s => /^n\.\d+$/.test(s) ? +s.slice(2) : (/^s\.\d+$/.test(s) ? +s.slice(2) : null);
function edgeEnds(e) {
  let sOsm = e.osm.start_node !== undefined ? e.osm.start_node : idOfNode(e.from), eOsm = e.osm.end_node !== undefined ? e.osm.end_node : idOfNode(e.to);
  const sg = e.osm.sapa_geom;
  if (sg) { if (nodeById.get(e.to).type === 'sapa') eOsm = sg.end_node; else sOsm = sg.end_node; }
  return [sOsm, eOsm];
}
const sapaGeomRows = [];   // 段階5a-1′：SA/PA 場内通路で延ばした辺ごとの検査値
const geomRows = [], geomBad = { missing: [], decode: [], endpoints: [], vertexFar: [], sampleFar: [], order: [], length: [] };
let nVertices = 0, nSamples = 0, nOrder = 0, nPathsTotal = 0, maxDropDev = 0, maxVertexDev = 0, maxSampleDev = 0, maxEndDev = 0, minLenRatio = Infinity, maxLenRatio = 0, geomChars = 0;
for (const e of G.edges) {
  if (typeof e.geom !== 'string' || !e.geom) { geomBad.missing.push(e.id); continue; }
  geomChars += e.geom.length;
  let pts; try { pts = decodePolyline(e.geom); } catch (err) { geomBad.decode.push(e.id); continue; }
  if (pts.length < 2) { geomBad.decode.push(e.id); continue; }
  // 端点：from / to に当たる OSM ノード（SA/PA ノードに接する辺は OSM 上の接続点。--sapa ありなら SA/PA 側は場内通路上の端点）
  const [sOsm, eOsm] = edgeEnds(e);
  const sg = e.osm.sapa_geom, edgeWays = sg ? e.osm.ways.concat(sg.ways) : e.osm.ways;
  const fillV = [], fillS = [];   // 場内通路で延ばした部分：頂点は本体の way（辺の osm.ways）から 1 m 超、線分の途中の点は 5.75 m 超（簡略化許容の外）離れる点
  const sc = coord.get(sOsm), ec = coord.get(eOsm);
  const ds = sc ? hav(sc, pts[0]) : Infinity, de = ec ? hav(ec, pts[pts.length - 1]) : Infinity;
  maxEndDev = Math.max(maxEndDev, ds, de);
  if (!(ds <= 1.5 && de <= 1.5)) geomBad.endpoints.push({ id: e.id, start_dev_m: r1(ds), end_dev_m: r1(de) });
  // 各点が元 way（辺の osm.ways）から 5 m 以内
  let vmax = 0; for (const p of pts) { vmax = Math.max(vmax, distToWays(p, edgeWays)); if (sg && distToWays(p, e.osm.ways) > 1.0) fillV.push(distToWays(p, sg.ways)); }
  nVertices += pts.length; maxVertexDev = Math.max(maxVertexDev, vmax);
  if (!(vmax <= 5.0)) geomBad.vertexFar.push({ id: e.id, max_m: r1(vmax) });
  // 線分の途中（約25mごと）も元 way から 5 m 以内（簡略化許容 5 m ＋ 座標丸め 約0.75 m）
  let smax = 0;
  for (let i = 1; i < pts.length; i++) {
    const L = hav(pts[i - 1], pts[i]); const n = Math.max(1, Math.ceil(L / 25));
    for (let k = 1; k < n; k++) { const t = k / n; const q = { lat: pts[i - 1].lat + t * (pts[i].lat - pts[i - 1].lat), lng: pts[i - 1].lng + t * (pts[i].lng - pts[i - 1].lng) }; smax = Math.max(smax, distToWays(q, edgeWays)); nSamples++; if (sg && distToWays(q, e.osm.ways) > 5.75) fillS.push(distToWays(q, sg.ways)); }
  }
  maxSampleDev = Math.max(maxSampleDev, smax);
  if (!(smax <= 5.75)) geomBad.sampleFar.push({ id: e.id, max_m: r1(smax) });
  // 順序・経路：OSM の有向道路から再構成した経路（始点ノード→終点ノード、一方通行の向きに従う）の頂点列の部分列になっていること。
  // 始点・終点が経路の両端、省いた頂点が残した線分から 5 m＋丸め以内。経路が複数あればいずれか1つに合えばよい
  const paths = osmPaths(e, sOsm, eOsm); nPathsTotal += paths.length;
  let ok = null, why = paths.length ? null : 'OSM から経路を再構成できない';
  for (const pa of paths) { const r = geomOnPath(pts, pa); if (r.ok) { ok = pa; maxDropDev = Math.max(maxDropDev, r.worst); break; } why = r.why; }
  nOrder++;
  if (!ok) geomBad.order.push({ id: e.id, paths: paths.length, why });
  // 長さ：geom の長さが length_m（SA/PA 辺は代表点までの近似距離 approx_service_m を除く）と一致（簡略化と座標丸めの差 ±(2%＋1.5 m) 以内）
  const gl = polyLenM(pts), base = e.length_m - (e.osm.approx_service_m || 0) + (sg ? sg.path_m : 0), ratio = gl / base;
  if (sg) sapaGeomRows.push({ id: e.id, kind: e.kind, end_node: sg.end_node, path_m: sg.path_m, filled_vertices: fillV.length, filled_samples: fillS.length, max_filled_vertex_dev_m: r1(Math.max(0, ...fillV)), max_filled_sample_dev_m: r1(Math.max(0, ...fillS)),
    geom_m: r1(gl), length_m: e.length_m, ratio_to_length_m: +(gl / e.length_m).toFixed(4), order_ok: !!ok });
  minLenRatio = Math.min(minLenRatio, ratio); maxLenRatio = Math.max(maxLenRatio, ratio);
  if (!(gl >= base * 0.98 - 1.5 && gl <= base * 1.005 + 1.5)) geomBad.length.push({ id: e.id, geom_m: r1(gl), length_m: e.length_m, approx_service_m: e.osm.approx_service_m || 0, ratio: +ratio.toFixed(4) });
  geomRows.push({ id: e.id, kind: e.kind, points: pts.length });
}
const nPts = geomRows.reduce((s, r) => s + r.points, 0);
results.sections.geom = { edges: geomRows.length, points: nPts, chars_total: geomChars, max_vertex_dev_m: r1(maxVertexDev), max_sample_dev_m: r1(maxSampleDev), max_endpoint_dev_m: r1(maxEndDev),
  samples_checked: nSamples, order_edges_checked: nOrder, osm_paths_reconstructed: nPathsTotal, max_dropped_vertex_dev_m: r1(maxDropDev), length_ratio: { min: +minLenRatio.toFixed(4), max: +maxLenRatio.toFixed(4) },
  per_kind: geomRows.reduce((o, r) => { const q = o[r.kind] || (o[r.kind] = { edges: 0, points: 0 }); q.edges++; q.points += r.points; return o; }, {}) };
check('(f) 全 ' + G.edges.length + ' 辺に geom があり、デコードできて 2 点以上', !geomBad.missing.length && !geomBad.decode.length && geomRows.length === G.edges.length, { points: nPts, chars: geomChars, missing: geomBad.missing, decode: geomBad.decode });
check('(f) geom の始点・終点が from・to（OSM 上の対応ノード）から 1.5 m 以内（最大 ' + r1(maxEndDev) + ' m）', !geomBad.endpoints.length, geomBad.endpoints.slice(0, 5));
check('(f) geom の各点（' + nVertices + '点）が元 way（辺の osm.ways）から ≤5 m（最大 ' + r1(maxVertexDev) + ' m）', !geomBad.vertexFar.length, geomBad.vertexFar.slice(0, 5));
check('(f) geom の線分の途中（約25mごと ' + nSamples + '点）も元 way から簡略化許容内（5 m＋座標丸め 0.75 m 以内、最大 ' + r1(maxSampleDev) + ' m）', !geomBad.sampleFar.length, geomBad.sampleFar.slice(0, 5));
check('(f) geom の順序が from→to：全 ' + nOrder + ' 辺で、OSM の有向道路（一方通行の向き）から再構成した始点ノード→終点ノードの経路の頂点列の部分列で、両端が経路の両端、省いた頂点は残した線分から 5 m＋丸め以内（最大 ' + r1(maxDropDev) + ' m）', !geomBad.order.length, geomBad.order.slice(0, 5));
check('(f) geom の長さが length_m と一致（SA/PA 辺は近似距離を除く。--sapa ありは場内通路の長さ osm.sapa_geom.path_m を加える。簡略化・座標丸めの差 ±(2%＋1.5 m) 以内。比 ' + minLenRatio.toFixed(4) + '〜' + maxLenRatio.toFixed(4) + '）', !geomBad.length.length, geomBad.length.slice(0, 5));
check('(f) OSMのみ版・軽量版の geom・via_heading が完全版と同一', GO.edges.every((e, i) => e.geom === G.edges[i].geom && e.via_heading === G.edges[i].via_heading) && GO.edges.length === G.edges.length &&
  APP.edges.length === G.edges.length && APP.edges.every((e, i) => e.id === G.edges[i].id && e.geom === G.edges[i].geom && e.via_heading === G.edges[i].via_heading));

// ---- via_heading：OSM way の進行方向と ±30° 以内
{
  const hBad = [], rows = []; let maxDiff = 0, maxDiff2 = 0, n = 0, skipped = 0;
  const hv = G.edges.filter(e => e.via);
  for (const e of hv) {
    if (!Number.isInteger(e.via_heading) || e.via_heading < 0 || e.via_heading > 359) { hBad.push({ id: e.id, via_heading: e.via_heading, why: '0〜359 の整数でない' }); continue; }
    const ns = nearestWaySeg(e.via, e.osm.ways);
    // 再構成した経路（OSM の有向道路、geom と同じもの）上で via に最も近い線分の進行方向
    const [sOsm, eOsm] = edgeEnds(e);
    const pa = osmPaths(e, sOsm, eOsm)[0]; let pb = null;
    if (pa) { let bd = Infinity; for (let i = 1; i < pa.length; i++) { const d = segDist(e.via, coord.get(pa[i - 1]), coord.get(pa[i])); if (d < bd) { bd = d; pb = bearing(coord.get(pa[i - 1]), coord.get(pa[i])); } } }
    if (pb === null) { hBad.push({ id: e.id, why: '経路を再構成できない' }); continue; }
    const df = angDiff(e.via_heading, pb); n++; maxDiff = Math.max(maxDiff, df);
    const df2 = ns && ns.dir !== 0 ? angDiff(e.via_heading, ns.brg) : 0; maxDiff2 = Math.max(maxDiff2, df2);
    rows.push({ id: e.id, kind: e.kind, via_heading: e.via_heading, osm_bearing: Math.round(pb), diff: Math.round(df), diff_nearest_way_segment: Math.round(df2) });
    if (df > 30 || df2 > 30) hBad.push({ id: e.id, via_heading: e.via_heading, osm_bearing: Math.round(pb), diff: Math.round(df), diff_nearest_way_segment: Math.round(df2) });
  }
  const noVia = G.edges.filter(e => !e.via && e.via_heading !== undefined).map(e => e.id);
  results.sections.via_heading = { edges_with_via: hv.length, compared: n, skipped_bidirectional: skipped, max_diff_deg: Math.round(maxDiff), max_diff_nearest_way_segment_deg: Math.round(maxDiff2), rows };
  check('(f) via_heading が OSM way の進行方向（via 点に最も近い線分、一方通行の向き）と ±30° 以内：via を持つ全 ' + hv.length + ' 辺（再構成した経路との最大差 ' + Math.round(maxDiff) + '°、最寄り way 線分との最大差 ' + Math.round(maxDiff2) + '°）。via のない辺に via_heading なし', !hBad.length && !noVia.length && hv.length > 0, hBad.slice(0, 5).concat(noVia.slice(0, 3)));
}

// ---- 軽量版 graph_small.app.json
{
  const appText = fileBytes('graph_small.app.json').toString('utf8');
  const keysOk = APP.edges.every(e => Object.keys(e).every(k => BG.APP_EDGE_KEYS.includes(k))) && APP.nodes.every(n => Object.keys(n).every(k => BG.APP_NODE_KEYS.includes(k)));
  const v = E.validateGraph(APP);
  check('(f) 軽量版 validateGraph 合格（エラー0・警告0）', v.ok && v.warnings.length === 0, { errors: v.errors.slice(0, 3), warnings: v.warnings.slice(0, 3) });
  check('(f) 軽量版は整形なし（本文は1行）で、osm サブオブジェクトを持たず、辺・ノードのキーが許可リスト内', appText.split('\n').length === 2 && appText.endsWith('\n') && !APP.edges.some(e => e.osm) && !APP.nodes.some(n => n.osm) && keysOk && !/"osm":\{"ways"/.test(appText));
  const idOrder = a => JSON.stringify(a.map(x => x.id));
  const edgeSet = g => JSON.stringify(g.edges.map(e => [e.id, e.from, e.to, e.kind, e.length_m]));
  check('(f) 軽量版と完全版で辺集合が一致（ID・端点・種別・長さ）、ノードID集合・ic 一覧も一致', edgeSet(APP) === edgeSet(G) && idOrder(APP.nodes) === idOrder(G.nodes) && JSON.stringify(APP.ics) === JSON.stringify(G.ics) && APP.edges.length === G.edges.length && APP.nodes.length === G.nodes.length, { edges: APP.edges.length, nodes: APP.nodes.length });
  const pickKeys = (o, ks) => { const r = {}; for (const k of ks) if (o[k] !== undefined) r[k] = o[k]; return r; };
  check('(f) 軽量版の辺・ノードの値が完全版の同名項目と完全一致（残す項目のみ）', G.edges.every((e, i) => JSON.stringify(pickKeys(e, BG.APP_EDGE_KEYS)) === JSON.stringify(APP.edges[i])) && G.nodes.every((nd, i) => JSON.stringify(pickKeys(nd, BG.APP_NODE_KEYS)) === JSON.stringify(APP.nodes[i])));
  // engine の列挙結果が同一（候補ID集合・ラベル数）
  const enumRows = []; let enumSame = true;
  for (const [a, b] of PAIRS) {
    const ia = byName(a), ib = byName(b); const o = icPt(ia), d = icPt(ib);
    const f = E.enumerate(G, o, d, {}), g2 = E.enumerate(APP, o, d, {});
    const same = f.candidates.length === g2.candidates.length && f.candidates.every((c, i) => c.id === g2.candidates[i].id) && f.stats.labelsCreated === g2.stats.labelsCreated && f.stats.labelsExpanded === g2.stats.labelsExpanded;
    enumRows.push({ from: a, to: b, candidates: f.candidates.length, labelsCreated: f.stats.labelsCreated, same }); if (!same) enumSame = false;
  }
  results.sections.app_enumeration = enumRows;
  check('(f) engine の列挙結果（候補ID・順序・ラベル数）が軽量版と完全版で同一：' + PAIRS.length + '区間', enumSame, enumRows.map(r => r.from + '→' + r.to + ':' + r.candidates).join(' '));
  // meta：地域・範囲・版・ハッシュ
  const M = APP.meta, full = fileBytes('graph_small.json'), osmBytes = fs.readFileSync(A.osm), n06Bytes = n06FileBytes();
  const bb = BG.PARAMS.bbox;
  const metaOk = M.app_format === 'rf-graph-app/1' && M.region === 'small' && M.published_file === 'graph-small.app.json' && typeof M.version === 'string' && M.version === G.meta.version && /^small-osm\d{8}-n06y2025-r\d+$/.test(M.version) &&
    M.bbox && M.bbox.latMin === bb.latMin && M.bbox.lngMin === bb.lngMin && M.bbox.latMax === bb.latMax && M.bbox.lngMax === bb.lngMax && G.meta.region === 'small' && GO.meta.region === 'small' && JSON.stringify(G.meta.bbox) === JSON.stringify(M.bbox) &&
    Object.prototype.hasOwnProperty.call(M, 'cross_region') && M.cross_region === null && typeof M.cross_region_note === 'string' && M.geom && M.geom.simplify_tolerance_m === 5 && M.via_heading && /30/.test(M.via_heading.definition);
  check('(f) 軽量版 meta：app_format・region="small"・配布名 graph-small.app.json・版（完全版と同一）・bbox・cross_region（将来用）・geom／via_heading の定義', metaOk, { region: M.region, version: M.version, bbox: M.bbox, published_file: M.published_file });
  const shaOk = M.derived_from.sha256 === sha256(full) && M.derived_from.bytes === full.length && M.osm.sha256 === sha256(osmBytes) && G.meta.osm.sha256 === sha256(osmBytes) && M.n06.extract_sha256 === sha256(n06Bytes) && G.meta.n06.extract_sha256 === sha256(n06Bytes);
  check('(f) 軽量版 meta のハッシュ：derived_from.sha256＝graph_small.json のバイト列、osm.sha256＝OSM 入力、n06.extract_sha256＝n06_small.json', shaOk, { derived_from: M.derived_from.sha256.slice(0, 16), osm: M.osm.sha256.slice(0, 16), n06_extract: M.n06.extract_sha256.slice(0, 16) });
  const content = sha256(Buffer.from(JSON.stringify({ nodes: APP.nodes, edges: APP.edges, ics: APP.ics }), 'utf8'));
  check('(f) 軽量版 content_sha256 が読み込み後の JSON.stringify({nodes, edges, ics}) の SHA-256 と一致', M.content_sha256 === content, content.slice(0, 16));
  const appBytes = fileBytes('graph_small.app.json');
  results.sections.app_file = { bytes: appBytes.length, gzip_bytes: zlib.gzipSync(appBytes, { level: 9 }).length, sha256: sha256(appBytes), full_bytes: full.length, full_sha256: sha256(full), geom_chars: geomChars, geom_points: nPts };
  check('(f) 軽量版のサイズ：' + appBytes.length + ' バイト（gzip ' + results.sections.app_file.gzip_bytes + '）、完全版 ' + full.length + ' バイトより小さい', appBytes.length < full.length / 2, results.sections.app_file);
}

// ================================================================ (g) 段階5a-1′：SA/PA 場内通路の形状・geom_gap
console.log('== (g) SA/PA 場内通路の形状・geom_gap・長さ比');
{
  const isSapaEdge = e => nodeById.get(e.from).type === 'sapa' || nodeById.get(e.to).type === 'sapa';
  const SAPA_EDGES = G.edges.filter(isSapaEdge);
  const gapEdges = G.edges.filter(e => e.geom_gap);
  const gapIds = gapEdges.map(e => e.id).sort();
  // geom_gap の構造（--sapa の有無によらず）：true のときだけ geom_gap_info（区間の長さ[m]・理由）を持ち、SA/PA 接続辺にだけ付き、軽量版にも同じ値がある
  const gapShapeBad = [];
  for (const e of G.edges) {
    const a = APP.edges.find(x => x.id === e.id);
    if (e.geom_gap !== undefined && e.geom_gap !== true) gapShapeBad.push({ id: e.id, why: 'geom_gap が true 以外' });
    if (e.geom_gap === true) {
      const gi = e.geom_gap_info;
      if (!gi || !(typeof gi.length_m === 'number' && gi.length_m > 0) || typeof gi.reason !== 'string' || !gi.reason) gapShapeBad.push({ id: e.id, why: 'geom_gap_info（length_m>0・reason）がない' });
      if (!isSapaEdge(e)) gapShapeBad.push({ id: e.id, why: 'SA/PA 接続辺でない辺に geom_gap' });
    } else if (e.geom_gap_info !== undefined) gapShapeBad.push({ id: e.id, why: 'geom_gap なしで geom_gap_info がある' });
    if (!a || a.geom_gap !== e.geom_gap || JSON.stringify(a.geom_gap_info) !== JSON.stringify(e.geom_gap_info)) gapShapeBad.push({ id: e.id, why: '軽量版の geom_gap・geom_gap_info が完全版と違う' });
    if (GO.edges.find(x => x.id === e.id).geom_gap !== e.geom_gap) gapShapeBad.push({ id: e.id, why: 'OSMのみ版の geom_gap が完全版と違う' });
  }
  check('(g) geom_gap の構造：true のときだけ geom_gap_info（length_m>0・reason）があり、SA/PA 接続辺だけに付き、OSMのみ版・軽量版が完全版と同一', gapShapeBad.length === 0, gapShapeBad.slice(0, 5));
  results.sections.geom_gap = { count: gapIds.length, ids: gapIds, info: gapEdges.map(e => ({ id: e.id, length_m: e.geom_gap_info.length_m, reason: e.geom_gap_info.reason })), sapa_connection_edges: SAPA_EDGES.length };
  check('(g) geom_gap 辺の列挙：' + gapIds.length + ' 件（SA/PA 接続辺 ' + SAPA_EDGES.length + ' 本中）' + (gapIds.length ? '：' + gapIds.join('、') : ''), gapIds.length === 0, results.sections.geom_gap.info.slice(0, 6), false);

  if (!HAS_SAPA) { console.log('(g) --sapa なし：SA/PA 場内通路の検査は省略（geom_gap の構造のみ）'); }
  else {
    const M1 = G.meta.osm_sapa, M2 = APP.meta.osm_sapa, M3 = GO.meta.osm_sapa;
    const sapaSha = sha256(SAPA_BYTES);
    const base = OSM.osm3s && OSM.osm3s.timestamp_osm_base, sapaBase = SAPA.osm3s && SAPA.osm3s.timestamp_osm_base;
    const queryFile = ['', '..', path.join('..', 'src')].map(d => path.join(__dirname, d, 'osm_query_sapa.overpassql')).find(f => fs.existsSync(f)) || null;
    check('(g) osm_sapa の入力：meta.osm_sapa.sha256 が入力ファイルと一致（完全版・OSMのみ版・軽量版）、osm_base が本体（osm_small）と同一、問い合わせ文名 osm_query_sapa.overpassql（ファイル ' + (queryFile ? '確認' : '未確認') + '）',
      M1.sha256 === sapaSha && M2 && M2.sha256 === sapaSha && M3 && M3.sha256 === sapaSha && M1.osm_base === sapaBase && sapaBase === base && M1.osm_base_same_as_main === true && M1.query === 'osm_query_sapa.overpassql' && M2.query === M1.query && !!queryFile,
      { sha256: sapaSha.slice(0, 16), osm_base: sapaBase, main_osm_base: base, query_file: queryFile && path.basename(queryFile) });
    // SA/PA 接続辺：本線の進入・退出 12、SA/PA 併設スマートICのランプ 4
    const kinds = SAPA_EDGES.reduce((o, e) => { const k = e.kind + (e.sub ? ':' + e.sub : ''); o[k] = (o[k] || 0) + 1; return o; }, {});
    const noInfo = SAPA_EDGES.filter(e => !e.osm.sapa_geom && !e.geom_gap).map(e => e.id);
    check('(g) SA/PA 接続辺 ' + SAPA_EDGES.length + ' 本（' + JSON.stringify(kinds) + '）：すべて場内通路で延ばした（osm.sapa_geom あり）か、延ばせず geom_gap', SAPA_EDGES.length === 16 && noInfo.length === 0 && G.edges.filter(e => !isSapaEdge(e) && e.osm.sapa_geom).length === 0, { no_info: noInfo });
    // 使った way：osm_sapa の service・motorway_link で、access / motor_vehicle / motorcar / vehicle が no・private でない
    const wayBad = [];
    for (const e of SAPA_EDGES) for (const w of (e.osm.sapa_geom ? e.osm.sapa_geom.ways : [])) {
      const ow = SW.get(w); const t = ow && ow.tags || {};
      if (!ow || !ow.geometry || !/^(service|motorway_link)$/.test(t.highway) || [t.access, t.motor_vehicle, t.motorcar, t.vehicle].some(x => x === 'no' || x === 'private')) wayBad.push({ id: e.id, way: w, highway: t.highway, access: t.access });
    }
    check('(g) 場内通路として使った way（' + new Set(SAPA_EDGES.flatMap(e => e.osm.sapa_geom ? e.osm.sapa_geom.ways : [])).size + ' 本）が osm_sapa の service・motorway_link で、access 等が no・private でない', wayBad.length === 0, wayBad.slice(0, 5));
    // 埋めた geom の各点が場内通路 way から ≤5 m（頂点）、線分の途中も ≤5.75 m（直線補間でない）
    const filledV = sapaGeomRows.reduce((a, r) => a + r.filled_vertices, 0), filledS = sapaGeomRows.reduce((a, r) => a + r.filled_samples, 0);
    const maxFV = Math.max(0, ...sapaGeomRows.map(r => r.max_filled_vertex_dev_m)), maxFS = Math.max(0, ...sapaGeomRows.map(r => r.max_filled_sample_dev_m));
    const noFill = sapaGeomRows.filter(r => r.path_m > 3 && r.filled_vertices < 1).map(r => r.id);
    check('(g) 埋めた geom の各点（' + filledV + ' 点、最大 ' + maxFV + ' m）が場内通路 way から ≤5 m、線分の途中（約25mごと ' + filledS + ' 点、最大 ' + maxFS + ' m）も ≤5.75 m（直線補間でない）。場内通路の長さが 3 m を超える辺はすべて埋めた点がある',
      sapaGeomRows.length > 0 && maxFV <= 5.0 && maxFS <= 5.75 && noFill.length === 0, { rows: sapaGeomRows.length, no_fill: noFill });
    // 順序 from→to（OSM の有向道路＝一方通行の向きで再構成した経路の頂点列の部分列、両端が経路の両端）
    const ordBad = sapaGeomRows.filter(r => !r.order_ok).map(r => r.id);
    check('(g) 埋めた辺 ' + sapaGeomRows.length + ' 本の geom の順序が from→to で、場内通路を一方通行の向きに従ってたどる', sapaGeomRows.length > 0 && ordBad.length === 0, ordBad);
    // SA/PA 側の端点と代表点
    const endBad = [], nonShare = [];
    for (const e of SAPA_EDGES) {
      const sg = e.osm.sapa_geom; if (!sg) continue;
      const sp = nodeById.get(nodeById.get(e.to).type === 'sapa' ? e.to : e.from), ec = coord.get(sg.end_node);
      const d = ec ? hav(ec, sp) : Infinity;
      if (!(Math.abs(d - sg.end_to_sapa_m) <= 0.2)) endBad.push({ id: e.id, recorded: sg.end_to_sapa_m, recomputed: r1(d) });
      else if (d > BG_SAPA_GAP_END_M && !e.geom_gap) endBad.push({ id: e.id, end_to_sapa_m: r1(d), why: '代表点まで ' + BG_SAPA_GAP_END_M + ' m 超だが geom_gap でない' });
    }
    // 同じ施設で入る辺と出る辺の端点が分かれるとき、端点間 ≤25 m、超えるなら両方 geom_gap（場内通路でつなげない組は meta.sapa_geom.no_passage_pairs）
    const jointBad = [], jointRows = [], noPass = new Set(((G.meta.sapa_geom || {}).no_passage_pairs) || []);
    for (const sp of sapas) {
      const ins = SAPA_EDGES.filter(e => e.to === sp.id && e.osm.sapa_geom), outs = SAPA_EDGES.filter(e => e.from === sp.id && e.osm.sapa_geom);
      for (const i of ins) for (const o of outs) {
        if (i.osm.sapa_geom.end_node === o.osm.sapa_geom.end_node) continue;
        const j = hav(coord.get(i.osm.sapa_geom.end_node), coord.get(o.osm.sapa_geom.end_node));
        jointRows.push({ in_edge: i.id, out_edge: o.id, jump_m: r1(j), no_passage: noPass.has(i.id + ' → ' + o.id) });
        if (j > BG_SAPA_GAP_JOINT_M && !(i.geom_gap && o.geom_gap) && !noPass.has(i.id + ' → ' + o.id)) jointBad.push({ in_edge: i.id, out_edge: o.id, jump_m: r1(j) });
      }
    }
    results.sections.sapa_geom = { rows: sapaGeomRows, joints_between_split_ends: jointRows, no_passage_pairs: [...noPass] };
    check('(g) SA/PA 側の端点：記録した代表点までの距離が再計算と一致し、' + BG_SAPA_GAP_END_M + ' m 超なら geom_gap。端点が分かれる入る辺・出る辺の組 ' + jointRows.length + '（最大 ' + Math.max(0, ...jointRows.map(r => r.jump_m)) + ' m）は ≤' + BG_SAPA_GAP_JOINT_M + ' m か geom_gap',
      endBad.length === 0 && jointBad.length === 0, { end: endBad.slice(0, 5), joint: jointBad.slice(0, 5) });
    // 長さ比：SA/PA 接続辺の geom の長さ / length_m が 0.9〜1.1（外れる辺は NOTE で列挙。必須の合否にはしない）
    const out = sapaGeomRows.filter(r => r.ratio_to_length_m < 0.9 || r.ratio_to_length_m > 1.1);
    const rs = sapaGeomRows.map(r => r.ratio_to_length_m);
    results.sections.sapa_ratio = { edges: sapaGeomRows.length, min: Math.min(...rs), max: Math.max(...rs), out_of_range: out.map(r => ({ id: r.id, ratio: r.ratio_to_length_m, geom_m: r.geom_m, length_m: r.length_m })) };
    check('(g) SA/PA 接続辺の長さ比（geom の長さ/length_m）が 0.9〜1.1：' + (sapaGeomRows.length - out.length) + '/' + sapaGeomRows.length + ' 本（最小 ' + Math.min(...rs) + '、最大 ' + Math.max(...rs) + '）' + (out.length ? '。範囲外：' + out.map(r => r.id + ' ' + r.ratio_to_length_m).join('、') : ''), out.length === 0, results.sections.sapa_ratio.out_of_range, false);

    // --sapa なしの再生成が 5a-1 の出力とバイト一致（後方互換）。5a-1 出力との差が意図した項目だけであること
    const tmp2 = path.join(A.tmp || os.tmpdir(), 'rfgraph-verify-rebuild-nosapa');
    fs.mkdirSync(tmp2, { recursive: true });
    let err2 = null;
    try { execFileSync(process.execPath, [path.join(__dirname, 'build_graph.js'), '--osm', A.osm, '--n06', N06_PATH, '--out', tmp2], { stdio: 'pipe' }); } catch (e) { err2 = String(e && e.message || e).slice(0, 200); }
    const hashes2 = {}, diffs2 = [];
    for (const f of FULL_FILES) { const b = err2 ? null : fs.readFileSync(path.join(tmp2, f)); hashes2[f] = b && sha256(b); if (!b || hashes2[f] !== BASELINE_5A1[f]) diffs2.push(f); }
    check('(g) --sapa なしの再生成が 5a-1 の出力（SHA-256 固定値）とバイト一致（' + FULL_FILES.length + 'ファイル）', !err2 && diffs2.length === 0, err2 || (diffs2.length ? { differ: diffs2 } : hashes2));
    if (!err2) {
      const B = JSON.parse(fs.readFileSync(path.join(tmp2, 'graph_small.json'), 'utf8'));
      const stripE = e => { const o = JSON.parse(JSON.stringify(e)); delete o.geom; delete o.geom_gap; delete o.geom_gap_info; if (o.osm) delete o.osm.sapa_geom; return o; };
      const chg = [];
      if (JSON.stringify(B.nodes) !== JSON.stringify(G.nodes)) chg.push('nodes');
      if (JSON.stringify(B.ics) !== JSON.stringify(G.ics)) chg.push('ics');
      if (B.edges.length !== G.edges.length) chg.push('edges.length');
      const geomChanged = [], other = [];
      for (const e of G.edges) { const b = B.edges.find(x => x.id === e.id); if (!b) { other.push(e.id + ':new'); continue; } if (JSON.stringify(stripE(b)) !== JSON.stringify(stripE(e))) other.push(e.id); if (b.geom !== e.geom) geomChanged.push(e.id); }
      const sapaIds = SAPA_EDGES.map(e => e.id).sort();
      const mk = Object.keys(G.meta).filter(k => JSON.stringify(G.meta[k]) !== JSON.stringify(B.meta[k]) || !(k in B.meta)).sort();
      const mkExpected = ['geom', 'osm_sapa', 'sapa_geom', 'version'];
      // geom が変わるのは SA/PA 接続辺のうち場内通路で延ばした辺だけ。場内通路の長さが 0.5 m を超える辺は必ず変わる
      const filledIds = sapaIds.filter(id => G.edges.find(e => e.id === id).osm.sapa_geom), mustChange = filledIds.filter(id => G.edges.find(e => e.id === id).osm.sapa_geom.path_m > 0.5);
      const gcOk = geomChanged.every(id => filledIds.includes(id)) && mustChange.every(id => geomChanged.includes(id));
      results.sections.diff_vs_5a1 = { changed_geom_edges: geomChanged.length, other_changed_edges: other, nodes_ics_changed: chg, meta_keys_changed: mk };
      check('(g) 5a-1 の出力（--sapa なし）との差が意図した項目だけ：ノード・ic は同一、辺は SA/PA 接続辺 ' + geomChanged.length + ' 本の geom（と geom_gap・osm.sapa_geom）だけが違い、meta は ' + mkExpected.join('・') + ' だけが違う',
        chg.length === 0 && other.length === 0 && gcOk && JSON.stringify(mk) === JSON.stringify(mkExpected) && G.meta.version === B.meta.version.replace(/-r(\d+)$/, (m, n) => '-r' + (+n + 1)),
        { chg, other: other.slice(0, 5), geomChanged: geomChanged.length, meta: mk });
    }
  }
}

// ================================================================ 数値
const cnt = (arr, f) => arr.reduce((o, x) => { const k = f(x); o[k] = (o[k] || 0) + 1; return o; }, {});
results.sections.counts = { nodes: G.nodes.length, edges: G.edges.length, node_types: cnt(G.nodes, n => n.type), edge_kinds: cnt(G.edges, e => e.kind + (e.sub ? ':' + e.sub : '')),
  ics: G.ics.length, ics_by_koj: cnt(G.ics, i => String(i.koj)), ramps: ramps.length, ramp_points: G.meta.rampPoints, sapa: sapas.length,
  ramps_by_road: cnt(ramps, e => e.road), toll_source: cnt(G.edges, e => e.kind + ':' + e.toll_source), fare_relevant: G.edges.filter(e => e.fare_relevant).length,
  mainline_km: r1(G.edges.filter(e => e.kind === 'mainline' && !e.sub).reduce((s, e) => s + e.length_m, 0) / 1000) };
console.log('counts', JSON.stringify(results.sections.counts));
results.summary = { hardFail, checks: results.checks.length, pass: results.checks.filter(c => c.ok).length, notes: results.checks.filter(c => !c.ok && !c.hard).length };
fs.writeFileSync(path.join(A.dir, 'verify_result.json'), JSON.stringify(results, null, 1) + '\n');
console.log('== 結果：検査 ' + results.checks.length + '（必須の失敗 ' + hardFail + '）→ ' + path.join(A.dir, 'verify_result.json'));
process.exit(hardFail ? 1 : 0);
