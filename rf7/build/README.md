# rf7/build — small・kanto の作成手順

公開コードと保存済みの入力からグラフを作り直す手順です。このデータの作成では Google に問い合わせていません。入出力は引数で渡します。Node は標準ライブラリだけを使います。N06 抽出は Python の標準ライブラリだけ、PBF 抽出には pyosmium が要ります。

## 1. 配布ファイル

| ファイル | バイト数 | SHA-256 |
|---|---:|---|
| `build_graph.js` | 186,250 | `1eb437451a4867eaeb90595f02cec91e71b286e2b33f02de18957c8bc6166240` |
| `verify_graph.js` | 121,764 | `8659423104f12cc2480809c0f0da48ed06c078fd002498a16ba1ce7d7da0c815` |
| `verify_general.js` | 77,076 | `5d2be277f52c31bb19f2f6118050a0beccf99cf836ffbee55f8bdf230eb507e0` |
| `graph_segments.js` | 3,493 | `26d774faf7ace6058702186a26985bad7e7c5f22923302945335973cca190e1c` |
| `regress_5a.js` | 6,238 | `ff32addd075a4f95d0f89bfc7bd015de00c611389e7b26677d2e0d09ae643e86` |
| `n06_extract.py` | 3,062 | `d7d1493bd93bf6800b45c253c4206e21b389fd8609600ed0e6e6bde173aede28` |
| `extract_pbf.py` | 6,665 | `82e91d82d9ee89fc23b3019a40e9cd51a871f89e87f74f585dabaae4f6696836` |
| `extract_pbf_steps.py` | 5,621 | `7f87fc9375e7160191003fe197c20da2d967d347166f5753132a94f2514f6c71` |
| `osm_query.overpassql` | 442 | `c0fe4940122a604a868a629efec74c1d039f3434d1694ba2deadd010ed452f48` |
| `osm_query_sapa.overpassql` | 524 | `4fb08d761f6d05c0f0727cc175e93d5967a06849d72f8908f3a76d994142a495` |
| `ledger/routes_kanto.json` | 103,903 | `f39b5148ca0851071f4ad787bfd12b90cb454197027d1589c118aa68711f7215` |
| `ledger/names_kanto.json` | 25,455 | `4b93700f83aaa8d3c9ec611879f666416cc9e4b5c33e2467bde01688c1f80a19` |
| `ledger/verify_exceptions_kanto.json` | 34,858 | `99b28d46c932c3edb7b0fc777ee459f12efe66374e0c8d1aec7475e99d22bf56` |
| `ledger/reach_expect_kanto.tsv` | 62,319 | `185a6f5e6c3274c63eb33e31ee3f5288cb7fb6a2995664ea64599b1e450dd478` |
| `n06_extract_region.py` | 4,874 | `7f26488dc4059ab42ff75bf35d3095f409d3a4eff5afcc877ba475dfdfb67c1c` |
| `../brute.js` | 6,876 | `867385d58e1eca9c66c0f80041613efdf7a334c7e8fee557328b9be274a73504` |
| `../base5a/graph_small.json.bak.20261101b` | 275,295 | `96e860d5d1ed5879f2c83fccf1fc2147deff741a36dfa09d8519fc8aabf004b7` |
| `../engine.js` | 55,563 | `1943ca3603ed0fdf51633f24945533d78d615bd33f6d83aebab2748921a7f4b7` |

この README 自身のハッシュは載せていません。ledger は路線・名前・検証の例外と到達期待値です。../brute.js と ../base5a/graph_small.json.bak.20261101b は一般の検証に必要な基準です。一般の検証では brute.js が無ければ失敗します。基準のデータは ODbL の派生データベースで、N06 の出典を併記します。コードのライセンスは未定です。

## 2. small の保存済み入力の記録


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


## 3. small の構築と検証

保存済み small の出力は Node v22.23.4 で作成した記録です。今回のコードの --profile 5a の回帰試験は済んでいます。Node の版が違えば meta.built_with によりファイルのバイト列が変わります。

