import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_FILE);
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const requireFromProject = createRequire(path.join(PROJECT_ROOT, 'package.json'));
const BUILD_DIR = path.join(PROJECT_ROOT, 'build', 'web-mobile');
const CHANNELS = ['facebook', 'google', 'tiktok', 'mintegral', 'unityads', 'applovin', 'ironsource', 'kwai', 'vungle', 'snap'];
const BRIDGE_JS = fs.readFileSync(path.join(SCRIPT_DIR, 'bridge.playable-sdk.js'), 'utf8');

// These files are inlined directly into HTML, so do not duplicate them into PACK.
const INLINE_FILES = new Set([
  'style.css',
  'src/polyfills.bundle.js',
  'src/system.bundle.js',
  'src/import-map.json',
]);

const COMPRESSIBLE_IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

let jimpModuleCache;
let jimpLoadErrorCache = null;

function parseBooleanLike(raw, fallback = true) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return fallback;
}

function resolveOutputDirFromArgs(args = process.argv.slice(2)) {
  const key = '--out-dir';
  const idx = args.indexOf(key);
  if (idx >= 0 && args[idx + 1]) {
    const raw = String(args[idx + 1]);
    return path.isAbsolute(raw) ? raw : path.resolve(PROJECT_ROOT, raw);
  }
  return path.join(PROJECT_ROOT, 'dist-playable');
}

function resolveCompressImagesFromArgs(args = process.argv.slice(2)) {
  const key = '--compress-images';
  const idx = args.indexOf(key);
  if (idx < 0) return true;
  return parseBooleanLike(args[idx + 1], true);
}

function resolveImageQualityFromArgs(args = process.argv.slice(2)) {
  const key = '--image-quality';
  const idx = args.indexOf(key);
  if (idx < 0) return 72;
  const n = Number(args[idx + 1]);
  if (!Number.isFinite(n)) return 72;
  return Math.max(1, Math.min(100, Math.round(n)));
}

