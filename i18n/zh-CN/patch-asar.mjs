#!/usr/bin/env node
/**
 * Patches T3 Code's resources/app.asar and resources/app-update.yml for Simplified Chinese (zh-CN)
 * and redirects electron-updater to the forked GitHub repository.
 *
 * Pure Node.js implementation (no external npm dependencies). Preserves unpacked flags,
 * symlinks, file permissions, and recomputes ASAR SHA-256 integrity metadata.
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

function writeAsar(asarPath, origAsar, modifiedFiles) {
  const newTree = structuredClone(origAsar.tree);
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
        // Keep unknown single-char escape if safe, otherwise bail out
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

function patchJsSource(code, dict) {
  const n = code.length;
  let i = 0;
  let lastEmit = 0;
  const parts = [];
  let replacements = 0;
  let prevToken = "";

  const isIdentStart = (c) =>
    (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$" || c.charCodeAt(0) >= 128;
  const isIdentPart = (c) => isIdentStart(c) || (c >= "0" && c <= "9");

  while (i < n) {
    const ch = code[i];

    // Whitespace
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }

    // Comments
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

    // Regex literal vs division
    if (
      ch === "/" &&
      (prevToken === "" || REGEX_PRECEDING_PUNCT.has(prevToken) || REGEX_PRECEDING_KEYWORDS.has(prevToken))
    ) {
      i++;
      let inClass = false;
      while (i < n) {
        const rc = code[i++];
        if (rc === "\\") {
          i++;
        } else if (rc === "[") {
          inClass = true;
        } else if (rc === "]" && inClass) {
          inClass = false;
        } else if (rc === "/" && !inClass) {
          break;
        } else if (rc === "\n") {
          break;
        }
      }
      while (i < n && isIdentPart(code[i])) i++;
      prevToken = "/";
      continue;
    }

    // Quoted strings: "..." or '...'
    if (ch === '"' || ch === "'") {
      const start = i;
      const quote = ch;
      i++;
      while (i < n) {
        const sc = code[i];
        if (sc === "\\") {
          i += 2;
        } else if (sc === quote) {
          i++;
          break;
        } else {
          i++;
        }
      }
      const raw = code.slice(start + 1, i - 1);
      const decoded = unescapeJsString(raw, quote);
      if (decoded !== null) {
        const translated = translateStringValue(decoded, dict);
        if (translated !== null && translated !== decoded) {
          const nextToken = peekNextToken(code, i);
          const isComparison =
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
            nextToken === "!=";
          const isObjectKey = (prevToken === "{" || prevToken === ",") && nextToken === ":";
          if (!isComparison && !isObjectKey) {
            parts.push(code.slice(lastEmit, start));
            parts.push(JSON.stringify(translated));
            lastEmit = i;
            replacements++;
          }
        }
      }
      prevToken = "STRING";
      continue;
    }

    // Template literals: `...` (only translate static templates without ${...})
    if (ch === "`") {
      const start = i;
      i++;
      let hasInterpolation = false;
      let depth = 0;
      while (i < n) {
        const tc = code[i];
        if (tc === "\\") {
          i += 2;
        } else if (tc === "$" && code[i + 1] === "{") {
          hasInterpolation = true;
          i += 2;
          depth = 1;
          // Skip nested interpolation cleanly using simple brace/string scan
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
            } else if (ic === "`") {
              // nested template: just break out to avoid ambiguity
              i++;
            } else if (ic === "{") {
              depth++;
              i++;
            } else if (ic === "}") {
              depth--;
              i++;
            } else {
              i++;
            }
          }
        } else if (tc === "`") {
          i++;
          break;
        } else {
          i++;
        }
      }
      if (!hasInterpolation) {
        const raw = code.slice(start + 1, i - 1);
        const decoded = unescapeJsString(raw, "`");
        if (decoded !== null) {
          const translated = translateStringValue(decoded, dict);
          if (translated !== null && translated !== decoded) {
            const nextToken = peekNextToken(code, i);
            const isComparison =
              prevToken === "===" ||
              prevToken === "!==" ||
              prevToken === "==" ||
              prevToken === "!=" ||
              prevToken === "case" ||
              nextToken === "===" ||
              nextToken === "!==" ||
              nextToken === "==" ||
              nextToken === "!=";
            const isObjectKey = (prevToken === "{" || prevToken === ",") && nextToken === ":";
            if (!isComparison && !isObjectKey) {
              parts.push(code.slice(lastEmit, start));
              parts.push(encodeTemplateLiteral(translated));
              lastEmit = i;
              replacements++;
            }
          }
        }
      }
      prevToken = "STRING";
      continue;
    }

    // Identifiers / keywords
    if (isIdentStart(ch)) {
      const start = i++;
      while (i < n && isIdentPart(code[i])) i++;
      prevToken = code.slice(start, i);
      continue;
    }

    // Numbers
    if (ch >= "0" && ch <= "9") {
      i++;
      while (i < n && /[0-9a-zA-Z_.]/.test(code[i])) i++;
      prevToken = "NUMBER";
      continue;
    }

    // Multi-char operators
    let matchedOp = null;
    for (const op of ["===", "!==", "==", "!=", "=>", "++", "--", "&&", "||", "??", "<=", ">="]) {
      if (code.startsWith(op, i)) {
        matchedOp = op;
        break;
      }
    }
    if (matchedOp) {
      prevToken = matchedOp;
      i += matchedOp.length;
      continue;
    }

    prevToken = ch;
    i++;
  }

  if (replacements === 0) return { code, replacements: 0 };
  parts.push(code.slice(lastEmit));
  return { code: parts.join(""), replacements };
}

// ---------- File selection ----------

function shouldPatchClientAsset(fileName) {
  if (!fileName.endsWith(".js")) return false;
  // Skip large third-party/vendor/syntax-grammar/icon/media chunks
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
      const html = origBuf.toString("utf8");
      const patchedHtml = html.replace('<html lang="en">', '<html lang="zh-CN">');
      if (patchedHtml !== html) {
        modifiedFiles.set(rel, Buffer.from(patchedHtml, "utf8"));
      }
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
    const res = patchJsSource(source, dict);
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
    }

    if (changed) {
      patchedJsFiles++;
      totalReplacements += res.replacements;
      modifiedFiles.set(rel, Buffer.from(source, "utf8"));
    }
  }

  const ymlChanged = patchAppUpdateYml(appUpdatePath, args.owner, args.repo, args.dryRun);

  if (!args.dryRun) {
    const newAsarSize = writeAsar(asarPath, origAsar, modifiedFiles);
    console.log(
      `Patched ${asarPath}: ${patchedJsFiles} JS files, ${totalReplacements} string replacements, ${modifiedFiles.size} total ASAR entries updated, app-update.yml=${ymlChanged ? "updated" : "unchanged"} (owner=${args.owner}, repo=${args.repo}), new ASAR size=${newAsarSize}`,
    );
  } else {
    console.log(
      `[dry-run] Would patch ${patchedJsFiles} JS files, ${totalReplacements} string replacements, ${modifiedFiles.size} total ASAR entries, app-update.yml=${ymlChanged}`,
    );
  }
}

main();
