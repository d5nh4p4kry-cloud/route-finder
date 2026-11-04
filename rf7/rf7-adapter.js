/*
 * RF7Adapter — ルートファインダー v7 段階5a 検証器（adapter）
 * 仕様（優先順位 v2.3 ＞ v2.2 ＞ v2.1 ＞ v2）：route-finder-stage5a-plan-v2.3.md §1〜§3、-v2.2.md、-v2.1.md、-v2.md §5.2 V1〜V5、HANDOVER.md（段階2の実機事実）
 * 1.1.0：V2 を「要求遵守の検査」に再定義（v2.1）／境界ごとの識別根拠 E-geo・E-name と BOUNDARY_UNRESOLVED（v2.2・v2.3）／GEOM_GAP／R1 の拒否／
 *        vehicleStopover 要求生成（検証専用）／料金・所要時間・条件の独立保持（v2.2 §5.3）／持ち出し用書き出し rf7-5a/3（v2.3 §3）
 * - DOM 非依存・外部依存なし・ES2020。ブラウザでは self.RF7Adapter、Node では module.exports
 * - engine.js（v7-stage4-1.1.0、無改変）の evaluate(search,{api}) に渡す api(q) を createAdapter() が作る
 * - 通信は注入（live の fetch と getKey は呼び出し側が渡す）。キーは保存せず、ログ・記録・エラー文に出さない
 * - Google の応答（実応答）は保存しない。polyline は照合の入力としてのみ使い、既定では記録に残さない（§5.9）
 * - 推測で埋めた点は README-adapter.md の「仮定」に列挙（閾値の許容割合など）
 *
 * 1.1.1：診断の追加のみ（判定規則・閾値・合否は 1.1.0 と同一）。リスク境界ごとの diag（案内文・step の構造に対する検査の真偽フラグ、maneuver の列挙名、step 添字・件数）、
 *        SURF_TOLL の内訳（leg の tollInfo／「有料区間」を含む step 添字）、非一致 leg の失敗検査コード、検証専用呼出の変種 V-t（avoidTolls）。
 *        診断に案内文の文字列・座標・距離・秒・円は出さない（v2.3 §3）。コード表は README-adapter.md「1.1.1 診断コード表」
 *
 * 1.2.0：出口 E-name の改訂（v2.4 §1）。実機（DG、2026-11-01 20:24）の step 構造に合わせる。判定規則のうち E-name 以外（形状照合・E-geo・料金・要求生成）は 1.1.1 と同一。
 *        出口：(a) 高速 leg の step 列を末尾から遡り、到着 step（最後の 1 つ）を除いた最後の RAMP_*／FORK_* を出口操作 step とする
 *              (b) その maneuver が RAMP_*／FORK_*、かつその step より後（到着 step を除く）に「有料区間」注記の step がない
 *              (c) その step の始点（操作地点）が予定ランプの分流点（本線側端点）から 25 m 以内、かつ同方向の他 IC・他群の出口ランプと JCT 連絡路の分流点から 25 m 超
 *                  （または予定の分流点の方が 25 m 以上近い）。さらに step の最初の 50 m の進行方位が予定ランプの via_heading と 45° 以内
 *              (d) その step の案内文に、予定 IC 名＋任意の空白＋「出口」が操作対象として現れる（文型 OUT-3。「方面」直結は不可。OUT-1/OUT-2 は存続）
 *              (e) 直後の一般道 leg に tollInfo／「有料区間」の step がない（不変）
 *        入口：実機の入口 step には IC 名が出ないため、入口のリスク境界は E-name を評価しない（E-geo のみ。なければ unresolved）。DEPART step の IC 名は根拠にしない
 *        診断（1.1.1）は維持。ei・mv・cd・cf は新しい (a)(c) の結果を反映（コード表は README-adapter.md「7. 診断コード表」）
 *
 * 変異試験（test/mutate_adapter.js）用の目印コメント（行末の「// @」＋M 番号）を付けた行がある。削除・移動しないこと。
 */
