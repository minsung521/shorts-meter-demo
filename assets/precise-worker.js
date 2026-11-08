/* 정밀 측정: 유튜브 시청 기록(테이크아웃 zip / 시청 기록.html / watch-history.json)을 이 기기 안에서만 분석하는 Web Worker.
   - 파일은 어디에도 보내지 않음. 결과는 숫자만 돌려줌 (제목·채널·URL은 밖으로 나가지 않음)
   - 큰 HTML도 DOMParser 없이 문자열을 앞에서부터 차례로 훑어 영상 링크·시각·광고/커뮤니티/YouTube Music 여부만 뽑음
   - 쇼츠 판별(A방식): 시청 기록에는 쇼츠 표시가 없어서, 다음 기록까지 간격이 90초 이하인 시청이 3편 이상 이어진 구간을 쇼츠로 봄.
     제목에 #shorts / #쇼츠가 있으면 간격과 상관없이 쇼츠로 포함 */
importScripts('vendor/fflate.min.js');

const GAP_SEC = 90, RUN_MIN = 3, WINDOW_DAYS = 365, CHUNK = 1 << 20;   // 1MB씩 읽음
const DAY = 86400000;

// 시간대 약어 → UTC 기준 시간(시). 모르는 약어는 0으로 두되, 한 파일 안의 간격 계산에는 영향이 거의 없음
const TZ = { KST: 9, JST: 9, UTC: 0, GMT: 0, WET: 0, WEST: 1, BST: 1, CET: 1, CEST: 2, EET: 2, EEST: 3, MSK: 3, IST: 5.5, ICT: 7, WIB: 7, CST: -6, CDT: -5,
  HKT: 8, SGT: 8, AWST: 8, PHT: 8, AEST: 10, AEDT: 11, ACST: 9.5, ACDT: 10.5, NZST: 12, NZDT: 13, PST: -8, PDT: -7, MST: -7, MDT: -6, EST: -5, EDT: -4,
  AKST: -9, AKDT: -8, HST: -10, AST: -4, ADT: -3, NST: -3.5, NDT: -2.5, BRT: -3, ART: -3 };
const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Sept: 8, Oct: 9, Nov: 10, Dec: 11 };
const SP = '[\\s\\u00a0\\u202f]';
const RE_KO = /(\d{4})\. (\d{1,2})\. (\d{1,2})\. (오전|오후) (\d{1,2}):(\d{2}):(\d{2})(?:[\s  ]+([A-Z]{2,5}|GMT[+-]\d{1,2}(?::?\d{2})?))?/;
const RE_EN = new RegExp(`([A-Z][a-z]{2,3}) (\\d{1,2}), (\\d{4}),?${SP}+(\\d{1,2}):(\\d{2}):(\\d{2})${SP}*(AM|PM|am|pm)(?:${SP}+([A-Z]{2,5}|GMT[+-]\\d{1,2}(?::?\\d{2})?))?`);
const tzOffset = z => { if (!z) return 0; if (z in TZ) return TZ[z]; const m = /^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(z); return m ? (m[1] === '-' ? -1 : 1) * (+m[2] + (+m[3] || 0) / 60) : 0; };
function parseTime(s) {   // 한국어·영어 테이크아웃 HTML 시각 → 절대시각(ms)
  let m = RE_KO.exec(s);
  if (m) { const h = (+m[5] % 12) + (m[4] === '오후' ? 12 : 0); return Date.UTC(+m[1], +m[2] - 1, +m[3], h, +m[6], +m[7]) - tzOffset(m[8]) * 3600000; }
  m = RE_EN.exec(s);
  if (m && m[1] in MON) { const h = (+m[4] % 12) + (/pm/i.test(m[7]) ? 12 : 0); return Date.UTC(+m[3], MON[m[1]], +m[2], h, +m[5], +m[6]) - tzOffset(m[8]) * 3600000; }
  return null;
}
const HINT = /#\s?(shorts|쇼츠)/i;

