# rf7/data — ルートファインダー v7 道路データ（small・kanto）

OpenStreetMap と国土数値情報（N06）から作成した派生データベースです。作成手順は [../build/README.md](../build/README.md)。このデータの作成では Google に問い合わせていません。

## 1. 帰属表示とライセンス

- © OpenStreetMap contributors, ODbL 1.0, https://www.openstreetmap.org/copyright
  Contains information from OpenStreetMap, which is made available here under the Open Database License (ODbL).
- 「国土数値情報（高速道路時系列データ）」（国土交通省）（https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N06-2025.html）（2026年11月1日取得）を加工して作成（CC BY 4.0（2025年度整備データを2025年12月31日時点の現況データとして使用））。この出典文は n06_small.json・n06_kanto.json の meta.source と一致します。
- kanto の OSM の入手元は Geofabrik の関東・中部・東北の地域ファイル、osm_base は 2026-11-03T21:24:23Z です。small の OSM の基準日は 2026-07-28 です。

| ファイル | 内容 | ライセンス |
|---|---|---|
| `graph-small.app.json` | アプリ用の軽量版（OSM 派生＋N06 の名称・種別） | **ODbL 1.0**（結合後は ODbL として扱う。N06 の出典表示を併記） |
| `graph_small.json` | 完全版（同上） | **ODbL 1.0**（同上） |
| `graph_small.osm-only.json` | OSM のみから作成した版（N06 照合前） | **ODbL 1.0** |
| `n06_small.json` | N06 から抽出した接合部22件のみ | **CC BY 4.0**（別ファイル。ODbL の対象ではない） |
| `graph-kanto.app.json` | 関東のアプリ用の軽量版 | **ODbL 1.0**（結合後は ODbL として扱い、N06 の出典表示を併記） |
| `graph_kanto.json` | 関東の完全版 | **ODbL 1.0**（同上） |
| `graph_kanto.osm-only.json` | 関東の OSM のみ版 | **ODbL 1.0** |
| `n06_kanto.json` | N06 だけの抽出 | **CC BY 4.0**（別ファイル、ODbL の対象ではない） |
| `LICENSE-ODbL.txt` | 約款の URI と適用範囲・帰属表示 | — |

LICENSE-ODbL.txt は ODbL の約款本文ではありません。本文の所在は https://opendatacommons.org/licenses/odbl/1-0/ です。OSM のみ版と N06 の抽出を別ファイルで置き、結合後のデータベースは ODbL として扱います。検証用の ../base5a/graph_small.json.bak.20261101b も ODbL の派生データベースで、N06 の出典を併記します。コードのライセンスは未定です。ODbL・CC BY の約款原文との照合はしていません。

## 2. ファイル一覧

| ファイル | バイト数 | SHA-256 |
|---|---:|---|
| `graph-small.app.json` | 90,679 | `6123d26b203104b9bf6cd84c96eded8cceeee654bd815466187feffbf119338a` |
| `graph_small.json` | 281,319 | `4eaae7774872f51852b90e5c74b95a74bad4471943eba17e4ce648e597e3eaa7` |
| `graph_small.osm-only.json` | 260,291 | `bdc836d836e2c227d24f53afe8a7028324ea16f82fd6ef880dcff42767d63a98` |
| `n06_small.json` | 5,853 | `46a902b4252ead19a1a4f6beefb99b2eec8ba4245cb1e432b81a78179075b397` |
| `graph-kanto.app.json` | 2,129,855 | `2ff841fa8c83f5c28a918ba0ee817be9072552daf235cf7ad74798249975eeb3` |
| `graph_kanto.json` | 9,271,128 | `5ffa64eaee55ecca7d4ce1fad88342467f15e4c0112ab5a2724030ddf5627064` |
| `graph_kanto.osm-only.json` | 8,921,912 | `8470eb817f39c9a8b886f9210ceb89ce432d76e1df540fa063013684cb20ea6c` |
| `n06_kanto.json` | 1,271,783 | `362d2ccb279baeaf1d3fbc2d59b3aa1a3ca2b859303ed5d3174e16af6b7f7a4b` |
| `LICENSE-ODbL.txt` | 3,478 | `36d3c997d115849c928f1feb0432967743b018c563e3f5d37e3ab0eed88df030` |
| `../engine.js` | 55,563 | `1943ca3603ed0fdf51633f24945533d78d615bd33f6d83aebab2748921a7f4b7` |
| `../bench/bench.js` | 5,588 | `a1c93c83136cfa4f29b8cfb7903edb4c18e2b27e8f366379a5e65056fdcaa979` |
| `../bench/index.html` | 3,819 | `7c3a92d7050886f875332dc35b7599664681e320370c38d4ebf649118dbc3a17` |