(function (root) {
  'use strict';

  const VERSION = 'rf7-adapter-1.3.1';

  // ================================================================ 固定設定（§5.2 V2 の閾値は実行前に固定。変更は理由付きで全件再判定）
  const CONFIG = Object.freeze({
    // --- V2 形状照合（仕様で決まっている値）
    SAMPLE_M: 20,           // leg ポリラインの標本間隔
    POS_M: 25,              // 標本と参照形状の最短距離の許容
    ANG_DEG: 45,            // 進行方位差の許容
    RAMP_COVER: 0.5,        // 入口・出口ランプの被覆率下限
    COV_GAP: 0.20,          // 対抗経路より「明確に優れる」被覆率差
    BEAR_GAP: 0.30,         // 対抗経路より「明確に優れる」方位不一致率差
    LEN_MIN: 0.9, LEN_MAX: 1.15,   // leg 長 / 参照形状長
    END_M: 50,              // leg 始点・終点と一般道側端点の距離（群内識別の唯一の根拠でもある）
    CROSS_M: 100,           // v2.1 で対抗経路の定義から廃止（定数のみ残す。削除は 5b）
    // --- v2.1 §5.6：仮置きから固定に昇格した値
    OK_RATE: 0.90,          // 位置・方位を満たす標本の割合の下限
    FAR_M: 100,             // 標本の最短距離の中央値がこれを超えれば「予定形状から明確に外れている」
    COVER_HALF_M: 12,       // 標本1点が被覆する範囲の半幅（標本間隔の 0.6 倍）
    ORDER_TOL: 0.02,        // 接続順の違反標本の割合の許容
    NEAR_BBOX_M: 300,       // 辺の外接矩形からこれ以上離れた標本は距離を厳密に計算しない
    BEARING_WIN_M: 10,      // 標本の進行方位を求める前後の幅
    SURF_ZERO_M: 10,        // 一般道接続区間の両端がこれ以内なら「長さ0の区間」
    // --- v2.1 §5.6：新設（固定）
    ALT_LEN_MIN: 0.85, ALT_LEN_MAX: 1.20,   // 対抗経路（leg 両端を結ぶ実現可能経路）の長さ比の窓
    MAX_ALT_PER_TYPE: 8,    // 対抗経路の上限数（v2.1 §5.3：MAX_ALT_PER_TYPE を流用）
    ALT_SEARCH_NODES: 20000, // 対抗経路の探索で展開するノード数の上限（暴走防止。超えたら打切りを記録）
    VIA_M: 25, VIA_ANG: 45, // (vii) 要求した via 点の通過検査：25 m 以内・方位差 45° 以内
    PARALLEL_FRAC: 0.30,    // 並走辺の定義（観測専用。5a の adapter では判定にも出力にも使わない）
    // --- v2.2 §2.2・v2.3 §1：識別根拠
    RISK_M: 50,             // 吸着リスク端点：一般道側端点から本線・JCT 連絡路が 50 m 以内
    UNIQ_SEP_M: 35,         // E-geo：ランプ固有区間＝本線・他群ランプから 35 m 以上離れる区間（v2.2 §2.3 の値。v2.3 の「25 m 以上」との差は README に記載）
    UNIQ_MIN_LEN_M: 60,     // 同：連続 60 m 以上
    EGEO_COVER: 0.5,        // 同：固有区間の被覆率の下限
    GROUP_GAP_M: 25,        // 群内帰属（v2.2 §5.1）：予定端点の方が 25 m 以上近ければ確定
    NAME_NEAR_M: 300,       // 1.1.1 までの入口 E-name (a) の値。1.2.0 では入口の E-name を評価しないため未使用（設定の互換のため残す）
    NAME_POS_M: 25,         // E-name (c)（1.2.0）：出口操作 step の始点が予定ランプの分流点から 25 m 以内、かつ他の出口ランプ・JCT 連絡路の分流点から 25 m 超（または予定の方が 25 m 以上近い）
    CONN_GAP_M: 15, CONN_DIR_DEG: 135, CONN_WIN_M: 30, CONN_HWY_WIN_M: 60, CONN_HWY_M: 25,   // 1.3.0 分割評価の接続検査 J1・J2（計画 v2.5.1 §2.3。CONN_HWY は本線・JCT 連絡路との距離）
    SPLIT_TIME_MIN_SEC: 120, SPLIT_TIME_FRAC: 0.05,                                       // 1.3.0 分割評価の時間差の許容 C：max(2 分, 全旅程の 5%)
    NAME_DIV_NEAR_M: 150,   // E-name (c)（1.2.1、実機 2026-11-02 で 25 m では全件 POS_NEAR）：出口操作 step の始点が予定ランプの分流点から 150 m 以内、かつ予定の分流点が他のどの分流点よりも NAME_POS_M 以上近い（最寄りの分流点であること）
    NAME_HEAD_M: 50,        // E-name (c)（1.2.0）：出口操作 step の進行方位を求める区間の長さ（step の最初の 50 m）
    NAME_HEAD_DEG: 45,      // E-name (c)（1.2.0）：その進行方位と予定ランプの via_heading の差の許容
    EDGE_MISS_POS: 0.5,     // 予定辺を 1 本まるごと外れた（EDGE_COVER）とき、posRate がこれ以上なら「別経路を走った」＝不一致（README の解釈）
    // --- V1/V3/V5
    MAX_POINTS: 25,         // 中間地点の上限（Routes API）
    DEADLINE_MARGIN_SEC: 30,
    FARE_TOL_JPY: 100,      // route 金額と leg 合計の差の許容
    // --- 通信・上限（§5.3・§5.4）
    URL: 'https://routes.googleapis.com/directions/v2:computeRoutes',
    TIMEOUT_MS: 20000,
    SESSION_MAX: 60,
    DAILY_MAX: 150,
  });

  const FIELD_MASK_PARTS = [
    'routes.duration', 'routes.distanceMeters', 'routes.polyline.encodedPolyline',
    'routes.legs.duration', 'routes.legs.distanceMeters', 'routes.legs.polyline.encodedPolyline',
    'routes.legs.steps.navigationInstruction', 'routes.legs.steps.distanceMeters',
    'routes.legs.steps.startLocation', 'routes.legs.steps.endLocation', 'routes.legs.steps.polyline.encodedPolyline',
    'routes.travelAdvisory.tollInfo', 'routes.legs.travelAdvisory.tollInfo', 'fallbackInfo',
  ];
  const FIELD_MASK = FIELD_MASK_PARTS.join(',');
  const FIELD_MASK_NO_TOLL = FIELD_MASK_PARTS.filter(p => p.indexOf('tollInfo') < 0).join(',');

  // 首都高3号は深夜割引（0〜4時、最初の ETC アンテナ通信時刻基準）が確認済み。NEXCO（東名・圏央道）の割引区間は一次資料で未確認（仕様 §5.2 V3）
  const TIME_DEPENDENCY = Object.freeze({ c3: '時刻依存', tomei: '未確認', ken: '未確認' });

  const AUTH_REASONS = ['API_KEY_HTTP_REFERRER_BLOCKED', 'API_KEY_INVALID', 'API_KEY_IP_ADDRESS_BLOCKED', 'API_KEY_ANDROID_APP_BLOCKED',
    'API_KEY_IOS_APP_BLOCKED', 'API_KEY_SERVICE_BLOCKED', 'PERMISSION_DENIED', 'SERVICE_DISABLED', 'BILLING_DISABLED', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'];

  // ================================================================ 基本関数
  const RAD = Math.PI / 180;
  const R_EARTH = 6371008.8;
  const isNum = x => typeof x === 'number' && Number.isFinite(x);
  const r6 = x => Math.round(x * 1e6) / 1e6;
  const r3 = x => (isNum(x) ? Math.round(x * 1000) / 1000 : x);
  const clone = o => JSON.parse(JSON.stringify(o));
  function yen(n) { return '¥' + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function fnv(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  }
  function scrubText(s, keys) {
    let t = String(s == null ? '' : s);
    for (const k of (keys || [])) if (k && typeof k === 'string') t = t.split(k).join('[APIキー省略]');
    return t.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[APIキー省略]');
  }
  function jstClock(ms) {
    if (!isNum(ms)) return '-';
    const d = new Date(ms + 9 * 3600 * 1000);
    const p = n => String(n).padStart(2, '0');
    return p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
  }
  function jstDate(ms) {
    const d = new Date(ms + 9 * 3600 * 1000);
    const p = n => String(n).padStart(2, '0');
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
  }
  function isoZ(ms) { return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'); }
  function median(a) {
    if (!a.length) return null;
    const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function percentile(a, p) {
    if (!a.length) return null;
    const s = a.slice().sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  }

  // ================================================================ Google 符号化ポリライン（精度 1e5）
  function decodePolyline(str) {
    if (typeof str !== 'string') throw new Error('POLYLINE_NOT_STRING');
    const out = [];
    let i = 0, lat = 0, lng = 0;
    const next = () => {
      let b, shift = 0, res = 0;
      do {
        if (i >= str.length) throw new Error('POLYLINE_TRUNCATED');
        b = str.charCodeAt(i++) - 63;
        if (b < 0 || b > 63) throw new Error('POLYLINE_BAD_CHAR');
        res |= (b & 31) << shift; shift += 5;
      } while (b >= 32);
      return (res & 1) ? ~(res >> 1) : (res >> 1);
    };
    while (i < str.length) {
      lat += next(); lng += next();
      out.push({ lat: lat / 1e5, lng: lng / 1e5 });
    }
    return out;
  }
  function encodePolyline(pts) {
    let s = '', plat = 0, plng = 0;
    const enc = v => {
      v = v < 0 ? ~(v << 1) : (v << 1);
      let o = '';
      while (v >= 0x20) { o += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
      return o + String.fromCharCode(v + 63);
    };
    for (const p of pts) {
      const la = Math.round(p.lat * 1e5), ln = Math.round(p.lng * 1e5);
      s += enc(la - plat) + enc(ln - plng);
      plat = la; plng = ln;
    }
    return s;
  }

  // ================================================================ 平面投影・幾何
  function projector(lat0, lng0) {
    const k = R_EARTH * RAD, c = Math.cos(lat0 * RAD);
    return (lat, lng) => [(lng - lng0) * k * c, (lat - lat0) * k];
  }
  function bearingOf(dx, dy) { let a = Math.atan2(dx, dy) * 180 / Math.PI; if (a < 0) a += 360; return a; }
  function angDiff(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
  function haversineM(a, b) {
    const dLat = (b.lat - a.lat) * RAD, dLng = (b.lng - a.lng) * RAD;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function cumLen(xy) {
    const c = [0];
    for (let i = 1; i < xy.length; i++) c.push(c[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
    return c;
  }
  /** 点 q=[x,y] から折れ線 xy=[[x,y]…] への最短距離（m）。折れ線が 1 点だけならその点までの距離 */
  function polyDist(q, xy) {
    if (!xy.length) return Infinity;
    if (xy.length === 1) return Math.hypot(q[0] - xy[0][0], q[1] - xy[0][1]);
    let best = Infinity;
    for (let j = 0; j + 1 < xy.length; j++) {
      const ax = xy[j][0], ay = xy[j][1], dx = xy[j + 1][0] - ax, dy = xy[j + 1][1] - ay, L2 = dx * dx + dy * dy;
      let u = L2 > 0 ? ((q[0] - ax) * dx + (q[1] - ay) * dy) / L2 : 0;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const d = Math.hypot(q[0] - (ax + u * dx), q[1] - (ay + u * dy));
      if (d < best) best = d;
    }
    return best;
  }
  /** 折れ線（平面座標）を一定間隔で標本化。各標本に前後 win の弦から求めた進行方位を付ける */
  function resample(xy, step, win) {
    const cum = cumLen(xy), L = cum[cum.length - 1];
    const at = s => {
      if (s <= 0) return xy[0];
      if (s >= L) return xy[xy.length - 1];
      let lo = 0, hi = cum.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
      const seg = cum[hi] - cum[lo] || 1, t = (s - cum[lo]) / seg;
      return [xy[lo][0] + (xy[hi][0] - xy[lo][0]) * t, xy[lo][1] + (xy[hi][1] - xy[lo][1]) * t];
    };
    const out = [];
    const add = s => {
      const p = at(s), a = at(Math.max(0, s - win)), b = at(Math.min(L, s + win));
      const dx = b[0] - a[0], dy = b[1] - a[1];
      out.push({ x: p[0], y: p[1], s, brg: Math.hypot(dx, dy) > 0.5 ? bearingOf(dx, dy) : null });
    };
    const cnt = Math.max(1, Math.floor(L / step));
    for (let i = 0; i <= cnt; i++) add(i * step);
    if (L - cnt * step > step * 0.25) add(L);
    return { samples: out, length: L };
  }

  // ================================================================ グラフ索引
  const isRampEdge = e => e.kind === 'on_ramp' || e.kind === 'off_ramp';
  const isTrunkEdge = e => e.kind === 'mainline' || e.kind === 'jct_link';
  const rampGroupKey = e => [e.ic_id, e.kind, e.dir].join('|');
  function indexGraph(graph) {
    const nodes = new Map(), edges = new Map(), out = new Map(), byIc = new Map();
    for (const n of graph.nodes) { nodes.set(n.id, n); out.set(n.id, []); }
    for (const e of graph.edges) {
      edges.set(e.id, e);
      if (out.has(e.from)) out.get(e.from).push(e);
      if (e.kind === 'on_ramp' || e.kind === 'off_ramp') {
        if (!byIc.has(e.ic_id)) byIc.set(e.ic_id, { on: [], off: [] });
        byIc.get(e.ic_id)[e.kind === 'on_ramp' ? 'on' : 'off'].push(e);
      }
    }
    for (const l of out.values()) l.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const icName = new Map((graph.ics || []).map(i => [i.ic_id, i.name]));
    const gi = { graph, nodes, edges, out, byIc, icName, geomCache: new Map(), altCache: new Map(), uniqCache: new Map(), compCache: new Map(), divCache: new Map() };
    buildRampInfo(gi);
    return gi;
  }
  /** ランプの一般道側端点ノード／本線側端点ノード */
  const surfaceNodeOf = (gi, e) => gi.nodes.get(e.kind === 'on_ramp' ? e.from : e.to);
  const mainNodeIdOf = e => (e.kind === 'on_ramp' ? e.to : e.from);
  /**
   * ランプ群（v2.1 §5.2：同一 ic_id・kind・dir）と吸着リスク端点（v2.2 §2.2：一般道側端点から本線・JCT 連絡路が RISK_M 以内）・群内識別不能対（端点が END_M 以内）を事前計算する。
   * 群の本線側端点が 1 つでなければ警告して群化しない（その群のランプは単独扱い）。geom_gap 辺の集合も作る。
   */
  function buildRampInfo(gi) {
    const cfg = CONFIG;
    const groups = new Map(), warnings = [];
    for (const e of gi.graph.edges) {
      if (!isRampEdge(e)) continue;
      const k = rampGroupKey(e);
      if (!groups.has(k)) groups.set(k, { key: k, members: [], grouped: true });
      groups.get(k).members.push(e);
    }
    gi.groupOf = new Map();
    for (const g of groups.values()) {
      const ends = new Set(g.members.map(mainNodeIdOf));
      if (ends.size !== 1) { g.grouped = false; warnings.push('GROUP_MAIN_ENDS:' + g.key + ':' + ends.size); }
      for (const m of g.members) gi.groupOf.set(m.id, g);
    }
    gi.groups = groups; gi.groupWarnings = warnings;
    // 吸着リスク端点
    const trunk = gi.graph.edges.filter(isTrunkEdge).map(e => ({ e, g: edgeGeom(gi, e) })).filter(x => x.g && x.g.length >= 2);
    gi.risk = new Map();
    for (const e of gi.graph.edges) {
      if (!isRampEdge(e)) continue;
      const n = surfaceNodeOf(gi, e);
      if (!n) continue;
      const proj = projector(n.lat, n.lng);
      let best = Infinity, bid = null;
      for (const t of trunk) { const d = polyDist([0, 0], t.g.map(p => proj(p.lat, p.lng))); if (d < best) { best = d; bid = t.e.id; } }
      if (best <= cfg.RISK_M) gi.risk.set(e.id, { distM: Math.round(best * 10) / 10, nearest: bid });
    }
    // 群内識別不能対
    gi.indistinct = [];
    for (const g of groups.values()) {
      if (!g.grouped) continue;
      const m = g.members.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
      for (let i = 0; i < m.length; i++) for (let j = i + 1; j < m.length; j++) {
        const d = haversineM(surfaceNodeOf(gi, m[i]), surfaceNodeOf(gi, m[j]));
        if (d <= cfg.END_M) gi.indistinct.push({ a: m[i].id, b: m[j].id, distM: Math.round(d * 10) / 10 });
      }
    }
    gi.geomGap = new Set(gi.graph.edges.filter(e => e.geom_gap === true).map(e => e.id));
  }
  /** 群内帰属（v2.2 §5.1）：leg の端点 pt が予定ランプ X の一般道側端点から END_M 以内で、群内の他端点 Y すべてが d(Y)>END_M または d(X)≤d(Y)−GROUP_GAP_M なら confirmed、そうでなければ indistinct。群が単独なら single */
  function groupAttribution(gi, ramp, pt, cfg) {
    cfg = cfg || CONFIG;
    const g = gi.groupOf.get(ramp.id);
    if (!g || !g.grouped || g.members.length < 2) return 'single';
    const dX = haversineM(pt, surfaceNodeOf(gi, ramp));
    for (const y of g.members) {
      if (y.id === ramp.id) continue;
      const dY = haversineM(pt, surfaceNodeOf(gi, y));
      if (!(dY > cfg.END_M || dX <= dY - cfg.GROUP_GAP_M)) return 'indistinct';
    }
    return 'confirmed';
  }
  /** ランプの対抗＝本線・JCT 連絡路・他群ランプ */
  function competitorsOf(gi, ramp) {
    if (gi.compCache.has(ramp.id)) return gi.compCache.get(ramp.id);
    const mine = gi.groupOf.get(ramp.id);
    const list = gi.graph.edges.filter(x => x.id !== ramp.id && (isTrunkEdge(x) || (isRampEdge(x) && gi.groupOf.get(x.id) !== mine)))
      .map(x => ({ id: x.id, g: edgeGeom(gi, x) })).filter(x => x.g && x.g.length >= 2);
    gi.compCache.set(ramp.id, list);
    return list;
  }
  /** 平面座標 q から対抗の最短距離。しきい値 stopBelow 以下が見つかれば打ち切って返す */
  function compDist(q, comps, stopBelow) {
    let best = Infinity;
    for (const c of comps) {
      if (q[0] < c.bb[0] - best || q[0] > c.bb[2] + best || q[1] < c.bb[1] - best || q[1] > c.bb[3] + best) continue;
      const d = polyDist(q, c.xy);
      if (d < best) { best = d; if (best <= stopBelow) return best; }
    }
    return best;
  }
  function projectComps(comps, proj) {
    return comps.map(c => {
      const xy = c.g.map(p => proj(p.lat, p.lng));
      let a = Infinity, b = Infinity, cc = -Infinity, d = -Infinity;
      for (const p of xy) { if (p[0] < a) a = p[0]; if (p[1] < b) b = p[1]; if (p[0] > cc) cc = p[0]; if (p[1] > d) d = p[1]; }
      return { xy, bb: [a, b, cc, d] };
    });
  }
  /** ランプ固有区間（E-geo）：本線・他群ランプから UNIQ_SEP_M 以上離れ、連続 UNIQ_MIN_LEN_M 以上ある区間。辺の始点からの距離 [s0,s1] の配列 */
  function uniqueSections(gi, ramp, cfg) {
    cfg = cfg || CONFIG;
    if (gi.uniqCache.has(ramp.id)) return gi.uniqCache.get(ramp.id);
    const g = edgeGeom(gi, ramp);
    let res = [];
    if (g && g.length >= 2) {
      const proj = projector(g[0].lat, g[0].lng);
      const xy = g.map(p => proj(p.lat, p.lng)), cum = cumLen(xy), L = cum[cum.length - 1];
      const comps = projectComps(competitorsOf(gi, ramp), proj);
      const STEP = 5;
      const at = s => {
        let lo = 0, hi = cum.length - 1;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
        const seg = cum[hi] - cum[lo] || 1, t = Math.min(1, Math.max(0, (s - cum[lo]) / seg));
        return [xy[lo][0] + (xy[hi][0] - xy[lo][0]) * t, xy[lo][1] + (xy[hi][1] - xy[lo][1]) * t];
      };
      let runA = null, last = null;
      const close = () => {
        if (runA !== null && last - runA + STEP >= cfg.UNIQ_MIN_LEN_M - 1e-9) res.push([Math.max(0, runA - STEP / 2), Math.min(L, last + STEP / 2)]);
        runA = null;
      };
      const n = Math.max(1, Math.floor(L / STEP));
      for (let i = 0; i <= n; i++) {
        const s = i * STEP;
        if (compDist(at(s), comps, cfg.UNIQ_SEP_M - 1e-9) >= cfg.UNIQ_SEP_M) { if (runA === null) runA = s; last = s; } else close();
      }
      close();
    }
    gi.uniqCache.set(ramp.id, res);
    return res;
  }
  /** E-geo の被覆率：固有区間のうち、標本（位置 ≤POS_M・方位 ≤ANG_DEG・接続順で割当済み）の被覆範囲に入る割合。固有区間がなければ available:false */
  function egeoCover(gi, ramp, creditedT, cfg) {
    cfg = cfg || CONFIG;
    const U = uniqueSections(gi, ramp, cfg);
    if (!U.length) return { available: false, cover: null, uniqueM: 0, ok: false };
    const H = cfg.COVER_HALF_M, a = (creditedT || []).slice().sort((x, y) => x - y);
    const merged = [];
    for (const t of a) { const s0 = t - H, e0 = t + H; if (merged.length && s0 <= merged[merged.length - 1][1]) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e0); else merged.push([s0, e0]); }
    let tot = 0, hit = 0;
    for (const [u0, u1] of U) { tot += u1 - u0; for (const [m0, m1] of merged) { const o = Math.min(u1, m1) - Math.max(u0, m0); if (o > 0) hit += o; } }
    const cover = tot ? Math.min(1, hit / tot) : 0;
    return { available: true, cover, uniqueM: Math.round(tot), ok: cover >= cfg.EGEO_COVER };
  }
  /** 点 pt={lat,lng} から、ランプ ramp の対抗（本線・JCT 連絡路・他群ランプ）の形状までの最短距離（m）。試験の模擬応答の合成にも使う */
  function distToCompetitors(gi, ramp, pt) {
    const proj = projector(pt.lat, pt.lng);
    return compDist([0, 0], projectComps(competitorsOf(gi, ramp), proj), -1);
  }
  /** グラフ側の事前計算結果（結果コピーの先頭に出す。自社生成情報） */
  function graphInfo(gi) {
    const nm = id => { const e = gi.edges.get(id); return (gi.icName.get(e.ic_id) || e.ic_id) + '(' + e.dir + ')' + (e.kind === 'on_ramp' ? '入口' : '出口'); };
    return {
      groups: gi.groups.size, groupWarnings: gi.groupWarnings.slice(),
      riskEndpoints: Array.from(gi.risk.keys()).sort().map(id => ({ id, name: nm(id), distM: gi.risk.get(id).distM, egeoAvailable: uniqueSections(gi, gi.edges.get(id)).length > 0 })),
      indistinctPairs: gi.indistinct.map(p => ({ a: p.a, b: p.b, nameA: nm(p.a), nameB: nm(p.b), distM: p.distM })),
      geomGapEdges: Array.from(gi.geomGap).sort(),
    };
  }
  /** 辺の形状（lat/lng 配列）。geom が無ければ null */
  function edgeGeom(gi, e) {
    if (gi.geomCache.has(e.id)) return gi.geomCache.get(e.id);
    let g = null;
    if (typeof e.geom === 'string' && e.geom.length) { try { g = decodePolyline(e.geom); } catch (x) { g = null; } }
    gi.geomCache.set(e.id, g);
    return g;
  }
  const roadTokens = e => String(e.road || '').split('>').filter(Boolean);

  // ================================================================ V5 期限確認
  function checkDeadline(departureTime, nowMs, marginSec) {
    const m = marginSec === undefined ? CONFIG.DEADLINE_MARGIN_SEC : marginSec;
    const t = Date.parse(departureTime);
    if (!isNum(t)) return { ok: false, reason: 'UNPARSEABLE', remainSec: null };
    const remain = (t - nowMs) / 1000;
    return { ok: remain >= m, reason: remain >= m ? null : 'PAST', remainSec: Math.round(remain * 10) / 10 };
  }

  // ================================================================ V1 要求生成
  function wpPoint(role, lat, lng, via, heading, edgeId) {
    const p = { role, lat, lng, via: !!via };
    if (heading !== undefined && heading !== null && isNum(heading)) p.heading = Math.round(heading) % 360;
    if (edgeId) p.edge = edgeId;
    return p;
  }
  /** 乗車1回ぶんの中間地点：入口一般道側端点(non-via)→入口ランプ中点(via)→料金影響点(via, path順)→出口ランプ中点(via)→出口一般道側端点(non-via) */
  function ridePoints(gi, ride) {
    const on = gi.edges.get(ride.on), off = gi.edges.get(ride.off);
    if (!on || !off) return { error: 'EDGE_NOT_FOUND' };
    const nIn = gi.nodes.get(on.from), nOut = gi.nodes.get(off.to);
    if (!nIn || !nOut || !on.via || !off.via) return { error: 'POINT_MISSING' };
    const pts = [];
    pts.push(wpPoint('S_in', nIn.lat, nIn.lng, false, null, on.id));              // @M1-A
    pts.push(wpPoint('V_on', on.via.lat, on.via.lng, true, on.via_heading, on.id)); // @M1-B
    for (const eid of ride.path) {
      const e = gi.edges.get(eid);
      if (!e) return { error: 'EDGE_NOT_FOUND' };
      if (e.fare_relevant) {
        if (!e.via) return { error: 'POINT_MISSING' };
        pts.push(wpPoint('V_fare', e.via.lat, e.via.lng, true, e.via_heading, e.id));
      }
    }
    pts.push(wpPoint('V_off', off.via.lat, off.via.lng, true, off.via_heading, off.id));
    pts.push(wpPoint('S_out', nOut.lat, nOut.lng, false, null, off.id));
    return { pts };
  }
  function bodyWaypoint(p) {
    const loc = { latLng: { latitude: r6(p.lat), longitude: r6(p.lng) } };
    if (p.heading !== undefined) loc.heading = p.heading;
    if (p.role === 'origin' || p.role === 'destination') return { location: loc };
    const w = { via: !!p.via, location: loc };
    if (p.stopover) w.vehicleStopover = true;      // 検証専用（比較試験 V-b）。非 via の停車点にだけ付く
    return w;
  }
  function fail(code, message, extra) { return Object.assign({ ok: false, error: code, message }, extra || {}); }

  /**
   * engine の要求 q（kind: base|full|split）から REST 要求を作る。
   * 戻り値 ok:true → { body, fieldMask, points[], expectedLegs, intermediates, departureTime, ... }
   * opts: { carrySec（split の到着時刻引継ぎ）, omitTollInfo（検証専用：FieldMask から tollInfo を外す）,
   *         vehicleStopover（検証専用・v2.2 §2.5 の比較試験 V-b：kind=full の S_in・S_out に vehicleStopover:true を付ける。標準の要求には付けない）,
   *         avoidTolls（検証専用・1.1.1 の診断 V-t：kind=full に routeModifiers.avoidTolls=true を付ける。その他は V-a と同じ。V-b とは同時に指定できない）, cfg }
   */
  function buildRequest(gi, q, opts) {
    opts = opts || {};
    const cfg = opts.cfg || CONFIG;
    const cond = q.cond;
    if (!cond || !cond.origin || !cond.destination) return fail('INVALID_ARGUMENT', '比較条件がない');
    if (opts.vehicleStopover && opts.avoidTolls) return fail('INVALID_ARGUMENT', 'V-b（vehicleStopover）と V-t（avoidTolls）は同時に指定できない');
    const depMs0 = Date.parse(cond.departureTime);
    if (!isNum(depMs0)) return fail('INVALID_ARGUMENT', 'departureTime を解釈できない');
    const mods = {};
    const origin = wpPoint('origin', cond.origin.lat, cond.origin.lng, false);
    const dest = wpPoint('destination', cond.destination.lat, cond.destination.lng, false);
    let wps, intermediates, expectedLegs, depMs = depMs0, kind = q.kind;

    if (kind === 'base') {
      if (q.attempt === 'avoidTolls') mods.avoidTolls = true;
      else if (q.attempt === 'avoidHighways') mods.avoidHighways = true;
      else return fail('INVALID_ARGUMENT', 'base の attempt が不正：' + q.attempt);
      wps = [origin, dest]; intermediates = 0; expectedLegs = 1;
    } else if (kind === 'full') {
      const c = q.candidate;
      if (!c || !Array.isArray(c.rides) || !c.rides.length) return fail('INVALID_ARGUMENT', '候補がない');
      const mid = [];
      for (const r of c.rides) {
        const rp = ridePoints(gi, r);
        if (rp.error) return fail('INVALID_ARGUMENT', '経由点を作れない：' + rp.error);
        for (const p of rp.pts) { if (opts.vehicleStopover && (p.role === 'S_in' || p.role === 'S_out')) p.stopover = true; mid.push(p); }
      }
      const expectCount = c.intermediates !== undefined ? c.intermediates : 4 * c.rides.length + c.rides.reduce((a, r) => a + r.fare.length, 0);
      if (mid.length !== expectCount) return fail('POINTS_MISMATCH', '中間地点数 ' + mid.length + ' が engine の値 ' + expectCount + ' と一致しない');
      if (mid.length > cfg.MAX_POINTS) return fail('TOO_MANY_POINTS', '中間地点 ' + mid.length + ' 点が上限 ' + cfg.MAX_POINTS + ' を超える'); // @M2
      wps = [origin].concat(mid, [dest]); intermediates = mid.length; expectedLegs = 2 * c.rides.length + 1;
      if (opts.avoidTolls) mods.avoidTolls = true;                 // V-t（検証専用。routeModifiers.avoidTolls 以外は V-a と同じ）
    } else if (kind === 'split') {
      const c = q.candidate, i = q.section, k = 2 * (c && c.rides ? c.rides.length : 0) + 1;
      if (!c || !Number.isInteger(i) || i < 0 || i >= k) return fail('INVALID_ARGUMENT', 'split の区間番号が不正');
      mods.avoidTolls = i % 2 === 0;       // 偶数＝一般道（avoidTolls）、奇数＝高速（ランプ・料金影響点を via）
      if (i % 2 === 0) {
        const prev = i === 0 ? null : gi.edges.get(c.rides[i / 2 - 1].off);
        const next = i === k - 1 ? null : gi.edges.get(c.rides[i / 2].on);
        const o = prev ? gi.nodes.get(prev.to) : null, d = next ? gi.nodes.get(next.from) : null;
        wps = [o ? wpPoint('S_out', o.lat, o.lng, false, null, prev.id) : origin, d ? wpPoint('S_in', d.lat, d.lng, false, null, next.id) : dest];
        intermediates = 0;
      } else {
        const rp = ridePoints(gi, c.rides[(i - 1) / 2]);
        if (rp.error) return fail('INVALID_ARGUMENT', '経由点を作れない：' + rp.error);
        const inner = rp.pts.slice(1, -1);                // 入口一般道側端点と出口一般道側端点は origin/destination にする
        wps = [rp.pts[0], ...inner, rp.pts[rp.pts.length - 1]];
        intermediates = inner.length;
        if (intermediates > cfg.MAX_POINTS) return fail('TOO_MANY_POINTS', '分割区間の中間地点が多すぎる');
      }
      expectedLegs = 1;
      depMs = depMs0 + Math.round((opts.carrySec || 0) * 1000);
    } else {
      return fail('INVALID_ARGUMENT', '未対応の kind：' + kind);
    }

    const routeModifiers = { vehicleInfo: { emissionType: 'GASOLINE' } };
    if (cond.etc !== false) routeModifiers.tollPasses = ['JP_ETC'];
    if (mods.avoidTolls) routeModifiers.avoidTolls = true;
    if (mods.avoidHighways) routeModifiers.avoidHighways = true;
    const body = {
      origin: bodyWaypoint(wps[0]),
      destination: bodyWaypoint(wps[wps.length - 1]),
      travelMode: 'DRIVE',
      routingPreference: cond.routingPreference || 'TRAFFIC_AWARE_OPTIMAL',
      departureTime: isoZ(depMs),
      extraComputations: ['TOLLS'],
      routeModifiers,
      polylineQuality: 'HIGH_QUALITY',
      languageCode: 'ja',
      regionCode: 'JP',
      units: 'METRIC',
    };
    if (wps.length > 2) body.intermediates = wps.slice(1, -1).map(bodyWaypoint);
    return {
      ok: true, kind, body, fieldMask: opts.omitTollInfo ? FIELD_MASK_NO_TOLL : FIELD_MASK,
      points: wps, intermediates, expectedLegs, departureTime: body.departureTime, departureMs: depMs,
      tollsRequested: true, fieldMaskHasToll: !opts.omitTollInfo, modifiers: mods,
      variant: opts.vehicleStopover && kind === 'full' ? 'V-b' : opts.avoidTolls && kind === 'full' ? 'V-t' : 'V-a', vehicleStopover: !!(opts.vehicleStopover && kind === 'full'),
    };
  }
  function compactPoints(points) {
    return points.map(p => [p.role, r6(p.lat), r6(p.lng), p.via ? 1 : 0, p.heading === undefined ? null : p.heading, p.edge || null]);
  }

  // ================================================================ V3 料金
  function parseMoney(m) {
    if (m === null || typeof m !== 'object' || typeof m.currencyCode !== 'string' || !m.currencyCode) return { ok: false, reason: 'NO_CURRENCY' };
    const part = v => {
      if (v === undefined || v === null) return 0;
      if (typeof v === 'string') return /^-?\d+$/.test(v) ? Number(v) : NaN;
      return typeof v === 'number' ? v : NaN;
    };
    const u = part(m.units), n = part(m.nanos);
    if (!Number.isFinite(u) || !Number.isFinite(n)) return { ok: false, reason: 'BAD_NUMBER' };
    const amount = u + n / 1e9;
    if (amount < 0) return { ok: false, reason: 'NEGATIVE' };
    // units・nanos が両方省略されたときは 0 として扱う（Money 型は値が 0 のフィールドを省略する。v5.1 追補#2）
    return { ok: true, currency: m.currencyCode, amount, omitted: (m.units === undefined || m.units === null) && (m.nanos === undefined || m.nanos === null) };
  }
  /** TollInfo → { present, status: priced|unknown|invalid, jpy?, reason? }（REST の estimatedPrice と JS の estimatedPrices の両方に対応） */
  function parseTollInfo(ti) {
    if (ti === undefined || ti === null) return { present: false };
    if (typeof ti !== 'object' || Array.isArray(ti)) return { present: true, status: 'invalid', reason: 'NOT_OBJECT' };
    let a = ti.estimatedPrice !== undefined ? ti.estimatedPrice : ti.estimatedPrices;
    if (a === undefined || a === null) a = [];
    if (!Array.isArray(a)) a = [a];
    const items = a.map(parseMoney);
    const bad = items.find(x => !x.ok);
    if (bad) return { present: true, status: 'invalid', reason: bad.reason };
    const jpy = items.filter(x => x.currency === 'JPY');
    if (jpy.length === 1) return { present: true, status: 'priced', jpy: jpy[0].amount, omitted: jpy[0].omitted };
    if (jpy.length > 1) return { present: true, status: 'invalid', reason: 'MULTI_JPY' };
    return { present: true, status: 'unknown', reason: items.length ? 'NON_JPY' : 'EMPTY' };
  }
  function parseDuration(d) {
    if (isNum(d)) return d;
    if (typeof d !== 'string') return undefined;
    const m = /^(\d+(?:\.\d+)?)s$/.exec(d);
    return m ? Number(m[1]) : undefined;
  }
  /**
   * 料金4状態＋全旅程料金（§5.2 V3、規則は仕様で固定）。route は routes[0]。
   * 前提（v2.2 §5.3）：TOLLS 要求・FieldMask に tollInfo・HTTP 200・routes[0]・legs 数一致。
   * 料金状態は tollInfo だけで決める：「所要時間あり」「fallbackInfo なし」は前提に含めない（所要時間・条件は独立に保持し、engine の入場条件で別枠にする）。
   * prereq.duration・prereq.noFallback は記録のみ。
   */
  function classifyToll(route, ctx) {
    const legs = Array.isArray(route.legs) ? route.legs : [];
    const routeTi = parseTollInfo(route.travelAdvisory && route.travelAdvisory.tollInfo);
    const legTis = legs.map((lg, i) => {
      if (i % 2 === 0 && ctx.ignoreSurfaceTollInfo) return { present: false };      // @M3b
      return parseTollInfo(lg && lg.travelAdvisory && lg.travelAdvisory.tollInfo);
    });
    const anyLeg = legTis.some(t => t.present);
    const prereq = {
      tollsRequested: !!ctx.tollsRequested, fieldMaskHasToll: !!ctx.fieldMaskHasToll, http200: ctx.http === 200,
      routePresent: true, legsMatch: legs.length === ctx.expectedLegs, noFallback: !ctx.fallback,
      duration: ctx.durationSec !== undefined,
    };
    const prereqOk = prereq.tollsRequested && prereq.fieldMaskHasToll && prereq.http200 && prereq.routePresent && prereq.legsMatch;
    const out = { state: 'unverified', jpy: undefined, fullTripFare: false, rule: 'ε', legSumJpy: null, legCompare: null, prereq, notes: [], legStates: legTis.map(t => (t.present ? t.status : 'none')) };
    if (!prereqOk) { out.notes.push('前提不成立：' + Object.keys(prereq).filter(k => k !== 'duration' && k !== 'noFallback' && !prereq[k]).join(',')); return out; }
    if (!routeTi.present) {
      if (!anyLeg) { out.state = 'free'; out.fullTripFare = true; out.rule = 'α'; return out; }       // route・全 leg に tollInfo なし：全旅程無料（確認済み）
      out.rule = 'γ'; out.state = 'unverified'; out.fullTripFare = false;                               // route なし・leg あり：全体／区間不整合
      out.notes.push('route に tollInfo がなく leg にある');
      return out;
    }
    if (routeTi.status === 'priced') {
      out.state = 'priced'; out.jpy = routeTi.jpy; out.fullTripFare = true; out.rule = 'β';
      if (anyLeg) {
        const comparable = legTis.every(t => !t.present || t.status === 'priced');
        if (comparable) {
          const sum = legTis.reduce((a, t) => a + (t.present ? t.jpy : 0), 0);
          out.legSumJpy = sum;
          const diff = Math.abs(routeTi.jpy - sum);
          if (diff === 0) out.legCompare = 'match';
          else if (diff <= CONFIG.FARE_TOL_JPY) out.legCompare = 'minor';
          else { out.legCompare = 'mismatch'; out.fullTripFare = false; out.notes.push('料金不整合（全体 ' + yen(routeTi.jpy) + '／区間合計 ' + yen(sum) + '）'); }
        } else out.legCompare = 'uncomparable';
      } else out.legCompare = 'no-leg-toll';
      return out;
    }
    if (routeTi.status === 'unknown') { out.state = 'unknown'; out.rule = 'δ'; out.notes.push('tollInfo あり・JPY 金額なし（' + routeTi.reason + '）'); return out; }
    out.notes.push('route の tollInfo が不正（' + routeTi.reason + '）');
    return out;
  }
  /** 候補の辺の road から時刻依存を決める。優先順 時刻依存＞未確認＞なし。base（一般道のみ）は呼ばない */
  function timeDependencyOf(gi, cand, table) {
    const T = table || TIME_DEPENDENCY;
    let td = 'なし';
    const rank = { なし: 0, 未確認: 1, 時刻依存: 2 };
    for (const r of cand.rides) {
      for (const eid of r.path) {
        const e = gi.edges.get(eid);
        const toks = e ? roadTokens(e) : [];
        if (!toks.length) { if (rank['未確認'] > rank[td]) td = '未確認'; continue; }
        for (const t of toks) {
          const v = T[t] || '未確認';
          if (rank[v] > rank[td]) td = v;
        }
      }
    }
    return td;
  }

  // ================================================================ V2 形状照合
  /** 参照辺1本と標本列の当てはめ：最短距離 d、進行方位の適合 ok、辺上の位置 t */
  function fitEdge(proj, gi, e, geomPts, samples, cfg) {
    const n = samples.length;
    const d = new Float64Array(n), ok = new Uint8Array(n), t = new Float64Array(n);
    const xy = geomPts.map(p => proj(p.lat, p.lng));
    const cum = cumLen(xy), len = cum[cum.length - 1];
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    for (const p of xy) { if (p[0] < minx) minx = p[0]; if (p[0] > maxx) maxx = p[0]; if (p[1] < miny) miny = p[1]; if (p[1] > maxy) maxy = p[1]; }
    const M = cfg.NEAR_BBOX_M;
    const degenerate = xy.length < 2 || len < 0.5;
    const segB = [];
    if (!degenerate) for (let j = 0; j + 1 < xy.length; j++) {
      const dx = xy[j + 1][0] - xy[j][0], dy = xy[j + 1][1] - xy[j][1], L = Math.hypot(dx, dy);
      segB.push(L > 0.01 ? bearingOf(dx, dy) : null);
    }
    for (let i = 0; i < n; i++) {
      const s = samples[i];
      if (s.x < minx - M || s.x > maxx + M || s.y < miny - M || s.y > maxy + M) { d[i] = 1e9; ok[i] = 0; t[i] = 0; continue; }
      if (degenerate) { d[i] = Math.hypot(s.x - xy[0][0], s.y - xy[0][1]); ok[i] = 1; t[i] = 0; continue; }
      let best = Infinity, bt = 0, bb = null;
      for (let j = 0; j + 1 < xy.length; j++) {
        const ax = xy[j][0], ay = xy[j][1], bx = xy[j + 1][0], by = xy[j + 1][1];
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
        let u = L2 > 0 ? ((s.x - ax) * dx + (s.y - ay) * dy) / L2 : 0;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const px = ax + u * dx, py = ay + u * dy, dd = Math.hypot(s.x - px, s.y - py);
        if (dd < best) { best = dd; bt = cum[j] + u * Math.sqrt(L2); bb = segB[j]; }
      }
      d[i] = best; t[i] = bt;
      const dirOk = s.brg === null || bb === null || angDiff(s.brg, bb) <= cfg.ANG_DEG;
      ok[i] = (best <= cfg.POS_M && dirOk) ? 1 : 0;                      // @M4
    }
    return { id: e.id, kind: e.kind, len, degenerate, d, ok, t };
  }

  /** 参照辺列（fits）に対する採点。標本は順に、接続順を守る最小の辺添字へ割り当てる（同一箇所を複数回通る場合の誤一致を防ぐ） */
  function scoreRef(fits, n, cfg) {
    const m = fits.length;
    const iv = fits.map(() => []);
    let prev = 0, okCnt = 0, posNear = 0, bearBad = 0, orderBad = 0;
    const dmin = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let minD = Infinity, anyNear = false, anyOk = false;
      let credited = false;
      for (let j = 0; j < m; j++) {
        const f = fits[j], dj = f.d[i];
        if (dj < minD) minD = dj;
        if (dj <= cfg.POS_M) {
          anyNear = true;
          if (f.ok[i]) { anyOk = true; }
        }
      }
      dmin[i] = minD;
      if (anyNear) posNear++;
      let first = -1;
      for (let j = prev; j < m; j++) {
        const f = fits[j];
        if (f.ok[i]) { if (first < 0) first = j; credited = true; iv[j].push(f.t[i]); }
      }
      if (credited) { okCnt++; prev = first; }
      else if (anyOk) orderBad++;
      else if (anyNear) bearBad++;
    }
    const cov = fits.map((f, j) => {
      if (f.degenerate || f.len < 1) return null;                       // 長さ0の辺は被覆を評価できない
      const H = cfg.COVER_HALF_M, a = iv[j].slice().sort((x, y) => x - y);
      let covered = 0, curS = null, curE = null;
      for (const t of a) {
        const s0 = Math.max(0, t - H), e0 = Math.min(f.len, t + H);
        if (curS === null) { curS = s0; curE = e0; }
        else if (s0 <= curE) curE = Math.max(curE, e0);
        else { covered += curE - curS; curS = s0; curE = e0; }
      }
      if (curS !== null) covered += curE - curS;
      return Math.min(1, covered / f.len);
    });
    const evalCov = cov.filter(x => x !== null);
    return {
      n, okRate: n ? okCnt / n : 0, posRate: n ? posNear / n : 0,
      bearMis: posNear ? bearBad / posNear : 0, orderRate: n ? orderBad / n : 0,
      cov, iv, minCov: evalCov.length ? Math.min.apply(null, evalCov) : 1,
      dMed: median(Array.from(dmin)), dP95: percentile(Array.from(dmin), 0.95),
    };
  }

  /**
   * SA/PA 同値経路：予定と別経路が分かれる区間のどれもが、一方に SA/PA 側道（'sapa.' ノード）を通り、もう一方がそれを通らない（本線をそのまま走る）形のもの。
   * 乗車（入口・出口・料金影響辺）は同じで engine では同一 ID の候補なので、対抗経路（取り違えの原因）ではなく同じ候補の走り方の違いとして扱う（README の解釈事項）。
   */
  function isSapaEquiv(gi, pathA, pathB) {
    const nodesOf = ids => { const l = [gi.edges.get(ids[0]).from]; ids.forEach(id => l.push(gi.edges.get(id).to)); return l; };
    const na = nodesOf(pathA), nb = nodesOf(pathB);
    const common = na.filter(n => nb.indexOf(n) >= 0);
    let diff = 0;
    for (let k = 0; k + 1 < common.length; k++) {
      const sa = na.slice(na.indexOf(common[k]), na.indexOf(common[k + 1]) + 1), sb = nb.slice(nb.indexOf(common[k]), nb.indexOf(common[k + 1]) + 1);
      if (sa.join() === sb.join()) continue;
      diff++;
      const hasSapa = x => x.some(n => /^sapa\./.test(n));
      if (hasSapa(sa) === hasSapa(sb)) return false;      // 片方だけが SA/PA を通る分岐でなければ同値としない
    }
    return diff > 0;
  }
  /**
   * 対抗経路（v2.1 §5.3）＝leg の両端を結ぶ、グラフ上で連結した実現可能な高速経路。入口ランプ辺・出口ランプ辺は予定と同じで、間の本線・JCT 連絡路の単純路が予定と異なり、
   * 全長が予定の ALT_LEN_MIN〜ALT_LEN_MAX 倍にあるもの（最大 MAX_ALT_PER_TYPE 本）。辺置換による仮説（本線直進・逆方向ランプ・同方向別ランプ・別方向連絡路・別路線）は対抗経路にしない
   * （要求遵守の検査 (i)〜(vii) の失敗として検出する）。戻り値：[{type:'alt', edges:[辺ID…]}]
   */
  function buildAlts(gi, path, cfg) {
    cfg = cfg || CONFIG;
    const key = path.join(',') + '|' + cfg.ALT_LEN_MIN + '|' + cfg.ALT_LEN_MAX + '|' + cfg.MAX_ALT_PER_TYPE;
    if (gi.altCache.has(key)) return gi.altCache.get(key);
    const alts = [];
    const first = gi.edges.get(path[0]), last = gi.edges.get(path[path.length - 1]);
    if (first && last && path.length >= 2) {
      const total = path.reduce((a, id) => a + (gi.edges.get(id).length_m || 0), 0);
      const ramps = first.length_m + last.length_m;
      const hi = cfg.ALT_LEN_MAX * total, lo = cfg.ALT_LEN_MIN * total;
      const planned = path.join(',');
      let budget = cfg.ALT_SEARCH_NODES;
      const dfs = (node, acc, midLen, seen) => {
        if ((alts.filter(a => !a.equiv).length >= cfg.MAX_ALT_PER_TYPE && alts.filter(a => a.equiv).length >= cfg.MAX_ALT_PER_TYPE) || budget-- <= 0) return;
        if (node === last.from && acc.length) {
          const L = ramps + midLen;
          if (L >= lo && L <= hi) {
            const ids = [first.id].concat(acc, [last.id]);
            if (ids.join(',') !== planned) {
              const equiv = isSapaEquiv(gi, path, ids);
              if (alts.filter(a => !!a.equiv === equiv).length < cfg.MAX_ALT_PER_TYPE) alts.push({ type: equiv ? 'sapa' : 'alt', equiv, edges: ids });
            }
          }
          return;                                    // 出口ランプの分岐点に着いたらその先は延ばさない（単純路）
        }
        for (const e of (gi.out.get(node) || [])) {
          if (!isTrunkEdge(e) || seen.has(e.to) || ramps + midLen + e.length_m > hi) continue;
          dfs(e.to, acc.concat([e.id]), midLen + e.length_m, new Set(seen).add(e.to));
        }
      };
      if (first.to === last.from) {
        // 入口ランプの本線側端点がそのまま出口ランプの分岐点（本線辺なしの乗車）：別経路は成り立たない
      } else dfs(first.to, [], 0, new Set([first.to]));
    }
    gi.altCache.set(key, alts);
    return alts;
  }

  // ---------------------------------------------------------------- E-name：案内文の名称（v2.3 §1.3 (d)、v2.4 §1.1 (d)）。文型は固定のパターン表（5a 中は変更しない。変更は理由付きで記録）
  // name-patterns-2（1.2.0）：OUT-3 を追加（理由：実機の出口 step の案内文は「<IC名> 出口を <方面> 方面に…」で、IC 名と「出口」の間に空白がある〔v2.4 §0〕。OUT-1／OUT-2 は空白を許さず不一致）。IN-1／IN-2／OUT-1／OUT-2 は不変
  const NAME_PATTERN_TABLE_VERSION = 'name-patterns-2';
  const reEsc = x => String(x).replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
  /** IC 名の表記ゆれ：N06 名（例 綾瀬SIC・厚木PASIC）に加え、末尾 SIC を「スマートIC」「スマートインターチェンジ」にした形 */
  function icNameForms(name) {
    const f = [String(name)];
    if (/SIC$/.test(name)) { f.push(name.replace(/SIC$/, 'スマートIC'), name.replace(/SIC$/, 'スマートインターチェンジ')); }
    return f;
  }
  const NAME_LEFT = '(^|[^一-龯ぁ-んァ-ヶー々A-Za-z0-9\\/／・])';        // 名称の左隣が文字・列挙記号でないこと（「圏央厚木」の中の「厚木」や「A/渋谷」を拾わない）
  const IC_ENDS = /(?:IC|インターチェンジ)$/;
  /** 入口側の対象表現：「◯◯入口」「◯◯IC」「◯◯スマートIC」 */
  function inTarget(forms) { return '(?:' + forms.map(f => (IC_ENDS.test(f) ? reEsc(f) + '(?:入口)?' : reEsc(f) + '(?:入口|IC|インターチェンジ)')).join('|') + ')'; }
  /** 出口側の対象表現：「◯◯出口」「◯◯ICの出口」。「出口」表記を必須とする */
  function outTarget(forms) { return '(?:' + forms.map(f => (IC_ENDS.test(f) ? reEsc(f) + '(?:の)?出口' : reEsc(f) + '出口')).join('|') + ')'; }
  /** OUT-3 の対象表現：「◯◯ 出口」「◯◯IC 出口」「◯◯出口」（IC 名＋任意の空白＋「出口」。空白は半角・全角・改行を何個でも） */
  function outTarget3(forms) { return '(?:' + forms.map(f => reEsc(f) + (IC_ENDS.test(f) ? '(?:の)?' : '(?:IC|インターチェンジ)?') + '[\\s　]*出口').join('|') + ')'; }
  const OUT3_NOT_DIRECTION = '(?![\\s　]*(?:方面|方向|行き))';       // @M12  OUT-3：「◯◯ 出口方面」「◯◯出口 方面」は標識・方面表示であって操作対象ではない（直後に「方面」が続くものを除く）
  const OUT3_NEXT = '(?=[\\s　]?[ぁ-んァ-ヶ一-龯])';                  // OUT-3：直後に文が続くこと（「を／へ／に／から」等の助詞や動詞。文末・読点・列挙記号の直前は不可）
  const PAT_IN_VERB = '(?:に入り|に入る|に入って|へ入り|へ入る|に入ります|へ入ります|に進入|に乗り|に乗る|に合流|を利用して入)';
  const PAT_OUT_VERB = '(?:出ます|出る|出て|降ります|降りる|降りて|退出|を出)';
  /** (d) の文型表。kind: 'in'|'out'。操作対象としての出現だけを認める（「◯◯方面」「◯◯/△△」「◯◯出口方面」の列挙は不可） */
  const NAME_PATTERNS = Object.freeze([
    { id: 'IN-1', side: 'in', make: f => new RegExp(NAME_LEFT + inTarget(f) + 'から[^。、]*?' + PAT_IN_VERB) },        // 「渋谷入口から首都高速3号渋谷線に入る」
    { id: 'IN-2', side: 'in', make: f => new RegExp(NAME_LEFT + inTarget(f) + '(?:に入り|に入る|に入って|に入ります|から入り|から入る|に進入|から進入)') },   // 「綾瀬SICに入る」
    { id: 'OUT-1', side: 'out', make: f => new RegExp(NAME_LEFT + outTarget(f) + '(?:から|で|を)[^。、]*?' + PAT_OUT_VERB) },  // 「渋谷出口で降りる」「渋谷出口から出る」
    { id: 'OUT-2', side: 'out', make: f => new RegExp(NAME_LEFT + outTarget(f) + '(?:に|へ)(?:進み|進む|進みます|向かい|向かう|向かいます)') },   // 「渋谷出口に進みます」
    { id: 'OUT-3', side: 'out', make: f => new RegExp(NAME_LEFT + outTarget3(f) + OUT3_NOT_DIRECTION + OUT3_NEXT) },   // 「渋谷 出口を 池尻 方面に進みます」「渋谷IC 出口へ」（実機型）。入口側に対応する文型はない（入口の E-name は評価しない）
  ]);
  /** 案内文 text に、側 side（'in'|'out'）・IC 名 name の操作対象としての表現があるか。戻り値：一致した文型 ID または null */
  function nameOperand(text, side, name) {
    const t = String(text || '').normalize('NFKC');
    const forms = icNameForms(String(name).normalize('NFKC'));
    for (const p of NAME_PATTERNS) if (p.side === side && p.make(forms).test(t)) return p.id;
    return null;
  }
  /** 出口操作 step になりうる maneuver（v2.4 §1.1 (a)(b)） */
  const EXIT_STEP_MANEUVERS = ['RAMP_LEFT', 'RAMP_RIGHT', 'FORK_LEFT', 'FORK_RIGHT'];
  const toll区間 = t => String(t || '').indexOf('有料区間') >= 0;
  /** (a) 高速 leg の step 列を末尾から遡り、到着 step（最後の 1 つ）を除いた最後の RAMP_*／FORK_* の添字。なければ -1 */
  function exitStepIndex(steps) {
    for (let i = steps.length - 2; i >= 0; i--) if (EXIT_STEP_MANEUVERS.indexOf(steps[i].maneuver) >= 0) return i;
    return -1;
  }
  /**
   * 出口ランプの分流点（本線側端点）と比べる「他の分流点」：同じ方向（dir）の他 IC・他群の出口ランプの分流点、および同じ方向から出る JCT 連絡路の分流点（連絡路の dir は「出発方向→到着方向」で、前半を見る）。
   * dir が欠けているものは同方向とみなす（保守的）。戻り値：[{lat,lng}]
   */
  function divergeOthers(gi, ramp) {
    if (gi.divCache.has(ramp.id)) return gi.divCache.get(ramp.id);
    const mine = gi.groupOf.get(ramp.id), sameDir = d => !d || !ramp.dir || d === ramp.dir;
    const list = [];
    for (const x of gi.graph.edges) {
      if (x.id === ramp.id) continue;
      let n = null;
      if (x.kind === 'off_ramp') { if (gi.groupOf.get(x.id) !== mine && sameDir(x.dir)) n = gi.nodes.get(x.from); }
      else if (x.kind === 'jct_link') { if (sameDir(x.dir ? String(x.dir).split('→')[0] : null)) n = gi.nodes.get(x.from); }
      if (n) list.push({ lat: n.lat, lng: n.lng, id: x.id });
    }
    gi.divCache.set(ramp.id, list);
    return list;
  }
  /** (c) の一部：操作地点 p0 が予定の分流点から dX。他の分流点のどれからも NAME_POS_M 超、または予定の方が NAME_POS_M 以上近い */
  function divergeClear(gi, ramp, p0, dX, cfg) {
    for (const o of divergeOthers(gi, ramp)) { const dY = haversineM(p0, o); if (!(dX <= dY - cfg.NAME_POS_M)) return false; }  // 1.2.1：予定の分流点が最寄り（他より NAME_POS_M 以上近い）
    return true;
  }
  /** polyline の最初の m [m] の進行方位（始点から m 進んだ点への方位。全長が m 未満なら終点まで）。5 m 未満しか進めない・点が 2 未満なら null */
  function startHeading(pts, m) {
    if (!pts || pts.length < 2) return null;
    const proj = projector(pts[0].lat, pts[0].lng), xy = pts.map(p => proj(p.lat, p.lng));
    let acc = 0, end = xy[xy.length - 1];
    for (let i = 1; i < xy.length; i++) {
      const d = Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]);
      if (acc + d >= m) { const t = d > 0 ? (m - acc) / d : 0; end = [xy[i - 1][0] + (xy[i][0] - xy[i - 1][0]) * t, xy[i - 1][1] + (xy[i][1] - xy[i - 1][1]) * t]; break; }
      acc += d;
    }
    if (Math.hypot(end[0] - xy[0][0], end[1] - xy[0][1]) < 5) return null;
    return bearingOf(end[0] - xy[0][0], end[1] - xy[0][1]);
  }

  /**
   * 境界 1 つぶんの E-name 判定（v2.4 §1。出口のみ。すべて満たすこと）。
   * side: 'in'|'out'、ramp: 予定ランプ辺、h: 高速 leg の添字、legs: legsView の配列、sPt: 境界 leg 端点（互換のため残す。1.2.0 では使わない）
   * 入口（side='in'）は評価しない（v2.4 §1.2：実機の入口 step には IC 名が出ない）：常に ok:false・conds:null・why:['IN_NA']。
   * 戻り値 { ok, conds:{a,b,c,d,e}|null, pattern, why[], idx（出口操作 step の添字。なければ null） }
   */
  function nameEvidence(gi, side, ramp, h, legs, sPt, cfg) {
    cfg = cfg || CONFIG;
    if (side !== 'out') return { ok: false, conds: null, pattern: null, why: ['IN_NA'], idx: null };
    const conds = { a: false, b: false, c: false, d: false, e: false }, why = [];
    const hw = legs && legs[h], steps = (hw && hw.steps) || [];
    const adj = legs && legs[h + 1];
    // (e) 補助：直後の一般道 leg に tollInfo なし、かつ「有料区間」の step なし（不変）
    conds.e = !!adj && !adj.tollPresent && !(adj.tollSteps > 0);
    if (!steps.length) { why.push('NO_STEPS'); if (!conds.e) why.push('e'); return { ok: false, conds, pattern: null, why, idx: null }; }
    // (a) 出口操作 step の特定：到着 step（最後の 1 つ）を除いた最後の RAMP_*／FORK_*
    const xi = exitStepIndex(steps); // @M10
    conds.a = xi >= 0;
    if (!conds.a) { why.push('NO_EXIT_STEP', 'a', 'b', 'c', 'd'); if (!conds.e) why.push('e'); return { ok: false, conds, pattern: null, why, idx: null }; }
    const st = steps[xi];
    // (b) 操作：RAMP_*／FORK_*、かつその step より後（到着 step を除く）に「有料区間」注記の step がない
    const tollAfter = steps.slice(xi + 1, steps.length - 1).some(x => toll区間(x.text));
    conds.b = EXIT_STEP_MANEUVERS.indexOf(st.maneuver || '') >= 0 && !tollAfter;
    if (tollAfter) why.push('TOLL_AFTER');
    // (c) 位置：操作地点（step の始点）と予定ランプの分流点の距離・他の分流点との区別・最初の 50 m の進行方位
    const pts = [];
    if (st.polyline) { try { st.polyline.length && pts.push.apply(pts, decodePolyline(st.polyline)); } catch (e) { why.push('STEP_POLY_INVALID'); } }
    const p0 = pts.length ? pts[0] : st.start, dv = gi.nodes.get(mainNodeIdOf(ramp));
    if (p0 && dv) {
      const dX = haversineM(p0, dv);
      const near = dX <= cfg.NAME_DIV_NEAR_M;
      const clear = divergeClear(gi, ramp, p0, dX, cfg); // @M11
      const hd = startHeading(pts, cfg.NAME_HEAD_M);
      const headOk = hd !== null && isNum(ramp.via_heading) && angDiff(hd, ramp.via_heading) <= cfg.NAME_HEAD_DEG;
      conds.c = near && clear && headOk;
      if (!near) why.push('POS_NEAR');
      if (!clear) why.push('POS_OTHER');
      if (!headOk) why.push(pts.length < 2 && why.indexOf('STEP_POLY_INVALID') < 0 ? 'NO_STEP_POLYLINE' : 'HEAD');
    } else why.push(p0 ? 'POS_NEAR' : 'NO_STEP_POLYLINE');
    // (d) 名称（固定の文型表：OUT-1／OUT-2／OUT-3）
    const nm = gi.icName.get(ramp.ic_id) || '';
    const pat = nm ? nameOperand(st.text, 'out', nm) : null;
    conds.d = !!pat;
    const ok = conds.a && conds.b && conds.c && conds.d && conds.e; // @M8
    if (!ok) Object.keys(conds).forEach(k => { if (!conds[k]) why.push(k); });
    return { ok, conds, pattern: conds.d ? pat : null, why, idx: xi };
  }

  // ---------------------------------------------------------------- 1.1.1 診断（判定には一切使わない）
  // 診断が持ち出してよいのは、案内文・step の構造に対する検査の真偽（フラグ）、Routes API の列挙型 maneuver の名前、step の添字と件数、自社生成の理由コードだけ。
  // 案内文の文字列・座標・距離・秒・円は診断に入れない（v2.3 §3）。フラグ列は固定の文字（DIAG_FLAG_CHARS）だけで作る。
  const DIAG_VERSION = 'diag-1';
  const MANEUVER_ENUMS = Object.freeze(['MANEUVER_UNSPECIFIED', 'TURN_SLIGHT_LEFT', 'TURN_SHARP_LEFT', 'UTURN_LEFT', 'TURN_LEFT', 'TURN_SLIGHT_RIGHT', 'TURN_SHARP_RIGHT', 'UTURN_RIGHT', 'TURN_RIGHT',
    'STRAIGHT', 'RAMP_LEFT', 'RAMP_RIGHT', 'MERGE', 'FORK_LEFT', 'FORK_RIGHT', 'FERRY', 'FERRY_TRAIN', 'ROUNDABOUT_LEFT', 'ROUNDABOUT_RIGHT', 'DEPART', 'NAME_CHANGE']);
  /** 呼出ログ（テキスト）で leg ごとの maneuver 列を短く出すための略号。JSON は列挙名そのまま */
  const MANEUVER_ABBR = Object.freeze({
    MANEUVER_UNSPECIFIED: 'UN', TURN_SLIGHT_LEFT: 'SL', TURN_SHARP_LEFT: 'HL', UTURN_LEFT: 'UL', TURN_LEFT: 'TL', TURN_SLIGHT_RIGHT: 'SR', TURN_SHARP_RIGHT: 'HR', UTURN_RIGHT: 'UR', TURN_RIGHT: 'TR',
    STRAIGHT: 'ST', RAMP_LEFT: 'RL', RAMP_RIGHT: 'RR', MERGE: 'MG', FORK_LEFT: 'FL', FORK_RIGHT: 'FR', FERRY: 'FE', FERRY_TRAIN: 'FT', ROUNDABOUT_LEFT: 'OL', ROUNDABOUT_RIGHT: 'OR', DEPART: 'DP', NAME_CHANGE: 'NC', NONE: '-', OTHER: '??',
  });
  /** maneuver の値を、既知の列挙名・NONE（なし）・OTHER（未知の値）のどれかにする。未知の文字列は出さない */
  const maneuverCode = m => (m === null || m === undefined || m === '' ? 'NONE' : (MANEUVER_ENUMS.indexOf(m) >= 0 ? m : 'OTHER'));
  /** step ごとのフラグ文字（この順に並べる）：N=IC 名を含む／D=「出口」／I=「入口」／R=「ランプ」／J=「JCT」／T=「有料区間」／H=「方面」／W=IC 名（＋IC）の直後に空白をはさんで「出口」／V=同じく「入口」。何もなければ「.」 */
  const DIAG_FLAG_CHARS = 'NDIRJTHWV';
  const DIAG_WORDS = [['D', '出口'], ['I', '入口'], ['R', 'ランプ'], ['J', 'JCT'], ['T', '有料区間'], ['H', '方面']];
  const normText = x => String(x || '').normalize('NFKC');
  /** 案内文 text の構造フラグ。forms は NFKC 済みの IC 名の表記ゆれ（icNameForms）。戻り値は固定の文字だけ（案内文の断片を含まない） */
  function stepFlags(text, forms) {
    const t = normText(text);
    forms = forms || [];
    let s = '';
    if (forms.length && forms.some(f => t.indexOf(f) >= 0)) s += 'N';
    for (const w of DIAG_WORDS) if (t.indexOf(w[1]) >= 0) s += w[0];
    if (forms.length) {
      const alt = '(?:' + forms.map(reEsc).join('|') + ')(?:IC|インターチェンジ)?\\s+';
      if (new RegExp(alt + '出口').test(t)) s += 'W';
      if (new RegExp(alt + '入口').test(t)) s += 'V';
    }
    return s || '.';
  }
  const DIAG_LEG_REASONS = ['NO_STEPS', 'NO_EXIT_STEP', 'NO_STEP_POLYLINE', 'STEP_POLY_INVALID', 'POS_NEAR', 'POS_OTHER', 'HEAD', 'TOLL_AFTER', 'IN_NA'];
  /**
   * リスク境界 1 つぶんの診断。side: 'in'|'out'、ramp: 予定ランプ辺、h: 高速 leg の添字、legs: legsView の配列、ne: nameEvidence の結果（判定に使った値、または診断用に別に求めた同じ関数の値）。
   * 戻り値（すべて数・真偽・固定文字のみ）：
   *  hn 高速 leg の step 数／an 隣接一般道 leg（入口＝直前、出口＝直後）の step 数（なければ null）／ei E-name が見た step の末尾からの位置（0＝高速 leg の最後の step）。1.2.0：出口＝(a) の出口操作 step（到着 step の直前なら 1。見つからない・step がなければ null）、入口＝最初の step（構造の記録だけで E-name は評価しない）／
   *  mv その step の maneuver 列挙名（NONE＝なし、OTHER＝未知）／cd E-name の条件 a〜e のうち真のもの（なければ -）／
   *  nf IC 名を含む step が最初に現れる位置 { leg, step, tail }（route の全 leg を先頭から。なければ null）／pm 文型表（IN-1〜OUT-3）に一致した step（直前・高速・直後の leg、最大 8 件）[{ leg, step, p }]／
   *  pt E-name が見た step の文型表の結果（IN-1|IN-2|OUT-1|OUT-2|OUT-3|NONE）／cf 失敗区分（1.2.0：NO_STEPS|NO_EXIT_STEP〔(a)〕|TOLL_AFTER〔(b)〕|NO_STEP_POLYLINE|STEP_POLY_INVALID|POS_NEAR|POS_OTHER|HEAD〔(c)〕|IN_NA〔入口は評価しない〕 を + でつなぐ。失敗なしは OK）／
   *  hf 高速 leg の step ごとのフラグ列（カンマ区切り）／af 隣接一般道 leg の step ごとのフラグ列（なければ null）
   */
  function boundaryDiag(gi, side, ramp, h, legs, ne) {
    const nm = normText(gi.icName.get(ramp.ic_id) || '');
    const forms = nm ? icNameForms(nm) : [];
    const hw = legs && legs[h], steps = (hw && hw.steps) || [];
    const adj = legs && legs[side === 'in' ? h - 1 : h + 1], adjSteps = (adj && adj.steps) || [];
    const hn = steps.length, idx = !hn ? null : (side === 'in' ? 0 : (ne && isNum(ne.idx) ? ne.idx : null));   // 1.2.0：出口＝E-name が見た出口操作 step（なければ null）。入口＝最初の step（構造の記録だけ。E-name は評価しない）
    let nf = null;
    if (forms.length && legs) {
      for (let li = 0; li < legs.length && !nf; li++) {
        const ss = legs[li].steps || [];
        for (let si = 0; si < ss.length; si++) { const t = normText(ss[si].text); if (forms.some(f => t.indexOf(f) >= 0)) { nf = { leg: li, step: si, tail: ss.length - 1 - si }; break; } }
      }
    }
    const pm = [];
    if (nm && legs) {
      for (const li of [h - 1, h, h + 1]) {
        const ss = (legs[li] && legs[li].steps) || [];
        for (let si = 0; si < ss.length && pm.length < 8; si++) { const p = nameOperand(ss[si].text, side, nm); if (p) pm.push({ leg: li, step: si, p }); }
      }
    }
    const conds = (ne && ne.conds) || {}, why = (ne && ne.why) || [];
    const cdv = ['a', 'b', 'c', 'd', 'e'].filter(k => conds[k]).join('');
    const cfv = DIAG_LEG_REASONS.filter(x => why.indexOf(x) >= 0).join('+');
    return {
      hn, an: adj ? adjSteps.length : null, ei: idx === null ? null : hn - 1 - idx, mv: idx === null ? 'NONE' : maneuverCode(steps[idx].maneuver),
      cd: cdv || '-', nf, pm, pt: (ne && ne.pattern) || 'NONE', cf: cfv || 'OK',
      hf: steps.map(x => stepFlags(x.text, forms)).join(','), af: adj ? adjSteps.map(x => stepFlags(x.text, forms)).join(',') : null,
    };
  }
  /** 失敗検査コード（OKRATE・LENGTH・RAMP_COVER:辺ID など自社生成の文字列）。想定外の文字が混じるものは OTHER にする */
  const safeCode = x => (/^[A-Za-z0-9_.:@+\-]{1,80}$/.test(String(x)) ? String(x) : 'OTHER');
  /** 高速 leg の診断（非一致のときの内訳）：step 数 n・maneuver 列 mv（列挙名のカンマ区切り）・失敗した検査 fails（コードの配列。数値は含まない） */
  function highwayLegDiag(legs, h, iFails) {
    const steps = (legs && legs[h] && legs[h].steps) || null;
    return { n: steps ? steps.length : null, mv: steps ? steps.map(x => maneuverCode(x.maneuver)).join(',') : null, fails: (iFails || []).map(safeCode) };
  }
  /** 一般道 leg の SURF_TOLL の内訳：ti＝leg の tollInfo あり／ts＝「有料区間」を含む step の添字／n＝step 数 */
  function surfaceTollDiag(leg) {
    const steps = (leg && leg.steps) || [];
    const ts = [];
    steps.forEach((x, i) => { if (toll区間(x.text)) ts.push(i); });
    return { ti: !!(leg && leg.tollPresent), ts, n: steps.length };
  }
  // ---- 持ち出し・呼出ログ用の短いコード
  const nfCode = nf => (nf ? 'L' + nf.leg + 's' + nf.step + 't' + nf.tail : '-');
  /** 境界の診断 → 呼出ログの短いコード（'|' '/' を含まない） */
  function diagCode(d) {
    if (!d) return '';
    return '{hn=' + d.hn + ';an=' + (d.an === null ? '-' : d.an) + ';ei=' + (d.ei === null ? '-' : d.ei) + ';mv=' + d.mv + ';cd=' + d.cd + ';nf=' + nfCode(d.nf) +
      ';pm=' + (d.pm && d.pm.length ? d.pm.map(x => 'L' + x.leg + 's' + x.step + ':' + x.p).join('+') : '-') + ';pt=' + d.pt + ';cf=' + d.cf + ';hf=' + (d.hf || '-') + ';af=' + (d.af === null ? '-' : (d.af || '-')) + '}';
  }
  /** leg の診断（legDiag の 1 要素 { leg, type, … }）→ 短いコード。高速 leg：L1{n=12;f=OKRATE+LENGTH;mv=RL.ST…}／一般道 leg：L0{ti=1;ts=3.7;n=12} */
  function legDiagCode(d) {
    if (!d) return '';
    if (d.type === 'surface') return 'L' + d.leg + '{ti=' + (d.ti ? 1 : 0) + ';ts=' + ((d.ts && d.ts.length) ? d.ts.join('.') : '-') + ';n=' + (d.n === null || d.n === undefined ? '-' : d.n) + '}';
    return 'L' + d.leg + '{n=' + (d.n === null || d.n === undefined ? '-' : d.n) + ';f=' + ((d.fails && d.fails.length) ? d.fails.join('+') : '-') + ';mv=' + (d.mv ? d.mv.split(',').map(x => MANEUVER_ABBR[x] || '??').join('.') : '-') + '}';
  }

  /** 乗車の要求のうち via 点（V_on・V_fare…・V_off）の一覧 */
  function viaPointsOf(gi, ride) {
    const rp = ridePoints(gi, ride);
    return rp.error ? [] : rp.pts.filter(p => p.via);
  }

  /**
   * 乗車1回（高速 leg）の照合（v2.1 §5.4 の遵守検査 (i)〜(vii)＋対抗経路＋v2.3 の境界ごとの識別根拠）。legPts は leg ポリラインの [{lat,lng}]。
   * ctx（任意）：{ legs, h, diagAll }＝legsView の配列と高速 leg の添字（E-name の判定材料。なければ E-name は成立しない）。diagAll＝通常境界にも診断 diag を付ける（1.1.1、既定は付けない）
   */
  function matchRide(gi, ride, legPts, cfg, ctx) {
    cfg = cfg || CONFIG;
    const res = (verdict, reason, extra) => Object.assign({ verdict, reason }, extra || {});
    const path = ride.path;
    const edges = [];
    for (const eid of path) {
      const e = gi.edges.get(eid);
      if (!e) return res('判定不能', 'NOEDGE');
      edges.push(e);
    }
    const gaps = path.filter(id => gi.geomGap.has(id));
    if (gaps.length) return res('判定不能', 'GEOM_GAP:' + gaps.join('+'));            // 形状未確認区間を通る leg は照合しない（別枠）
    for (const e of edges) if (!edgeGeom(gi, e) && e.length_m > 0) return res('判定不能', 'NOGEOM');
    if (!Array.isArray(legPts) || legPts.length < 2) return res('判定不能', 'NO_POLYLINE');
    const nIn = gi.nodes.get(edges[0].from), nOut = gi.nodes.get(edges[edges.length - 1].to);
    const proj = projector(nIn.lat, nIn.lng);
    const legXY = legPts.map(p => proj(p.lat, p.lng));
    const rs = resample(legXY, cfg.SAMPLE_M, cfg.BEARING_WIN_M);
    if (rs.length < 5) return res('判定不能', 'POLY_SHORT');
    const samples = rs.samples, n = samples.length;
    const cache = new Map();
    const fitOf = eid => {
      if (cache.has(eid)) return cache.get(eid);
      const e = gi.edges.get(eid);
      const g = edgeGeom(gi, e) || [gi.nodes.get(e.from)];
      const f = fitEdge(proj, gi, e, g, samples, cfg);
      cache.set(eid, f);
      return f;
    };
    const I = scoreRef(path.map(fitOf), n, cfg);
    const refLen = path.reduce((a, eid) => a + fitOf(eid).len, 0);
    I.lenRatio = refLen > 0 ? rs.length / refLen : null;
    const sNode = proj(nIn.lat, nIn.lng), eNode = proj(nOut.lat, nOut.lng);
    I.startD = Math.hypot(legXY[0][0] - sNode[0], legXY[0][1] - sNode[1]);
    I.endD = Math.hypot(legXY[legXY.length - 1][0] - eNode[0], legXY[legXY.length - 1][1] - eNode[1]);

    const passCheck = (S, ids, withEnds) => {
      const fails = [];
      if (S.okRate < cfg.OK_RATE) fails.push('OKRATE');
      ids.forEach((eid, j) => {
        const c = S.cov[j];
        if (c === null) return;
        const e = gi.edges.get(eid);
        const isRamp = (j === 0 && e.kind === 'on_ramp') || (j === ids.length - 1 && e.kind === 'off_ramp');
        if (isRamp ? c < cfg.RAMP_COVER : c <= 0) fails.push((isRamp ? 'RAMP_COVER:' : 'EDGE_COVER:') + eid);
      });
      if (S.orderRate > cfg.ORDER_TOL) fails.push('ORDER');
      if (withEnds) {
        if (S.startD > cfg.END_M) fails.push('START');
        if (S.endD > cfg.END_M) fails.push('END');
        if (S.lenRatio === null || S.lenRatio < cfg.LEN_MIN || S.lenRatio > cfg.LEN_MAX) fails.push('LENGTH');
      }
      return fails;
    };
    // (vii) via 通過検査：要求した各 via 点を VIA_M 以内で通り、通過位置付近の進行方位が via_heading と VIA_ANG 以内
    const viaFails = [], viaFar = [];
    for (const vp of viaPointsOf(gi, ride)) {  // @M6
      const q = proj(vp.lat, vp.lng);
      const dv = polyDist(q, legXY);
      if (dv > cfg.VIA_M) { viaFails.push('VIA:' + vp.role + ':' + vp.edge); if (dv > cfg.FAR_M) viaFar.push('VIA:' + vp.role + ':' + vp.edge); continue; }
      if (vp.heading === undefined) continue;
      const okB = samples.some(s => Math.hypot(s.x - q[0], s.y - q[1]) <= cfg.VIA_M + cfg.SAMPLE_M / 2 && (s.brg === null || angDiff(s.brg, vp.heading) <= cfg.VIA_ANG));
      if (!okB) viaFails.push('VIA:' + vp.role + ':' + vp.edge + ':DIR');
    }
    const iFails = passCheck(I, path, true).concat(viaFails);
    const grpIn = groupAttribution(gi, edges[0], legPts[0], cfg), grpOut = groupAttribution(gi, edges[edges.length - 1], legPts[legPts.length - 1], cfg);
    const summary = () => ({
      n, dMed: r3(I.dMed), dP95: r3(I.dP95), okRate: r3(I.okRate), posRate: r3(I.posRate), bearMis: r3(I.bearMis), orderRate: r3(I.orderRate),
      minCov: r3(I.minCov), rampCov: [r3(I.cov[0]), r3(I.cov[I.cov.length - 1])], lenRatio: r3(I.lenRatio), startD: r3(I.startD), endD: r3(I.endD),
      fails: iFails.slice(), group: { in: grpIn, out: grpOut },
    });

    // 対抗経路との比較（leg 両端を結ぶ実現可能経路のみ）
    let alts = buildAlts(gi, path, cfg);
    alts = alts.slice(); // @M5
    const altRes = alts.map(a => {
      const ids = a.edges;
      const S = scoreRef(ids.map(fitOf), n, cfg);
      const onlyI = [], onlyA = [];
      path.forEach((eid, j) => { if (!ids.includes(eid)) onlyI.push(j); });
      ids.forEach((eid, j) => { if (!path.includes(eid)) onlyA.push(j); });
      const worst = (SS, idx) => { const v = idx.map(j => SS.cov[j]).filter(x => x !== null); return v.length ? Math.min.apply(null, v) : null; };
      const covI = worst(I, onlyI), covA = worst(S, onlyA);
      let rel = 'close', covGap = null;
      if (covI !== null && covA !== null) {
        covGap = covI - covA;
        if (covGap >= cfg.COV_GAP) rel = 'worse'; else if (-covGap >= cfg.COV_GAP) rel = 'better';
      }
      const bearGap = S.bearMis - I.bearMis;
      if (rel === 'close') { if (bearGap >= cfg.BEAR_GAP) rel = 'worse'; else if (-bearGap >= cfg.BEAR_GAP) rel = 'better'; }
      const aFails = passCheck(S, ids, false);
      return { type: a.type, equiv: !!a.equiv, rel, covGap: r3(covGap), bearGap: r3(bearGap), passes: aFails.length === 0, fails: aFails };
    });
    // 同値経路（SA/PA 側道を通る／通らない）は、取り違えの対抗ではなく同じ候補の走り方の違い。曖昧さ・取り違えの判定からは外す
    const cmpAlts = altRes.filter(a => !a.equiv), equivAlts = altRes.filter(a => a.equiv);
    const altStat = { worse: cmpAlts.filter(a => a.rel === 'worse').length, close: cmpAlts.filter(a => a.rel === 'close').length, better: cmpAlts.filter(a => a.rel === 'better').length, total: cmpAlts.length, equiv: equivAlts.length };
    const closest = cmpAlts.filter(a => a.rel !== 'worse').slice(0, 4).map(a => ({ type: a.type, rel: a.rel, covGap: a.covGap, bearGap: a.bearGap, passes: a.passes }));
    const hwDiag = highwayLegDiag(ctx && ctx.legs, ctx && ctx.h, iFails);            // 1.1.1 診断（判定には使わない）
    const out = (verdict, reason, bds) => Object.assign(res(verdict, reason), { score: Object.assign(summary(), { alts: altStat, closest, boundaries: bds || [] }), diag: hwDiag });

    // 予定の形状が基準を満たさなくても、同値経路（SA/PA を通らない走り方など）が満たし、残りの失敗が経路の差で説明できるもの（被覆・順序・適合率）だけなら同じ候補として受理する
    let equivUsed = null;
    if (iFails.length) {
      const eq = equivAlts.find(a => a.passes);
      const rest = iFails.filter(f => !(f === 'OKRATE' || f === 'ORDER' || f.startsWith('EDGE_COVER:')));
      if (eq && rest.length === 0) equivUsed = eq;
    }
    if (iFails.length === 0 || equivUsed) {
      const betterAlt = cmpAlts.find(a => a.rel === 'better' && a.passes);
      if (betterAlt) return out('不一致', 'COUNTER:' + betterAlt.type);
      const close = cmpAlts.filter(a => a.rel === 'close');
      if (close.length) return out('判定不能', 'AMBIGUOUS:' + Array.from(new Set(close.map(a => a.type))).join('+'));
      // 遵守検査に合格：境界ごとの識別根拠（v2.3 §1.2）。リスク境界に根拠がなければ判定不能（入口の根拠で出口を確認済みにしない）
      const bds = boundaryEvidence(gi, ride, edges, nIn, nOut, creditedOf(I, path.length), ctx, cfg);
      const unresolved = bds.filter(b => b.risk && b.status === 'unresolved'); // @M9
      if (unresolved.length) return out('判定不能', 'BOUNDARY_UNRESOLVED:' + unresolved.map(b => b.id).join('+'), bds);
      return out('一致', equivUsed ? 'OK_EQUIV:' + equivUsed.type : 'OK', bds);
    }
    // 遵守検査に不合格：対抗経路で説明できるか、予定形状から明確に外れているか、説明できないか
    const explain = cmpAlts.find(a => a.passes);
    if (explain) return out('不一致', 'COUNTER:' + explain.type);
    if (I.bearMis >= cfg.BEAR_GAP && I.posRate >= 0.5) return out('不一致', 'DIR');
    if (I.orderRate > cfg.ORDER_TOL) return out('不一致', 'ORDER');
    if (I.dMed !== null && I.dMed > cfg.FAR_M) return out('不一致', 'FAR');
    if (iFails.includes('START') || iFails.includes('END')) return out('不一致', iFails.filter(f => f === 'START' || f === 'END').join('+'));
    if (viaFar.length) return out('不一致', viaFar[0]);                        // 要求した via 点から FAR_M 超離れて通った（別の連絡路・別の道を走った）
    const viaDir = iFails.filter(f => /^VIA:.*:DIR$/.test(f));
    if (viaDir.length) return out('不一致', viaDir[0]);
    if (I.posRate >= cfg.EDGE_MISS_POS && iFails.some(f => f.startsWith('EDGE_COVER:'))) return out('不一致', iFails.find(f => f.startsWith('EDGE_COVER:')));
    const viaMiss = viaFails.filter(f => !/:DIR$/.test(f));
    if (viaMiss.length && I.posRate >= cfg.EDGE_MISS_POS) return out('不一致', viaMiss[0]);   // 形状の大半は予定どおりなのに要求した via 点を外した（別の連絡路などを走った）。全体が一様にずれている雑音(posRate が低い)は対象外
    return out('判定不能', 'UNEXPLAINED:' + iFails.slice(0, 3).join('+'));
  }
  /** scoreRef の iv（辺ごとの被覆に使った標本位置）から、入口ランプ（添字 0）と出口ランプ（最後）のものを取り出す */
  function creditedOf(I, m) { return { first: I.iv[0] || [], last: I.iv[m - 1] || [] }; }
  /**
   * 境界ごとの識別根拠（v2.3 §1.2）。リスク境界＝吸着リスク端点（gi.risk）を含む境界。
   * 戻り値：[{id:'S_in@辺ID'|'S_out@辺ID', side, ride辺, risk, status:'normal'|'geo'|'name'|'unresolved', via:'E-geo'|'E-name'|null, pattern, geo:{available,cover,uniqueM}, name:{conds,why}}]
   */
  function boundaryEvidence(gi, ride, edges, nIn, nOut, cred, ctx, cfg) {
    const hasLegs = !!(ctx && ctx.legs);
    const mk = (side, ramp, sPt, creditedT) => {
      const b = { id: (side === 'in' ? 'S_in@' : 'S_out@') + ramp.id, side, edge: ramp.id, risk: gi.risk.has(ramp.id), status: 'normal', via: null, pattern: null, geo: null, name: null, diag: null };
      const diagOf = ne => (hasLegs ? boundaryDiag(gi, side, ramp, ctx.h, ctx.legs, ne || nameEvidence(gi, side, ramp, ctx.h, ctx.legs, sPt, cfg)) : null);   // 1.1.1 診断。判定には使わない
      if (!b.risk) { if (ctx && ctx.diagAll) b.diag = diagOf(null); return b; }
      b.geo = egeoCover(gi, ramp, creditedT, cfg);
      if (b.geo.ok) { b.status = 'geo'; b.via = 'E-geo'; b.diag = diagOf(null); return b; }
      const ne = hasLegs ? nameEvidence(gi, side, ramp, ctx.h, ctx.legs, sPt, cfg) : { ok: false, conds: null, pattern: null, why: ['NO_STEPS'] };
      b.name = { ok: ne.ok, conds: ne.conds, why: ne.why };
      if (ne.ok) { b.status = 'name'; b.via = 'E-name'; b.pattern = ne.pattern; } else b.status = 'unresolved';
      if (hasLegs) b.diag = diagOf(ne);
      return b;
    };
    return [mk('in', edges[0], nIn, cred.first), mk('out', edges[edges.length - 1], nOut, cred.last)];
  }

  /** 一般道接続区間（leg[2k]）の照合：端点が前出口・次入口の一般道側端点から END_M 以内、料金・有料区間ステップなし */
  function matchSurface(gi, cand, idx, leg, cfg) {
    cfg = cfg || CONFIG;
    const n = cand.rides.length;
    const startNode = idx === 0 ? null : gi.nodes.get(gi.edges.get(cand.rides[idx / 2 - 1].off).to);
    const endNode = idx === 2 * n ? null : gi.nodes.get(gi.edges.get(cand.rides[idx / 2].on).from);
    const res = (verdict, reason) => ({ index: idx, type: 'surface', ride: null, verdict, reason });
    let pts = null;
    if (leg.polyline) { try { pts = decodePolyline(leg.polyline); } catch (e) { return res('判定不能', 'POLY_INVALID'); } }
    if (!pts || pts.length < 1) {
      if (startNode && endNode && haversineM(startNode, endNode) <= cfg.SURF_ZERO_M) return res('一致', 'ZERO_LEN');   // 長さ0の一般道区間（出口と次の入口が同一点）
      return res('判定不能', 'NO_POLYLINE');
    }
    const d0 = startNode ? haversineM(pts[0], startNode) : null, d1 = endNode ? haversineM(pts[pts.length - 1], endNode) : null;
    const r = (v, why) => Object.assign(res(v, why), { startD: r3(d0), endD: r3(d1) });
    if (d0 !== null && d0 > cfg.END_M) return r('不一致', 'SURF_START');
    if (d1 !== null && d1 > cfg.END_M) return r('不一致', 'SURF_END');
    const surfToll = leg.tollPresent || leg.tollSteps > 0;           // @M3
    if (surfToll) return Object.assign(r('判定不能', 'SURF_TOLL'), { diag: surfaceTollDiag(leg) });      // 1.1.1 診断：leg の tollInfo／「有料区間」を含む step の添字
    return r('一致', 'OK');
  }

  /** 候補全体の照合：全 leg 一致→一致、1 leg でも不一致→不一致、それ以外→判定不能 */
  function matchCandidate(gi, cand, legs, cfg, dopts) {
    cfg = cfg || CONFIG;
    const n = cand.rides.length, expected = 2 * n + 1;
    if (!Array.isArray(legs) || legs.length !== expected) {
      return { verdict: '判定不能', reasons: ['LEGS:' + (legs ? legs.length : 0) + '/' + expected], legs: [] };
    }
    const results = [];
    for (let i = 0; i < expected; i++) {
      if (i % 2 === 0) { results.push(matchSurface(gi, cand, i, legs[i], cfg)); continue; }
      const ride = cand.rides[(i - 1) / 2];
      let pts = null, r;
      if (legs[i].polyline) { try { pts = decodePolyline(legs[i].polyline); } catch (e) { r = { verdict: '判定不能', reason: 'POLY_INVALID' }; } }
      if (!r) r = matchRide(gi, ride, pts, cfg, { legs, h: i, diagAll: !!(dopts && dopts.diagAll) });
      results.push(Object.assign({ index: i, type: 'highway', ride: (i - 1) / 2 }, r));
    }
    const verdict = results.some(x => x.verdict === '不一致') ? '不一致' : results.every(x => x.verdict === '一致') ? '一致' : '判定不能';
    const reasons = results.filter(x => x.verdict !== '一致').map(x => 'L' + x.index + ':' + x.reason);
    const boundaries = [];
    results.forEach(x => { if (x.type === 'highway' && x.score && x.score.boundaries) x.score.boundaries.forEach(b => boundaries.push(Object.assign({ ride: x.ride }, b))); });
    return { verdict, reasons, legs: results, boundaries };
  }

  // ================================================================ 1.3.0 分割評価（検証専用。計画 v2.5.1 §2.3。engine の判定は変えない）
  let trunkCache = null;
  function trunkComps(gi) {
    if (trunkCache && trunkCache.gi === gi) return trunkCache.list;
    const list = gi.graph.edges.filter(isTrunkEdge).map(x => ({ id: x.id, g: edgeGeom(gi, x) })).filter(x => x.g && x.g.length >= 2);
    trunkCache = { gi, list };
    return list;
  }
  /** 点 pt から本線・JCT 連絡路の形状までの最短距離（m） */
  function distToTrunk(gi, pt) {
    const proj = projector(pt.lat, pt.lng);
    return compDist([0, 0], projectComps(trunkComps(gi), proj), -1);
  }
  /** 折れ線の先頭（fromEnd=false）または末尾（true）から m [m] の部分 */
  function polyPart(pts, m, fromEnd) {
    const a = fromEnd ? pts.slice().reverse() : pts;
    const out = [a[0]];
    let acc = 0;
    for (let i = 1; i < a.length; i++) {
      const L = haversineM(a[i - 1], a[i]);
      if (acc + L >= m) { const t = L > 0 ? (m - acc) / L : 0; out.push({ lat: a[i - 1].lat + (a[i].lat - a[i - 1].lat) * t, lng: a[i - 1].lng + (a[i].lng - a[i - 1].lng) * t }); break; }
      out.push(a[i]); acc += L;
    }
    return fromEnd ? out.reverse() : out;
  }
  function polyBearing(pts) {
    if (!pts || pts.length < 2) return null;
    const a = pts[0], b = pts[pts.length - 1];
    if (haversineM(a, b) < 1) return null;
    const proj = projector(a.lat, a.lng), q = proj(b.lat, b.lng);
    let d = Math.atan2(q[0], q[1]) * 180 / Math.PI; if (d < 0) d += 360;
    return d;
  }
  function samplesAlong(pts, step) {
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const L = haversineM(pts[i - 1], pts[i]), n = Math.max(1, Math.ceil(L / step));
      for (let k = 1; k <= n; k++) out.push({ lat: pts[i - 1].lat + (pts[i].lat - pts[i - 1].lat) * k / n, lng: pts[i - 1].lng + (pts[i].lng - pts[i - 1].lng) * k / n });
    }
    return out;
  }
  /** 接続検査 J（v2.5.1 §2.3）：(i) 境目 ≤CONN_GAP_M (ii) 方位差 ≤CONN_DIR_DEG (iii) 一般道側が本線・JCT 連絡路から CONN_HWY_M 超（同じ IC のランプは対象外：正しい進入も落ちるため。高速から来た場合は A で検出）(iv) E-geo なしの吸着リスク端点でない */
  function connCheck(gi, ramp, side, prevPts, nextPts, cfg) {
    cfg = cfg || CONFIG;
    if (!prevPts || prevPts.length < 2 || !nextPts || nextPts.length < 2) return { ok: false, code: 'CONN_NOPOLY' };
    if (gi.risk.has(ramp.id) && !uniqueSections(gi, ramp, cfg).length) return { ok: false, code: 'CONN_RISK' };
    const gap = haversineM(prevPts[prevPts.length - 1], nextPts[0]);
    if (!(gap <= cfg.CONN_GAP_M)) return { ok: false, code: 'CONN_GAP' };
    const b0 = polyBearing(polyPart(prevPts, cfg.CONN_WIN_M, true)), b1 = polyBearing(polyPart(nextPts, cfg.CONN_WIN_M, false));
    if (b0 !== null && b1 !== null && angDiff(b0, b1) > cfg.CONN_DIR_DEG) return { ok: false, code: 'CONN_DIR' };
    const surf = side === 'in' ? polyPart(prevPts, cfg.CONN_HWY_WIN_M, true) : polyPart(nextPts, cfg.CONN_HWY_WIN_M, false);
    if (samplesAlong(surf, 5).some(p => distToTrunk(gi, p) <= cfg.CONN_HWY_M)) return { ok: false, code: 'CONN_HWY' };
    return { ok: true, code: 'OK' };
  }
  /** 1.3.1（v2.5.3）確認できたゼロ区間：形状 1 点以上で全点 1 m 以内・距離 0（省略含む）・所要 0 秒・step の始終点 1 m 以内。欠落・空・短い非ゼロ区間は該当しない */
  function isZeroSection(leg, pts) {
    if (!leg || !Array.isArray(pts) || pts.length < 1) return false;
    if (!pts.every(p => haversineM(p, pts[0]) <= 1)) return false;
    if (!leg.distanceZero) return false;
    if (leg.durationSec !== 0) return false;
    if (Array.isArray(leg.steps) && leg.steps.some(st => st.start && st.end && haversineM(st.start, st.end) > 1)) return false;
    return true;
  }
  /** ゼロ区間の境目：① 高速区間の端↔点 ② 点↔出発地／目的地、ともに CONN_GAP_M 以内（(iv) は呼出側） */
  function connZero(hwEnd, zeroPt, terminal, cfg) {
    if (!hwEnd || !zeroPt || !terminal) return { ok: false, code: 'CONN_NOPOLY' };
    if (!(haversineM(hwEnd, zeroPt) <= cfg.CONN_GAP_M) || !(haversineM(zeroPt, terminal) <= cfg.CONN_GAP_M)) return { ok: false, code: 'CONN_GAP' };
    return { ok: true, code: 'OK_ZERO' };
  }
  /** 時間差の検査 C：分割合計 splitSec と全旅程 fullSec の差が max(SPLIT_TIME_MIN_SEC, fullSec×SPLIT_TIME_FRAC) 以内 */
  function splitTimeOk(splitSec, fullSec, cfg) {
    cfg = cfg || CONFIG;
    if (!isNum(splitSec) || !isNum(fullSec)) return null;
    return Math.abs(splitSec - fullSec) <= Math.max(cfg.SPLIT_TIME_MIN_SEC, fullSec * cfg.SPLIT_TIME_FRAC);
  }
  /** 分割評価（乗車 1 回・3 区間）の検査 A・B・D・J1・J2 と判定。session（所要合計・S1 料金）は非列挙でセッション内のみ */
  function evalSplit(gi, cand, secs, dep0Ms, cfg, cond) {
    cfg = cfg || CONFIG;
    const out = { A: null, B: null, D: null, J1: null, J2: null, verdict: '判定不能', reasons: [] };
    Object.defineProperty(out, 'session', { value: { durationSec: null, s1Jpy: null, s1TollState: null }, enumerable: false, writable: true });
    if (!cand || !cand.rides || cand.rides.length !== 1) { out.reasons.push('SPLIT_RIDES'); return out; }
    if (!Array.isArray(secs) || secs.length !== 3 || secs.some(x => !x || x.error || !Array.isArray(x.sectionLegs) || x.sectionLegs.length !== 1)) { out.reasons.push('SPLIT_INCOMPLETE'); return out; }
    const L0 = secs[0].sectionLegs[0], L1 = secs[1].sectionLegs[0], L2 = secs[2].sectionLegs[0];
    const ride = cand.rides[0], on = gi.edges.get(ride.on), off = gi.edges.get(ride.off);
    // 一般道区間（S0・S2）：端点の位置と料金（A）
    const s0 = matchSurface(gi, cand, 0, L0, cfg), s2 = matchSurface(gi, cand, 2, L2, cfg);
    const tollFail = [];
    if (s0.reason === 'SURF_TOLL' || secs[0].contaminated) tollFail.push('S0');
    if (s2.reason === 'SURF_TOLL' || secs[2].contaminated) tollFail.push('S2');
    out.A = { ok: tollFail.length === 0, code: tollFail.length ? 'SPLIT_SURF_TOLL:' + tollFail.join('+') : 'OK' };
    if (!out.A.ok) out.reasons.push('A:' + out.A.code);
    [['S0', s0], ['S2', s2]].forEach(([k, r]) => { if (r.verdict === '不一致') out.reasons.push(k + ':' + r.reason); else if (r.verdict === '判定不能' && r.reason !== 'SURF_TOLL') out.reasons.push(k + ':' + r.reason); });
    // 時刻の引継ぎ（B）
    const d0 = secs[0].durationSec, d1 = secs[1].durationSec, d2 = secs[2].durationSec;
    const sp = i => secs[i].split || {};
    const bOk = isNum(dep0Ms) && isNum(d0) && isNum(d1) && sp(0).departureMs === dep0Ms && sp(1).departureMs === dep0Ms + Math.round(d0 * 1000) && sp(2).departureMs === dep0Ms + Math.round((d0 + d1) * 1000);
    out.B = { ok: !!bOk, code: bOk ? 'OK' : 'SPLIT_CARRY' };
    if (!bOk) out.reasons.push('B:SPLIT_CARRY');
    // 高速区間（S1）の照合（D）：全旅程の高速 leg と同じ照合。E-name の「隣の一般道 leg」には S2 を渡す
    let pts1 = null, d;
    try { pts1 = L1.polyline ? decodePolyline(L1.polyline) : null; } catch (e) { d = { verdict: '判定不能', reason: 'POLY_INVALID' }; }
    if (!d) d = matchRide(gi, ride, pts1, cfg, { legs: [L1, L2], h: 0 });
    out.D = { verdict: d.verdict, code: d.reason };
    if (d.verdict !== '一致') out.reasons.push('D:' + d.reason);
    // 境目の接続（J1・J2）
    let p0 = null, p2 = null;
    try { p0 = L0.polyline ? decodePolyline(L0.polyline) : null; p2 = L2.polyline ? decodePolyline(L2.polyline) : null; } catch (e) { /* CONN_NOPOLY */ }
    // 1.3.1：ゼロ区間は (iv) の後に ①②（cond が無ければ特例なし）
    const riskNoGeo = ramp => gi.risk.has(ramp.id) && !uniqueSections(gi, ramp, cfg).length;
    const z0 = !!(cond && cond.origin) && isZeroSection(L0, p0), z2 = !!(cond && cond.destination) && isZeroSection(L2, p2);
    out.J1 = z0 ? (riskNoGeo(on) ? { ok: false, code: 'CONN_RISK' } : connZero(pts1 && pts1[0], p0[0], cond.origin, cfg)) : connCheck(gi, on, 'in', p0, pts1, cfg);
    out.J2 = z2 ? (riskNoGeo(off) ? { ok: false, code: 'CONN_RISK' } : connZero(pts1 && pts1[pts1.length - 1], p2[0], cond.destination, cfg)) : connCheck(gi, off, 'out', pts1, p2, cfg);
    if (!out.J1.ok) out.reasons.push('J1:' + out.J1.code);
    if (!out.J2.ok) out.reasons.push('J2:' + out.J2.code);
    const bad = s0.verdict === '不一致' || s2.verdict === '不一致' || d.verdict === '不一致';
    const good = out.A.ok && s0.verdict === '一致' && s2.verdict === '一致' && d.verdict === '一致' && out.J1.ok && out.J2.ok;
    out.verdict = bad ? '不一致' : good ? '一致' : '判定不能';
    out.session = { durationSec: isNum(d0) && isNum(d1) && isNum(d2) ? d0 + d1 + d2 : null, s1Jpy: secs[1].toll && secs[1].toll.state === 'priced' ? secs[1].toll.jpy : null, s1TollState: secs[1].toll ? secs[1].toll.state : null };
    return out;
  }

  // ================================================================ 応答の解釈（REST 応答 → engine の内部形式）
  const JCT_RE = /[^\s　、。（）()「」\/]{1,15}JCT/g;
  const IC_RE = /[^\s　、。（）()「」\/]{1,15}(?:IC|ＩＣ|インターチェンジ)/g;
  function legsView(route) {
    return (Array.isArray(route.legs) ? route.legs : []).map(lg => {
      const steps = Array.isArray(lg && lg.steps) ? lg.steps : [];
      let tollSteps = 0;
      const jct = [], ic = [], stepView = [];
      const ll = x => (x && x.latLng && isNum(x.latLng.latitude) && isNum(x.latLng.longitude) ? { lat: x.latLng.latitude, lng: x.latLng.longitude } : null);
      for (const st of steps) {
        const text = (st && st.navigationInstruction && st.navigationInstruction.instructions) || '';
        stepView.push({
          text, maneuver: (st && st.navigationInstruction && st.navigationInstruction.maneuver) || null,
          polyline: (st && st.polyline && st.polyline.encodedPolyline) || null, start: ll(st && st.startLocation), end: ll(st && st.endLocation),
        });
        if (text.indexOf('有料区間') >= 0) tollSteps++;
        (text.match(JCT_RE) || []).forEach(x => { if (jct.indexOf(x) < 0) jct.push(x); });
        (text.match(IC_RE) || []).forEach(x => { if (ic.indexOf(x) < 0) ic.push(x); });
      }
      const ti = parseTollInfo(lg && lg.travelAdvisory && lg.travelAdvisory.tollInfo);
      return {
        polyline: lg && lg.polyline && lg.polyline.encodedPolyline,
        durationSec: parseDuration(lg && lg.duration), distanceM: Number(lg && lg.distanceMeters) || null,
        distanceZero: !!lg && (lg.distanceMeters === undefined || lg.distanceMeters === null || Number(lg.distanceMeters) === 0),   // 1.3.1：proto3 JSON では 0 は省略される
        tollPresent: ti.present, tollStatus: ti.present ? ti.status : 'none', tollJpy: ti.status === 'priced' ? ti.jpy : null,
        tollSteps, jct, ic, steps: stepView,
      };
    });
  }
  function rideNames(gi, cand) {
    return cand.rides.map(r => {
      const on = gi.edges.get(r.on), off = gi.edges.get(r.off);
      const jct = [];
      r.path.forEach(eid => { const e = gi.edges.get(eid); if (e && e.jct && e.jct.name && jct.indexOf(e.jct.name) < 0) jct.push(e.jct.name); });
      return { on: (gi.icName.get(on.ic_id) || on.ic_id) + (on.dir ? '(' + on.dir + ')' : ''), off: (gi.icName.get(off.ic_id) || off.ic_id) + (off.dir ? '(' + off.dir + ')' : ''), jct };
    });
  }

  /** 200 応答の本文 → 内部形式。q は engine の要求、req は buildRequest の結果 */
  function interpret(gi, q, req, json, cfg, flags) {
    flags = flags || {};
    const route = json.routes[0];
    const durationSec = parseDuration(route.duration);
    const legs = legsView(route);
    const fallback = json.fallbackInfo !== undefined && json.fallbackInfo !== null;
    const toll = classifyToll(route, {
      tollsRequested: req.tollsRequested, fieldMaskHasToll: req.fieldMaskHasToll, http: 200, expectedLegs: req.expectedLegs,
      fallback, durationSec, ignoreSurfaceTollInfo: !!flags.ignoreSurfaceTollInfo,
    });
    const condition = fallback ? 'fallback' : '要求充足';
    const out = {
      toll: { state: toll.state }, condition, fullTripFare: toll.fullTripFare, fallback,
    };
    if (durationSec !== undefined) out.durationSec = durationSec;
    if (toll.state === 'priced') out.toll.jpy = toll.jpy;
    const meta = {
      distanceM: Number(route.distanceMeters) || null,
      legs: legs.map(l => ({ durationSec: l.durationSec === undefined ? null : l.durationSec, distanceM: l.distanceM, toll: l.tollStatus, tollJpy: l.tollJpy, tollSteps: l.tollSteps })),
      fullTripRule: toll.rule, legSumJpy: toll.legSumJpy, legCompare: toll.legCompare, tollNotes: toll.notes, prereq: toll.prereq,
      fallback: fallback ? { routingMode: json.fallbackInfo.routingMode || null, reason: json.fallbackInfo.routingModeReason || null } : null,
      apiNames: { jct: Array.from(new Set([].concat(...legs.map(l => l.jct)))), ic: Array.from(new Set([].concat(...legs.map(l => l.ic)))) },
    };
    if (q.kind === 'full') {
      const cand = q.candidate;
      out.timeDependency = timeDependencyOf(gi, cand, flags.timeDependency);
      const m = matchCandidate(gi, cand, legs, cfg, { diagAll: !!(q.inject && q.inject.diagAll) });
      out.match = m.verdict;
      meta.match = { verdict: m.verdict, reasons: m.reasons, legs: m.legs.map(l => ({ i: l.index, type: l.type, verdict: l.verdict, reason: l.reason, score: l.score, startD: l.startD, endD: l.endD, diag: l.diag || null })), boundaries: m.boundaries };
      meta.names = rideNames(gi, cand);
      if (flags.keepPolyline) meta.polylines = legs.map(l => l.polyline || null);
    } else if (q.kind === 'split') {
      const surface = q.section % 2 === 0;
      out.sectionType = surface ? 'surface' : 'highway';
      out.contaminated = surface && (toll.state !== 'free' || legs.some(l => l.tollPresent || l.tollSteps > 0));
      out.match = null;
      Object.defineProperty(out, 'sectionLegs', { value: legs, enumerable: false });   // 1.3.0：分割評価の検査（evalSplit）用。セッション内のみ（列挙されないので JSON・持ち出しに出ない）
      if (flags.keepPolyline) meta.polylines = legs.map(l => l.polyline || null);
    } else {
      out.match = null; out.timeDependency = 'なし';
    }
    out.meta = meta;
    return out;
  }

  // ================================================================ HTTP 分類（§5.3）
  function errDetails(json) {
    const e = json && typeof json === 'object' ? json.error : null;
    if (!e || typeof e !== 'object') return { status: '', message: '', reasons: [], metas: [] };
    const det = Array.isArray(e.details) ? e.details : [];
    return {
      status: String(e.status || ''), message: String(e.message || ''),
      reasons: det.map(d => d && d.reason).filter(Boolean).map(String),
      metas: det.map(d => d && d.metadata).filter(m => m && typeof m === 'object'),
    };
  }
  /** raw: { status, json, text } または { netError: 'timeout'|'abort'|'network', message }。戻り値 { ok:true } か { ok:false, error, ... } */
  function classifyHttp(raw) {
    if (raw.netError) {
      const code = raw.netError === 'timeout' ? 'TIMEOUT' : 'NETWORK';
      return { ok: false, error: code, retryable: true, fatal: false, reason: raw.netError, message: raw.message || raw.netError };
    }
    const s = raw.status, d = errDetails(raw.json);
    const msg = d.message || String(raw.text || '').slice(0, 200);
    if (s === 200) {
      const j = raw.json;
      if (!j || typeof j !== 'object') return { ok: false, error: 'BAD_RESPONSE', retryable: false, fatal: false, reason: 'NOT_JSON', message: 'JSON として解釈できない' };
      if (!Array.isArray(j.routes) || !j.routes.length) return { ok: false, error: 'BAD_RESPONSE', retryable: false, fatal: false, reason: 'NO_ROUTES', message: 'routes が空（応答不備）' };
      return { ok: true };
    }
    const mk = (error, extra) => Object.assign({ ok: false, error, retryable: ['TRANSIENT', 'NETWORK', 'SERVER', 'TIMEOUT', 'UNAVAILABLE'].includes(error), fatal: error === 'AUTH_DENIED' || error === 'DAILY_LIMIT', reason: d.reasons.join(',') || d.status || String(s), message: msg }, extra || {});
    if (d.reasons.some(r => AUTH_REASONS.includes(r)) || s === 401 || s === 403 || d.status === 'PERMISSION_DENIED' || d.status === 'UNAUTHENTICATED') return mk('AUTH_DENIED');
    if (s === 429 || d.status === 'RESOURCE_EXHAUSTED') {
      // 429 の details の形は未確認（わからない）：既定は日次上限として停止（費用保護）。分あたりを示す値があれば一時的な制限として再試行
      const perMin = d.metas.some(m => Object.keys(m).some(k => /quota/i.test(k) && /per.?min|PerMinute|\/min|分/i.test(String(m[k]))));
      return perMin ? mk('TRANSIENT') : mk('DAILY_LIMIT');
    }
    if (s === 400) return mk('INVALID_ARGUMENT');
    if (s === 408) return mk('TIMEOUT');
    if (s >= 500 && s <= 599) return mk('SERVER');
    return mk('HTTP_ERROR');
  }

  // ================================================================ 二重上限（§5.4）
  function createLimiter(o) {
    o = o || {};
    const now = o.now || (() => Date.now());
    const sessionMax = o.sessionMax === undefined ? CONFIG.SESSION_MAX : o.sessionMax;
    const dailyMax = o.dailyMax === undefined ? CONFIG.DAILY_MAX : o.dailyMax;
    const key = o.storageKey || 'rf7_daily';
    const storage = o.storage || null;
    let session = 0, memDaily = { date: null, count: 0 };
    const readDaily = () => {
      const today = jstDate(now());
      let rec = null;
      if (storage) { try { const t = storage.getItem(key); rec = t ? JSON.parse(t) : null; } catch (e) { rec = null; } }
      if (!rec) rec = memDaily;
      if (!rec || rec.date !== today) rec = { date: today, count: 0 };
      return rec;
    };
    const writeDaily = rec => {
      memDaily = rec;
      if (storage) { try { storage.setItem(key, JSON.stringify(rec)); } catch (e) { /* 保存不可でもメモリ側で数える */ } }
    };
    return {
      sessionMax, dailyMax,
      status() { const d = readDaily(); return { session, sessionMax, daily: d.count, dailyMax, date: d.date }; },
      /** n 回送信できるか（実行前の確認ダイアログ用）。B=23 の検索は 1 セッション 2 件まで（60÷23） */
      preflight(n) {
        const st = this.status();
        if (st.session + n > sessionMax) return { ok: false, reason: 'SESSION', limit: 'session', status: st };
        if (st.daily + n > dailyMax) return { ok: false, reason: 'DAILY', limit: 'daily', status: st };
        return { ok: true, status: st };
      },
      /** 送信直前に1回ぶんを確保。上限を超えるなら確保せず ok:false */
      take() {
        const d = readDaily();
        if (session + 1 > sessionMax) return { ok: false, limit: 'session', status: { session, sessionMax, daily: d.count, dailyMax } };
        if (d.count + 1 > dailyMax) return { ok: false, limit: 'daily', status: { session, sessionMax, daily: d.count, dailyMax } };
        session++; d.count++; writeDaily(d);
        return { ok: true, status: { session, sessionMax, daily: d.count, dailyMax } };
      },
      resetSession() { session = 0; },
    };
  }

  // ================================================================ mock の既定値（engine 試験の決定的模擬の移植）
  function mockValue(q, o) {
    o = o || {};
    const seed = o.seed || 'rf7';
    const r = k => fnv(seed + ':' + k + ':' + (q.candidateId || '') + ':g' + q.generation) / 4294967296;
    if (q.kind === 'base') return { durationSec: o.baseSec || 4800, toll: { state: 'free' }, match: null, condition: '要求充足', timeDependency: 'なし', fullTripFare: true };
    if (q.kind === 'split') return { durationSec: 600, toll: { state: 'free' }, match: null, condition: '要求充足', sectionType: q.section % 2 === 0 ? 'surface' : 'highway', contaminated: false };
    const min = 45 + Math.floor(r('t') * 30), jpy = Math.floor(r('c') * 300) * 10;
    const v = { durationSec: min * 60, toll: jpy === 0 ? { state: 'free' } : { state: 'priced', jpy }, match: '一致', condition: '要求充足', timeDependency: 'なし', fullTripFare: true };
    if (o.faults !== false) {
      const m = r('m'); v.match = m < 0.85 ? '一致' : m < 0.93 ? '不一致' : '判定不能';
      const c = r('k'); v.condition = c < 0.9 ? '要求充足' : c < 0.96 ? 'fallback' : '通行条件未確認';
      const t = r('s'); if (t < 0.05) v.toll = { state: 'unknown' }; else if (t < 0.07) v.toll = { state: 'unverified' };
      const d = r('d'); v.timeDependency = d < 0.6 ? 'なし' : d < 0.8 ? '時刻依存' : '未確認';
      if (r('f') < 0.06) v.fullTripFare = false;
    }
    return v;
  }

  // ================================================================ 退化乗車（v2.2 §3）
  /** R1：同一 IC・同一方向で入って出る乗車（path に jct_link なし）。5a の評価対象外。純関数（アプリ層・adapter・検証側が同じ述語を使う） */
  function isR1Ride(gi, ride) {
    const on = gi.edges.get(ride.on), off = gi.edges.get(ride.off);
    if (!on || !off) return false;
    return on.ic_id === off.ic_id && on.dir === off.dir && !(ride.path || []).some(id => { const e = gi.edges.get(id); return e && e.kind === 'jct_link'; });
  }
  /** 候補のうち R1 に当たる乗車の添字 */
  function r1Rides(gi, cand) { const out = []; (cand.rides || []).forEach((r, i) => { if (isR1Ride(gi, r)) out.push(i); }); return out; }
  /** R2（観測のみ）：前の乗車の出口 IC・方向と次の乗車の入口 IC・方向が同じ乗り直し */
  function hasR2(gi, cand) {
    const rs = cand.rides || [];
    for (let k = 0; k + 1 < rs.length; k++) {
      const off = gi.edges.get(rs[k].off), on = gi.edges.get(rs[k + 1].on);
      if (off && on && off.ic_id === on.ic_id && off.dir === on.dir) return true;
    }
    return false;
  }
  /**
   * アプリ層の分離：列挙結果から R1 を含む候補を除いた enumeration（engine.createSearch の enumeration にそのまま渡せる）と、表示用の件数を返す。
   * R2 は分離しない（件数だけ観測）。元の enumeration は変更しない。enumeration.stats.candidates など列挙の値はそのまま残し、stats.separated に分離後の件数を併記する。
   * graphOrGi：グラフ（JSON）または indexGraph の結果
   */
  function partitionDegenerate(graphOrGi, enumeration) {
    const gi = graphOrGi && graphOrGi.edges instanceof Map ? graphOrGi : indexGraph(graphOrGi);
    const kept = [], separated = [];
    let r2 = 0;
    for (const c of enumeration.candidates) {
      const idx = r1Rides(gi, c);
      if (idx.length) separated.push({ id: c.id, rides: idx }); else kept.push(c);
      if (hasR2(gi, c)) r2++;
    }
    const info = { enumerated: enumeration.candidates.length, r1: separated.length, kept: kept.length, r2Observed: r2 };
    const stats = Object.assign({}, enumeration.stats, { separated: info });
    return { enumeration: Object.assign({}, enumeration, { candidates: kept, stats }), separated, counts: info };
  }

  // ================================================================ createAdapter
  /**
   * opts:
   *  graph（必須）、mode: 'mock'|'replay'|'live'（setMode で切替可）、now、
   *  live: fetch（fetch 互換関数）、getKey（呼出時にキー文字列を返す。adapter は保存しない）、timeoutMs
   *  replay: 関数 (q, keys)=>raw | オブジェクト（キー→raw または関数）。raw は {status,json} | {netError,message}
   *  mock: { seed, baseSec, faults:false, valueFor:(q)=>内部形式 }
   *  limiter（createLimiter の結果）、keepPolyline（既定 false）、cfg（閾値の上書き。通常は使わない）
   */
  function createAdapter(opts) {
    opts = opts || {};
    const gi = indexGraph(opts.graph);
    const cfg = Object.assign({}, CONFIG, opts.cfg || {});
    const now = opts.now || (() => Date.now());
    let mode = opts.mode || 'mock';
    const limiter = opts.limiter || createLimiter({ now });
    const state = { search: null, expired: false, splitMemo: new Map(), log: [], counters: { sent: 0, simulated: 0, blockedExpired: 0, blockedLimit: 0, rejectedV1: 0, rejectedDegenerate: 0 } };
    const flags = { keepPolyline: !!opts.keepPolyline, ignoreSurfaceTollInfo: false, timeDependency: opts.timeDependency };

    function replayKeys(q) {
      const base = [q.searchId, q.kind, q.candidateId || '', q.attempt || '', q.section === undefined || q.section === null ? '' : q.section].join('|');
      return [base + '|g' + q.generation, base];
    }
    async function sendLive(req, q) {
      const key = typeof opts.getKey === 'function' ? opts.getKey() : null;
      if (!key) return { netError: 'nokey', message: 'APIキー未設定' };
      if (typeof opts.fetch !== 'function') return { netError: 'network', message: 'fetch が注入されていない' };
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      let timedOut = false, injected = false;
      const timers = [];
      if (ctrl) {
        timers.push(setTimeout(() => { timedOut = true; ctrl.abort(); }, opts.timeoutMs || cfg.TIMEOUT_MS));
        if (q.inject && isNum(q.inject.abortAfterMs)) timers.push(setTimeout(() => { injected = true; ctrl.abort(); }, q.inject.abortAfterMs));
      }
      const init = { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': req.fieldMask }, body: JSON.stringify(req.body) };
      if (ctrl) init.signal = ctrl.signal;
      let resp, text;
      try {
        resp = await opts.fetch(cfg.URL, init);
        text = await resp.text();
      } catch (e) {
        timers.forEach(clearTimeout);
        const aborted = e && e.name === 'AbortError';
        return { netError: timedOut ? 'timeout' : (aborted && injected ? 'abort' : 'network'), message: scrubText((e && e.message) || e, [key]) };
      }
      timers.forEach(clearTimeout);
      let json = null;
      try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
      return { status: resp.status, json, text: scrubText(text, [key]).slice(0, 400) };
    }
    function lookupReplay(q) {
      const keys = replayKeys(q);
      let raw;
      if (typeof opts.replay === 'function') raw = opts.replay(q, keys);
      else if (opts.replay && typeof opts.replay === 'object') { for (const k of keys) { if (opts.replay[k] !== undefined) { raw = opts.replay[k]; break; } } }
      if (typeof raw === 'function') raw = raw(q);
      return raw === undefined ? { fixtureMissing: keys[0] } : raw;
    }

    async function api(q) {
      const t0 = now();
      const mkMeta = extra => Object.assign({ mode, sent: false, http: null, ms: 0, deadline: null }, extra || {});
      const done = res => { state.log.push({ kind: q.kind, candidateId: q.candidateId || null, mode, error: res.error || null }); return res; };
      let carry = 0;
      if (q.kind === 'split') {
        const mk = q.searchId + '|' + q.generation + '|' + q.candidateId;
        const memo = state.splitMemo.get(mk) || [];
        for (let i = 0; i < q.section; i++) carry += memo[i] || 0;
        if (q.section === 0) state.splitMemo.set(mk, []);
      }
      // R1（同一IC・同方向で入って出る乗車）を含む候補は送信しない（アプリ層の分離の安全網。予算は engine 側で 1 回消費、上限カウンタは消費しない）
      if ((q.kind === 'full' || q.kind === 'split') && q.candidate && Array.isArray(q.candidate.rides)) {
        const dg = r1Rides(gi, q.candidate);
        if (dg.length) { // @M7
          state.counters.rejectedDegenerate++;
          return done({ error: 'DEGENERATE', message: '退化候補（同一IC・同方向で入って出る乗車）は 5a の評価対象外', retryable: false, fatal: false, meta: mkMeta({ stage: 'DEGENERATE', degenerate: { r1Rides: dg } }) });
        }
      }
      const req = buildRequest(gi, q, { carrySec: carry, omitTollInfo: !!(q.inject && q.inject.omitTollInfo), vehicleStopover: !!(q.inject && q.inject.vehicleStopover), avoidTolls: !!(q.inject && q.inject.avoidTolls), cfg });
      if (!req.ok) { state.counters.rejectedV1++; return done({ error: req.error, message: req.message, meta: mkMeta({ stage: 'V1' }) }); }
      const reqMeta = { points: compactPoints(req.points), intermediates: req.intermediates, expectedLegs: req.expectedLegs, departureTime: req.departureTime, modifiers: req.modifiers, fieldMaskHasToll: req.fieldMaskHasToll, tollsRequested: req.tollsRequested, variant: req.variant, vehicleStopover: req.vehicleStopover };
      // V5：各送信の直前に出発時刻の期限を確認。期限切れは送信せず停止
      const dl = checkDeadline(req.departureTime, now(), cfg.DEADLINE_MARGIN_SEC);
      if (state.expired || !dl.ok) {
        state.expired = true; state.counters.blockedExpired++;
        if (state.search && state.search.searchId === q.searchId) state.search.stopped = 'EXPIRED';
        return done({ error: 'EXPIRED', message: '指定出発時刻が過去になった', meta: mkMeta({ stage: 'V5', deadline: dl, request: reqMeta }) });
      }
      let raw;
      if (mode === 'mock') {
        state.counters.simulated++;
        const v = (opts.mock && opts.mock.valueFor) ? opts.mock.valueFor(q) : mockValue(q, opts.mock);
        const res = Object.assign({}, v);
        if (res.error) return done(Object.assign(res, { meta: mkMeta({ deadline: dl, request: reqMeta }) }));
        res.meta = Object.assign({}, v.meta || {}, mkMeta({ deadline: dl, request: reqMeta, simulated: true, names: q.kind === 'full' ? rideNames(gi, q.candidate) : undefined }));
        return done(res);
      }
      if (mode === 'replay') {
        state.counters.simulated++;
        raw = lookupReplay(q);
        if (raw && raw.fixtureMissing) return done({ error: 'FIXTURE_MISSING', message: '模擬応答が見つからない：' + raw.fixtureMissing, meta: mkMeta({ deadline: dl, request: reqMeta, simulated: true }) });
      } else {
        const tk = limiter.take();
        if (!tk.ok) {
          state.counters.blockedLimit++;
          return done({ error: 'DAILY_LIMIT', message: tk.limit === 'session' ? 'セッション上限に到達' : '日次上限に到達', meta: mkMeta({ stage: 'LIMIT', limit: tk.limit, limiter: tk.status, deadline: dl, request: reqMeta }) });
        }
        state.counters.sent++;
        raw = await sendLive(req, q);
      }
      const ms = now() - t0;
      const meta0 = mkMeta({ sent: mode === 'live', simulated: mode !== 'live', http: raw.status === undefined ? null : raw.status, ms, deadline: dl, request: reqMeta });
      if (mode === 'live' && raw.netError === 'nokey') return done({ error: 'AUTH_DENIED', message: raw.message, meta: meta0 });
      const cls = classifyHttp(raw);
      if (!cls.ok) {
        const key = typeof opts.getKey === 'function' ? opts.getKey() : null;
        return done({ error: cls.error, message: scrubText(cls.message, [key]), meta: Object.assign(meta0, { reason: cls.reason }) });
      }
      let res;
      try { res = interpret(gi, q, req, raw.json, cfg, flags); } catch (e) { return done({ error: 'BAD_RESPONSE', message: '応答の解釈に失敗：' + String((e && e.message) || e), meta: meta0 }); }
      res.meta = Object.assign(res.meta, meta0);
      if (q.kind === 'split') res.split = { section: q.section, carrySec: carry, departureMs: req.departureMs };   // 1.3.0：時刻引継ぎの検査 B 用（自社の要求値）
      if (q.kind === 'split' && typeof res.durationSec === 'number') {
        const mk = q.searchId + '|' + q.generation + '|' + q.candidateId;
        const memo = state.splitMemo.get(mk) || [];
        memo[q.section] = res.durationSec; state.splitMemo.set(mk, memo);
      }
      return done(res);
    }

    const verifyRecords = [];
    /** 検証専用呼出（engine 非経由。基準なし・ランキング対象外）。記録は verifyRecords に残す */
    async function callVerify(q) {
      const qq = Object.assign({ searchId: 'verify', generation: 1 }, q);
      const res = await api(qq);
      const rec = { seq: verifyRecords.length, label: q.label || null, kind: qq.kind, candidateId: qq.candidateId || null, section: qq.section === undefined ? null : qq.section, fetchedAt: now(), ok: !res.error, failReason: res.error || null, response: res };
      verifyRecords.push(rec);
      return rec;
    }
    return {
      api, callVerify, verifyRecords, graphIndex: gi, limiter, cfg, state,
      get mode() { return mode; },
      setMode(m) { if (['mock', 'replay', 'live'].indexOf(m) < 0) throw new Error('mode は mock|replay|live'); mode = m; },
      /** 検索を結ぶ：期限切れのとき search.stopped を 'EXPIRED' にする（engine は無改変のまま、以降の呼出を止められる） */
      bind(search) { state.search = search; state.expired = false; },
      /** 出発時刻更新（新世代）の後に呼ぶ：期限切れの停止を解除する */
      onDepartureUpdated(search) { state.expired = false; if (search && search.stopped === 'EXPIRED') search.stopped = null; },
      /** 実行前の確認ダイアログ用 */
      preflight(B) { return limiter.preflight(B); },
      setFlag(k, v) { flags[k] = v; },
      keyless() { return true; },
    };
  }

  // ================================================================ 記録（セッション内 exportSearch）と持ち出し（rf7-5a/3：結果コピー・JSON）
  //  exportSearch ……… セッション内（メモリ上）の完全な記録。Google 由来の所要秒・料金・照合の数値を含む。verify_rank（セッション内の独立再計算）が読む。持ち出さない。
  //  carryOut ………… 持ち出し用（結果コピー・JSON）。v2.3 §3：検証合否・理由コード・自社生成情報・最小限の試験集計だけ。Google 由来の数値・文言とその区分値は含めない。
  const FORMAT = 'rf7-5a/3';
  const giCache = new WeakMap();
  function giFor(graph) { let g = giCache.get(graph); if (!g) { g = indexGraph(graph); giCache.set(graph, g); } return g; }
  function slimCandidate(c) {
    return {
      id: c.id, n: c.n, intermediates: c.intermediates, fareCount: c.fareCount, restrictionUnresolved: !!c.restrictionUnresolved,
      seeded: !!c.seeded, estSec: r3(c.estSec), estTollJpy: c.estTollJpy, divKey: c.divKey,
      rides: c.rides.map(r => ({ on: r.on, off: r.off, fare: r.fare.slice() })),
    };
  }
  /**
   * 1 検索ぶんの記録（セッション内）。主ランキングの独立再計算（verify_rank）に必要な項目（各候補の比較条件・料金状態・時間・照合結果・世代・searchId）を store から読める形で出す。
   * 維持する項目：searchId・generation・generations[{generation,condKey}]・candidates[{id,rides[{on,off,fare}],restrictionUnresolved}]・store[{seq,searchId,generation,condKey,kind,candidateId,retry,ok,response{durationSec,toll{state,jpy},match,condition,fullTripFare,fallback}}]
   * ctx: { engine（RFEngine。VERSION・DEFAULTS 用）, label, kind: 'free'|'designated', includeAllCandidates }
   */
  function exportSearch(search, rep, ctx) {
    ctx = ctx || {};
    const en = search.enumeration, o = search.options;
    const used = new Set(search.store.map(r => r.candidateId).filter(Boolean));
    (rep.main || []).concat(rep.beyondTop || [], rep.others || []).forEach(x => used.add(x.id));
    const cands = en.candidates.filter(c => ctx.includeAllCandidates || used.has(c.id)).map(slimCandidate);
    const gens = {};
    search.store.forEach(r => { if (!gens[r.generation]) gens[r.generation] = { generation: r.generation, condKey: r.condKey }; });
    const exp = {
      searchId: search.searchId, label: ctx.label || null, kind: ctx.kind || 'free', generation: search.generation,
      cond: clone(search.cond),
      generations: Object.keys(gens).map(k => gens[k]),
      options: { budget: o.budget, maxRetries: o.maxRetries, topN: o.topN, maxLabels: o.maxLabels, maxMs: o.maxMs, directSlots: o.directSlots, seedIcCount: o.seedIcCount, pointsPerRide: o.pointsPerRide, maxIntermediates: o.maxIntermediates, profile: o.profile },
      enumStats: { complete: en.complete, truncated: en.truncated, candidates: en.stats.candidates, byRides: en.stats.byRides, labelsCreated: en.stats.labelsCreated, labelsExpanded: en.stats.labelsExpanded, elapsedMs: en.stats.elapsedMs, seedRegistered: en.stats.seed ? en.stats.seed.registered : null, separated: en.stats.separated ? clone(en.stats.separated) : null },
      budget: { B: search.budget.B, used: search.budget.used, retriesUsed: search.budget.retriesUsed, waitsMs: search.budget.waitsMs.slice() },
      stopped: search.stopped || null,
      candidates: cands,
      store: search.store.map(r => ({
        seq: r.seq, searchId: r.searchId, generation: r.generation, condKey: r.condKey, kind: r.kind, candidateId: r.candidateId, attempt: r.attempt, slot: r.slot,
        section: r.section, sections: r.sections, retry: r.retry, fetchedAt: r.fetchedAt, method: r.method, ok: r.ok, failReason: r.failReason,
        response: clone(r.response),
      })),
      rank: {
        status: rep.status, baseOk: rep.baseOk, baseReason: rep.baseReason, baseMin: rep.baseMin, enumerated: rep.enumerated, enumComplete: rep.enumComplete,
        attempted: rep.attempted, evaluated: rep.evaluated, unevaluated: rep.unevaluated, comparable: rep.comparable, unverified: rep.unverified,
        main: (rep.main || []).map(x => ({ id: x.id, C: x.C, Tmin: x.Tmin, savingMin: x.savingMin, yenPerMin: x.yenPerMin, td: x.td, generation: x.generation, recSeq: x.recSeq })),
        beyondTop: (rep.beyondTop || []).map(x => ({ id: x.id, C: x.C, Tmin: x.Tmin, savingMin: x.savingMin, yenPerMin: x.yenPerMin, td: x.td, generation: x.generation, recSeq: x.recSeq })),
        others: (rep.others || []).map(x => ({ id: x.id, reasons: x.reasons.slice(), durationSec: x.durationSec || null, comparable: !!x.comparable })),
        pending: (rep.pending || []).map(x => ({ id: x.id, reason: x.reason })),
        direct: rep.direct ? { population: rep.direct.population, reps: rep.direct.reps.slice() } : null,
        prioritized: !!rep.prioritized, lines: (rep.lines || []).slice(),
      },
      graphInfo: graphInfo(giFor(search.graph)),
    };
    Object.defineProperty(exp, '_graph', { value: search.graph, enumerable: false });     // 持ち出し用の生成（carryOut）が使う。JSON には出ない
    return exp;
  }

  // ---------------------------------------------------------------- 理由コードの表示名（持ち出し・セッション表示共通）
  const REASON_LABEL = {
    BOUNDARY_UNRESOLVED: '吸着リスク端点の走行道路を確認できない', GEOM_GAP: '形状未確認区間', SURF_TOLL: '一般道区間に有料の記録', DEGENERATE: '退化候補（同一IC・同方向で入って出る乗車）',
    AMBIGUOUS: '対抗経路と識別できない', UNEXPLAINED: '予定経路と一致せず他でも説明できない', COUNTER: '対抗経路の方が良く説明する',
    LEGS: 'legs 数が期待と異なる', NO_POLYLINE: 'polyline なし', POLY_INVALID: 'polyline が壊れている',
  };
  /** 'L1:BOUNDARY_UNRESOLVED:S_in@x' → 'L1:BOUNDARY_UNRESOLVED:S_in@x（吸着リスク端点の走行道路を確認できない）' */
  function reasonWithLabel(code) {
    const m = /^L\d+:([A-Z_]+)/.exec(code) || /^([A-Z_]+)/.exec(code);
    const lab = m && REASON_LABEL[m[1]];
    return lab ? code + '（' + lab + '）' : code;
  }
  /** engine の別枠理由「経路を確認できず（照合：判定不能）」を、照合理由コードに応じて具体的な文言にする。料金の金額は入れない */
  function refineReasons(reasons, matchReasons) {
    const codes = (matchReasons || []).map(c => (/^L\d+:([A-Z_]+)/.exec(c) || [])[1]).filter(Boolean);
    const uniq = Array.from(new Set(codes));
    let why = null;
    if (uniq.length && uniq.every(c => c === 'GEOM_GAP')) why = '形状未確認区間';
    else if (uniq.length && uniq.every(c => c === 'BOUNDARY_UNRESOLVED')) why = REASON_LABEL.BOUNDARY_UNRESOLVED;
    return reasons.map(r => {
      let t = r.replace('（API評価失敗：DEGENERATE）', '（退化候補：同一IC・同方向で入って出る乗車は5aの評価対象外）');
      if (why && t.indexOf('経路を確認できず（照合：判定不能）') >= 0) t = t.replace('経路を確認できず（照合：判定不能）', '経路を確認できず（照合：' + why + '）');
      return t;
    });
  }
  /** セッション内表示用：engine の表示文言のうち EXPIRED の素の表示を日本語に直し、別枠の各行に理由コードを足す（金額の注記を含む。持ち出しには使わない） */
  function decorateLines(exp) {
    const L = exp.rank.lines.map(l => l.replace('評価停止：EXPIRED。以降のAPI評価を行っていません', '評価停止：指定出発時刻が過去になった。新しい検索を実行するか、出発時刻を更新してください').replace('（EXPIRED）', '（指定出発時刻が過去）'));
    const recOf = id => {
      let r = null;
      exp.store.forEach(x => { if (x.candidateId === id && x.kind === 'full' && x.generation === exp.generation && x.ok) r = x; });
      return r;
    };
    const idx = L.indexOf('別枠（主ランキング外）：');
    if (idx < 0) return L;
    exp.rank.others.forEach((x, i) => {
      const line = idx + 1 + i;
      if (line >= L.length) return;
      const r = recOf(x.id), m = r && r.response && r.response.meta;
      const notes = [];
      if (m) {
        if (m.tollNotes && m.tollNotes.length) m.tollNotes.forEach(n => notes.push(n));
        if (m.fullTripRule === 'γ') notes.push('全体／区間不整合');
        if (m.match && m.match.verdict !== '一致' && m.match.reasons.length) notes.push('照合理由 ' + m.match.reasons.map(reasonWithLabel).join(','));
      }
      L[line] = L[line].replace('（API評価失敗：DEGENERATE）', '（退化候補：同一IC・同方向で入って出る乗車は5aの評価対象外）');
      if (m && m.match && m.match.verdict !== '一致') {
        const refined = refineReasons(['経路を確認できず（照合：判定不能）'], m.match.reasons)[0];
        L[line] = L[line].replace('経路を確認できず（照合：判定不能）', refined);
      }
      if (notes.length) L[line] = L[line] + '〔' + notes.join('／') + '〕';
    });
    return L;
  }

  // ---------------------------------------------------------------- 持ち出し用（v2.3 §3）
  const CARRY_FORBIDDEN_KEYS = Object.freeze(['durationSec', 'distanceM', 'distanceMeters', 'duration', 'jpy', 'tollJpy', 'legSumJpy', 'polyline', 'polylines', 'encodedPolyline', 'instructions', 'navigationInstruction',
    'steps', 'legs', 'response', 'meta', 'score', 'estimatedPrice', 'estimatedPrices', 'latitude', 'longitude', 'C', 'Tmin', 'savingMin', 'yenPerMin', 'baseMin', 'estSec', 'estTollJpy',
    'dMed', 'dP95', 'okRate', 'posRate', 'bearMis', 'orderRate', 'minCov', 'rampCov', 'lenRatio', 'startD', 'endD', 'covGap', 'bearGap', 'cover', 'uniqueM', 'remainSec']);
  /** 持ち出し用オブジェクトに Google 由来の数値項目が紛れていないかの検査。違反のキー経路の配列を返す（空なら合格）。lat/lng のキーは検索条件 cond（利用者が決めた出発地・目的地）の中だけ許す */
  function checkCarryClean(obj) {
    const bad = [];
    const walk = (v, path, inCond) => {
      if (Array.isArray(v)) { v.forEach((x, i) => walk(x, path + '[' + i + ']', inCond)); return; }
      if (v && typeof v === 'object') {
        for (const k of Object.keys(v)) {
          const p = path + '.' + k;
          if (CARRY_FORBIDDEN_KEYS.indexOf(k) >= 0) bad.push(p);
          else if ((k === 'lat' || k === 'lng') && !inCond) bad.push(p);
          else if (k === 'diag' || k === 'legDiag') diagViolations(v[k], p).forEach(x => bad.push(x));
          walk(v[k], p, inCond || k === 'cond');
        }
      }
    };
    walk(obj, '$', false);
    return bad;
  }
  /**
   * 1.1.1 診断（diag・legDiag）の形の検査：値は 非負の整数（9999 以下）・真偽・null・[A-Za-z0-9_.,:@+=-] だけの文字列・それらの配列・オブジェクトに限る。
   * 日本語・空白・記号類を含む文字列（＝案内文の断片）や小数（＝座標・距離・秒）、DIAG_KEYS にないキーは違反。違反のキー経路の配列を返す
   */
  const DIAG_KEYS = Object.freeze(['hn', 'an', 'ei', 'mv', 'cd', 'nf', 'pm', 'pt', 'cf', 'hf', 'af', 'leg', 'step', 'tail', 'p', 'type', 'n', 'fails', 'ti', 'ts']);
  function diagViolations(v, path) {
    const bad = [];
    const walk = (x, p) => {
      if (x === null || typeof x === 'boolean') return;
      if (typeof x === 'number') { if (!(Number.isInteger(x) && x >= 0 && x <= 9999)) bad.push(p); return; }
      if (typeof x === 'string') { if (!/^[A-Za-z0-9_.,:@+=\-]{0,4000}$/.test(x)) bad.push(p); return; }
      if (Array.isArray(x)) { x.forEach((y, i) => walk(y, p + '[' + i + ']')); return; }
      if (typeof x === 'object') { for (const k of Object.keys(x)) { if (DIAG_KEYS.indexOf(k) < 0) bad.push(p + '.' + k); else walk(x[k], p + '.' + k); } return; }
      bad.push(p);
    };
    walk(v, path);
    return bad;
  }
  const rideLabel = (gi, r) => {
    const nmOf = id => { const e = gi.edges.get(id); return e ? (gi.icName.get(e.ic_id) || e.ic_id) + (e.dir ? '(' + e.dir + ')' : '') : id; };
    const via = r.fare.filter(f => f !== r.on && f !== r.off).map(f => { const e = gi.edges.get(f); return (e && (e.jct && e.jct.name ? e.jct.name : e.road)) || f; });
    const uniq = via.filter((v, i) => via.indexOf(v) === i);
    return nmOf(r.on) + '→' + nmOf(r.off) + (uniq.length ? '〔経由：' + uniq.join('・') + '〕' : '');
  };
  /** 1 検索ぶんの持ち出し用オブジェクト。exportSearch の戻り値（exp）と graph から作る。Google 由来の項目は一切コピーしない（ホワイトリスト方式） */
  function carryOut(exp, graph) {
    graph = graph || exp._graph;
    if (!graph) throw new Error('carryOut: graph が必要');
    const gi = giFor(graph);
    const candById = new Map(exp.candidates.map(c => [c.id, c]));
    const labelOf = id => { const c = candById.get(id); return c ? c.rides.map(r => rideLabel(gi, r)).join(' ／ ') : id; };
    const lastFull = new Map();
    exp.store.forEach(r => { if (r.kind === 'full' && r.generation === exp.generation) lastFull.set(r.candidateId, r); });
    const calls = exp.store.map(r => {
      const resp = r.response || {}, m = resp.meta || {}, mm = m.match || null, rq = m.request || null;
      const fareCodes = [];
      if (m.fullTripRule) fareCodes.push('RULE_' + m.fullTripRule);
      if (m.legCompare === 'mismatch') fareCodes.push('LEG_MISMATCH');
      if (m.legCompare === 'uncomparable') fareCodes.push('LEG_UNCOMPARABLE');
      if (m.prereq) Object.keys(m.prereq).filter(k => k !== 'duration' && k !== 'noFallback' && m.prereq[k] === false).forEach(k => fareCodes.push('PREREQ_' + k));
      return {
        seq: r.seq, kind: r.kind, slot: r.slot || null, candidateId: r.candidateId || null, attempt: r.attempt || null, section: r.section === undefined ? null : r.section, sections: r.sections === undefined ? null : r.sections,
        retry: !!r.retry, generation: r.generation, ok: !!r.ok, failReason: r.failReason || null,
        http: m.http === undefined ? null : m.http, sent: m.sent === undefined ? null : m.sent, mode: m.mode || r.method || null, ms: m.ms === undefined ? null : m.ms, deadlineOk: m.deadline ? !!m.deadline.ok : null,
        tollState: resp.toll ? resp.toll.state : null, fullTripFare: resp.fullTripFare === undefined ? null : !!resp.fullTripFare, fareCodes,
        condition: resp.condition || null, fallback: !!(m.fallback || resp.fallback), timeDependency: resp.timeDependency || null,
        match: resp.match === undefined ? null : resp.match,
        matchReasons: mm ? mm.reasons.slice() : [],
        boundaries: mm && mm.boundaries ? mm.boundaries.map(b => ({ ride: b.ride, id: b.id, side: b.side, risk: !!b.risk, status: b.status, via: b.via, pattern: b.pattern, name: b.name && b.name.conds ? b.name.conds : null, diag: b.diag ? clone(b.diag) : null })) : [],
        legDiag: mm ? mm.legs.filter(l => l.verdict !== '一致' && l.diag).map(l => Object.assign({ leg: l.i, type: l.type }, clone(l.diag))) : [],
        group: mm ? mm.legs.filter(l => l.score && l.score.group).map(l => ({ leg: l.i, in: l.score.group.in, out: l.score.group.out })) : [],
        request: rq ? { variant: rq.variant || 'V-a', vehicleStopover: !!rq.vehicleStopover, intermediates: rq.intermediates, expectedLegs: rq.expectedLegs, departureTime: rq.departureTime, points: rq.points } : null,
      };
    });
    const tally = { match: { 一致: 0, 不一致: 0, 判定不能: 0 }, boundary: { normal: 0, geo: 0, name: 0, unresolved: 0 }, reasons: {} };
    calls.forEach(c => {
      if (c.kind !== 'full' || !c.ok || c.generation !== exp.generation) return;
      if (c.match) tally.match[c.match] = (tally.match[c.match] || 0) + 1;
      c.boundaries.forEach(b => { tally.boundary[b.status] = (tally.boundary[b.status] || 0) + 1; });
      c.matchReasons.forEach(x => { const k = (/^L\d+:([A-Z_]+)/.exec(x) || [])[1] || x; tally.reasons[k] = (tally.reasons[k] || 0) + 1; });
    });
    const mainRow = (x, i) => {
      const r = lastFull.get(x.id), resp = r && r.response || {};
      return { pos: i + 1, id: x.id, label: labelOf(x.id), match: resp.match || null, tollState: resp.toll ? resp.toll.state : null, condition: resp.condition || null, timeDependency: resp.timeDependency || null };
    };
    const matchReasonsOf = id => { const r = lastFull.get(id); return r && r.ok && r.response.meta && r.response.meta.match ? r.response.meta.match.reasons : []; };
    const pendingBy = {};
    exp.rank.pending.forEach(p => { pendingBy[p.reason] = (pendingBy[p.reason] || 0) + 1; });
    return {
      searchId: exp.searchId, label: exp.label, kind: exp.kind, generation: exp.generation,
      cond: clone(exp.cond), generations: clone(exp.generations), options: clone(exp.options),
      enumStats: clone(exp.enumStats), budget: clone(exp.budget), stopped: exp.stopped,
      candidates: exp.candidates.map(c => ({ id: c.id, n: c.n, intermediates: c.intermediates, fareCount: c.fareCount, restrictionUnresolved: !!c.restrictionUnresolved, seeded: !!c.seeded, divKey: c.divKey, label: labelOf(c.id), rides: clone(c.rides) })),
      calls,
      rank: {
        status: exp.rank.status, baseOk: exp.rank.baseOk, baseReason: exp.rank.baseReason, enumerated: exp.rank.enumerated, enumComplete: exp.rank.enumComplete,
        attempted: exp.rank.attempted, evaluated: exp.rank.evaluated, unevaluated: exp.rank.unevaluated, comparable: exp.rank.comparable, unverified: exp.rank.unverified,
        main: exp.rank.main.map(mainRow), beyondTopIds: exp.rank.beyondTop.map(x => x.id),
        others: exp.rank.others.map(x => ({ id: x.id, label: labelOf(x.id), reasons: refineReasons(x.reasons, matchReasonsOf(x.id)), matchReasons: matchReasonsOf(x.id).map(reasonWithLabel) })),
        pendingByReason: pendingBy, direct: exp.rank.direct ? { population: exp.rank.direct.population, reps: exp.rank.direct.reps.slice() } : null, prioritized: !!exp.rank.prioritized,
      },
      tally,
    };
  }
  const yn = b => (b ? '1' : '0');
  /** 持ち出し用の呼出ログ 1 行（17 項目）。Google 由来の数値（所要秒・料金・距離・採点）は含めない */
  function callLogLine(c) {
    const slot = c.kind === 'split' ? ('s' + c.section + '/' + c.sections) : (c.slot || '-');
    const mt = c.match ? c.match + (c.matchReasons.length ? '[' + c.matchReasons.join(',') + ']' : '') : '-';
    const bd0 = c.boundaries.length ? c.boundaries.map(b => b.side + ':' + (b.risk ? 'R' : 'N') + ':' + b.status + (b.pattern ? '(' + b.pattern + ')' : '') + diagCode(b.diag)).join('/') : '';
    const ld = (c.legDiag || []).map(legDiagCode).join(' ');                       // 1.1.1：非一致 leg の内訳（SURF_TOLL・失敗検査）
    const bd = (bd0 && ld) ? bd0 + ' ' + ld : (bd0 || ld || '-');
    return [c.seq, c.kind, slot, c.candidateId || '-', c.attempt || '-', yn(c.retry), c.http === null ? (c.sent === false ? '未送信' : '-') : c.http, c.ms === null ? '-' : c.ms,
      c.deadlineOk === null ? '-' : (c.deadlineOk ? 'ok' : 'NG'), c.tollState || '-', c.fullTripFare === null ? '-' : (yn(c.fullTripFare) + (c.fareCodes.length ? '(' + c.fareCodes.join(',') + ')' : '')),
      mt, bd, c.condition || (c.failReason ? 'ERR:' + c.failReason : '-'), yn(c.fallback), c.timeDependency || '-', c.request ? (c.request.intermediates + (c.request.variant !== 'V-a' ? '/' + c.request.variant : '')) : '-'].join('|');
  }
  const CALL_LOG_HEADER = '呼出ログ（seq|kind|slot|候補ID|attempt|retry|HTTP|ms|期限確認|料金状態|全旅程料金(規則)|照合[理由]|境界(S_in/S_out:R=吸着リスク/N=通常:根拠{診断}と非一致legの内訳)|条件|fallback|時刻依存|点数/変種）';
  const DIAG_LEGEND = '診断凡例(1.1.1の形式。1.2.0でei・mv・cd・cfの意味を更新。案内文の文字列・座標・距離は含まない): 境界{hn=高速legのstep数;an=隣接一般道legのstep数;ei=E-nameが見たstepの末尾からの位置(0=最後,1=到着stepの直前。出口=出口操作step、入口=最初のstep);mv=そのstepのmaneuver列挙名;cd=E-name条件a〜eのうち真(入口は評価しない=-);nf=IC名を含む最初のstep(L=leg,s=添字,t=末尾からの位置);pm=文型表に一致したstep(leg,step:文型);pt=E-nameが見たstepの文型(NONE=不一致);cf=失敗区分(OK=失敗なし,NO_EXIT_STEP=出口操作stepなし,TOLL_AFTER=出口操作step以降に有料区間,POS_NEAR=分流点から遠い,POS_OTHER=他の分流点に近い,HEAD=方位不一致,IN_NA=入口は評価しない);hf/af=stepごとのフラグ(N=IC名 D=出口 I=入口 R=ランプ J=JCT T=有料区間 H=方面 W=IC名+空白+出口 V=IC名+空白+入口 .=なし)} ／非一致leg L<i>{n=step数;f=失敗した検査;mv=maneuver略号(RL=RAMP_LEFT RR=RAMP_RIGHT MG=MERGE FL/FR=FORK ST=STRAIGHT TL/TR=TURN 他はREADME)} ／一般道leg L<i>{ti=legのtollInfo有;ts=有料区間を含むstep添字;n=step数}';
  const ATTRIBUTION = '帰属: 経路・所要時間・料金は Google Maps（Routes API）による ／ Contains information from OpenStreetMap, which is made available here under the Open Database License (ODbL). © OpenStreetMap contributors ／ 『国土数値情報（高速道路時系列データ）』（国土交通省）を加工して作成 (CC BY 4.0)';
  const CARRY_NOTICE = '持ち出し範囲(v2.3 §3): この記録は検証合否・理由コード・自社生成情報・件数集計のみ。Google 由来の所要時間・料金・距離・案内文・経路形状・緯度経度（とその区分値）は含まない（画面表示はセッション中のみ）。保存の適法性を認定したものではない';

  function fmtCond(c) {
    return '(' + c.origin.lat.toFixed(5) + ',' + c.origin.lng.toFixed(5) + ') → (' + c.destination.lat.toFixed(5) + ',' + c.destination.lng.toFixed(5) + ') departureTime=' + c.departureTime + ' etc=' + (c.etc ? 'JP_ETC' : 'なし') + ' pref=' + c.routingPreference;
  }
  /** 持ち出し用の 1 検索の本文 */
  function formatSearchText(carry) {
    const L = [];
    L.push('■検索 ' + carry.searchId + (carry.label ? ' ' + carry.label : '') + ' ' + fmtCond(carry.cond) + ' 世代=' + carry.generation + ' 種別=' + (carry.kind === 'designated' ? '指定候補検索' : carry.kind === 'verify' ? '検証専用' : '通常'));
    const e = carry.enumStats;
    L.push(' 列挙: 候補' + e.candidates + ' complete=' + e.complete + ' truncated=' + e.truncated + ' 生成' + e.labelsCreated + ' 展開' + e.labelsExpanded + ' byRides ' + Object.keys(e.byRides || {}).map(k => k + ':' + e.byRides[k]).join(',') + ' elapsed ' + (e.elapsedMs / 1000).toFixed(2) + 's(端末)');
    if (e.separated) L.push(' 分離: 退化候補(R1:同一IC・同方向で入って出る乗車) ' + e.separated.r1 + '件を列挙結果から分離しAPI評価の対象外（残り' + e.separated.kept + '件）／R2(同一IC・同方向への乗り直し)は分離せず観測 ' + e.separated.r2Observed + '件');
    if (carry.rank.direct) L.push(' 直行代表: 母集団' + carry.rank.direct.population + '件 代表 ' + (carry.rank.direct.reps.join(' ／ ') || 'なし'));
    L.push(' ' + CALL_LOG_HEADER);
    carry.calls.forEach(c => L.push('  ' + callLogLine(c)));
    if (carry.calls.some(c => (c.legDiag && c.legDiag.length) || c.boundaries.some(b => b.diag))) L.push(' ' + DIAG_LEGEND);
    L.push(' 予算: used ' + carry.budget.used + '/' + carry.budget.B + ' retries ' + carry.budget.retriesUsed + ' waits [' + carry.budget.waitsMs.join(',') + ']' + (carry.stopped ? ' 停止=' + carry.stopped : ''));
    const t = carry.tally;
    L.push(' 検証集計(現世代の全旅程評価): 照合 一致' + t.match.一致 + '／不一致' + t.match.不一致 + '／判定不能' + t.match.判定不能 + ' ・境界 通常' + t.boundary.normal + '／E-geo' + t.boundary.geo + '／E-name' + t.boundary.name + '／未確認' + t.boundary.unresolved +
      ' ・理由 ' + (Object.keys(t.reasons).sort().map(k => k + ':' + t.reasons[k]).join(',') || 'なし'));
    const r = carry.rank;
    L.push(' 状態: ' + r.status + (r.baseOk ? '' : '（基準経路不成立：' + (r.baseReason || '未取得') + '）') + ' 列挙済み' + r.enumerated + ' 評価試行' + r.attempted + ' 評価済み' + r.evaluated + ' 比較可能' + r.comparable + ' 未検証' + r.unverified + ' 未評価' + r.unevaluated);
    L.push(' 主ランキング(順位と候補のみ。円/分・料金・所要時間・短縮分は含めない):');
    if (!r.main.length) L.push('  なし');
    r.main.forEach(x => L.push('  ' + x.pos + '. ' + x.id + ' ' + x.label + ' [照合:' + x.match + ' 料金:' + x.tollState + ' 条件:' + x.condition + (x.timeDependency && x.timeDependency !== 'なし' ? ' 時刻:' + x.timeDependency : '') + ']'));
    if (r.beyondTopIds.length) L.push(' 圏外(比較可能で順位6位以下): ' + r.beyondTopIds.length + '件');
    if (r.others.length) {
      L.push(' 別枠(主ランキング外):');
      r.others.forEach(x => L.push('  - ' + x.id + ' ' + x.label + '：' + x.reasons.join('／') + (x.matchReasons.length ? '〔照合理由 ' + x.matchReasons.join(',') + '〕' : '')));
    }
    const pk = Object.keys(r.pendingByReason);
    if (pk.length) L.push(' 未評価: ' + pk.reduce((a, k) => a + r.pendingByReason[k], 0) + '件（' + pk.map(k => k + ' ' + r.pendingByReason[k]).join('、') + '）');
    return L;
  }
  /** テストC（公式料金の人手照合）の記録欄：照合一致の全旅程評価ごとに 1 行。金額の記入欄は設けない（v2.3 §3）。Tak が端末画面で照合し「一致／不一致／照合不能」と理由だけを記入する */
  function testCRows(carry) {
    const rows = [];
    carry.calls.forEach(c => {
      if (c.kind !== 'full' || !c.ok || c.generation !== carry.generation || c.match !== '一致') return;
      const cand = carry.candidates.find(x => x.id === c.candidateId);
      rows.push(' 〔' + carry.searchId + '／' + c.candidateId + '〕出発 ' + carry.cond.departureTime + '｜' + (cand ? cand.label : '-') + '｜照合結果 □一致 □不一致 □照合不能｜理由 ＿＿');
    });
    return rows;
  }
  /** 持ち出し用の header（ホワイトリスト）。文字列・数値だけ */
  function carryHeader(h) {
    h = h || {};
    const o = {};
    ['app', 'engineVersion', 'engineSha', 'graphSha', 'graphLabel', 'apiMode', 'runAt', 'origin', 'ua', 'B', 'profile', 'opts', 'hook'].forEach(k => { if (h[k] !== undefined && (typeof h[k] === 'string' || typeof h[k] === 'number')) o[k] = h[k]; });
    o.adapter = VERSION;
    return o;
  }
  /**
   * 結果コピー全体（rf7-5a/3）。header: { app, engineVersion, engineSha, graphSha, graphLabel, apiMode, runAt, origin, ua, B, profile, hook }
   * searches: exportSearch の結果の配列（セッション内の完全な記録）。opts.graph：グラフ（exportSearch の戻り値を渡すときは省略可）、opts.withJson（既定 true）、opts.keys：除去するキー
   * 出力は carryOut を通した持ち出し用の内容だけ。Google 由来の数値項目が紛れていたら Error('CARRY_LEAK:…') を投げる
   */
  function formatReport(header, searches, opts) {
    opts = opts || {};
    const h = header || {};
    const graph = opts.graph || (searches[0] && searches[0]._graph);
    if (!graph) throw new Error('formatReport: opts.graph が必要（exportSearch の戻り値を渡すなら省略可）');
    const gInfo = graphInfo(giFor(graph));
    const carries = searches.map(exp => carryOut(exp, graph));
    const obj = { format: FORMAT, header: carryHeader(h), graph: gInfo, searches: carries };
    const leaks = checkCarryClean(obj);
    if (leaks.length) throw new Error('CARRY_LEAK:' + leaks.slice(0, 5).join(','));
    const L = [];
    L.push('RF7-5A | app ' + (h.app || '-') + ' | engine ' + (h.engineVersion || '-') + ' sha256=' + (h.engineSha || '-') + ' | adapter ' + VERSION + ' | graph sha256=' + (h.graphSha || '-') + ' (' + (h.graphLabel || '-') + ') | apiMode=' + (h.apiMode || '-') + ' | format ' + FORMAT);
    L.push('実行: ' + (h.runAt || '-') + ' | ' + (h.origin || '-') + ' | ' + (h.ua || '-') + ' | B=' + (h.B === undefined ? '-' : h.B) + ' profile=' + (h.profile || '-') + (h.opts ? ' ' + h.opts : '') + ' | 試験フック: ' + (h.hook || 'なし'));
    L.push(ATTRIBUTION);
    L.push(CARRY_NOTICE);
    L.push('グラフ側: ランプ群' + gInfo.groups + ' ／ 吸着リスク端点' + gInfo.riskEndpoints.length + '本(E-geo 固有区間あり ' + gInfo.riskEndpoints.filter(x => x.egeoAvailable).length + ') ／ 群内識別不能対' + gInfo.indistinctPairs.length + ' ／ geom_gap 辺' + gInfo.geomGapEdges.length + (gInfo.groupWarnings.length ? ' ／ 警告 ' + gInfo.groupWarnings.join(',') : ''));
    L.push(' 吸着リスク端点: ' + gInfo.riskEndpoints.map(x => x.name + '=' + x.id).join(' ／ '));
    carries.forEach(c => { formatSearchText(c).forEach(x => L.push(x)); });
    L.push('■テストC 記録欄（Tak が端末画面で公式料金と照合し、一致／不一致／照合不能と理由のみ記入。金額の記入欄はない）');
    carries.forEach(c => { testCRows(c).forEach(x => L.push(x)); });
    if (opts.withJson !== false) {
      L.push('■JSON（機械可読。持ち出し用 ' + FORMAT + '。Google 由来の数値・案内文・polyline は含まない）');
      L.push(JSON.stringify(obj));
    }
    return scrubText(L.join('\n'), opts.keys);
  }

  const api = {
    VERSION, CONFIG, FORMAT, FIELD_MASK, FIELD_MASK_NO_TOLL, TIME_DEPENDENCY, ATTRIBUTION, CALL_LOG_HEADER,
    decodePolyline, encodePolyline, haversineM, projector, resample, scrubText, fnv, yen,
    indexGraph, edgeGeom, buildRequest, compactPoints, checkDeadline,
    parseMoney, parseTollInfo, parseDuration, classifyToll, timeDependencyOf,
    buildAlts, matchRide, matchSurface, matchCandidate, legsView, interpret, rideNames,
    classifyHttp, createLimiter, mockValue, createAdapter,
    exportSearch, carryOut, carryHeader, checkCarryClean, decorateLines, callLogLine, formatSearchText, formatReport, testCRows, reasonWithLabel, refineReasons,
    // v1.1.0 追加
    groupAttribution, uniqueSections, egeoCover, graphInfo, distToCompetitors, distToTrunk, connCheck, splitTimeOk, evalSplit, polyPart, isZeroSection, nameOperand, nameEvidence, NAME_PATTERNS, NAME_PATTERN_TABLE_VERSION, icNameForms,
    // v1.2.0 追加（出口 E-name）
    exitStepIndex, divergeOthers, divergeClear, startHeading, EXIT_STEP_MANEUVERS,
    isR1Ride, r1Rides, hasR2, partitionDegenerate, viaPointsOf, CARRY_FORBIDDEN_KEYS, REASON_LABEL, CARRY_NOTICE,
    // v1.1.1 追加（診断）
    DIAG_VERSION, DIAG_LEGEND, MANEUVER_ENUMS, MANEUVER_ABBR, maneuverCode, stepFlags, boundaryDiag, highwayLegDiag, surfaceTollDiag, diagCode, legDiagCode, diagViolations,
  };
  root.RF7Adapter = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
