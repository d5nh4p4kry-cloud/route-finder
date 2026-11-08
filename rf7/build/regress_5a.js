#!/usr/bin/env node
/*
 * 段階5a 回帰試験 R1（計画 §3.2）。Node の版に依存する記録だけを除いて比較する。
 * node regress_5a.js --mode sapa|nosapa --out <再生成先> --base <基準ディレクトリ>
 * sapa: 同名の基準ファイル、nosapa: 基準の *.bak.20261101b を使用する。
 * 比較対象は6ファイル。読み込み・形式・比較の失敗は終了コード1、引数不正は2。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILES = Object.freeze([
  'graph_small.json', 'graph_small.osm-only.json', 'graph_small.app.json',
  'ic_match.json', 'unmatched.json', 'build_report.json',
]);
const GRAPH_FILES = FILES.slice(0, 3);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function objectAt(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' がオブジェクトでない');
  }
  return value;
}

function builtWithOf(filename, graph) {
  const meta = objectAt(objectAt(graph, filename).meta, filename + '.meta');
  const holder = filename === 'graph_small.app.json'
    ? objectAt(meta.derived_from, filename + '.meta.derived_from') : meta;
  const value = holder.built_with;
  if (typeof value !== 'string' || !value.startsWith('Node v')) {
    throw new Error(filename + ' の built_with が「Node v」で始まる文字列でない');
  }
  return value;
}

/**
 * 許可された差だけを除いた出力書式のバイト列。
 * 入力 Buffer を変更せず、JSON のキー順・配列順・その他すべての値を保持する。
 * verify_graph.js の (g) も同じ関数を使用する。
 */
function normalizedBytes(filename, bytes) {
  if (!FILES.includes(filename)) throw new Error('比較対象外のファイル: ' + filename);
  if (!GRAPH_FILES.includes(filename)) return bytes;
  const graph = JSON.parse(bytes.toString('utf8'));
  builtWithOf(filename, graph);
  if (filename === 'graph_small.app.json') {
    delete graph.meta.derived_from.built_with;
    delete graph.meta.derived_from.sha256;
    delete graph.meta.derived_from.bytes;
    return Buffer.from(JSON.stringify(graph) + '\n', 'utf8');
  }
  delete graph.meta.built_with;
  return Buffer.from(JSON.stringify(graph, null, 1) + '\n', 'utf8');
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!['--mode', '--out', '--base'].includes(key) ||
        options[key] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error('不正な引数: ' + key);
    }
    options[key] = argv[i + 1];
  }
  if (!['sapa', 'nosapa'].includes(options['--mode']) || !options['--out'] || !options['--base']) {
    throw new Error('--mode sapa|nosapa、--out、--base が必要');
  }
  return { mode: options['--mode'], out: options['--out'], base: options['--base'] };
}

function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(argv); }
  catch (error) {
    console.error(error.message);
    console.error('usage: node regress_5a.js --mode sapa|nosapa --out <dir> --base <dir>');
    return 2;
  }
  let passed = 0, failed = 0;
  function check(name, test) {
    try {
      const detail = test();
      passed++;
      console.log('PASS ' + name + (detail ? '  ' + detail : ''));
    } catch (error) {
      failed++;
      console.log('FAIL ' + name + '  ' + error.message);
    }
  }
  function assert(ok, message) { if (!ok) throw new Error(message); }
  const suffix = options.mode === 'nosapa' ? '.bak.20261101b' : '';
  const bytes = { out: new Map(), base: new Map() };
  function read(side, filename) {
    const cache = bytes[side];
    if (!cache.has(filename)) {
      cache.set(filename, fs.readFileSync(path.join(options[side], filename + (side === 'base' ? suffix : ''))));
    }
    return cache.get(filename);
  }
  const json = (side, filename) => JSON.parse(read(side, filename).toString('utf8'));
  console.log('R1 mode=' + options.mode + ' baseline_suffix=' + (suffix || '(同名)'));

  for (const filename of GRAPH_FILES) {
    for (const side of ['base', 'out']) {
      check(filename + ' ' + side + ' built_with', () => builtWithOf(filename, json(side, filename)));
    }
  }
  for (const filename of FILES) {
    const normalized = GRAPH_FILES.includes(filename);
    check(filename + (normalized ? ' 正規化バイト一致' : ' 生バイト一致'), () => {
      const a = normalizedBytes(filename, read('out', filename));
      const b = normalizedBytes(filename, read('base', filename));
      assert(a.equals(b), '出力と基準が不一致 (out=' + sha256(a) + ', base=' + sha256(b) + ')');
      return 'sha256=' + sha256(a);
    });
  }
  check('軽量版 derived_from.sha256 が再生成完全版の生バイトと一致', () => {
    const derived = objectAt(json('out', 'graph_small.app.json').meta.derived_from, 'derived_from');
    const expected = sha256(read('out', 'graph_small.json'));
    assert(derived.sha256 === expected, 'derived_from.sha256 が不一致');
    return expected;
  });
  check('軽量版 derived_from.bytes が再生成完全版の生バイト数と一致', () => {
    const derived = objectAt(json('out', 'graph_small.app.json').meta.derived_from, 'derived_from');
    const expected = read('out', 'graph_small.json').length;
    assert(derived.bytes === expected, 'derived_from.bytes が不一致');
    return String(expected);
  });
  check('軽量版 meta.content_sha256 が保存済みの値と一致', () => {
    const current = json('out', 'graph_small.app.json').meta.content_sha256;
    const saved = json('base', 'graph_small.app.json').meta.content_sha256;
    assert(typeof saved === 'string' && /^[0-9a-f]{64}$/.test(saved), '保存済み content_sha256 が SHA-256 でない');
    assert(current === saved, 'content_sha256 が不一致');
    return saved;
  });
  console.log('R1 ' + (failed === 0 ? 'PASS' : 'FAIL') + ': ' + passed + ' passed, ' + failed + ' failed');
  return failed === 0 ? 0 : 1;
}

if (require.main === module) process.exitCode = main();
module.exports = { normalizedBytes, FILES };
