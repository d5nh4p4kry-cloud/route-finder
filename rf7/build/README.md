# rf7/build — 道路データの作成手順

`../data/` のグラフ JSON を作る生成器・検証器と、入力の取得方法です。コードにも本書にもローカルの絶対パスは書いていません（入出力は引数で渡します）。Node は標準ライブラリのみ（v22.23.4 で作成・検証）、Python 3 は N06 の抽出にだけ使います。

## 1. ファイル

| ファイル | バイト数 | SHA-256 | 内容 |
|---|---:|---|---|
| `build_graph.js` | 101,582 | `45d9f5b5c62b829b548afdf107f6ffde3806b95aebad6c3246aa71e8bb9e5b5f` | グラフ生成器（`--sapa` で SA/PA 場内通路を取り込む） |
| `verify_graph.js` | 75,103 | `b16454e95ddc7308ddfbbff408402290c5c079925582df2981e6afde6c6fae13` | 検証器（71 検査） |
| `osm_query.overpassql` | 442 | `c0fe4940122a604a868a629efec74c1d039f3434d1694ba2deadd010ed452f48` | Overpass の問い合わせ文（本体 `osm_small.json`） |
| `osm_query_sapa.overpassql` | 524 | `4fb08d761f6d05c0f0727cc175e93d5967a06849d72f8908f3a76d994142a495` | Overpass の問い合わせ文（SA/PA 場内通路 `osm_sapa.json`） |
| `n06_extract.py` | 3,062 | `d7d1493bd93bf6800b45c253c4206e21b389fd8609600ed0e6e6bde173aede28` | N06 から接合部を抽出 |

## 2. 入力の取得方法

### 2.1 OpenStreetMap（`osm_small.json`）

| 項目 | 内容 |
|---|---|
| エンドポイント | Overpass API `overpass.kumi.systems`（標準の Overpass API 形式 `https://overpass.kumi.systems/api/interpreter` と考えられるが、この作業ではネット接続を使わず再確認していない） |
| 問い合わせ文 | `osm_query.overpassql`（下記。範囲 `35.38,139.30,35.68,139.76`） |
| 取得日 | 2026-11-01 |
| `osm_base` | 2026-07-28T02:16:18Z（応答に含まれる OSM データの基準時刻） |
| 保存した応答 | `osm_small.json`、3,816,345 バイト、SHA-256 `70775da03bab5f95fa265fb03348e92b7538169c69bffefd46468fa3728664c1` |
| 内容 | way 2,799 本（geometry 付き）、motorway_junction 271、toll_booth 207、restriction 関係 22 |

```
[out:json][timeout:180][bbox:35.38,139.30,35.68,139.76];
(
  way[highway~"^(motorway|motorway_link)$"];
  way[highway~"^(trunk|trunk_link)$"][motorroad=yes];
  way[highway~"^(trunk|trunk_link)$"][toll=yes];
)->.hw;
.hw out body geom;
node(w.hw)->.hn;
node.hn[highway=motorway_junction]; out body;
node.hn[barrier=toll_booth]; out body;
way(bn.hn)[highway]->.touch;
(.touch; - .hw;)->.sw;
.sw out body;
rel(bw.hw)[type=restriction]; out body;
```

- 取得に使った実際のコマンドは記録に残っていない（わからない）。問い合わせ文を上記エンドポイントへ POST し、応答の JSON をそのまま保存したものが `osm_small.json`。
- Overpass の応答は OSM の更新で変わる。**同じバイト列を得るには、SHA-256 が上の値と一致する保存済みの応答を使う**。`osm_small.json` 自体（3.8 MB）はこのリポジトリには置いていない。新しく取得した応答で作ると、`meta.osm.sha256`・`osm_base` と、道路の更新があれば内容が変わる。
- OSM データは ODbL（© OpenStreetMap contributors）。

### 2.2 OpenStreetMap：SA/PA 場内通路（`osm_sapa.json`、段階5a-1′）

SA/PA 6 施設の場内通路（service・motorway_link）の形状。`osm_small.json` の service way は geometry を持たないため、SA/PA 接続辺の `geom` を場内通路の実形状で延ばすには、この別取得が要る。

