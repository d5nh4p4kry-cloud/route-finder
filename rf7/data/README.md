# rf7/data — ルートファインダー v7 道路データ（region: `small`）

東名（東京〜厚木・伊勢原JCT付近）・圏央道（寒川北〜相模原愛川）・首都高3号（谷町JCT〜用賀）の方向付きランプ・本線・JCT連絡路のグラフ。OpenStreetMap と国土数値情報（N06）から作成した派生データベースです。作成手順は [`../build/README.md`](../build/README.md)。

## 1. 帰属表示とライセンス

### 帰属表示（このデータを使う画面・配布物に付ける）

- © OpenStreetMap contributors, ODbL 1.0, https://www.openstreetmap.org/copyright
  Contains information from OpenStreetMap, which is made available here under the Open Database License (ODbL).（ODbL 1.0: https://opendatacommons.org/licenses/odbl/1-0/ ）
- 「国土数値情報（高速道路時系列データ）」（国土交通省）（https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N06-2025.html）（2026年11月1日取得）を加工して作成（CC BY 4.0。2025年度整備データを2025年12月31日時点の現況データとして使用）。この文は `n06_small.json` の `meta.source` と同じです。

### ライセンス区分

| ファイル | 内容 | ライセンス |
|---|---|---|
| `graph-small.app.json` | アプリ用の軽量版（OSM 派生＋N06 の名称・種別） | **ODbL 1.0**（結合後は ODbL として扱う。N06 の出典表示を併記） |
| `graph_small.json` | 完全版（同上） | **ODbL 1.0**（同上） |
| `graph_small.osm-only.json` | OSM のみから作成した版（N06 照合前） | **ODbL 1.0** |
| `n06_small.json` | N06 から抽出した接合部22件のみ | **CC BY 4.0**（別ファイル。ODbL の対象ではない） |
| `LICENSE-ODbL.txt` | ODbL 1.0 の所在を示すテキスト | — |

- **`LICENSE-ODbL.txt` は ODbL の約款本文ではありません。** 本文の手元の写しがないため、本文の URI（https://opendatacommons.org/licenses/odbl/1-0/ ）と適用範囲・帰属表示を記したテキストにしています。本文そのものを同梱する場合は、公式の本文に差し替えてください。
- ODbL と CC BY を混ぜないため、OSM のみの版（`graph_small.osm-only.json`）と N06 の抽出（`n06_small.json`）を別ファイルで置いています。
- コード（`../engine.js`、`../build/`）のライセンスは、このディレクトリでは定めていません（未定）。ODbL の対象はこの表のデータファイルです。

## 2. ファイル一覧（バイト数・SHA-256）

| ファイル | バイト数 | SHA-256 |
|---|---:|---|
| `graph-small.app.json` | 90,679 | `6123d26b203104b9bf6cd84c96eded8cceeee654bd815466187feffbf119338a` |
| `graph_small.json` | 281,319 | `4eaae7774872f51852b90e5c74b95a74bad4471943eba17e4ce648e597e3eaa7` |
| `graph_small.osm-only.json` | 260,291 | `bdc836d836e2c227d24f53afe8a7028324ea16f82fd6ef880dcff42767d63a98` |
| `n06_small.json` | 5,853 | `46a902b4252ead19a1a4f6beefb99b2eec8ba4245cb1e432b81a78179075b397` |
| `LICENSE-ODbL.txt` | 2,309 | `8e49af3efcf8e69c344e87b66640518f2ad4a0229b942ac201d033bee06d39ed` |
| `../engine.js`（探索器 `v7-stage4-1.1.0`、無改変で使用） | 47,715 | `e055b53e083b1cfc9013c48200aee418dc7aa44a5b085d94715b395fede33a0e` |

- `graph-small.app.json` は、作成手順の出力 `graph_small.app.json` と同一内容（配布名だけがハイフン区切り。§3）。
- 軽量版は整形なしの1行 JSON（gzip で約 19.5 KB）。完全版・OSMのみ版は整形あり。
- 上の 3 つのグラフは、SA/PA 場内通路（`osm_sapa.json`、OSM 由来）を取り込んで作ったものです（段階5a-1′。§4・§5）。取り込まずに作った版（段階5a-1。軽量版 89,994 バイト、SHA-256 `df7339aed15ad577c43ef1b376182772b57474f2807c815807d3fff94a492d0a`）とは、SA/PA ノードに接する辺 16 本の `geom` だけが違います。
- この README 自身のハッシュは載せていません。

## 3. 地域分割の方針（Tak 決定 2026-11-01）

道路データと探索器は `index.html` に埋め込まず、別ファイルとして置く。**地域ごとに1ファイル**とし、アプリは必要な地域だけ読み込む。