function isMainModule() {
  try {
    if (!process.argv[1]) return false;
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function relFromBuild(abs) {
  return toPosix(path.relative(BUILD_DIR, abs));
}

function readText(rel) {
  return fs.readFileSync(path.join(BUILD_DIR, rel), 'utf8');
}

function readBufByAbs(abs) {
  return fs.readFileSync(abs);
}

function escapeInlineScript(source) {
  // Prevent HTML parser from prematurely closing inline <script> blocks.
  return String(source).replace(/<\/script/gi, '<\\/script');
}

function escapeInlineStyle(source) {
  return String(source).replace(/<\/style/gi, '<\\/style');
}

function guessMime(rel) {
  const ext = path.extname(rel).toLowerCase();
  return ({
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.json': 'application/json',
    '.css': 'text/css',
    '.html': 'text/html',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.bin': 'application/octet-stream',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.mp4': 'video/mp4',
    '.wasm': 'application/wasm',
  }[ext] || 'application/octet-stream');
}

function shouldPack(rel) {
  if (rel === 'index.html') return false;
  if (INLINE_FILES.has(rel)) return false;
  return true;
}

function isCompressibleImage(rel, mime) {
  const ext = path.extname(rel).toLowerCase();
  if (!COMPRESSIBLE_IMAGE_EXT.has(ext)) return false;
  return /^image\//i.test(String(mime || ''));
}

async function loadJimpModule() {
  if (jimpModuleCache !== undefined) return { jimp: jimpModuleCache, error: jimpLoadErrorCache };
  try {
    const mod = await import('jimp');
    jimpModuleCache = mod;
    jimpLoadErrorCache = null;
  } catch (importErr) {
    try {
      const mod = requireFromProject('jimp');
      jimpModuleCache = mod;
      jimpLoadErrorCache = null;
    } catch (requireErr) {
      jimpLoadErrorCache = requireErr || importErr || null;
      jimpModuleCache = null;
    }
  }
  return { jimp: jimpModuleCache, error: jimpLoadErrorCache };
}

function formatErrorMessage(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err && typeof err.message === 'string' && err.message.trim()) return err.message;
  return String(err);
}

function getJimpApi(jimpModule) {
  if (!jimpModule) return null;
  const Jimp = jimpModule.Jimp || jimpModule.default || jimpModule;
  const JimpMime = jimpModule.JimpMime || jimpModule.default?.JimpMime || {};
  return { Jimp, JimpMime };
}

function asBuffer(data) {
  if (!data) return null;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  return Buffer.from(data);
}

async function getJimpBuffer(image, mime, options) {
  if (typeof image.getBufferAsync === 'function') {
    return asBuffer(await image.getBufferAsync(mime, options));
  }

  if (typeof image.getBuffer !== 'function') {
    throw new Error('Jimp image instance does not support getBuffer().');
  }

  try {
    const out = await image.getBuffer(mime, options);
    if (out) return asBuffer(out);
  } catch {
    // Fall through to callback-style API handling.
  }

  return await new Promise((resolve, reject) => {
    const done = (err, out) => {
      if (err) return reject(err);
      resolve(asBuffer(out));
    };
    if (image.getBuffer.length >= 3) image.getBuffer(mime, options, done);
    else image.getBuffer(mime, done);
  });
}

async function compressImageWithJimp(rel, buf, quality, jimpModule) {
  const ext = path.extname(rel).toLowerCase();
  const { Jimp, JimpMime } = getJimpApi(jimpModule) || {};
  if (!Jimp || typeof Jimp.read !== 'function') {
    throw new Error('Invalid Jimp module shape.');
  }

  // Current Jimp ecosystem support for webp is not stable across releases.
  if (ext === '.webp') {
    return buf;
  }

  const image = await Jimp.read(buf);

  if (ext === '.png') {
    const pngMime = JimpMime?.png || 'image/png';
    return getJimpBuffer(image, pngMime, { compressionLevel: 9 });
  }

  if (ext === '.jpg' || ext === '.jpeg') {
    const jpegMime = JimpMime?.jpeg || JimpMime?.jpg || 'image/jpeg';
    return getJimpBuffer(image, jpegMime, { quality });
  }

  return buf;
}

async function resolveImageCompressor(compressImages) {
  if (!compressImages) return { compressor: null, warning: null };
  const { jimp, error: jimpErr } = await loadJimpModule();
  if (jimp) {
    return {
      compressor: {
        name: 'jimp',
        encode: (rel, buf, quality) => compressImageWithJimp(rel, buf, quality, jimp),
      },
      warning: null,
    };
  }

  const warning = `[pack-single-html] compression skipped: jimp unavailable (${formatErrorMessage(jimpErr)})`;
  return { compressor: null, warning };
}

async function buildBinaryPack(compressImages, imageQuality) {
  const files = walk(BUILD_DIR);
  /** @type {Record<string, [number, number]>} */
  const manifest = {};
  /** @type {Buffer[]} */
  const chunks = [];
  let blobOffset = 0;
  const stats = {
    compressedCount: 0,
    originalBytes: 0,
    compressedBytes: 0,
    packedBytes: 0,
    fileCount: 0,
    compressor: 'none',
  };

  const { compressor, warning } = await resolveImageCompressor(compressImages);
  if (compressImages && compressor) stats.compressor = compressor.name;
  if (warning) {
    console.warn(warning);
  }

  for (const abs of files) {
    const rel = relFromBuild(abs);
    if (!shouldPack(rel)) continue;

    let buf = readBufByAbs(abs);
    const mime = guessMime(rel);

    if (compressImages && compressor && isCompressibleImage(rel, mime)) {
      stats.originalBytes += buf.length;
      try {
        const compressed = await compressImageBuffer(rel, buf, imageQuality, compressor);
        if (compressed.length < buf.length) {
          buf = compressed;
          stats.compressedCount += 1;
        }
      } catch (err) {
        console.warn(`[pack-single-html] compress fail ${rel}: ${err && err.message ? err.message : err}`);
      }
      stats.compressedBytes += buf.length;
    }

    manifest[rel] = [blobOffset, buf.length];
    chunks.push(buf);
    blobOffset += buf.length;
    stats.fileCount += 1;
    stats.packedBytes += buf.length;
  }

  return {
    manifest,
    blob: Buffer.concat(chunks),
    stats,
  };
}

async function compressImageBuffer(rel, buf, quality, compressor) {
  const next = asBuffer(await compressor.encode(rel, buf, quality));
  if (!next || next.length >= buf.length) return buf;
  return next;
}


function makeVfsPatchScript() {
  return String.raw`
(function(){
  const LEGACY_PACK = window.__PACKED_FILES__ || {};
  const BIN_MANIFEST = window.__PACK_MANIFEST__ || {};
  const BIN_BLOB = window.__PACK_BLOB__ || null;
  const PACK_KEYS = Array.from(new Set(Object.keys(LEGACY_PACK).concat(Object.keys(BIN_MANIFEST))));
  const RESOLVE_CACHE = Object.create(null);
  const ORIGIN_FETCH = window.fetch ? window.fetch.bind(window) : null;

  const B64_TABLE = new Int16Array(128).fill(-1);
  for (let i = 0; i < 26; i++) {
    B64_TABLE[65 + i] = i; // A-Z
    B64_TABLE[97 + i] = 26 + i; // a-z
  }
  for (let i = 0; i < 10; i++) B64_TABLE[48 + i] = 52 + i; // 0-9
  B64_TABLE[43] = 62; // +
  B64_TABLE[47] = 63; // /

  function b64ToBytes(b64){
    let clean = String(b64 || '')
      .replace(/\s+/g, '')
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .replace(/[^A-Za-z0-9+/=]/g, '');

    if (!clean) return new Uint8Array(0);

    clean = clean.replace(/=+$/g, '');
    if (clean.length % 4 === 1) clean = clean.slice(0, -1);
    if (clean.length % 4) clean += '='.repeat(4 - (clean.length % 4));

    let pad = 0;
    if (clean.endsWith('==')) pad = 2;
    else if (clean.endsWith('=')) pad = 1;

    const outLen = Math.max(0, ((clean.length >> 2) * 3) - pad);
    const out = new Uint8Array(outLen);
    let outIndex = 0;

    for (let i = 0; i < clean.length; i += 4) {
      const c1 = clean.charCodeAt(i);
      const c2 = clean.charCodeAt(i + 1);
      const c3 = clean.charCodeAt(i + 2);
      const c4 = clean.charCodeAt(i + 3);

      const v1 = c1 < 128 ? B64_TABLE[c1] : -1;
      const v2 = c2 < 128 ? B64_TABLE[c2] : -1;
      const v3 = c3 === 61 ? 0 : (c3 < 128 ? B64_TABLE[c3] : -1);
      const v4 = c4 === 61 ? 0 : (c4 < 128 ? B64_TABLE[c4] : -1);
      if (v1 < 0 || v2 < 0 || v3 < 0 || v4 < 0) throw new Error('Invalid base64 character');

      const n = (v1 << 18) | (v2 << 12) | (v3 << 6) | v4;
      if (outIndex < outLen) out[outIndex++] = (n >> 16) & 255;
      if (c3 !== 61 && outIndex < outLen) out[outIndex++] = (n >> 8) & 255;
      if (c4 !== 61 && outIndex < outLen) out[outIndex++] = n & 255;
    }

    return out;
  }

  function bytesToUtf8(u8){
    if (typeof TextDecoder !== 'undefined') {
      return new TextDecoder().decode(u8);
    }
    let out = '';
    for (let i = 0; i < u8.length; i++) out += '%' + u8[i].toString(16).padStart(2, '0');
    return decodeURIComponent(out);
  }

  function utf8ToBytes(str){
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(str);
    }
    const encoded = unescape(encodeURIComponent(str));
    const out = new Uint8Array(encoded.length);
    for (let i = 0; i < encoded.length; i++) out[i] = encoded.charCodeAt(i);
    return out;
  }

  function latin1ToBytes(str){
    const s = String(str || '');
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
    return out;
  }

  function getHit(rel){
    if (!rel) return null;
    if (Object.prototype.hasOwnProperty.call(LEGACY_PACK, rel)) return LEGACY_PACK[rel];
    if (Object.prototype.hasOwnProperty.call(BIN_MANIFEST, rel)) return BIN_MANIFEST[rel];
    return null;
  }

  function getEntryBytes(hit){
    if (!hit) return null;
    if (Array.isArray(hit) && hit.length >= 2) {
      const o = Number(hit[0]);
      const l = Number(hit[1]);
      if (!Number.isFinite(o) || !Number.isFinite(l) || o < 0 || l < 0) return null;
      if (!BIN_BLOB || typeof BIN_BLOB.subarray !== 'function') return null;
      const end = o + l;
      if (end > BIN_BLOB.length) return null;
      return BIN_BLOB.subarray(o, end);
    }
    if (hit && typeof hit === 'object' && hit.o != null && hit.l != null) {
      const o = Number(hit.o);
      const l = Number(hit.l);
      if (!Number.isFinite(o) || !Number.isFinite(l) || o < 0 || l < 0) return null;
      if (!BIN_BLOB || typeof BIN_BLOB.subarray !== 'function') return null;
      const end = o + l;
      if (end > BIN_BLOB.length) return null;
      return BIN_BLOB.subarray(o, end);
    }
    if (hit.text != null) return utf8ToBytes(hit.text);
    if (hit.b64 != null) return b64ToBytes(hit.b64);
    if (hit.bin != null) return latin1ToBytes(hit.bin);
    return null;
  }

  function getEntryText(hit){
    if (!hit) return null;
    if (hit.text != null) return String(hit.text);
    if (hit.b64 != null) return bytesToUtf8(b64ToBytes(hit.b64));
    if (hit.bin != null) return bytesToUtf8(latin1ToBytes(hit.bin));
    const bytes = getEntryBytes(hit);
    if (!bytes) return null;
    return bytesToUtf8(bytes);
  }

  function stripQueryHash(u){
    const s = String(u);
    return s.split('#')[0].split('?')[0];
  }

  function collapsePath(p){
    const segs = String(p || '').replace(/\\/g, '/').split('/');
    const out = [];
    for (const seg of segs) {
      if (!seg || seg === '.') continue;
      if (seg === '..') {
        if (out.length) out.pop();
        continue;
      }
      out.push(seg);
    }
    return out.join('/');
  }

  function norm(input){
    try {
      let url = (input && typeof input === 'object' && 'url' in input) ? input.url : input;
      if (url == null) return null;
      if (typeof url !== 'string') url = String(url);
      url = stripQueryHash(url);
      if (/^(data:|blob:|javascript:)/i.test(url)) return null;
      if (/^https?:\/\//i.test(url)) {
        const U = new URL(url);
        url = U.pathname;
      } else if (/^file:\/\//i.test(url)) {
        const U = new URL(url);
        url = decodeURIComponent(U.pathname || '');
        if (/^\/[A-Za-z]:\//.test(url)) url = url.slice(1);
      }
      url = url.replace(/^\//, '');
      if (url.startsWith('./')) url = url.slice(2);
      return collapsePath(url);
    } catch (e) {
      return null;
    }
  }

  function has(rel){
    return rel && getHit(rel) != null;
  }

  function resolveRel(rel){
    if (!rel) return null;
    if (Object.prototype.hasOwnProperty.call(RESOLVE_CACHE, rel)) {
      return RESOLVE_CACHE[rel];
    }

    let normalized = collapsePath(rel);
    if (has(normalized)) {
      RESOLVE_CACHE[rel] = normalized;
      return normalized;
    }

    normalized = normalized.replace(/^(\.\.\/)+/, '');
    if (has(normalized)) {
      RESOLVE_CACHE[rel] = normalized;
      return normalized;
    }

    for (let i = 0; i < PACK_KEYS.length; i++) {
      const key = PACK_KEYS[i];
      if (normalized === key || normalized.endsWith('/' + key)) {
        RESOLVE_CACHE[rel] = key;
        return key;
      }
    }

    RESOLVE_CACHE[rel] = null;
    return null;
  }

  function guessMime(rel){
    const extMatch = /\.([^.\/]+)$/.exec(String(rel || '').toLowerCase());
    const ext = extMatch ? '.' + extMatch[1] : '';
    return ({
      '.js': 'text/javascript',
      '.mjs': 'text/javascript',
      '.json': 'application/json',
      '.css': 'text/css',
      '.html': 'text/html',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.mp3': 'audio/mpeg',
      '.ogg': 'audio/ogg',
      '.wav': 'audio/wav',
      '.bin': 'application/octet-stream',
      '.ttf': 'font/ttf',
      '.otf': 'font/otf',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.mp4': 'video/mp4',
      '.wasm': 'application/wasm',
    }[ext] || 'application/octet-stream');
  }

  function getEntryMime(rel, hit){
    if (hit && typeof hit === 'object' && typeof hit.mime === 'string' && hit.mime) return hit.mime;
    return guessMime(rel);
  }

  function isScriptLike(rel, hit){
    const mime = String(getEntryMime(rel, hit) || '').toLowerCase();
    return /javascript|ecmascript/.test(mime) || /\.(m?js)$/i.test(String(rel || ''));
  }

  function patchSystemShouldFetch(){
    try {
      const S = window.System;
      if (!S || !S.constructor || !S.constructor.prototype) return;
      const proto = S.constructor.prototype;
      if (proto.__vfsPatchedShouldFetch__) return;

      const originalShouldFetch = typeof proto.shouldFetch === 'function'
        ? proto.shouldFetch
        : function(){ return false; };
      const originalSystemFetch = typeof proto.fetch === 'function'
        ? proto.fetch
        : null;

      proto.shouldFetch = function(url){
        const rel = resolveRel(norm(url));
        if (rel) {
          const hit = getHit(rel);
          if (hit && getEntryText(hit) != null && isScriptLike(rel, hit)) return true;
        }
        return originalShouldFetch.call(this, url);
      };

      proto.fetch = function(url, init){
        const rel = resolveRel(norm(url));
        if (rel) {
          const response = toResponse(rel, init);
          if (response) return Promise.resolve(response);
        }
        if (originalSystemFetch) return originalSystemFetch.call(this, url, init);
        if (ORIGIN_FETCH) return ORIGIN_FETCH(url, init);
        return Promise.reject(new Error('No fetch available'));
      };

      proto.__vfsPatchedShouldFetch__ = true;
    } catch (e) {}
  }

  function patchScriptSrc(){
    try {
      const proto = window.HTMLScriptElement && window.HTMLScriptElement.prototype;
      if (!proto || proto.__vfsPatchedScriptSrc__) return;

      const desc = Object.getOwnPropertyDescriptor(proto, 'src');
      if (!desc || typeof desc.set !== 'function') return;

      const origGet = desc.get;
      const origSet = desc.set;

      Object.defineProperty(proto, 'src', {
        configurable: true,
        enumerable: !!desc.enumerable,
        get: function(){
          return origGet ? origGet.call(this) : '';
        },
        set: function(v){
          const rel = resolveRel(norm(v));
          const hit = rel && getHit(rel);
          const scriptText = hit && isScriptLike(rel, hit) ? getEntryText(hit) : null;
          if (scriptText != null) {
            const URL_API = window.URL || window.webkitURL;
            if (URL_API && typeof URL_API.createObjectURL === 'function') {
              const blob = new Blob([scriptText], { type: getEntryMime(rel, hit) || 'text/javascript' });
              const objectURL = URL_API.createObjectURL(blob);
              if (typeof this.addEventListener === 'function') {
                const self = this;
                const cleanup = function(){
                  try { URL_API.revokeObjectURL(objectURL); } catch (e) {}
                  try { self.removeEventListener('load', cleanup); } catch (e) {}
                  try { self.removeEventListener('error', cleanup); } catch (e) {}
                };
                this.addEventListener('load', cleanup);
                this.addEventListener('error', cleanup);
              }
              return origSet.call(this, objectURL);
            }
          }
          return origSet.call(this, v);
        }
      });

      if (typeof proto.setAttribute === 'function' && !proto.__vfsPatchedScriptSetAttribute__) {
        const origSetAttribute = proto.setAttribute;
        proto.setAttribute = function(name, value){
          if (String(name || '').toLowerCase() === 'src') {
            this.src = value;
            return;
          }
          return origSetAttribute.call(this, name, value);
        };
        proto.__vfsPatchedScriptSetAttribute__ = true;
      }

      proto.__vfsPatchedScriptSrc__ = true;
    } catch (e) {}
  }

  function patchScriptInsertion(){
    function patchScriptNode(node){
      try {
        if (!node || !node.tagName || String(node.tagName).toLowerCase() !== 'script') return;

        let src = '';
        try {
          if (typeof node.getAttribute === 'function') src = node.getAttribute('src') || '';
        } catch (e) {}
        if (!src) {
          try { src = node.src || ''; } catch (e) {}
        }

        const rel = resolveRel(norm(src));
        const hit = rel && getHit(rel);
        const scriptText = hit && isScriptLike(rel, hit) ? getEntryText(hit) : null;
        if (scriptText == null) return;

        try { if (typeof node.removeAttribute === 'function') node.removeAttribute('src'); } catch (e) {}
        try { node.text = scriptText; } catch (e) { try { node.textContent = scriptText; } catch (e2) {} }
      } catch (e) {}
    }

    try {
      const NP = window.Node && window.Node.prototype;
      if (!NP) return;

      if (typeof NP.appendChild === 'function' && !NP.__vfsPatchedAppendChild__) {
        const origAppendChild = NP.appendChild;
        NP.appendChild = function(node){
          patchScriptNode(node);
          return origAppendChild.call(this, node);
        };
        NP.__vfsPatchedAppendChild__ = true;
      }

      if (typeof NP.insertBefore === 'function' && !NP.__vfsPatchedInsertBefore__) {
        const origInsertBefore = NP.insertBefore;
        NP.insertBefore = function(node, refNode){
          patchScriptNode(node);
          return origInsertBefore.call(this, node, refNode);
        };
        NP.__vfsPatchedInsertBefore__ = true;
      }
    } catch (e) {}
  }

  function toResponse(rel, init){
    const hit = getHit(rel);
    if (!hit) return null;

    const bytes = getEntryBytes(hit);
    if (!bytes && hit.text == null) return null;
    const body = hit.text != null ? String(hit.text) : bytes;

    const headers = new Headers((init && init.headers) || {});
    if (!headers.has('Content-Type')) headers.set('Content-Type', getEntryMime(rel, hit));
    return new Response(body, { status: 200, headers });
  }

  if (ORIGIN_FETCH) {
    window.fetch = function(input, init){
      const rel = resolveRel(norm(input));
      if (rel) {
        const response = toResponse(rel, init);
        if (response) return Promise.resolve(response);
      }
      return ORIGIN_FETCH(input, init);
    };
  }

  patchSystemShouldFetch();
  patchScriptSrc();
  patchScriptInsertion();

  const XHR = window.XMLHttpRequest;
  if (XHR) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    const setRequestHeader = XHR.prototype.setRequestHeader;

    XHR.prototype.open = function(method, url, async, user, password){
      this.__vfs_method__ = method;
      this.__vfs_url__ = url;
      this.__vfs_async__ = async;
      this.__vfs_user__ = user;
      this.__vfs_password__ = password;
      this.__vfs_headers__ = [];
      return open.apply(this, arguments);
    };

    XHR.prototype.setRequestHeader = function(name, value){
      if (this.__vfs_headers__) this.__vfs_headers__.push([name, value]);
      return setRequestHeader.apply(this, arguments);
    };

    XHR.prototype.send = function(body){
      const rel = resolveRel(norm(this.__vfs_url__));
      const hit = rel && getHit(rel);
      if (!hit) return send.apply(this, arguments);

      const URL_API = window.URL || window.webkitURL;
      if (!URL_API || typeof URL_API.createObjectURL !== 'function') {
        return send.apply(this, arguments);
      }

      try {
        const mime = getEntryMime(rel, hit);
        const bytes = getEntryBytes(hit);
        if (!bytes && hit.text == null) return send.apply(this, arguments);
        const payload = hit.text != null ? String(hit.text) : bytes;
        const blob = new Blob([payload], { type: mime });
        const objectURL = URL_API.createObjectURL(blob);
        const self = this;

        const cleanup = function(){
          try { URL_API.revokeObjectURL(objectURL); } catch (e) {}
          if (typeof self.removeEventListener === 'function') {
            try { self.removeEventListener('loadend', cleanup); } catch (e) {}
            try { self.removeEventListener('error', cleanup); } catch (e) {}
            try { self.removeEventListener('abort', cleanup); } catch (e) {}
          }
        };

        if (typeof this.addEventListener === 'function') {
          this.addEventListener('loadend', cleanup);
          this.addEventListener('error', cleanup);
          this.addEventListener('abort', cleanup);
        }

        const method = this.__vfs_method__ || 'GET';
        const asyncFlag = this.__vfs_async__;
        const user = this.__vfs_user__;
        const password = this.__vfs_password__;
        const headers = Array.isArray(this.__vfs_headers__) ? this.__vfs_headers__.slice() : [];

        if (asyncFlag === undefined) {
          open.call(this, method, objectURL);
        } else {
          open.call(this, method, objectURL, asyncFlag, user, password);
        }

        for (let i = 0; i < headers.length; i++) {
          const pair = headers[i];
          try { setRequestHeader.call(this, pair[0], pair[1]); } catch (e) {}
        }

        return send.call(this, body == null ? null : body);
      } catch (e) {
        return send.apply(this, arguments);
      }
    };
  }

  const _Image = window.Image;
  if (_Image) {
    const desc = Object.getOwnPropertyDescriptor(_Image.prototype, 'src');
    window.Image = function(w, h){
      const img = new _Image(w, h);
      if (desc && desc.set) {
        Object.defineProperty(img, 'src', {
          set(v){
            const rel = resolveRel(norm(v));
            const hit = rel && getHit(rel);
            if (hit) {
              if (hit && typeof hit === 'object' && hit.b64) {
                return desc.set.call(img, 'data:' + getEntryMime(rel, hit) + ';base64,' + hit.b64);
              }
              const bytes = getEntryBytes(hit);
              if (bytes) {
                const b = new Blob([bytes], { type: getEntryMime(rel, hit) });
                const URL_API = window.URL || window.webkitURL;
                if (URL_API && typeof URL_API.createObjectURL === 'function') {
                  const objectURL = URL_API.createObjectURL(b);
                  return desc.set.call(img, objectURL);
                }
              }
            }
            return desc.set.call(img, v);
          }
        });
      }
      return img;
    };
    window.Image.prototype = _Image.prototype;
  }
})();`.trim();
}

function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
}