| 項目 | 内容 |
|---|---|
| エンドポイント | Overpass API `overpass.kumi.systems` の `/api/interpreter`（`https://overpass.kumi.systems/api/interpreter`） |
| 問い合わせ文 | `osm_query_sapa.overpassql`（下記。SA/PA 6 施設の代表点から半径 600 m） |
| 取得日 | 2026-11-01 |
| `osm_base` | 2026-07-28T02:16:18Z（**`osm_small.json` と同一**。鮮度の混在なし） |
| 保存した応答 | `osm_sapa.json`、218,638 バイト、SHA-256 `b33d636a30b0e1dfa6e74bebe35a0fd3fbe7a88b0650d4805457ebcf1805c806` |
| 内容 | way 340 本（service 309・motorway_link 31、すべて geometry 付き）。うち access 等が no・private の 20 本は生成器が使わない |
| 生成器 | Overpass API 0.7.62.11 87bfad18（応答の `generator`） |

```
[out:json][timeout:120];
(
  way[highway~"^(service|motorway_link)$"](around:600,35.4903416,139.368994);
  way[highway~"^(service|motorway_link)$"](around:600,35.4918128,139.369453);
  way[highway~"^(service|motorway_link)$"](around:600,35.5357472,139.5332665);
  way[highway~"^(service|motorway_link)$"](around:600,35.5327154,139.5269309);
  way[highway~"^(service|motorway_link)$"](around:600,35.4316273,139.4005378);
  way[highway~"^(service|motorway_link)$"](around:600,35.4316047,139.3996791);
)->.w;
.w out body geom;
```

- 6 つの座標は、グラフの SA/PA ノード 6 つの緯度経度で、順に 厚木PA/スマートIC（外回り）、厚木PA/スマートIC（内回り）、港北PA（下り）、港北PA（上り）、海老名SA（下り）、海老名SA（上り）。
- 応答は OSM の更新で変わる。同じバイト列を得るには、SHA-256 が上の値と一致する保存済みの応答を使う。`osm_sapa.json` 自体（218 KB）はこのディレクトリには置いていない。
- OSM データは ODbL（© OpenStreetMap contributors）。
- この取得は 2026-11-01 の作業指示にもとづく記録で、この README の作成時にはネット接続を使っていない（エンドポイントの再確認はしていない）。

### 2.3 国土数値情報 N06（`n06_small.json`）

| 項目 | 内容 |
|---|---|
| 配布ページ | https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N06-2025.html（「高速道路時系列データ」2025年度） |
| 取得日 | 2026-11-01 |
| ファイル | `N06-25_GML.zip`、SHA-256 `742c8785dfb2f900f167972abe00d5c36103365c0f9fb11dc8a883aa358ac23e` |
| 使うもの | 解凍した UTF-8 版の `N06-25_HighwaySection.geojson` と `N06-25_Joint.geojson` |
| 基準 | 2025年度整備データ、2025-12-31 時点の現況（設置期間終了=9999） |
| ライセンス | CC BY 4.0（出典表示は `../data/README.md` §1） |

抽出（Python は `-I` で実行し、2つの geojson があるディレクトリを引数で渡す）:

```
python3 -I n06_extract.py <2つの geojson があるディレクトリ> <出力 n06_small.json>
```

- 結果は接合部 22 件。`../data/n06_small.json`（SHA-256 `46a902b4252ead19a1a4f6beefb99b2eec8ba4245cb1e432b81a78179075b397`）と同じになる。

## 3. 実行手順

```
node --check build_graph.js && node --check verify_graph.js

# 生成（約 0.5 秒）。--out に6ファイルができる。配布物（../data/）は --sapa 付きで作ったもの
node build_graph.js --osm <osm_small.json> --n06 <n06_small.json> --sapa <osm_sapa.json> --out <出力ディレクトリ>

# 検証（約 10 秒）。--engine は engine.js があるディレクトリ（配布物では rf7 の直下）
node verify_graph.js --dir <出力ディレクトリ> --osm <osm_small.json> --n06 <n06_small.json> --sapa <osm_sapa.json> --engine <engine.js のディレクトリ> [--n06raw <N06 の UTF-8 ディレクトリ>] [--tmp <再生成用の作業ディレクトリ>]
```

