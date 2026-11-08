#!/usr/bin/env python3
"""Extract unthinned active N06 lines and joints for a ledger bbox + 5 km.

Usage: python3 -I -B n06_extract_region.py DIR LEDGER OUT
Standard library only. Source feature indices are zero based; coordinates of
sections are preserved verbatim. Joint fields/distance match n06_extract.py.
"""
import hashlib
import json
import math
from pathlib import Path
import sys

SOURCE = '「国土数値情報（高速道路時系列データ）」（国土交通省）（https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N06-2025.html）（2026年11月1日取得）を加工して作成'
LICENSE = 'CC BY 4.0（2025年度整備データを2025年12月31日時点の現況データとして使用）'
KOJ = {'1': '一般IC', '2': 'スマートIC', '3': 'JCT', '4': 'その他'}
def lines(g):
    if g['type'] == 'LineString': return [g['coordinates']]
    if g['type'] == 'MultiLineString': return g['coordinates']
    raise ValueError('unsupported section geometry: ' + g['type'])
def inside(p, b):
    return b['lngMin'] <= p[0] <= b['lngMax'] and b['latMin'] <= p[1] <= b['latMax']
def distance(p, a, b):
    kx = 111320 * math.cos(math.radians(p[1]))
    ax, ay = (a[0]-p[0])*kx, (a[1]-p[1])*110574
    bx, by = (b[0]-p[0])*kx, (b[1]-p[1])*110574
    dx, dy = bx-ax, by-ay
    size = dx*dx+dy*dy
    t = max(0, min(1, -(ax*dx+ay*dy)/size)) if size else 0
    return math.hypot(ax+t*dx, ay+t*dy)
def extract(directory, ledger):
    original = ledger['bbox']
    dx, dy = 5000/(111320*math.cos(math.radians(34.85))), 5000/110574
    box = {k:v + (-1 if k.endswith('Min') else 1)*(dy if k.startswith('lat') else dx) for k,v in original.items()}
    source_files, docs = [], []
    for name in ('N06-25_HighwaySection.geojson', 'N06-25_Joint.geojson'):
        raw = (directory/name).read_bytes()
        source_files.append({'file':name, 'sha256':hashlib.sha256(raw).hexdigest()})
        docs.append(json.loads(raw)['features'])
    sections, segments, grid = [], [], {}
    # A degree grid is only a conservative candidate filter. Exact distance
    # determines membership. Section selection is by vertices, not intersection.
    cell = .02
    for i,f in enumerate(docs[0]):
        pr, g = f['properties'], f['geometry']
        if str(pr['N06_003']) != '9999' or not any(inside(p, box) for l in lines(g) for p in l): continue
        sections.append({'source_index':i, 'n06_id':pr['N06_004'], 'name':pr['N06_007'], 'geometry':g})
        for l in lines(g):
            for a,b in zip(l,l[1:]):
                idx = len(segments); segments.append((pr['N06_007'], a, b))
                for x in range(math.floor(min(a[0],b[0])/cell), math.floor(max(a[0],b[0])/cell)+1):
                    for y in range(math.floor(min(a[1],b[1])/cell), math.floor(max(a[1],b[1])/cell)+1): grid.setdefault((x,y), []).append(idx)
    joints = []
    for f in docs[1]:
        pr, c = f['properties'], f['geometry']['coordinates']
        if str(pr['N06_014']) != '9999' or not inside(c, box): continue
        x,y = math.floor(c[0]/cell),math.floor(c[1]/cell)
        indices = {i for ix in range(x-1,x+2) for iy in range(y-1,y+2) for i in grid.get((ix,iy),())}
        near = {}
        for i in sorted(indices):
            name,a,b = segments[i]; d = distance(c,a,b)
            if d <= 300 and d < near.get(name, math.inf): near[name] = d
        if near:
            joints.append({'n06_id':pr['N06_015'], 'name':pr['N06_018'], 'koj':pr['N06_019'],
                'koj_label':KOJ.get(pr['N06_019'],'?'), 'open_year':pr['N06_012'],
                'lng':round(c[0],6), 'lat':round(c[1],6), 'routes':{k:round(v) for k,v in sorted(near.items())}})
    joints.sort(key=lambda x:(min(x['routes']), x['lng'], x['n06_id'], x['open_year']))
    meta = {'source':SOURCE, 'license':LICENSE,
        'file':'N06-25_GML.zip sha256 742c8785dfb2f900f167972abe00d5c36103365c0f9fb11dc8a883aa358ac23e',
        'base_date':'2025-12-31', 'source_files':source_files,
        'filter':'区間: N06_003=9999・5 km拡張矩形内の頂点を含む。接合部: N06_014=9999・拡張矩形内・選択線形から300m以内。区間の座標は無間引き・無丸め。',
        'bbox':original, 'expanded_bbox':box, 'margin_m':5000, 'source_index_base':0,
        'routes':sorted({s['name'] for s in sections}), 'section_count':len(sections),
        'line_count':sum(len(lines(s['geometry'])) for s in sections), 'segment_count':len(segments), 'count':len(joints)}
    return {'meta':meta, 'joints':joints, 'sections':sections}
def main():
    directory, ledger, output = map(Path, sys.argv[1:])
    result = extract(directory, json.loads(ledger.read_text()))
    output.write_text(json.dumps(result, ensure_ascii=False, indent=1)+'\n')
    print(json.dumps({k:result['meta'][k] for k in ('section_count','line_count','segment_count','count')}))
if __name__ == '__main__': main()