探索器 ../engine.js の版は `v7-stage5-1.3.0`。計測ページの版は `rf7-bench 1.0.0`。この README 自身のハッシュは載せていません。

## 3. 地域ごとの配置と本体のハッシュ

| 地域 | 配布名 | 作成手順の出力名 | meta.version |
|---|---|---|---|
| small | graph-small.app.json | graph_small.app.json | small-osm20260728-n06y2025-r2 |
| kanto | graph-kanto.app.json | graph_kanto.app.json | kanto-osm20261103-n06y2025-r2 |

配布時は改名だけで、内容は同じです。軽量版は地域ごとに分けた整形なしの JSON です。meta.app_format は rf-graph-app/1、schema は rf-graph/1。meta.region は地域キー、meta.published_file は配布名、meta.bbox は対象の範囲です。meta.derived_from は完全版のファイル名・バイト数・SHA-256・作成器・Node の版、meta.osm と meta.n06 は入力の記録を持ちます。kanto の meta.names は名前の表の版と SHA-256 を持ちます（small にはありません）。地域またぎの接続と、読み込む地域の選び方は未設計です。

`graph-small.app.json` の `meta.content_sha256` の確認（data ディレクトリで実行）：

```sh
node -e "const c=require('crypto'),g=JSON.parse(require('fs').readFileSync('graph-small.app.json','utf8'));console.log(c.createHash('sha256').update(JSON.stringify({nodes:g.nodes,edges:g.edges,ics:g.ics}),'utf8').digest('hex'))"
```

出力は `a39c21344d9e8db9ea03e8f61cf3e0352a74f3c28d542f1e5023caa47bb35d9d` です。

`graph-kanto.app.json` の `meta.content_sha256` の確認（data ディレクトリで実行）：

```sh
node -e "const c=require('crypto'),g=JSON.parse(require('fs').readFileSync('graph-kanto.app.json','utf8'));console.log(c.createHash('sha256').update(JSON.stringify({nodes:g.nodes,edges:g.edges,ics:g.ics}),'utf8').digest('hex'))"
```

出力は `a93d9b14875f2b62d0151932c1897f3313c1f26014045cf7de395326cd8dee17` です。

## 4. データの形

- small：東名（東京〜厚木・伊勢原JCT付近）・圏央道（寒川北〜相模原愛川）・首都高3号（谷町JCT〜用賀）の範囲です。ノード 147、辺 210、IC 16、方向付きランプ 108。SA/PA 場内通路を取り込んだ版です。
- kanto：緯度 34.85〜37.2・経度 138.75〜140.95 の矩形（`meta.bbox`）にある高速道路・有料道路で、路線は 71（`meta.road_list`。台帳は ../build/ledger/routes_kanto.json）です。矩形の外の道路と、台帳で除外した 11 路線は含みません。ノード 3,726、辺 5,092、方向付きランプ 2,112、完全版・軽量版の IC 512、OSM のみ版の IC 548。終端ランプ（本線が一般道か無料の本線に直接つながる点で、入る区間を出口ランプ、出る区間を入口ランプにしたもの）があります。同じ路線で一般道側の点が 50 m 以内にあり、一般道の name か ref が共通の終端の IC は、1 つにまとめています。
- 名前の表（../build/ledger/names_kanto.json）は、名前の訂正、道路名の語、照合の保持、方向名の決定を記録します。
- edges[].geom は from→to の順に並ぶ Google 符号化ポリライン（精度 1e5）です。OSM の道路形状を 5 m 許容で簡略化しています。adapter の形状照合にも使います。
- SA/PA 接続辺は 406 本。形状で埋まらない区間のある 62 辺に geom_gap と geom_gap_info があり、その区間は形状照合で判定不能になります。SA/PA 代表点までの直線補間はしません。
- `dir_basis`・`dir_basis_to` は完全版と OSM のみ版にあり、軽量版には無い方向名の根拠です。SA/PA ノードの `osm.dir_in`・`osm.dir_out` は、SA/PA の方向名の写しです。
- 軽量版は osm・n06_match などの検証用の情報を落とします。完全版には残します。道路のつながり・辺の ID と並び・形状は同じです。

