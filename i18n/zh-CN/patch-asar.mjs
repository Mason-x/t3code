#!/usr/bin/env node
/**
 * Patches T3 Code's resources/app.asar and resources/app-update.yml for Simplified Chinese (zh-CN)
 * and redirects electron-updater to the forked GitHub repository.
 *
 * Hybrid 2-Layer Architecture:
 *  1. Static AST/Lexer bundle patching: safely translates unambiguous UI string literals in client JS
 *     chunks and `label:` menu entries in Electron `main.cjs` (strictly guarding Effect `_tag`s & enums).
 *  2. Scoped Runtime DOM Translator (`/zh-cn-i18n.js` packed into `app.asar` and loaded before React):
 *     translates React-Compiler hoisted words, server-sent provider messages, dynamic `${...}` templates,
 *     relative timestamps, and `placeholder`/`title`/`aria-label` attributes, while strictly excluding
 *     `.chat-markdown`, composer editor, code/diffs, terminals, and `.font-mono` identifiers.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {
    resourcesDir: null,
    dictPath: path.join(__dirname, "dict.json"),
    owner: process.env.T3CODE_ZH_OWNER || "Mason-x",
    repo: process.env.T3CODE_ZH_REPO || "t3code",
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--resources-dir" && argv[i + 1]) args.resourcesDir = argv[++i];
    else if (a === "--dict" && argv[i + 1]) args.dictPath = argv[++i];
    else if (a === "--owner" && argv[i + 1]) args.owner = argv[++i];
    else if (a === "--repo" && argv[i + 1]) args.repo = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "-h" || a === "--help") {
      console.log(
        "Usage: node patch-asar.mjs --resources-dir <dir> [--dict <dict.json>] [--owner <owner>] [--repo <repo>] [--dry-run]",
      );
      process.exit(0);
    }
  }
  if (!args.resourcesDir) {
    throw new Error("--resources-dir is required");
  }
  return args;
}

// ---------- ASAR reader/writer ----------

function readAsar(asarPath) {
  const buf = fs.readFileSync(asarPath);
  if (buf.length < 16) throw new Error(`Invalid ASAR file: ${asarPath}`);
  const headerSize = buf.readUInt32LE(4);
  const jsonStrLen = buf.readUInt32LE(12);
  const dataStart = 8 + headerSize;
  const jsonText = buf.subarray(16, 16 + jsonStrLen).toString("utf8");
  const tree = JSON.parse(jsonText);
  return { buf, dataStart, tree };
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function computeIntegrity(buffer, blockSize = 4194304) {
  const hash = sha256Hex(buffer);
  const blocks = [];
  if (buffer.length === 0) {
    blocks.push(hash);
  } else {
    for (let offset = 0; offset < buffer.length; offset += blockSize) {
      blocks.push(sha256Hex(buffer.subarray(offset, Math.min(offset + blockSize, buffer.length))));
    }
  }
  return {
    algorithm: "SHA256",
    hash,
    blockSize,
    blocks,
  };
}

function ensureTreeFileNode(rootTree, relPath) {
  const segments = relPath.split("/");
  let curr = rootTree;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (!curr.files) curr.files = {};
    if (!curr.files[seg]) curr.files[seg] = { files: {} };
    curr = curr.files[seg];
  }
  const leaf = segments[segments.length - 1];
  if (!curr.files) curr.files = {};
  if (!curr.files[leaf]) {
    curr.files[leaf] = {
      size: 0,
      offset: "0",
      integrity: {
        algorithm: "SHA256",
        hash: "",
        blockSize: 4194304,
        blocks: [],
      },
    };
  }
}

function writeAsar(asarPath, origAsar, modifiedFiles, addedPaths = []) {
  const newTree = structuredClone(origAsar.tree);
  for (const added of addedPaths) {
    ensureTreeFileNode(newTree, added);
  }

  const chunks = [];
  let currentOffset = 0;

  function visit(node, relPath) {
    if (!node || typeof node !== "object") return;
    if (node.files) {
      for (const name of Object.keys(node.files)) {
        const childRel = relPath ? `${relPath}/${name}` : name;
        visit(node.files[name], childRel);
      }
      return;
    }
    if (node.link !== undefined || node.unpacked) {
      return;
    }
    if (typeof node.size === "number" && node.offset !== undefined) {
      let fileBuf;
      if (modifiedFiles.has(relPath)) {
        fileBuf = modifiedFiles.get(relPath);
      } else {
        const origStart = origAsar.dataStart + Number(node.offset);
        fileBuf = origAsar.buf.subarray(origStart, origStart + node.size);
      }
      node.size = fileBuf.length;
      node.offset = String(currentOffset);
      if (node.integrity) {
        node.integrity = computeIntegrity(fileBuf, node.integrity.blockSize || 4194304);
      }
      chunks.push(fileBuf);
      currentOffset += fileBuf.length;
    }
  }

  visit(newTree, "");

  const jsonBuf = Buffer.from(JSON.stringify(newTree), "utf8");
  const jsonLen = jsonBuf.length;
  const padding = (4 - (jsonLen % 4)) % 4;
  const jsonPayloadSize = 4 + jsonLen + padding;
  const headerSize = 4 + jsonPayloadSize;

  const headerBuf = Buffer.alloc(8 + headerSize, 0);
  headerBuf.writeUInt32LE(4, 0);
  headerBuf.writeUInt32LE(headerSize, 4);
  headerBuf.writeUInt32LE(jsonPayloadSize, 8);
  headerBuf.writeUInt32LE(jsonLen, 12);
  jsonBuf.copy(headerBuf, 16);

  const outBuf = Buffer.concat([headerBuf, ...chunks]);
  fs.writeFileSync(asarPath, outBuf);
  return outBuf.length;
}

// ---------- Runtime Scoped DOM Translator generator ----------

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildCompiledTemplates(templatesObj = {}) {
  const byFirstWord = {};
  const leadingVar = [];

  for (const [enTpl, zhTpl] of Object.entries(templatesObj)) {
    if (!enTpl || !zhTpl || enTpl === zhTpl) continue;
    const stripped = enTpl.replace(/\{\d+\}/g, "").trim();
    if (stripped.length < 3 || !/[A-Za-z]{2,}/.test(stripped)) continue;

    const tokens = enTpl.split(/(\{\d+\})/g);
    const order = [];
    let regexSrc = "^";
    let longestStatic = "";

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (!tok) continue;
      const m = /^\{(\d+)\}$/.exec(tok);
      if (m) {
        order.push(Number(m[1]));
        const isLast = tokens.slice(i + 1).every((t) => t === "");
        regexSrc += isLast ? "(.+)" : "(.+?)";
      } else {
        regexSrc += escapeRegex(tok);
        if (tok.length > longestStatic.length) longestStatic = tok;
      }
    }
    regexSrc += "$";

    if (order.length === 0) continue;

    const firstToken = tokens[0] || "";
    const wordMatch = /^([A-Za-z]+)/.exec(firstToken.trimStart());
    const entry = { r: regexSrc, o: order, z: zhTpl, a: longestStatic };

    if (wordMatch && firstToken === firstToken.trimStart()) {
      const key = wordMatch[1];
      if (!byFirstWord[key]) byFirstWord[key] = [];
      byFirstWord[key].push(entry);
    } else {
      if (longestStatic.trim().length >= 3) {
        leadingVar.push(entry);
      }
    }
  }

  return { byFirstWord, leadingVar };
}

function generateRuntimeDomScript(dict) {
  const compiled = buildCompiledTemplates(dict.templates || {});
  const payload = JSON.stringify({
    exact: dict.exact || {},
    prefixes: dict.patterns || [],
    byFirstWord: compiled.byFirstWord,
    leadingVar: compiled.leadingVar,
  });

  return `(() => {
  "use strict";
  if (typeof window === "undefined" || window.__T3CODE_ZH_CN_ACTIVE__) return;
  window.__T3CODE_ZH_CN_ACTIVE__ = true;

  const DATA = ${payload};
  const EXACT = DATA.exact;
  const PREFIXES = DATA.prefixes;

  // Pre-compile template regexes lazily per bucket
  const WORD_BUCKETS = new Map();
  for (const [word, list] of Object.entries(DATA.byFirstWord)) {
    WORD_BUCKETS.set(word, list.map((e) => ({ re: new RegExp(e.r), o: e.o, z: e.z, a: e.a })));
  }
  const LEADING_VAR = DATA.leadingVar.map((e) => ({ re: new RegExp(e.r), o: e.o, z: e.z, a: e.a }));

  // Built-in relative time & common count rules
  const BUILTIN_RULES = [
    [/^just now$/i, () => "刚刚"],
    [/^yesterday$/i, () => "昨天"],
    [/^(\\d+)\\s*s(?:ec(?:ond)?s?)?\\s+ago$/i, (m) => m[1] + " 秒前"],
    [/^(\\d+)\\s*m(?:in(?:ute)?s?)?\\s+ago$/i, (m) => m[1] + " 分钟前"],
    [/^(\\d+)\\s*h(?:(?:ou)?rs?)?\\s+ago$/i, (m) => m[1] + " 小时前"],
    [/^(\\d+)\\s*d(?:ays?)?\\s+ago$/i, (m) => m[1] + " 天前"],
    [/^(\\d+)\\s*w(?:(?:ee)?ks?)?\\s+ago$/i, (m) => m[1] + " 周前"],
    [/^(\\d+)\\s*mo(?:nths?)?\\s+ago$/i, (m) => m[1] + " 个月前"],
    [/^(\\d+)\\s*y(?:(?:ea)?rs?)?\\s+ago$/i, (m) => m[1] + " 年前"],
    [/^(\\d+)\\s+files?\\s+changed$/i, (m) => m[1] + " 个文件已更改"],
    [/^(\\d+)\\s+files?$/i, (m) => m[1] + " 个文件"],
    [/^(\\d+)\\s+folders?$/i, (m) => m[1] + " 个文件夹"],
    [/^(\\d+)\\s+projects?$/i, (m) => m[1] + " 个项目"],
    [/^(\\d+)\\s+threads?$/i, (m) => m[1] + " 个 Threads"],
    [/^(\\d+)\\s+commits?$/i, (m) => m[1] + " 个 Commits"],
    [/^(\\d+)\\s+branches$/i, (m) => m[1] + " 个 Branches"],
    [/^(\\d+)\\s+changes?$/i, (m) => m[1] + " 处变更"],
    [/^(\\d+)\\s+selected$/i, (m) => "已选 " + m[1] + " 项"],
    [/^(\\d+)\\s+results?$/i, (m) => m[1] + " 条结果"],
    [/^(\\d+)\\s+items?$/i, (m) => m[1] + " 项"],
    [/^(\\d+)\\s+warnings?$/i, (m) => m[1] + " 个警告"],
    [/^(\\d+)\\s+errors?$/i, (m) => m[1] + " 个错误"],
  ];

  const EXCLUDE_SELECTOR =
    ".chat-markdown, [data-testid='composer-editor'], [contenteditable='true'], .ProseMirror, pre, code, kbd, samp, script, style, textarea, svg, .shiki, .xterm, .cm-editor, .monaco-editor, [data-diff-file-key], .font-mono";
  const NON_MONO_EXCLUDE_SELECTOR =
    ".chat-markdown, [data-testid='composer-editor'], [contenteditable='true'], .ProseMirror, pre, code, kbd, samp, script, style, textarea, svg, .shiki, .xterm, .cm-editor, .monaco-editor, [data-diff-file-key]";
  const MONO_ALLOW = new Set(["Always", "Unassigned"]);

  const excludedCache = new WeakMap();
  const seenText = new WeakMap();

  function isExcludedElement(el) {
    if (!el || el.nodeType !== 1) return true;
    const cached = excludedCache.get(el);
    if (cached !== undefined) return cached;
    const hit = el.closest(EXCLUDE_SELECTOR) !== null;
    excludedCache.set(el, hit);
    return hit;
  }

  function applyTemplate(entry, core) {
    if (entry.a && !core.includes(entry.a)) return null;
    const m = entry.re.exec(core);
    if (!m) return null;
    const vals = {};
    for (let i = 0; i < entry.o.length; i++) {
      const rawCap = m[i + 1];
      const trimmedCap = rawCap.trim();
      vals[entry.o[i]] = Object.prototype.hasOwnProperty.call(EXACT, trimmedCap)
        ? rawCap.replace(trimmedCap, EXACT[trimmedCap])
        : rawCap;
    }
    return entry.z.replace(/\\{(\\d+)\\}/g, (_, k) => (vals[k] !== undefined ? vals[k] : ""));
  }

  function applyTemplates(core, requireDot) {
    const wm = /^([A-Za-z]+)/.exec(core);
    if (wm) {
      const bucket = WORD_BUCKETS.get(wm[1]);
      if (bucket) {
        for (let i = 0; i < bucket.length; i++) {
          if (requireDot && !bucket[i].a.includes(" · ")) continue;
          const out = applyTemplate(bucket[i], core);
          if (out !== null) return out;
        }
      }
    }
    for (let i = 0; i < LEADING_VAR.length; i++) {
      if (requireDot && !LEADING_VAR[i].a.includes(" · ")) continue;
      const out = applyTemplate(LEADING_VAR[i], core);
      if (out !== null) return out;
    }
    return null;
  }

  function translateCore(core, depth = 0) {
    if (Object.prototype.hasOwnProperty.call(EXACT, core)) {
      return EXACT[core];
    }

    // Punctuation wrappers (trailing colon / ellipsis / period, leading bullet)
    if (core.startsWith("· ")) {
      const rest = core.slice(2).trim();
      if (Object.prototype.hasOwnProperty.call(EXACT, rest)) return "· " + EXACT[rest];
    }
    for (const [enSuf, zhSuf] of [[":", "："], ["...", "..."], ["…", "…"]]) {
      if (core.endsWith(enSuf)) {
        const stem = core.slice(0, -enSuf.length).trimEnd();
        if (Object.prototype.hasOwnProperty.call(EXACT, stem)) {
          return EXACT[stem] + zhSuf;
        }
      }
    }

    // Built-in count/time rules
    for (let i = 0; i < BUILTIN_RULES.length; i++) {
      const m = BUILTIN_RULES[i][0].exec(core);
      if (m) return BUILTIN_RULES[i][1](m);
    }

    // Prefix rules
    for (let i = 0; i < PREFIXES.length; i++) {
      const p = PREFIXES[i];
      if (p.prefix && core.startsWith(p.prefix)) {
        const tail = core.slice(p.prefix.length);
        const trTail = Object.prototype.hasOwnProperty.call(EXACT, tail) ? EXACT[tail] : tail;
        return p.zhPrefix + trTail;
      }
    }

    // Multi-line tooltips & middle-dot metadata lists: match dot-aware templates first,
    // then translate each segment independently before falling back to greedy templates.
    if (depth === 0 && core.includes("\\n")) {
      const lines = core.split("\\n");
      if (lines.length >= 2 && lines.length <= 8) {
        let changed = false;
        const nextLines = lines.map((line) => {
          const trimmed = line.trim();
          if (!trimmed) return line;
          const tr = translateCore(trimmed, 1);
          if (tr && tr !== trimmed) {
            changed = true;
            return line.replace(trimmed, tr);
          }
          return line;
        });
        if (changed) return nextLines.join("\\n");
      }
    }

    if (depth === 0 && core.includes(" · ")) {
      const dotTpl = applyTemplates(core, true);
      if (dotTpl !== null) return dotTpl;
      const segs = core.split(" · ");
      if (segs.length >= 2 && segs.length <= 8) {
        let changed = false;
        const nextSegs = segs.map((seg) => {
          const trimmed = seg.trim();
          if (!trimmed) return seg;
          const tr = translateCore(trimmed, 1);
          if (tr && tr !== trimmed) {
            changed = true;
            return tr;
          }
          return seg;
        });
        if (changed) return nextSegs.join(" · ");
      }
    }

    return applyTemplates(core, false);
  }

  function translateString(raw) {
    if (!raw || raw.length > 260) return null;
    if (!/[A-Za-z]/.test(raw)) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const translated = translateCore(trimmed);
    if (!translated || translated === trimmed) return null;
    const startIdx = raw.indexOf(trimmed);
    const leading = raw.slice(0, startIdx);
    const trailing = raw.slice(startIdx + trimmed.length);
    return leading + translated + trailing;
  }

  window.__T3_ZH_TR__ = (s) => (typeof s === "string" ? translateCore(s) || s : s);

  function processTextNode(node) {
    const val = node.nodeValue;
    if (!val || seenText.get(node) === val) return;
    const parent = node.parentElement;
    if (!parent) return;
    if (isExcludedElement(parent)) {
      const trimmed = val.trim();
      if (!MONO_ALLOW.has(trimmed) || parent.closest(NON_MONO_EXCLUDE_SELECTOR) !== null) {
        seenText.set(node, val);
        return;
      }
    }
    const next = translateString(val);
    if (next !== null && next !== val) {
      seenText.set(node, next);
      node.nodeValue = next;
    } else {
      seenText.set(node, val);
    }
  }

  const UI_ATTRS = ["placeholder", "title", "aria-label"];

  function processElementAttrs(el) {
    if (!el || el.nodeType !== 1) return;
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "SVG" || tag === "PATH") return;
    // Allow placeholder/aria-label/title on inputs even when input has font-mono
    const inChatOrCode = el.closest(".chat-markdown, pre, code, .shiki, .xterm") !== null;
    if (inChatOrCode) return;
    for (let i = 0; i < UI_ATTRS.length; i++) {
      const attr = UI_ATTRS[i];
      const v = el.getAttribute(attr);
      if (v) {
        const next = translateString(v);
        if (next !== null && next !== v) {
          el.setAttribute(attr, next);
        }
      }
    }
  }

  function scanSubtree(root) {
    if (!root) return;
    if (root.nodeType === 3) {
      processTextNode(root);
      return;
    }
    if (root.nodeType !== 1) return;
    processElementAttrs(root);
    if (isExcludedElement(root)) return;

    const elems = root.querySelectorAll("[placeholder],[title],[aria-label]");
    for (let i = 0; i < elems.length; i++) processElementAttrs(elems[i]);

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      processTextNode(n);
    }
  }

  const observer = new MutationObserver((mutations) => {
    for (let i = 0; i < mutations.length; i++) {
      const m = mutations[i];
      if (m.type === "characterData") {
        processTextNode(m.target);
      } else if (m.type === "attributes") {
        processElementAttrs(m.target);
      } else if (m.type === "childList") {
        if (m.target.nodeType === 1 && isExcludedElement(m.target)) continue;
        const added = m.addedNodes;
        for (let j = 0; j < added.length; j++) {
          scanSubtree(added[j]);
        }
      }
    }
  });

  function start() {
    const target = document.documentElement;
    if (!target) return;
    scanSubtree(document.body || target);
    observer.observe(target, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: UI_ATTRS,
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
`;
}

// ---------- Safe JS string literal translator ----------

const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "case",
  "throw",
  "typeof",
  "void",
  "delete",
  "in",
  "instanceof",
  "new",
  "else",
  "do",
  "yield",
  "await",
  "of",
]);

const REGEX_PRECEDING_PUNCT = new Set([
  "(",
  "[",
  "{",
  ",",
  ";",
  ":",
  "?",
  "!",
  "&",
  "|",
  "^",
  "~",
  "+",
  "-",
  "*",
  "/",
  "%",
  "=",
  "<",
  ">",
  "=>",
]);

const BLOCKED_PROP_KEYS = new Set([
  "_tag",
  "_op",
  "_id",
  "op",
  "tag",
  "kind",
  "type",
  "status",
  "driver",
  "driverKind",
  "mode",
  "role",
  "id",
  "value",
  "category",
  "method",
  "event",
  "action",
  "level",
  "icon",
  "expected",
  "key",
  "code",
  "reason",
  "provider",
  "command",
  "platform",
  "arch",
  "defaultValue",
  "className",
]);

const UI_PROP_KEYS = new Set([
  "children",
  "title",
  "label",
  "description",
  "placeholder",
  "heading",
  "emptyText",
  "confirmLabel",
  "cancelLabel",
  "confirmText",
  "cancelText",
  "tooltip",
  "aria-label",
  "headline",
  "subtitle",
  "detail",
  "summary",
  "text",
  "message",
  "ctaLabel",
]);

function unescapeJsString(raw, quote) {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    if (i + 1 >= raw.length) return null;
    const esc = raw[++i];
    switch (esc) {
      case "n":
        out += "\n";
        break;
      case "r":
        out += "\r";
        break;
      case "t":
        out += "\t";
        break;
      case "b":
        out += "\b";
        break;
      case "f":
        out += "\f";
        break;
      case "v":
        out += "\v";
        break;
      case "0":
        if (i + 1 < raw.length && /[0-7]/.test(raw[i + 1])) return null;
        out += "\0";
        break;
      case "\\":
        out += "\\";
        break;
      case "'":
        out += "'";
        break;
      case '"':
        out += '"';
        break;
      case "`":
        out += "`";
        break;
      case "\n":
        break;
      case "\r":
        if (raw[i + 1] === "\n") i++;
        break;
      case "x": {
        const hex = raw.slice(i + 1, i + 3);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 2;
        break;
      }
      case "u": {
        if (raw[i + 1] === "{") {
          const end = raw.indexOf("}", i + 2);
          if (end === -1) return null;
          const cp = parseInt(raw.slice(i + 2, end), 16);
          if (Number.isNaN(cp)) return null;
          out += String.fromCodePoint(cp);
          i = end;
        } else {
          const hex = raw.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        }
        break;
      }
      default:
        if (esc === quote) out += quote;
        else out += esc;
        break;
    }
  }
  return out;
}

function encodeTemplateLiteral(str) {
  return "`" + str.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${") + "`";
}

function translateStringValue(decoded, dict) {
  if (Object.hasOwn(dict.exact, decoded)) {
    return dict.exact[decoded];
  }
  if (Array.isArray(dict.patterns)) {
    for (const pat of dict.patterns) {
      if (pat.prefix && decoded.startsWith(pat.prefix)) {
        return pat.zhPrefix + decoded.slice(pat.prefix.length);
      }
    }
  }
  return null;
}

function peekNextToken(code, pos) {
  const n = code.length;
  let i = pos;
  while (i < n) {
    const ch = code[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    if (ch === "/" && code[i + 1] === "/") {
      i += 2;
      while (i < n && code[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && code[i + 1] === "*") {
      i += 2;
      while (i + 1 < n && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    break;
  }
  if (i >= n) return "";
  for (const op of ["===", "!==", "==", "!=", "=>"]) {
    if (code.startsWith(op, i)) return op;
  }
  return code[i];
}

function patchJsSource(code, dict, options = { mode: "client" }) {
  const n = code.length;
  let i = 0;
  let lastEmit = 0;
  const parts = [];
  let replacements = 0;

  let prevToken = "";
  let prev2Token = "";
  let prevStringVal = null;
  let prev2StringVal = null;

  const stack = [];

  const currentScope = () => (stack.length > 0 ? stack[stack.length - 1] : null);
  const currentPropKey = () => {
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k].type === "{") return stack[k].propKey;
    }
    return null;
  };

  const pushToken = (tok, strVal = null) => {
    prev2Token = prevToken;
    prevToken = tok;
    prev2StringVal = prevStringVal;
    prevStringVal = strVal;
  };

  const isIdentStart = (c) =>
    (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$" || c.charCodeAt(0) >= 128;
  const isIdentPart = (c) => isIdentStart(c) || (c >= "0" && c <= "9");

  const canTranslate = (decoded, nextToken) => {
    if (
      prevToken === "===" ||
      prevToken === "!==" ||
      prevToken === "==" ||
      prevToken === "!=" ||
      prevToken === "case" ||
      prevToken === "import" ||
      prevToken === "from" ||
      nextToken === "===" ||
      nextToken === "!==" ||
      nextToken === "==" ||
      nextToken === "!="
    ) {
      return false;
    }

    const isObjectKey = (prevToken === "{" || prevToken === ",") && nextToken === ":";
    if (isObjectKey) return false;

    const propKey = currentPropKey();

    if (options.mode === "desktopMain") {
      return propKey === "label";
    }

    if (propKey !== null && BLOCKED_PROP_KEYS.has(propKey)) {
      return false;
    }

    // Single-word tokens in static JS patching require explicit UI prop context;
    // any hoisted single-word UI labels are safely handled at render time by /zh-cn-i18n.js.
    const isSingleWord = !/\s/.test(decoded);
    if (isSingleWord) {
      const inUiProp = propKey !== null && (UI_PROP_KEYS.has(propKey) || propKey.startsWith("/settings"));
      if (!inUiProp) return false;
    }

    return true;
  };

  while (i < n) {
    const ch = code[i];

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }

    if (ch === "/" && code[i + 1] === "/") {
      i += 2;
      while (i < n && code[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && code[i + 1] === "*") {
      i += 2;
      while (i + 1 < n && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    if (
      ch === "/" &&
      (prevToken === "" || REGEX_PRECEDING_PUNCT.has(prevToken) || REGEX_PRECEDING_KEYWORDS.has(prevToken))
    ) {
      i++;
      let inClass = false;
      while (i < n) {
        const rc = code[i++];
        if (rc === "\\") i++;
        else if (rc === "[") inClass = true;
        else if (rc === "]" && inClass) inClass = false;
        else if (rc === "/" && !inClass) break;
        else if (rc === "\n") break;
      }
      while (i < n && isIdentPart(code[i])) i++;
      pushToken("/");
      continue;
    }

    if (ch === '"' || ch === "'") {
      const start = i;
      const quote = ch;
      i++;
      while (i < n) {
        const sc = code[i];
        if (sc === "\\") i += 2;
        else if (sc === quote) {
          i++;
          break;
        } else i++;
      }
      const raw = code.slice(start + 1, i - 1);
      const decoded = unescapeJsString(raw, quote);
      if (decoded !== null) {
        const translated = translateStringValue(decoded, dict);
        if (translated !== null && translated !== decoded) {
          const nextToken = peekNextToken(code, i);
          if (canTranslate(decoded, nextToken)) {
            parts.push(code.slice(lastEmit, start));
            parts.push(JSON.stringify(translated));
            lastEmit = i;
            replacements++;
          }
        }
      }
      pushToken("STRING", decoded);
      continue;
    }

    if (ch === "`") {
      const start = i;
      i++;
      let hasInterpolation = false;
      let depth = 0;
      while (i < n) {
        const tc = code[i];
        if (tc === "\\") i += 2;
        else if (tc === "$" && code[i + 1] === "{") {
          hasInterpolation = true;
          i += 2;
          depth = 1;
          while (i < n && depth > 0) {
            const ic = code[i];
            if (ic === "\\") i += 2;
            else if (ic === '"' || ic === "'") {
              const q = ic;
              i++;
              while (i < n) {
                if (code[i] === "\\") i += 2;
                else if (code[i] === q) {
                  i++;
                  break;
                } else i++;
              }
            } else if (ic === "{") {
              depth++;
              i++;
            } else if (ic === "}") {
              depth--;
              i++;
            } else i++;
          }
        } else if (tc === "`") {
          i++;
          break;
        } else i++;
      }
      let decoded = null;
      if (!hasInterpolation) {
        const raw = code.slice(start + 1, i - 1);
        decoded = unescapeJsString(raw, "`");
        if (decoded !== null) {
          const translated = translateStringValue(decoded, dict);
          if (translated !== null && translated !== decoded) {
            const nextToken = peekNextToken(code, i);
            if (canTranslate(decoded, nextToken)) {
              parts.push(code.slice(lastEmit, start));
              parts.push(encodeTemplateLiteral(translated));
              lastEmit = i;
              replacements++;
            }
          }
        }
      }
      pushToken("STRING", decoded);
      continue;
    }

    if (isIdentStart(ch)) {
      const start = i++;
      while (i < n && isIdentPart(code[i])) i++;
      pushToken(code.slice(start, i));
      continue;
    }

    if (ch >= "0" && ch <= "9") {
      i++;
      while (i < n && /[0-9a-zA-Z_.]/.test(code[i])) i++;
      pushToken("NUMBER");
      continue;
    }

    let matchedOp = null;
    for (const op of ["===", "!==", "==", "!=", "=>", "++", "--", "&&", "||", "??", "<=", ">="]) {
      if (code.startsWith(op, i)) {
        matchedOp = op;
        break;
      }
    }
    if (matchedOp) {
      pushToken(matchedOp);
      i += matchedOp.length;
      continue;
    }

    if (ch === "{" || ch === "(" || ch === "[") {
      stack.push({ type: ch, propKey: null, ternaryDepth: 0 });
    } else if (ch === "}" || ch === ")" || ch === "]") {
      if (stack.length > 0) stack.pop();
    } else if (ch === "?") {
      const sc = currentScope();
      if (sc) sc.ternaryDepth++;
    } else if (ch === ":") {
      const sc = currentScope();
      if (sc && sc.ternaryDepth > 0) {
        sc.ternaryDepth--;
      } else if (sc && sc.type === "{" && (prev2Token === "{" || prev2Token === ",")) {
        if (prevToken === "STRING" && prevStringVal !== null) {
          sc.propKey = prevStringVal;
        } else if (prevToken && prevToken !== "NUMBER") {
          sc.propKey = prevToken;
        }
      }
    } else if (ch === "=") {
      const sc = currentScope();
      if (sc && sc.type === "{" && (prev2Token === "{" || prev2Token === ";") && prevToken) {
        sc.propKey = prevToken;
      }
    } else if (ch === "," || ch === ";") {
      const sc = currentScope();
      if (sc && sc.type === "{") sc.propKey = null;
    }

    pushToken(ch);
    i++;
  }

  if (replacements === 0) return { code, replacements: 0 };
  parts.push(code.slice(lastEmit));
  return { code: parts.join(""), replacements };
}

// ---------- File selection ----------

function shouldPatchClientAsset(fileName) {
  if (!fileName.endsWith(".js")) return false;
  const skipPrefixes = [
    "heic-to-",
    "katex-",
    "lucideIconByName-",
    "PdfViewer-",
    "highlights-",
    "document.worker-",
    "react-",
    "react-dom-",
    "jsx-runtime-",
    "rolldown-runtime-",
    "emacs-lisp-",
    "cpp-",
    "wasm-",
    "wolfram-",
    "objective-",
    "bsl-",
    "powershell-",
    "luau-",
    "apache-",
  ];
  return !skipPrefixes.some((p) => fileName.startsWith(p));
}

function collectFilesFromTree(node, prefix, out = []) {
  if (!node || typeof node !== "object") return out;
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) {
      const p = prefix ? `${prefix}/${name}` : name;
      collectFilesFromTree(child, p, out);
    }
  } else {
    out.push({ path: prefix, meta: node });
  }
  return out;
}

function patchAppUpdateYml(ymlPath, owner, repo, dryRun) {
  if (!fs.existsSync(ymlPath)) {
    console.warn(`Warning: ${ymlPath} not found, skipping update feed rewrite.`);
    return false;
  }
  const orig = fs.readFileSync(ymlPath, "utf8");
  let next = orig
    .replace(/^owner:\s*.*$/m, `owner: ${owner}`)
    .replace(/^repo:\s*.*$/m, `repo: ${repo}`);
  if (!/^owner:/m.test(next)) next = `owner: ${owner}\n${next}`;
  if (!/^repo:/m.test(next)) next = `repo: ${repo}\n${next}`;
  if (!dryRun) fs.writeFileSync(ymlPath, next, "utf8");
  return next !== orig;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dict = JSON.parse(fs.readFileSync(args.dictPath, "utf8"));
  const asarPath = path.join(args.resourcesDir, "app.asar");
  const appUpdatePath = path.join(args.resourcesDir, "app-update.yml");

  const origAsar = readAsar(asarPath);
  const allEntries = collectFilesFromTree(origAsar.tree, "");
  const modifiedFiles = new Map();
  const addedPaths = [];

  // Build and inject /zh-cn-i18n.js into apps/server/dist/client/zh-cn-i18n.js
  const runtimeRelPath = "apps/server/dist/client/zh-cn-i18n.js";
  const runtimeScriptBuf = Buffer.from(generateRuntimeDomScript(dict), "utf8");
  modifiedFiles.set(runtimeRelPath, runtimeScriptBuf);
  addedPaths.push(runtimeRelPath);

  let totalReplacements = 0;
  let patchedJsFiles = 0;

  for (const entry of allEntries) {
    const rel = entry.path;
    if (entry.meta.unpacked || entry.meta.link !== undefined) continue;

    if (rel === "apps/server/dist/client/index.html") {
      const origBuf = origAsar.buf.subarray(
        origAsar.dataStart + Number(entry.meta.offset),
        origAsar.dataStart + Number(entry.meta.offset) + entry.meta.size,
      );
      let html = origBuf.toString("utf8");
      html = html.replace('<html lang="en">', '<html lang="zh-CN">');
      if (!html.includes('/zh-cn-i18n.js')) {
        html = html.replace(
          /<script\s+type="module"/,
          '<script src="/zh-cn-i18n.js"></script>\n    <script type="module"',
        );
      }
      modifiedFiles.set(rel, Buffer.from(html, "utf8"));
      continue;
    }

    const isClientJs =
      rel.startsWith("apps/server/dist/client/assets/") &&
      shouldPatchClientAsset(path.basename(rel));
    const isDesktopMain = rel === "apps/desktop/dist-electron/main.cjs";

    if (!isClientJs && !isDesktopMain) continue;

    const origBuf = origAsar.buf.subarray(
      origAsar.dataStart + Number(entry.meta.offset),
      origAsar.dataStart + Number(entry.meta.offset) + entry.meta.size,
    );
    let source = origBuf.toString("utf8");
    const res = patchJsSource(source, dict, {
      mode: isDesktopMain ? "desktopMain" : "client",
    });
    let changed = res.replacements > 0;
    source = res.code;

    if (isDesktopMain) {
      const replacedUrl = source.replaceAll(
        "https://github.com/pingdotgg/t3code/releases",
        `https://github.com/${args.owner}/${args.repo}/releases`,
      );
      if (replacedUrl !== source) {
        source = replacedUrl;
        changed = true;
      }
    } else if (path.basename(rel).startsWith("KeybindingsSettings.logic-")) {
      // Also translate dynamically assembled commandLabel(`Sidebar: Toggle`, `Run Script: ...`, etc.)
      // in JS memory so both Chinese & English queries match in Keybindings search and Settings search.
      const hooked = source.replace(
        /([A-Za-z0-9_$]+\.split\([`"']\.[`"']\)\.map\([A-Za-z0-9_$]+\)\.join\([`"']: [`"']\))/,
        "(globalThis.__T3_ZH_TR__?globalThis.__T3_ZH_TR__($1):$1)",
      );
      if (hooked !== source) {
        source = hooked;
        changed = true;
      }
    }

    if (changed) {
      patchedJsFiles++;
      totalReplacements += res.replacements;
      modifiedFiles.set(rel, Buffer.from(source, "utf8"));
    }
  }

  const ymlChanged = patchAppUpdateYml(appUpdatePath, args.owner, args.repo, args.dryRun);

  if (!args.dryRun) {
    const newAsarSize = writeAsar(asarPath, origAsar, modifiedFiles, addedPaths);
    console.log(
      `Patched ${asarPath}: ${patchedJsFiles} JS files (${totalReplacements} static replacements) + runtime DOM i18n (${runtimeScriptBuf.length} bytes), ${modifiedFiles.size} ASAR entries updated, app-update.yml=${ymlChanged ? "updated" : "unchanged"} (owner=${args.owner}, repo=${args.repo}), new ASAR size=${newAsarSize}`,
    );
  } else {
    console.log(
      `[dry-run] Would patch ${patchedJsFiles} JS files (${totalReplacements} static replacements) + runtime DOM i18n (${runtimeScriptBuf.length} bytes)`,
    );
  }
}

main();
