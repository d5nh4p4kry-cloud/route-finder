'use strict';
/*
 * brute.js — 段階4 独立全列挙器（engine.js のコードを一切流用しない）
 * 方式：単純な再帰DFS（バックトラック）。優先度・推定値・上限なし（上限は安全弁の再帰回数のみ）。
 * 仕様（README「遷移規則」）を文章から独立に実装する：
 *   - 候補＝出発地→乗車1→…→乗車n→目的地（n≥1）
 *   - 乗車＝on_ramp →（mainline/jct_link の単純路）→ off_ramp
 *   - 同一ランプ辺の再利用禁止、ゼロ長の連続遷移禁止（一般道区間も1ステップとして数える）
 *   - 解決済みかつ通行不可の辺は使わない
 * 併せて、同じ模擬API値から主ランキングを独立に算出する rankIndependent を提供する。
 */

const EARTH_R = 6371008.8;
function gcDist(p, q) {
  const toR = d => d * Math.PI / 180;
  const a = Math.pow(Math.sin(toR(q.lat - p.lat) / 2), 2) +
    Math.cos(toR(p.lat)) * Math.cos(toR(q.lat)) * Math.pow(Math.sin(toR(q.lng - p.lng) / 2), 2);
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function makeId(rideList) {
  const parts = [];
  for (let i = 0; i < rideList.length; i++) {
    const r = rideList[i];
    parts.push(`${r.entry}>${r.exit}[${r.fareEdges.join(',')}]`);
  }
  return parts.join('|');
}

function enumerateAll(graph, origin, destination, safety) {
  const maxSteps = (safety && safety.maxSteps) || 5e6;
  const maxRides = (safety && safety.maxRides) || 0;   // 0＝無制限。1 にすると乗車1回の候補だけを列挙する（v5.2.1 試験用の追加。既定の挙動は不変）
  const nodeById = {};
  graph.nodes.forEach(n => { nodeById[n.id] = n; });
  const usable = graph.edges.filter(e => !(e.restriction && e.restriction.resolved === true && e.restriction.passable === false));
  const outgoing = {};
  usable.forEach(e => { (outgoing[e.from] = outgoing[e.from] || []).push(e); });
  const entries = usable.filter(e => e.kind === 'on_ramp');

  const found = new Map(); // id -> {rides, fareCount, allRestricted, count}
  const usedEntry = new Set(), usedExit = new Set();
  const rides = [];
  let steps = 0;
  let aborted = false;

  function record(restrictedHere) {
    const id = makeId(rides);
    const prev = found.get(id);
    if (prev) {
      prev.count += 1;
      prev.allRestricted = prev.allRestricted && restrictedHere;
    } else {
      let fc = 0;
      rides.forEach(r => { fc += r.fareEdges.length; });
      found.set(id, {
        id, n: rides.length, fareCount: fc, allRestricted: restrictedHere, count: 1,
        rides: rides.map(r => ({ entry: r.entry, exit: r.exit, fareEdges: r.fareEdges.slice() })),
      });
    }
  }

  // 一般道側にいる状態：here＝ノードID（出発地はnull）、herePt＝座標、prevZero＝直前ステップがゼロ長か
  function atSurface(here, herePt, prevZero, restricted) {
    if (++steps > maxSteps) { aborted = true; return; }
    if (rides.length > 0) {
      const toDest = gcDist(herePt, destination);
      if (!(prevZero && toDest === 0)) record(restricted);
    }
    if (maxRides && rides.length >= maxRides) return;
    for (const e of entries) {
      if (usedEntry.has(e.id)) continue;
      const surf = (here !== null && here === e.from) ? 0 : gcDist(herePt, nodeById[e.from]);
      if (prevZero && surf === 0) continue;
      if (surf === 0 && e.length_m === 0) continue;
      usedEntry.add(e.id);
      const visited = new Set([e.to]);
      const fareEdges = e.fare_relevant ? [e.id] : [];
      const r = e.restriction && e.restriction.resolved !== true;
      inRide(e.id, e.to, visited, fareEdges, e.length_m === 0, restricted || r);
      usedEntry.delete(e.id);
      if (aborted) return;
    }
  }

  function inRide(entryId, at, visited, fareEdges, prevZero, restricted) {
    if (++steps > maxSteps) { aborted = true; return; }
    const outs = outgoing[at] || [];
    for (const x of outs) {
      const zero = x.length_m === 0;
      if (prevZero && zero) continue;
      const r = restricted || (x.restriction && x.restriction.resolved !== true);
      if (x.kind === 'off_ramp') {
        if (usedExit.has(x.id)) continue;
        usedExit.add(x.id);
        rides.push({ entry: entryId, exit: x.id, fareEdges: x.fare_relevant ? fareEdges.concat([x.id]) : fareEdges.slice() });
        atSurface(x.to, nodeById[x.to], zero, r);
        rides.pop();
        usedExit.delete(x.id);
      } else if (x.kind === 'mainline' || x.kind === 'jct_link') {
        if (visited.has(x.to)) continue;
        visited.add(x.to);
        if (x.fare_relevant) fareEdges.push(x.id);
        inRide(entryId, x.to, visited, fareEdges, zero, r);
        if (x.fare_relevant) fareEdges.pop();
        visited.delete(x.to);
      }
      if (aborted) return;
    }
  }

  atSurface(null, origin, false, false);
  return { ids: new Set(found.keys()), info: found, aborted, steps };
}

/*
 * 主ランキングの独立算出（仕様文から独立実装）
 * valueOf(id) は模擬APIと同じ値を返す純関数。base は {durationSec}（無料・要求充足を前提に試験側が与える）。
 * 入場：match=一致 ∧ condition=要求充足 ∧ toll∈{free, priced(有効な円)} ∧ fullTripFare===true ∧ 有効な所要時間
 *       ∧ 中間地点(4n+料金影響点)≤25 ∧ 全実現経路が未解決規制を含むものでない
 * 円/分＝C/(Tbase−Tcand)（分、未丸め）。分母≤0は除外。昇順、同値は短縮分の大きい順、次にID昇順。
 */
function rankIndependent(info, valueOf, base, opt) {
  const perRide = (opt && opt.pointsPerRide) || 4;
  const limit = (opt && opt.maxIntermediates) || 25;
  const top = (opt && opt.topN) || 5;
  const tb = base.durationSec / 60;
  const rows = [];
  for (const [id, meta] of info) {
    if (perRide * meta.n + meta.fareCount > limit) continue;
    if (meta.allRestricted) continue;
    const v = valueOf(id);
    if (!v || v.error) continue;
    if (v.match !== '一致' || v.condition !== '要求充足' || v.fullTripFare !== true) continue;
    if (typeof v.durationSec !== 'number' || !(v.durationSec > 0) || !isFinite(v.durationSec)) continue;
    let cost;
    if (v.toll && v.toll.state === 'free') cost = 0;
    else if (v.toll && v.toll.state === 'priced' && typeof v.toll.jpy === 'number' && isFinite(v.toll.jpy) && v.toll.jpy >= 0) cost = v.toll.jpy;
    else continue;
    const saving = tb - v.durationSec / 60;
    if (saving <= 0) continue;
    rows.push({ id, value: cost / saving, saving });
  }
  rows.sort((p, q) => {
    if (p.value !== q.value) return p.value < q.value ? -1 : 1;
    if (p.saving !== q.saving) return p.saving > q.saving ? -1 : 1;
    return p.id < q.id ? -1 : p.id > q.id ? 1 : 0;
  });
  return rows.slice(0, top);
}

module.exports = { enumerateAll, rankIndependent, makeId, gcDist };