/* ----- HTML: 'outer-cell' 단위로 순차 처리 ----- */
class HtmlScan {
  constructor() { this.buf = ''; this.ev = []; this.cells = 0; this.watched = 0; this.activity = false; }
  push(text, final) {
    if (!this.activity && /내 활동 내역|My Activity|outer-cell/.test(text)) this.activity = true;   // 구글 '내 활동' 형식 파일인지 (항목이 0개여도 시청 기록 파일)
    this.buf += text;
    let a = this.buf.indexOf('outer-cell');
    if (a < 0) { if (this.buf.length > 4096) this.buf = this.buf.slice(-64); return; }
    for (;;) {
      const b = this.buf.indexOf('outer-cell', a + 10);
      if (b < 0) break;
      this.cell(this.buf.slice(a, b)); a = b;
    }
    this.buf = this.buf.slice(a);
    if (final) { this.cell(this.buf); this.buf = ''; }
  }
  cell(c) {
    if (c.length < 20) return;
    this.cells++;
    const bi = c.indexOf('mdl-typography--body-1">');
    if (bi < 0) return;
    const be = c.indexOf('</div>', bi), body = c.slice(bi + 24, be < 0 ? undefined : be);
    const t = parseTime(body);
    if (t === null) return;
    const music = c.includes('mdl-typography--title">YouTube Music');
    const ad = c.includes('출처: Google 광고') || c.includes('From Google Ads') || body.includes('에서 본 광고');
    const watchedText = body.includes('시청했습니다') || /^\s*Watched[\s ]/.test(body);
    const watched = watchedText && !ad && !music;
    let hint = false;
    if (watched) {
      this.watched++;
      const tm = /watch\?v=[\w-]{11}"[^>]*>([^<]*)<\/a>/.exec(body);
      hint = !!(tm && HINT.test(tm[1]));
    }
    this.ev.push({ t, w: watched, h: hint });   // 광고·게시물 등도 시간축의 점으로는 남김 (쇼츠 피드 사이에 끼어 있으므로)
  }
}

/* ----- JSON (watch-history.json): 시각은 UTC ISO ----- */
function scanJson(text) {
  let arr; try { arr = JSON.parse(text); } catch (_) { return null; }
  if (!Array.isArray(arr)) return null;
  const r = { ev: [], cells: arr.length, watched: 0, activity: true };
  for (const e of arr) {
    if (!e || typeof e !== 'object') continue;
    const t = Date.parse(e.time); if (isNaN(t)) continue;
    const music = e.header === 'YouTube Music' || (Array.isArray(e.products) && e.products.includes('YouTube Music') && !e.products.includes('YouTube'));
    const ad = (e.details || []).some(d => /Google Ads|Google 광고/.test((d && d.name) || ''));
    const title = String(e.title || '');
    const watchedText = /시청했습니다/.test(title) || /^Watched\s/.test(title);
    const watched = watchedText && /watch\?v=/.test(String(e.titleUrl || '')) && !ad && !music;
    if (watched) r.watched++;
    r.ev.push({ t, w: watched, h: watched && HINT.test(title) });
  }
  return r;
}

/* ----- 쇼츠 판별 (A방식) ----- */
function analyze(scan) {
  const ev = scan.ev.slice();   // 파일 순서(최신이 위)를 유지한 채 시간순 정렬 (같은 초는 원래 순서)
  ev.sort((a, b) => a.t - b.t);
  if (!ev.length) return { empty: true };
  const last = ev[ev.length - 1].t;
  const win = ev.filter(e => e.t > last - WINDOW_DAYS * DAY);   // 최근 365일 (기록이 더 짧으면 있는 만큼)
  const first = win[0].t;
  const isShortA = new Uint8Array(win.length);
  let seq = [];
  const close = () => { if (seq.length >= RUN_MIN) for (const k of seq) isShortA[k] = 1; seq = []; };
  for (let i = 0; i < win.length; i++) {
    if (!win[i].w) continue;
    const g = i + 1 < win.length ? (win[i + 1].t - win[i].t) / 1000 : null;
    if (g !== null && g <= GAP_SEC) seq.push(i);
    else { if (seq.length) { seq.push(i); close(); } }
  }
  close();
  let watched = 0, shortsA = 0, shorts = 0, hints = 0;
  for (let i = 0; i < win.length; i++) {
    const e = win[i]; if (!e.w) continue;
    watched++; if (isShortA[i]) shortsA++; if (e.h) hints++;
    if (isShortA[i] || e.h) shorts++;
  }
  return { watched, shortsA, shorts, hintsExtra: shorts - shortsA, first, last, days: Math.max(1, Math.floor((last - first) / DAY)), longer: ev[0].t < last - WINDOW_DAYS * DAY };
}