## 5. 限界

- 現実の道路との一致は未検証です。構造検査は原データ内の整合を確かめるものです。
- 公式の出入方向は未確認です。道路管理者の一次資料による確認を残しています。
- 名前の表による方向名は規則と Tak の承認によるもので、道路管理者の資料とは照合していないものです。
- 幾何から付けた方向名は公式の呼び方ではないものです。
- 名前の無い IC は、関東の完全版・軽量版で 22、OSM のみ版で 24 あります。
- 範囲の端の IC は、範囲の外へ続く本線が無いため、片方向の移動しかできないことがあります。該当するのは、東北自動車道の矢吹、常磐自動車道のいわき四倉、磐越自動車道のいわき三和、関越自動車道の大和SIC、上信越自動車道の松井田妙義、中央自動車道の大月、東名高速道路の愛鷹SIC、新東名高速道路の長泉沼津・駿河湾沼津SIC の 9 つです。
- このほか、江間（伊豆中央道）・横浜新道戸塚終点（横浜新道）・皆野長瀞（皆野寄居バイパス）・岩（真鶴道路）にも、入口から他の IC へ行けない、または出口へ他の IC から来られない向きがあります。
- SA/PA の場内でつなげない組が 38 組あり、通り抜けの実在は保証しません。OSM の場内通路の記録は実際の通行可否の確認を代えるものではありません。
- 伊豆中央道の北行きは、OSM の規制により江間料金所の付近から先へ進めない形になっており、伊豆から北へ伊豆中央道を使う候補は出ません。公式資料による確認が残ります。
- データの鮮度は kanto の OSM 2026-11-03、small の OSM 2026-07-28、N06 2025-12-31 基準です。その後の変更は反映していません。

## 6. small の詳細（段階5a の記録）

- 帰属表示（§1）は、このデータを使う画面・配布物に付けます。
- `LICENSE-ODbL.txt` の代わりに約款の本文そのものを同梱する場合は、公式の本文に差し替えてください。
- 軽量版は整形なしの1行 JSON（gzip で約 19.5 KB）。完全版・OSMのみ版は整形あり。
- small の 3 つのグラフは、SA/PA 場内通路（`osm_sapa.json`、OSM 由来）を取り込んで作ったものです（段階5a-1′。§4・§5）。取り込まずに作った版（段階5a-1。軽量版 89,994 バイト、SHA-256 `df7339aed15ad577c43ef1b376182772b57474f2807c815807d3fff94a492d0a`）とは、SA/PA ノードに接する辺 16 本の `geom` だけが違います。

| 項目 | 内容 |
|---|---|
| `meta.published_file` | 配布名（`graph-small.app.json`） |
| `meta.bbox` | 範囲（`latMin 35.38, lngMin 139.30, latMax 35.68, lngMax 139.76`）。OSM の取得範囲と同じ |
| `meta.version` | `<region>-osm<OSM基準日>-n06y<N06年度>-r<改訂番号>`。今回 `small-osm20260728-n06y2025-r2`（SA/PA 場内通路を取り込んだ版。取り込まない版は r1）。作成ロジックの変更で出力が変わるときに改訂番号を上げる |
| `meta.derived_from` | 元になった完全版のファイル名・SHA-256・バイト数・作成器・Node の版 |
| `meta.osm.sha256` / `meta.n06.extract_sha256` | 入力（OSM の取得結果、`n06_small.json`）の SHA-256 |
| `meta.osm_sapa` | SA/PA 場内通路の入力（`osm_sapa.json`）の SHA-256（`b33d636a30b0e1dfa6e74bebe35a0fd3fbe7a88b0650d4805457ebcf1805c806`）・`osm_base`（2026-07-28T02:16:18Z。本体と同一）・問い合わせ文名（`osm_query_sapa.overpassql`）。取得方法は [`../build/README.md`](../build/README.md) §2.2 |
| `meta.content_sha256` | 本体（`nodes`・`edges`・`ics`）の SHA-256。ファイル全体のハッシュはファイル自身に埋め込めないので、読み込み後に確認できるこの値を別に持つ。確認は下の式 |
| `meta.cross_region` | **`null`（未設計）**。地域またぎの接続（地域間の境界ノードの対応など）は 5b 前に決める。今回は項目と注記（`cross_region_note`）だけを置いた |