function inlineHtml(channel, manifest, blob) {
  let html = fs.readFileSync(path.join(BUILD_DIR, 'index.html'), 'utf8');
  const manifestJson = JSON.stringify(manifest);
  const blobB64 = blob.toString('base64');
  const PACK_CHUNK_SIZE = 256 * 1024;

  const blobB64Chunks = [];
  for (let i = 0; i < blobB64.length; i += PACK_CHUNK_SIZE) {
    blobB64Chunks.push(blobB64.slice(i, i + PACK_CHUNK_SIZE));
  }
  const packedChunkTags = blobB64Chunks
    .map((chunk, idx) => `<script class="__PACK_BIN_CHUNK__" data-idx="${idx}" type="application/octet-stream">${chunk}</script>`)
    .join('\n');
  const manifestTag = `<script id="__PACK_MANIFEST__" type="application/octet-stream">${escapeInlineScript(manifestJson)}</script>`;

  const packedBootstrap = `<script>(function(){
  const nodes = document.querySelectorAll('script.__PACK_BIN_CHUNK__');
  const manifestNode = document.getElementById('__PACK_MANIFEST__');
  let b64 = '';
  for (let i = 0; i < nodes.length; i++) {
    b64 += nodes[i].textContent || '';
  }
  b64 = b64.replace(/\\s+/g, '');
  const manifestText = manifestNode ? (manifestNode.textContent || '{}') : '{}';
  const B64_TABLE = new Int16Array(128).fill(-1);
  for (let i = 0; i < 26; i++) {
    B64_TABLE[65 + i] = i;
    B64_TABLE[97 + i] = 26 + i;
  }
  for (let i = 0; i < 10; i++) B64_TABLE[48 + i] = 52 + i;
  B64_TABLE[43] = 62;
  B64_TABLE[47] = 63;
  function b64ToBytes(input){
    let clean = String(input || '')
      .replace(/\\s+/g, '')
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .replace(/[^A-Za-z0-9+/=]/g, '');

    if (!clean) return new Uint8Array(0);

    clean = clean.replace(/=+$/g, '');
    if (clean.length % 4 === 1) clean = clean.slice(0, -1);
    if (clean.length % 4) clean += '='.repeat(4 - (clean.length % 4));

    let pad = 0;
    if (clean.endsWith('==')) pad = 2;
    else if (clean.endsWith('=')) pad = 1;

    const outLen = Math.max(0, ((clean.length >> 2) * 3) - pad);
    const out = new Uint8Array(outLen);
    let off = 0;
    for (let i = 0; i < clean.length; i += 4) {
      const c1 = clean.charCodeAt(i);
      const c2 = clean.charCodeAt(i + 1);
      const c3 = clean.charCodeAt(i + 2);
      const c4 = clean.charCodeAt(i + 3);
      const v1 = c1 < 128 ? B64_TABLE[c1] : -1;
      const v2 = c2 < 128 ? B64_TABLE[c2] : -1;
      const v3 = c3 === 61 ? 0 : (c3 < 128 ? B64_TABLE[c3] : -1);
      const v4 = c4 === 61 ? 0 : (c4 < 128 ? B64_TABLE[c4] : -1);
      if (v1 < 0 || v2 < 0 || v3 < 0 || v4 < 0) throw new Error('Invalid base64 character');

      const n = (v1 << 18) | (v2 << 12) | (v3 << 6) | v4;
      if (off < outLen) out[off++] = (n >> 16) & 255;
      if (c3 !== 61 && off < outLen) out[off++] = (n >> 8) & 255;
      if (c4 !== 61 && off < outLen) out[off++] = n & 255;
    }
    return out;
  }
  try {
    window.__PACK_MANIFEST__ = JSON.parse(manifestText);
    window.__PACK_BLOB__ = b64ToBytes(b64);
    if (!window.__PACKED_FILES__) window.__PACKED_FILES__ = {};
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i] && nodes[i].parentNode) nodes[i].parentNode.removeChild(nodes[i]);
    }
    if (manifestNode && manifestNode.parentNode) manifestNode.parentNode.removeChild(manifestNode);
  } catch (e) {
    console.error('[pack-single-html] binary pack parse failed:', e && e.message ? e.message : e);
    window.__PACK_MANIFEST__ = {};
    window.__PACK_BLOB__ = new Uint8Array(0);
    window.__PACKED_FILES__ = window.__PACKED_FILES__ || {};
  }
})();</script>`;

  if (!/<link[^>]+rel=["']icon["']/i.test(html)) {
    html = html.replace(/<head>/i, '<head>\n  <link rel="icon" href="data:,">');
  }

  if (fs.existsSync(path.join(BUILD_DIR, 'style.css'))) {
    const css = readText('style.css');
    html = html.replace(/<link[^>]+href="style\.css"[^>]*>/i, `<style>\n${escapeInlineStyle(css)}\n</style>`);
  }

  html = html.replace(
    /<script[^>]*src="src\/polyfills\.bundle\.js"[^>]*>\s*<\/script>/i,
    `<script>\n${escapeInlineScript(readText('src/polyfills.bundle.js'))}\n</script>`
  );

  html = html.replace(
    /<script[^>]*src="src\/system\.bundle\.js"[^>]*>\s*<\/script>/i,
    `<script>\n${escapeInlineScript(readText('src/system.bundle.js'))}\n</script>`
  );

  html = html.replace(
    /<script[^>]*src="src\/import-map\.json"[^>]*type="systemjs-importmap"[^>]*>\s*<\/script>/i,
    `<script type="systemjs-importmap">\n${readText('src/import-map.json').replace(/<\/script/gi, '<\\/script')}\n</script>`
  );

  const injected =
`<script>window.__CHANNEL__=${JSON.stringify(channel)};</script>
${manifestTag}
${packedChunkTags}
${packedBootstrap}
<script>${escapeInlineScript(makeVfsPatchScript())}</script>
<script>${escapeInlineScript(BRIDGE_JS)}</script>
`;

  html = html.replace(
    /<script[^>]*>\s*System\.import\((['"])\.\/index\.js\1\)[\s\S]*?<\/script>/i,
    injected + '\n$&'
  );

  html = html.replace(/<title>.*?<\/title>/i, `<title>Playable-${channel}-${sha1(channel + String(Object.keys(manifest).length))}</title>`);

  return html;
}

export async function packSingleHtml(options = {}) {
  const requestedOutDir = String(options.outDir || resolveOutputDirFromArgs());
  const outDir = path.isAbsolute(requestedOutDir)
    ? requestedOutDir
    : path.resolve(PROJECT_ROOT, requestedOutDir);
  const compressImages = typeof options.compressImages === 'boolean'
    ? options.compressImages
    : resolveCompressImagesFromArgs();
  const imageQuality = Number.isFinite(options.imageQuality)
    ? Math.max(1, Math.min(100, Math.round(options.imageQuality)))
    : resolveImageQualityFromArgs();
  fs.mkdirSync(outDir, { recursive: true });

  const { manifest, blob, stats } = await buildBinaryPack(compressImages, imageQuality);
  const writtenFiles = [];
  for (const ch of CHANNELS) {
    const out = inlineHtml(ch, manifest, blob);
    const outPath = path.join(outDir, `${ch}.html`);
    fs.writeFileSync(outPath, out, 'utf8');
    console.log('written:', outPath);
    writtenFiles.push(outPath);
  }

  if (compressImages && stats.compressor !== 'none') {
    const saved = Math.max(0, stats.originalBytes - stats.compressedBytes);
    console.log(`[pack-single-html] compressed=${stats.compressedCount} saved=${saved}B q=${imageQuality} via=${stats.compressor}`);
  }

  return {
    outDir,
    files: writtenFiles,
    bundle: {
      fileCount: stats.fileCount,
      packedBytes: stats.packedBytes,
    },
    imageCompression: {
      enabled: compressImages,
      quality: imageQuality,
      compressor: stats.compressor,
      compressedCount: stats.compressedCount,
      originalBytes: stats.originalBytes,
      compressedBytes: stats.compressedBytes,
    },
  };
}

if (isMainModule()) {
  packSingleHtml().catch((err) => {
    console.error('[pack-single-html] failed:', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  });
}
