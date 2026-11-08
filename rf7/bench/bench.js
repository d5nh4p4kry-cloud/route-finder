(function (root) {
  'use strict';
  const VERSION = 'rf7-bench 1.0.0';
  const FILES = [
    {key: 'engine', path: '../engine.js', bytes: 55563, sha256: '1943ca3603ed0fdf51633f24945533d78d615bd33f6d83aebab2748921a7f4b7', type: 'script', global: 'RFEngine'},
    {key: 'adapter', path: '../rf7-adapter.js', bytes: 149933, sha256: '679c8095ae0653a19eaf7d1014ffb5dc591d4c358d32a5992d3d4df0a269e1d2', type: 'script', global: 'RF7Adapter'},
    {key: 'small', path: '../data/graph-small.app.json', bytes: 90679, sha256: '6123d26b203104b9bf6cd84c96eded8cceeee654bd815466187feffbf119338a', type: 'json'},
    {key: 'kanto', path: '../data/graph-kanto.app.json', bytes: 2129855, sha256: '2ff841fa8c83f5c28a918ba0ee817be9072552daf235cf7ad74798249975eeb3', type: 'json'}
  ];
  const ORIGIN = {lat: 35.6036, lng: 139.5076};
  const ODS = [
    {name: '渋谷', lat: 35.65644, lng: 139.69981},
    {name: '厚木', lat: 35.4457, lng: 139.366},
    {name: '日光', icName: '日光'}
  ];
  const REPEAT = 3;

  function makeLoad(fetchFn, baseHref) {
    return async function load(p) {
      if (!FILES.some(f => f.path === p)) throw new Error('未定義のファイル');
      const u = new URL(p, baseHref);
      if (u.origin !== new URL(baseHref).origin) throw new Error('origin の不一致');
      const r = await fetchFn(u.href, {cache: 'no-store', redirect: 'error'});
      if (!r.ok) throw new Error('ファイルの取得失敗');
      if (r.redirected || r.url !== u.href) throw new Error('転送または URL の不一致');
      const bytes = new Uint8Array(await r.arrayBuffer());
      return {bytes, text: new TextDecoder().decode(bytes)};
    };
  }

  async function checkFiles(env) {
    const files = [], by = {};
    for (const f of FILES) {
      const start = env.now();
      const data = await env.load(f.path);
      const fetchMs = env.now() - start;
      const sha256 = await env.sha256(data.bytes);
      const row = {key: f.key, path: f.path, bytes: data.bytes.byteLength, sha256,
        match: sha256 === f.sha256 && data.bytes.byteLength === f.bytes, fetchMs};
      files.push(row);
      by[f.key] = Object.assign({}, row, {text: data.text, rawBytes: data.bytes});
    }
    return {files, by};
  }

  async function measure(env, text) {
    const rows = [];
    for (let i = 0; i < REPEAT; i++) {
      const start = env.now();
      const g = JSON.parse(text);
      const parsed = env.now();
      const valid = env.E.validateGraph(g);
      const validated = env.now();
      const hash = await env.sha256(env.utf8(JSON.stringify({nodes: g.nodes, edges: g.edges, ics: g.ics})));
      const hashed = env.now();
      env.A.indexGraph(g);
      const indexed = env.now();
      rows.push({parseMs: parsed - start, validateMs: validated - parsed, hashMs: hashed - validated,
        indexMs: indexed - hashed, totalMs: indexed - start, ok: valid.ok, contentOk: hash === g.meta.content_sha256});
    }
    return rows;
  }

  async function runMain(env) {
    const checked = await checkFiles(env);
    for (const f of FILES.filter(f => f.type === 'script')) {
      if (!checked.by[f.key].match) throw new Error('script の不一致: ' + f.key);
    }
    await env.install(checked.by);
    const small = await measure(env, checked.by.small.text);
    const kanto = await measure(env, checked.by.kanto.text);
    const g = JSON.parse(checked.by.kanto.text);
    const enumerate = [];
    for (const od of ODS) {
      let destination = {lat: od.lat, lng: od.lng};
      if (od.icName) {
        const matches = g.ics.filter(ic => ic.name === od.icName);
        if (matches.length !== 1) throw new Error('IC 名の件数の不一致: ' + od.icName);
        destination = {lat: matches[0].lat, lng: matches[0].lng};
      }
      const start = env.now();
      const result = env.E.enumerate(g, ORIGIN, destination);
      enumerate.push({name: od.name, ms: env.now() - start, truncated: result.truncated,
        candidates: result.candidates.length, labels: result.stats.labelsCreated});
    }
    return {version: VERSION, ua: env.ua, files: checked.files, small, kanto, enumerate};
  }

  function makeX2(g) {
    const copy = JSON.parse(JSON.stringify({nodes: g.nodes, edges: g.edges, ics: g.ics}));
    for (const node of copy.nodes) {
      node.id = 'x2.' + node.id;
      if (Object.hasOwn(node, 'ic_id')) node.ic_id = 'x2.' + node.ic_id;
    }
    for (const edge of copy.edges) {
      for (const key of ['id', 'from', 'to']) edge[key] = 'x2.' + edge[key];
      if (Object.hasOwn(edge, 'ic_id')) edge.ic_id = 'x2.' + edge.ic_id;
    }
    for (const ic of copy.ics) ic.ic_id = 'x2.' + ic.ic_id;
    return {schema: g.schema, meta: g.meta, nodes: g.nodes.concat(copy.nodes),
      edges: g.edges.concat(copy.edges), ics: g.ics.concat(copy.ics)};
  }

  function runX2(env, text) {
    const g = makeX2(JSON.parse(text));
    const start = env.now();
    const valid = env.E.validateGraph(g);
    const validated = env.now();
    env.A.indexGraph(g);
    const indexed = env.now();
    const indexMs = indexed - validated;
    return {version: VERSION, ua: env.ua, nodes: g.nodes.length, edges: g.edges.length,
      validateOk: valid.ok, errors: valid.errors.slice(0, 3), warnings: valid.warnings.length,
      validateMs: validated - start, indexMs, over30s: indexMs > 30000};
  }

  const api = {VERSION, FILES, ORIGIN, ODS, REPEAT, makeLoad, checkFiles, measure, runMain, makeX2, runX2};
  root.RF7Bench = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof self !== 'undefined' ? self : globalThis));
