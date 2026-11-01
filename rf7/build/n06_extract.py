#!/usr/bin/env python3
"""N06-25（高速道路時系列）から小グラフ対象路線の現役接合部を抽出する。
現況データとして使用（設置期間終了=9999、2025-12-31時点）→ CC BY 4.0。
使い方: python3 -I n06_extract.py <N06 UTF-8 dir> <out.json>"""
import json, sys, math
d, outp = sys.argv[1], sys.argv[2]
ROUTES = ['第一東海自動車道', '首都圏中央連絡自動車道', '首都高速3号渋谷線']
BB = (139.30, 35.38, 139.76, 35.68)  # lng0, lat0, lng1, lat1
KOJ = {'1': '一般IC', '2': 'スマートIC', '3': 'JCT', '4': 'その他'}
def lines(g):
    return [g['coordinates']] if g['type'] == 'LineString' else g['coordinates']
def dist_m(a, b):
    la = math.radians((a[1] + b[1]) / 2)
    return math.hypot((a[0] - b[0]) * 111320 * math.cos(la), (a[1] - b[1]) * 110574)
def seg_d(p, a, b):
    la = math.radians(p[1]); kx = 111320 * math.cos(la); ky = 110574
    ax, ay = (a[0]-p[0])*kx, (a[1]-p[1])*ky; bx, by = (b[0]-p[0])*kx, (b[1]-p[1])*ky
    dx, dy = bx-ax, by-ay; L = dx*dx+dy*dy
    t = 0 if L == 0 else max(0, min(1, -(ax*dx+ay*dy)/L))
    return math.hypot(ax+t*dx, ay+t*dy)
def inb(c): return BB[0] <= c[0] <= BB[2] and BB[1] <= c[1] <= BB[3]
S = json.load(open(d + '/N06-25_HighwaySection.geojson', encoding='utf-8'))['features']
J = json.load(open(d + '/N06-25_Joint.geojson', encoding='utf-8'))['features']
secs = [(f['properties']['N06_007'], l) for f in S if f['properties']['N06_003'] == 9999
        and f['properties']['N06_007'] in ROUTES for l in lines(f['geometry'])]
out = []
for f in J:
    p = f['properties']; c = f['geometry']['coordinates']
    if p['N06_014'] != 9999 or not inb(c): continue
    near = {}
    for rn, l in secs:
        for a, b in zip(l, l[1:]):
            dd = seg_d(c, a, b)
            if dd <= 300 and dd < near.get(rn, 1e9): near[rn] = dd
    if not near: continue
    out.append({'n06_id': p['N06_015'], 'name': p['N06_018'], 'koj': p['N06_019'],
                'koj_label': KOJ.get(p['N06_019'], '?'), 'open_year': p['N06_012'],
                'lng': round(c[0], 6), 'lat': round(c[1], 6),
                'routes': {k: round(v) for k, v in sorted(near.items())}})
out.sort(key=lambda x: (min(x['routes']), x['lng']))
meta = {'source': '「国土数値情報（高速道路時系列データ）」（国土交通省）'
        '（https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N06-2025.html）（2026年11月1日取得）を加工して作成',
        'license': 'CC BY 4.0（2025年度整備データを2025年12月31日時点の現況データとして使用）',
        'file': 'N06-25_GML.zip sha256 742c8785dfb2f900f167972abe00d5c36103365c0f9fb11dc8a883aa358ac23e',
        'base_date': '2025-12-31', 'filter': '設置期間終了=9999・路線線形から300m以内・bbox ' + str(BB),
        'routes': ROUTES, 'count': len(out)}
json.dump({'meta': meta, 'joints': out}, open(outp, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(len(out))
for x in out: print(x['koj_label'], x['name'], x['routes'], x['lat'], x['lng'])