```sh
node build_graph.js --profile 5a --osm <osm_small.json> --n06 <n06_small.json> --sapa <osm_sapa.json> --out <出力>
node verify_graph.js --dir <出力> --osm <osm_small.json> --n06 <n06_small.json> --sapa <osm_sapa.json> --engine .. --n06raw <N06 UTF-8 のフォルダ> --tmp <作業用フォルダ>
```

small の検証の結果は <出力>/verify_result.json に出ます。--sapa 付きの出力が ../data/ の small の配布物です。付けない版が ../base5a/ の検証用の基準です。graph_small.app.json は配布時に graph-small.app.json へ改名します。ic_match.json・unmatched.json・build_report.json は配布しません。

## 4. kanto の入力と抽出

Geofabrik の関東・中部・東北の地域 PBF を使用します。保存日は 2026-11-05、ファイル名の日付 261103、osm_base は 2026-11-03T21:24:23Z です。同じ出力を得るには下記の SHA-256 の保存済み入力が要ります。入力自体は配布しません。

| 入力（配布しない） | バイト数 | SHA-256 |
|---|---:|---|
| kanto-261103.osm.pbf | 523,821,119 | 791cbc0afd3b747236f615c09a9ad2ae46a95b8226b0c39c90bad51b5bc90208 |
| chubu-261103.osm.pbf | 516,260,596 | 64e6a7a2896a3c6d283c3446ba919af516891be02e25d3f19214c9e4953c0311 |
| tohoku-261103.osm.pbf | 311,752,409 | 1f054040a81cdb91648de9a59570cfb67fc066977d09aede145f5c9d82b55444 |
| kanto.json | 15,501,510 | c389c80fefb7073c23858e92a63af2be3c6cf16c87e22a45d76e5b2e72a41284 |
| chubu.json | 18,454,806 | c7c7e770d3ff7474aa62ddb5bc8298504157451fd178291b7fd383c0d1dc4b22 |
| tohoku.json | 11,394,602 | a9acb143babd0bc7f4dceee54d8671621e43f5cbe4e7269f9447e00fd11fa155 |
| N06-25_HighwaySection.geojson | 5,362,956 | 5ee02732ed5ea70452f9fd5001fed05c43867af198e403bf6caf681d1709b2b7 |
| N06-25_Joint.geojson | 672,230 | c1446de67ed736624691df579157f87fd3c12ea8c49b54c4dcd97081f428c7d9 |

N06 の配布 zip（N06-25_GML.zip）の SHA-256 は 742c8785dfb2f900f167972abe00d5c36103365c0f9fb11dc8a883aa358ac23e。N06 の帰属表示とライセンスは ../data/README.md を参照してください。

PBF からの抽出例（pyosmium が要る環境で実行）：

```sh
python3 -I -B extract_pbf.py <kanto-261103.osm.pbf> <抽出>/kanto.json
python3 -I -B extract_pbf.py <chubu-261103.osm.pbf> <抽出>/chubu.json
python3 -I -B extract_pbf.py <tohoku-261103.osm.pbf> <抽出>/tohoku.json
```

extract_pbf_steps.py は抽出を段階に分ける補助です。入力の取り直し（Geofabrik からの取得と PBF からの抽出）は試していません。今回の作り直しは、保存済みの抽出 JSON と N06 の UTF-8 GeoJSON から始めています。

## 5. kanto の構築と検証

実行前に `python3 --version` と `node --version` で版を確かめます。今回確かめた版は Python 3.12.13、Node v26.0.0 です。作業ディレクトリはこの build です。<出力>・<作業用フォルダ>・<検証の結果のフォルダ> は最初に空で作ります。--osm の順は kanto,chubu,tohoku に固定です。--tmp・--result は --dir の外に置きます。

