'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const zlib = require('zlib');

const PROD_DIR = path.resolve(__dirname, '../../production');

let cachedSourceFiles = null;
function loadProductionSources() {
  if (cachedSourceFiles) return cachedSourceFiles;
  const files = fs.readdirSync(PROD_DIR).filter(f => f.endsWith('.js')).sort();
  cachedSourceFiles = files.map(f => ({
    filename: f,
    code: fs.readFileSync(path.join(PROD_DIR, f), 'utf8')
  }));
  return cachedSourceFiles;
}

function makeSheet(name) {
  const data = []; // row 0 = header row (1-based row 1)
  return {
    _name: name,
    _data: data,
    getName() { return name; },
    getLastRow() { return data.length; },
    getLastColumn() { return data.length ? data[0].length : 0; },
    getMaxRows() { return Math.max(data.length, 100); },
    setFrozenRows() {},
    autoResizeColumns() {},
    appendRow(row) {
      data.push(row.map(v => (v === undefined ? '' : v)));
      return this;
    },
    deleteRow(rowIndex) {
      if (rowIndex < 1 || rowIndex > data.length) {
        throw new Error('Row out of bounds: ' + rowIndex);
      }
      data.splice(rowIndex - 1, 1);
    },
    getRange(row, col, numRows, numCols) {
      const r1 = row - 1;
      const c1 = col - 1;
      const nr = numRows || 1;
      const nc = numCols || 1;
      return {
        getValues() {
          const out = [];
          for (let r = 0; r < nr; r++) {
            const srcRow = data[r1 + r] || [];
            const line = [];
            for (let c = 0; c < nc; c++) {
              line.push(srcRow[c1 + c] === undefined ? '' : srcRow[c1 + c]);
            }
            out.push(line);
          }
          return out;
        },
        setValues(vals) {
          for (let r = 0; r < vals.length; r++) {
            while (data.length <= r1 + r) data.push([]);
            const dstRow = data[r1 + r];
            for (let c = 0; c < vals[r].length; c++) {
              dstRow[c1 + c] = vals[r][c] === undefined ? '' : vals[r][c];
            }
          }
          return this;
        },
        setValue(v) {
          while (data.length <= r1) data.push([]);
          data[r1][c1] = v === undefined ? '' : v;
          return this;
        },
        setFontWeight() { return this; },
        setBackground() { return this; },
        setNumberFormat() { return this; }
      };
    },
    getRangeList(a1s) {
      const sheet = this;
      function colToNum(letters) {
        let n = 0;
        for (let i = 0; i < letters.length; i++) {
          n = n * 26 + (letters.charCodeAt(i) - 64);
        }
        return n;
      }
      return {
        getRanges() {
          return a1s.map(a1 => {
            const m = a1.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
            if (!m) throw new Error('Bad A1 range: ' + a1);
            const c1 = colToNum(m[1]);
            const r1 = Number(m[2]);
            const c2 = colToNum(m[3]);
            const r2 = Number(m[4]);
            return sheet.getRange(r1, c1, r2 - r1 + 1, c2 - c1 + 1);
          });
        }
      };
    }
  };
}

function pad2(n) { return String(n).padStart(2, '0'); }

function formatDateTz(d, tz, fmt) {
  // Asia/Dhaka = UTC+6
  const dt = new Date(d.getTime() + 6 * 3600 * 1000);
  const yyyy = dt.getUTCFullYear();
  const MM = pad2(dt.getUTCMonth() + 1);
  const dd = pad2(dt.getUTCDate());
  const HH = pad2(dt.getUTCHours());
  const mm = pad2(dt.getUTCMinutes());
  const ss = pad2(dt.getUTCSeconds());
  if (fmt === 'yyyy-MM-dd') return `${yyyy}-${MM}-${dd}`;
  if (fmt === 'HH:mm:ss') return `${HH}:${mm}:${ss}`;
  if (fmt === 'yyyy') return `${yyyy}`;
  if (fmt === "yyyy-MM-dd'T'HH:mm:ss") return `${yyyy}-${MM}-${dd}T${HH}:${mm}:${ss}`;
  if (fmt === 'yyyy-MM-dd HH:mm:ss') return `${yyyy}-${MM}-${dd} ${HH}:${mm}:${ss}`;
  return `${yyyy}-${MM}-${dd}T${HH}:${mm}:${ss}`;
}