- `--sapa`（任意）：SA/PA 場内通路。付けると SA/PA ノードに接する辺 16 本の `geom` を、接続点から場内通路（service・motorway_link）を一方通行の向きにたどった実形状で SA/PA 側の端点まで延ばす（直線補間はしない）。形状で埋まらない区間がある辺には `geom_gap:true`・`geom_gap_info`（今回は 0 件）。`meta.version` の改訂番号は r2。
- `--sapa` を付けずに作ると段階5a-1 の出力（`meta.version` r1。軽量版 89,994 バイト、SHA-256 `df7339aed15ad577c43ef1b376182772b57474f2807c815807d3fff94a492d0a`、完全版 `96e860d5d1ed5879f2c83fccf1fc2147deff741a36dfa09d8519fc8aabf004b7`、OSMのみ版 `a0b8b9349333eaf074f4a31af562f628fa9ca85601a1087e9ddf3405f58b74e4`）とバイト一致する。
- 検証器は、グラフに `meta.osm_sapa` があれば `--sapa` を必須とする（生成に使ったものと同じファイル）。

| 出力 | 配布先 |
|---|---|
| `graph_small.app.json` | `../data/graph-small.app.json`（改名のみ。内容は同一） |
| `graph_small.json` | `../data/graph_small.json` |
| `graph_small.osm-only.json` | `../data/graph_small.osm-only.json` |
| `ic_match.json`・`unmatched.json`・`build_report.json` | 配布しない（照合表・除外記録・検証用。検証器が使う） |

- 生成結果の SHA-256（`--sapa` 付き）は `../data/README.md` §2 の値と一致する（一致しなければ入力か Node の版が違う。完全版の `meta.built_with` に Node の版が入るので、Node の版が違うとバイト列が変わる）。
- 検証器は終了コード 0（必須検査が全て合格）で終わる。`--engine` のディレクトリに `brute.js` があれば、探索器と独立全列挙の一致も検査し、なければその比較だけ省く。`--n06raw` を省くと N06 原本の再確認だけ省く（注記が1件出る）。検証器は再生成用に `--tmp`（省略時は OS の一時ディレクトリ内の `rfgraph-verify-rebuild`）へ書き込むが、ファイルは削除しない。

## 4. 検証の内容（`verify_graph.js`）

| 区分 | 検査 |
|---|---|
| (a) | `validateGraph` 合格（完全版・OSMのみ版）、辺の集合、toll、meta、via が自辺の way 上 |
| (b) | 片方向IC・スマートIC・SA/PA・JCT連絡路・restriction の一次データ付き照合（公式の出入方向は「未確認」と記録） |
| (c) | N06 22 件との対応、IC のランプ中点との距離、N06 抽出条件 |
| (d) | 7 区間の到達性（engine の列挙と独立全列挙の一致） |
| (e) | 全ランプが一般道側端点を1つ持ち、その端点が OSM 上で一般道に接する |
| (f) | 再生成でバイト一致（6ファイル）、符号化ポリラインの既知ベクトル、`geom` の各点・線分が元 way から 5 m 以内（座標丸め込み）、`geom` の順序が from→to（OSM の有向道路から再構成した経路の頂点列の部分列）、`via_heading` が OSM way の進行方向と ±30° 以内、軽量版の `validateGraph`・辺集合の一致・meta のハッシュ・`content_sha256`、軽量版と完全版で engine の列挙結果が同一 |
| (g) | 段階5a-1′（`--sapa`）：`geom_gap` の構造と列挙、`osm_sapa` の入力（SHA-256・osm_base・問い合わせ文名）、SA/PA 接続辺 16 本の網羅、使った way の資格、埋めた `geom` の各点が場内通路 way から 5 m 以内（頂点と約25mごとの途中）、順序 from→to（一方通行の向き）、SA/PA 側の端点と代表点の距離、**SA/PA 接続辺の長さ比（`geom` の長さ／`length_m`）が 0.9〜1.1（外れる辺は NOTE で列挙）**、`--sapa` なしの再生成が 5a-1 の出力とバイト一致、5a-1 との差が意図した項目だけ |

## 5. 注意

- 検証の合格は、OSM 内部の整合と探索器との整合を示すもので、**現実の道路（公式の出入方向、連絡路の実在）との一致は保証しません**。公式の出入方向は一次資料の確認待ちです。
- `meta.builder`・`meta.osm.query` は、本ディレクトリのファイル名（`build_graph.js`・`osm_query.overpassql`）を指します。