### データ形式の要点（small）

| 項目 | 内容 |
|---|---|
| `edges[].geom` | 辺の道路形状。OSM way の形状を 5 m 許容（Douglas-Peucker）で簡略化し、辺の from→to の進行方向順に並べた Google 符号化ポリライン（精度 1e5）。全 210 辺、2,440 点。SA/PA ノードに接する辺（16 本）は、接続点から場内通路（OSM の service・motorway_link）を一方通行の向きにたどった実形状で SA/PA 側の端点まで続く。端点から SA/PA ノードの代表点までの直線区間は含まない（直線補間はしない。最大 53.8 m。`length_m` にはその近似距離が加わったまま） |
| `edges[].geom_gap`・`geom_gap_info` | 場内通路の形状で埋まらない区間がある辺に `geom_gap:true`、`geom_gap_info:{length_m, reason}`。**今回は 0 件**（該当する辺には項目自体がない）。軽量版にも同じ項目を残す。`meta.counts.geom_gap_edges` に件数 |
| `edges[].via_heading` | `via` 点の前後 30 m の OSM way 形状から求めた進行方向の方位（度、北=0、時計回り、整数 0〜359）。`via` を持つ 122 辺のみ |
| `edges[].jct` | JCT連絡路の N06 JCT 名（軽量版に残した追加項目。表示名用） |
| 軽量版で落とした項目 | `osm` サブオブジェクト（way・ノード・料金所の記録など）、`via_basis`・`toll_source`・`fare_reason`・`sub`・`via_excluded`・`n06_match` など。完全版にはすべて残っている |
| 辺・ノード数 | ノード 147、辺 210、IC 16（一般 14・スマート 2）、方向付きランプ 108 |

### 限界・未確定事項（small）

- **現実の道路との一致は未検証**です。構造検査の合格（`../build/verify_graph.js`）は OSM 内部の整合を見たもので、公式の構造との一致を保証しません。
- **公式の出入方向（片方向IC・スマートIC・SA/PA・JCT 8方向・渋谷出口の右折規制・圏央道の内回り／外回り名）はすべて一次資料（道路管理者の出入口案内等）確認待ち**です。大橋JCT経由の3号同一路線連絡4辺は `restriction.resolved:false`（通行可否が未確認）です。
- **SA/PA の場内通路**（段階5a-1′）：OSM の mapping 結果で、実際の通行可否（駐車場内の通り抜けなど）は未確認。SA/PA ノードの代表点は接続ノードの重心で道路上の点ではない。厚木PASIC（内回り）は、SIC 入口→SIC 出口が場内通路でつながらない（完全版 `graph_small.json` の `meta.sapa_geom.no_passage_pairs`。グラフは SA/PA ノードで両辺をつなぐので、この組合せは実在経路の裏付けがない）。SA/PA 接続辺の `geom` の長さ／`length_m` は 16 本中 15 本が 0.9〜1.1、`off.sapa230182519.7715004105` だけが 1.137。
- データの鮮度: OSM 2026-07-28（本体・SA/PA 場内通路とも同一の `osm_base`）、N06 2025-12-31 基準。この間の供用変更は反映されていません。
- 収録外の道路（新東名・小田原厚木道路・横浜北西線・第三京浜・中央環状線・都心環状線など）は含まれません。