function createGasEnvironment(options = {}) {
  let nowMs = options.nowIso
    ? new Date(options.nowIso).getTime()
    : new Date('2026-11-15T10:00:00+06:00').getTime();

  const sheets = {};
  const docProps = {};
  const scriptProps = {};
  const scriptCache = {};
  const OrigDate = Date;

  const ss = {
    getSheetByName(name) { return sheets[name] || null; },
    insertSheet(name) {
      sheets[name] = makeSheet(name);
      return sheets[name];
    }
  };

  function makePropStore(store) {
    return {
      getProperty(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setProperty(k, v) { store[k] = String(v); },
      deleteProperty(k) { delete store[k]; }
    };
  }

  function buildExecutionContext() {
    class FakeDate extends OrigDate {
      constructor(...args) {
        if (args.length === 0) super(nowMs);
        else super(...args);
      }
      static now() { return nowMs; }
    }

    const sandbox = {
      console,
      Date: FakeDate,
      Math, Number, String, Boolean, Array, Object, JSON, RegExp, Error,
      TypeError, RangeError, isNaN, isFinite, parseInt, parseFloat, Set, Map,
      SpreadsheetApp: {
        getActiveSpreadsheet: () => ss,
        flush: () => {},
        getUi: () => ({ alert: () => {}, ButtonSet: { OK: 'OK' } })
      },
      LockService: {
        getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} })
      },
      PropertiesService: {
        getDocumentProperties: () => makePropStore(docProps),
        getScriptProperties: () => makePropStore(scriptProps)
      },
      CacheService: {
        getScriptCache: () => ({
          get: k => (Object.prototype.hasOwnProperty.call(scriptCache, k) ? scriptCache[k] : null),
          put: (k, v) => { scriptCache[k] = String(v); },
          remove: k => { delete scriptCache[k]; }
        })
      },
      Session: {
        getScriptTimeZone: () => 'Asia/Dhaka',
        getActiveUser: () => ({ getEmail: () => 'owner@test.local' })
      },
      Logger: { log: () => {} },
      Utilities: {
        formatDate: (d, tz, fmt) => formatDateTz(new OrigDate(d), tz, fmt),
        getUuid: () => crypto.randomUUID(),
        DigestAlgorithm: { SHA_256: 'SHA_256' },
        Charset: { UTF_8: 'UTF_8' },
        computeDigest: (alg, text) =>
          Array.from(crypto.createHash('sha256').update(String(text), 'utf8').digest())
            .map(b => (b > 127 ? b - 256 : b)),
        base64Encode: bytes =>
          Buffer.from(bytes.map(b => (b < 0 ? b + 256 : b))).toString('base64'),
        base64Decode: str => Array.from(Buffer.from(str, 'base64')),
        base64EncodeWebSafe: str => Buffer.from(String(str), 'utf8').toString('base64url'),
        base64DecodeWebSafe: str => Array.from(Buffer.from(str, 'base64url')),
        newBlob: data => {
          const buf = typeof data === 'string'
            ? Buffer.from(data, 'utf8')
            : Buffer.from(data.map(b => (b < 0 ? b + 256 : b)));
          return {
            getBytes: () => Array.from(buf),
            getDataAsString: () => buf.toString('utf8')
          };
        },
        gzip: blob => {
          const gz = zlib.gzipSync(Buffer.from(blob.getBytes().map(b => (b < 0 ? b + 256 : b))));
          return { getBytes: () => Array.from(gz) };
        },
        ungzip: blob => {
          const raw = zlib.gunzipSync(Buffer.from(blob.getBytes().map(b => (b < 0 ? b + 256 : b))));
          return { getDataAsString: () => raw.toString('utf8') };
        }
      }
    };
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    for (const src of loadProductionSources()) {
      vm.runInContext(src.code, ctx, { filename: src.filename });
    }
    return ctx;
  }

  const ctx = buildExecutionContext();
  ctx.setupSystem_();

  const adminToken = 'test-admin-token';
  ctx.appendRow_('USERS', {
    'User ID': 'USR-000001', 'Full Name': 'Admin Tester', 'Mobile Number': '01700000000',
    'Password Hash': 'x', 'Password Salt': 'x', 'Role': 'Administrator', 'Status': 'Active',
    'Created By': 'System', 'Created At': new OrigDate(nowMs), 'Last Login': new OrigDate(nowMs)
  });
  ctx.appendRow_('SESSIONS', {
    'Token': adminToken, 'User ID': 'USR-000001', 'Mobile Number': '01700000000',
    'Created At': new OrigDate(nowMs), 'Expires At': 'Never', 'Last Activity': new OrigDate(nowMs)
  });

  function setTime(iso) { nowMs = new OrigDate(iso).getTime(); }
  function advanceSeconds(sec) { nowMs += sec * 1000; }

  return {
    ctx,
    token: adminToken,
    sheets,
    scriptCache,
    docProps,
    scriptProps,
    setTime,
    advanceSeconds,
    /** Spawns a fresh Apps Script execution sharing the same Sheets/Properties/CacheService. */
    newRequestContext: buildExecutionContext
  };
}

function mustOk(res, label = 'RPC') {
  if (!res || res.success !== true) {
    throw new Error(`${label} failed: ${res ? res.message : 'null response'}`);
  }
  return res.data;
}

module.exports = { createGasEnvironment, mustOk };