```sh
python3 -I -B n06_extract_region.py <N06 UTF-8 のフォルダ> ledger/routes_kanto.json <出力>/n06_kanto.json
node build_graph.js --profile general --osm <抽出>/kanto.json,<抽出>/chubu.json,<抽出>/tohoku.json --n06 <出力>/n06_kanto.json --ledger ledger/routes_kanto.json --names ledger/names_kanto.json --out <出力>
node verify_graph.js --dir <出力> --osm <抽出>/kanto.json,<抽出>/chubu.json,<抽出>/tohoku.json --n06 <出力>/n06_kanto.json --n06raw <N06 UTF-8 のフォルダ> --ledger ledger/routes_kanto.json --names ledger/names_kanto.json --exceptions ledger/verify_exceptions_kanto.json --reach-expect ledger/reach_expect_kanto.tsv --engine .. --tmp <作業用フォルダ> --result <検証の結果のフォルダ>/verify_result.json
```

公開コードと保存済みの入力（§4 の抽出の JSON 3 本と N06 の GeoJSON 2 本）だけを公開と同じ並びの空の作業場所へ写して試験しました。Node v26.0.0 で、N06 の範囲抽出と構築の 7 ファイル（配布する 4 ファイルと、配布しない ic_match.json・unmatched.json・build_report.json）が保存済みの出力と同じバイト列になり、検証の必須の失敗は 0 でした。実行の記録は公開していません。入力の再取得で同じバイト列が得られることは保証しません。

## 6. データの形と検証

形状は Google 符号化ポリライン（精度 1e5）です。完全版・OSM のみ版・軽量版の件数、content_sha256 の確認、ODbL と CC BY 4.0 の区分、現実の道路との一致などの限界は ../data/README.md に記しています。verify は構造・方向・名前・到達・再生成・例外の使用状況を確かめます。例外一覧は 15 項目・47 対象です。検証の合格は現実の通行可否の保証ではありません。

## 7. small の補足（段階5a の記録）

生成（約 0.5 秒）の出力は `--out` の 6 ファイルです。検証（約 10 秒）の `--engine` は engine.js があるディレクトリ（配布物では rf7 の直下）です。

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

### 検証の内容（small。`verify_graph.js`）

| 区分 | 検査 |
|---|---|
| (a) | `validateGraph` 合格（完全版・OSMのみ版）、辺の集合、toll、meta、via が自辺の way 上 |
| (b) | 片方向IC・スマートIC・SA/PA・JCT連絡路・restriction の一次データ付き照合（公式の出入方向は「未確認」と記録） |
| (c) | N06 22 件との対応、IC のランプ中点との距離、N06 抽出条件 |
| (d) | 7 区間の到達性（engine の列挙と独立全列挙の一致） |
| (e) | 全ランプが一般道側端点を1つ持ち、その端点が OSM 上で一般道に接する |
| (f) | 再生成でバイト一致（6ファイル）、符号化ポリラインの既知ベクトル、`geom` の各点・線分が元 way から 5 m 以内（座標丸め込み）、`geom` の順序が from→to（OSM の有向道路から再構成した経路の頂点列の部分列）、`via_heading` が OSM way の進行方向と ±30° 以内、軽量版の `validateGraph`・辺集合の一致・meta のハッシュ・`content_sha256`、軽量版と完全版で engine の列挙結果が同一 |
| (g) | 段階5a-1′（`--sapa`）：`geom_gap` の構造と列挙、`osm_sapa` の入力（SHA-256・osm_base・問い合わせ文名）、SA/PA 接続辺 16 本の網羅、使った way の資格、埋めた `geom` の各点が場内通路 way から 5 m 以内（頂点と約25mごとの途中）、順序 from→to（一方通行の向き）、SA/PA 側の端点と代表点の距離、**SA/PA 接続辺の長さ比（`geom` の長さ／`length_m`）が 0.9〜1.1（外れる辺は NOTE で列挙）**、`--sapa` なしの再生成が 5a-1 の出力とバイト一致、5a-1 との差が意図した項目だけ |

### 注意

- 検証の合格は、OSM 内部の整合と探索器との整合を示すもので、**現実の道路（公式の出入方向、連絡路の実在）との一致は保証しません**。公式の出入方向は一次資料の確認待ちです。
- `meta.builder`・`meta.osm.query` は、本ディレクトリのファイル名（`build_graph.js`・`osm_query.overpassql`）を指します。