| 項目 | 内容 |
|---|---|
| ファイル名 | `graph-<region>.app.json`。今回は `graph-small.app.json` だけ。将来 `graph-kanto.app.json`・`graph-tohoku.app.json` 等を追加する |
| 作成手順の出力名 | `graph_small.app.json`（アンダースコア）。配布時に上のハイフン名へ改名（内容は同一） |
| `meta.app_format` | `rf-graph-app/1`（軽量版の形式。`schema` は engine の検証に合わせ `rf-graph/1` のまま） |
| `meta.region` | 地域キー（今回 `"small"`）。完全版・OSMのみ版の meta にも入っている |
| `meta.published_file` | 配布名（`graph-small.app.json`） |
| `meta.bbox` | 範囲（`latMin 35.38, lngMin 139.30, latMax 35.68, lngMax 139.76`）。OSM の取得範囲と同じ |
| `meta.version` | `<region>-osm<OSM基準日>-n06y<N06年度>-r<改訂番号>`。今回 `small-osm20260728-n06y2025-r2`（SA/PA 場内通路を取り込んだ版。取り込まない版は r1）。作成ロジックの変更で出力が変わるときに改訂番号を上げる |
| `meta.derived_from` | 元になった完全版のファイル名・SHA-256・バイト数・作成器・Node の版 |
| `meta.osm.sha256` / `meta.n06.extract_sha256` | 入力（OSM の取得結果、`n06_small.json`）の SHA-256 |
| `meta.osm_sapa` | SA/PA 場内通路の入力（`osm_sapa.json`）の SHA-256（`b33d636a30b0e1dfa6e74bebe35a0fd3fbe7a88b0650d4805457ebcf1805c806`）・`osm_base`（2026-07-28T02:16:18Z。本体と同一）・問い合わせ文名（`osm_query_sapa.overpassql`）。取得方法は [`../build/README.md`](../build/README.md) §2.2 |
| `meta.content_sha256` | 本体（`nodes`・`edges`・`ics`）の SHA-256。ファイル全体のハッシュはファイル自身に埋め込めないので、読み込み後に確認できるこの値を別に持つ。確認は下の式 |
| `meta.cross_region` | **`null`（未設計）**。地域またぎの接続（地域間の境界ノードの対応など）は 5b 前に決める。今回は項目と注記（`cross_region_note`）だけを置いた |

`meta.content_sha256` の確認（`graph-small.app.json` があるディレクトリで）:

```
node -e "const c=require('crypto'),g=JSON.parse(require('fs').readFileSync('graph-small.app.json','utf8'));console.log(c.createHash('sha256').update(JSON.stringify({nodes:g.nodes,edges:g.edges,ics:g.ics}),'utf8').digest('hex'))"
```

出力は `a39c21344d9e8db9ea03e8f61cf3e0352a74f3c28d542f1e5023caa47bb35d9d` になる。

どの地域ファイルを読むかの選び方（出発地・目的地の bbox 判定、地域一覧ファイルの要否）は**まだ決めていない**。

## 4. データ形式の要点

| 項目 | 内容 |
|---|---|
| `edges[].geom` | 辺の道路形状。OSM way の形状を 5 m 許容（Douglas-Peucker）で簡略化し、辺の from→to の進行方向順に並べた Google 符号化ポリライン（精度 1e5）。全 210 辺、2,440 点。SA/PA ノードに接する辺（16 本）は、接続点から場内通路（OSM の service・motorway_link）を一方通行の向きにたどった実形状で SA/PA 側の端点まで続く。端点から SA/PA ノードの代表点までの直線区間は含まない（直線補間はしない。最大 53.8 m。`length_m` にはその近似距離が加わったまま） |
| `edges[].geom_gap`・`geom_gap_info` | 場内通路の形状で埋まらない区間がある辺に `geom_gap:true`、`geom_gap_info:{length_m, reason}`。**今回は 0 件**（該当する辺には項目自体がない）。軽量版にも同じ項目を残す。`meta.counts.geom_gap_edges` に件数 |
| `edges[].via_heading` | `via` 点の前後 30 m の OSM way 形状から求めた進行方向の方位（度、北=0、時計回り、整数 0〜359）。`via` を持つ 122 辺のみ |
| `edges[].jct` | JCT連絡路の N06 JCT 名（軽量版に残した追加項目。表示名用） |
| 軽量版で落とした項目 | `osm` サブオブジェクト（way・ノード・料金所の記録など）、`via_basis`・`toll_source`・`fare_reason`・`sub`・`via_excluded`・`n06_match` など。完全版にはすべて残っている |
| 辺・ノード数 | ノード 147、辺 210、IC 16（一般 14・スマート 2）、方向付きランプ 108 |

## 5. 限界・未確定事項

- **現実の道路との一致は未検証**です。構造検査の合格（`../build/verify_graph.js`）は OSM 内部の整合を見たもので、公式の構造との一致を保証しません。
- **公式の出入方向（片方向IC・スマートIC・SA/PA・JCT 8方向・渋谷出口の右折規制・圏央道の内回り／外回り名）はすべて一次資料（道路管理者の出入口案内等）確認待ち**です。大橋JCT経由の3号同一路線連絡4辺は `restriction.resolved:false`（通行可否が未確認）です。
- **SA/PA の場内通路**（段階5a-1′）：OSM の mapping 結果で、実際の通行可否（駐車場内の通り抜けなど）は未確認。SA/PA ノードの代表点は接続ノードの重心で道路上の点ではない。厚木PASIC（内回り）は、SIC 入口→SIC 出口が場内通路でつながらない（完全版 `graph_small.json` の `meta.sapa_geom.no_passage_pairs`。グラフは SA/PA ノードで両辺をつなぐので、この組合せは実在経路の裏付けがない）。SA/PA 接続辺の `geom` の長さ／`length_m` は 16 本中 15 本が 0.9〜1.1、`off.sapa230182519.7715004105` だけが 1.137。
- データの鮮度: OSM 2026-07-28（本体・SA/PA 場内通路とも同一の `osm_base`）、N06 2025-12-31 基準。この間の供用変更は反映されていません。
- 収録外の道路（新東名・小田原厚木道路・横浜北西線・第三京浜・中央環状線・都心環状線など）は含まれません。