/* ----- 파일 종류 판별 (이름이 아니라 내용으로) ----- */
const td = () => new TextDecoder('utf-8');
function sniff(u8) {
  if (u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04) return 'zip';
  let i = 0; if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) i = 3;   // UTF-8 BOM
  while (i < u8.length && (u8[i] === 0x20 || u8[i] === 0x0a || u8[i] === 0x0d || u8[i] === 0x09)) i++;
  const head = new TextDecoder('utf-8', { fatal: false }).decode(u8.subarray(i, i + 4096));
  if (head[0] === '[' || head[0] === '{') return 'json';
  if (/<html|<!doctype|<div|<head/i.test(head)) return 'html';
  return 'other';
}

let lastP = -1;
const progress = p => { const q = Math.min(99, Math.floor(p * 100)); if (q !== lastP) { lastP = q; postMessage({ type: 'progress', p: q }); } };

async function readDirect(file, kind) {
  const dec = td();
  if (kind === 'json') {
    let text = ''; for (let pos = 0; pos < file.size; pos += CHUNK) { text += dec.decode(new Uint8Array(await file.slice(pos, pos + CHUNK).arrayBuffer()), { stream: true }); progress(pos / file.size * 0.8); }
    text += dec.decode(); return scanJson(text);
  }
  const sc = new HtmlScan();
  for (let pos = 0; pos < file.size; pos += CHUNK) {
    const u8 = new Uint8Array(await file.slice(pos, pos + CHUNK).arrayBuffer()), end = pos + CHUNK >= file.size;
    sc.push(dec.decode(u8, { stream: !end }), end); progress((pos + u8.length) / file.size * 0.95);
  }
  return sc;
}

async function readZip(file) {
  // zip 안의 .html/.htm/.json 파일을 모두 순차로 풀며 훑고, 시청 기록 항목이 가장 많은 파일을 고름 (파일명 인코딩이 깨져도 확장자·내용으로 판단)
  const cands = []; let failed = null;
  const uz = new fflate.Unzip();
  uz.register(fflate.UnzipInflate);
  uz.onfile = f => {
    if (!/\.(html?|json)$/i.test(f.name)) return;   // 시작하지 않은 파일은 건너뜀
    const c = { kind: null, dec: td(), scan: null, json: '' }; cands.push(c);
    f.ondata = (err, dat, final) => {
      if (err) { failed = err; return; }
      if (!c.kind) { c.kind = sniff(dat); if (c.kind === 'html') c.scan = new HtmlScan(); }
      const text = c.dec.decode(dat, { stream: !final });
      if (c.kind === 'html') c.scan.push(text, final);
      else if (c.kind === 'json') { c.json += text; if (final) { c.scan = scanJson(c.json); c.json = ''; } }
    };
    f.start();
  };
  for (let pos = 0; pos < file.size; pos += CHUNK) {
    const u8 = new Uint8Array(await file.slice(pos, pos + CHUNK).arrayBuffer());
    uz.push(u8, pos + CHUNK >= file.size);
    if (failed) throw failed;
    progress((pos + u8.length) / file.size * 0.95);
  }
  const best = cands.filter(c => c.scan && c.scan.activity).sort((a, b) => b.scan.watched - a.scan.watched || b.scan.ev.length - a.scan.ev.length)[0];
  return best ? { scan: best.scan, kind: best.kind } : null;
}

onmessage = async ({ data: file }) => {
  try {
    if (!file || !file.size) return postMessage({ type: 'error', code: 'empty-file' });
    const head = new Uint8Array(await file.slice(0, 8192).arrayBuffer()), kind = sniff(head);
    let scan, format;
    if (kind === 'zip') {
      let got; try { got = await readZip(file); } catch (_) { return postMessage({ type: 'error', code: 'broken-zip' }); }
      if (!got) return postMessage({ type: 'error', code: 'not-history' });
      scan = got.scan; format = 'zip/' + got.kind;
    } else if (kind === 'html' || kind === 'json') {
      scan = await readDirect(file, kind); format = kind;
      if (!scan) return postMessage({ type: 'error', code: 'broken-json' });
    } else return postMessage({ type: 'error', code: 'not-history' });
    if (!scan.activity) return postMessage({ type: 'error', code: 'not-history' });   // 시청 기록 형식이 아님
    if (!scan.ev.length) return postMessage({ type: 'error', code: 'no-watch', format, items: scan.cells });   // 형식은 맞는데 기록이 비어 있음
    const r = analyze(scan);
    if (r.empty || !r.watched) return postMessage({ type: 'error', code: 'no-watch', format, items: scan.cells });
    postMessage({ type: 'done', result: { format, items: scan.cells, ...r } });
  } catch (e) {
    postMessage({ type: 'error', code: 'unknown' });
  }
};
