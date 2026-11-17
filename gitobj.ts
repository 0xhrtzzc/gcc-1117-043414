// gitobj.ts: the git object model and packfile codec, built on Node's own crypto and zlib.
//
// What lives here: sha1 object ids, tree/commit/tag parse and build, a packfile reader that
// resolves plain, ofs-delta and ref-delta entries, a packfile writer (plain objects), and a
// reachability walk. Nothing in this file talks HTTP or knows about a repository.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** The all-zero object id: an unborn branch's old/new value in a receive-pack command list. */
export const ZERO_OID = '0'.repeat(40);

/** git's LARGE_PACKET_MAX: the largest pkt-line including its 4-byte length prefix. */
export const PKT_LINE_MAX = 65520;

/** A pkt-line payload may hold at most this many bytes. */
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;

const HEX40 = /^[0-9a-f]{40}$/;

/** Whether a string is a lowercase 40-hex object id. */
export function isOid(value) {
  return typeof value === 'string' && HEX40.test(value);
}

/** SHA-1 of a buffer, lowercase hex. */
export function sha1Hex(data) {
  return createHash('sha1').update(data).digest('hex');
}

/** git's object id: SHA-1 over `<type> <size>\0` and the object's bytes. */
export function hashObject(type, data) {
  const header = Buffer.from(`${type} ${data.length}\u0000`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

// ------------------------------------------------------------------ pkt-line

/** One pkt-line's bytes: four hex digits then the payload. */
export function pktLine(payload) {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

/** The flush packet. */
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
/** The delim packet (protocol v2's section separator). */
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Concatenate pkt-lines from strings, buffers, and the markers 'flush' and 'delim'. */
export function pktLines(items) {
  const parts = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/**
 * Decode a pkt-line stream. Returns {packets, rest}: packets is a list of {kind, payload}. Decoding
 * stops at the first byte sequence that is not a pkt-line length, and `rest` holds that plus
 * everything after it (the packfile a receive-pack body carries directly).
 */
export function decodePktLines(buffer) {
  const packets = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const head = buffer.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: null });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: null });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: null });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: buffer.subarray(offset) };
}

// ------------------------------------------------------------------ trees

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data) {
  const entries = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const mode = data.toString('ascii', offset, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry order: raw byte order of the name, a directory compared as if it ended in '/'. */
function compareEntries(a, b) {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes; entries are sorted the way git sorts them. */
export function buildTree(entries) {
  const sorted = entries.slice().sort(compareEntries);
  const parts = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ commits and tags

/** Parse a commit object into its headers and message. */
export function parseCommit(data) {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerText = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const commit = { tree: '', parents: [], author: '', committer: '', message, headers: [] };
  for (const line of headerText.split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') commit.tree = value;
    else if (key === 'parent') commit.parents.push(value);
    else if (key === 'author') commit.author = value;
    else if (key === 'committer') commit.committer = value;
    else commit.headers.push([key, value]);
  }
  return commit;
}

/** Build a commit object's bytes. */
export function buildCommit(fields) {
  const timezone = fields.timezone ?? '+0000';
  const author = fields.author ?? 'makefun forge <forge@makefun.invalid>';
  const committer = fields.committer ?? author;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${author} ${fields.timestamp} ${timezone}`);
  lines.push(`committer ${committer} ${fields.timestamp} ${timezone}`);
  for (const [key, value] of fields.headers ?? []) lines.push(`${key} ${value}`);
  return Buffer.from(`${lines.join('\n')}\n\n${fields.message}`, 'utf8');
}

/** Parse an annotated tag object. */
export function parseTag(data) {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerText = blank < 0 ? text : text.slice(0, blank);
  const headers = new Map();
  for (const line of headerText.split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : text.slice(blank + 2),
  };
}

/** Build an annotated tag object's bytes. */
export function buildTag(fields) {
  const tagger = fields.tagger ?? 'makefun forge <forge@makefun.invalid>';
  const timezone = fields.timezone ?? '+0000';
  const lines = [`object ${fields.object}`, `type ${fields.type}`, `tag ${fields.tag}`];
  lines.push(`tagger ${tagger} ${fields.timestamp} ${timezone}`);
  return Buffer.from(`${lines.join('\n')}\n\n${fields.message}`, 'utf8');
}

/** Peel an object to the commit it ultimately names (tags may chain). */
export function peelToCommit(oid, lookup) {
  let current = oid;
  for (let hop = 0; hop < 16; hop += 1) {
    const object = lookup(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    current = parseTag(object.data).object;
  }
  return null;
}

/** Every object reachable from `roots`: commit -> tree and parents, tree -> entries, tag -> target. */
export function collectReachable(roots, lookup) {
  const seen = new Set();
  const queue = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop();
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      if (commit.tree) queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

// ------------------------------------------------------------------ packfiles

const TYPE_CODE = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function readVarint(buffer, start) {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset];
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsBase(buffer, start) {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset];
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate the zlib stream at `offset`; answer its bytes and the offset just past it. */
function inflateAt(buffer, offset) {
  const result = inflateSync(buffer.subarray(offset), { info: true });
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base, delta) {
  let offset = 0;
  const readSize = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta wants a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += delta[offset] * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += delta[offset] * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

/**
 * Read a packfile and resolve every object. Answers {objects: Map<oid, {type, data}>, count,
 * deltaCount, version}. Throws on a malformed pack.
 */
export function readPack(pack) {
  if (pack.length < 32 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const byOffset = new Map();
  const raw = [];
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry = { offset: entryOffset, typeCode, size: header.size, data: null, baseOffset: 0, baseOid: '' };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }

  const objects = new Map();
  const resolvedByOid = new Map();
  let deltaCount = 0;
  const resolve = (entry) => {
    if (entry.resolved) return entry.resolved;
    let type;
    let data;
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let base;
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset);
        if (!baseEntry) throw new Error(`ofs-delta base at ${entry.baseOffset} is missing`);
        base = resolve(baseEntry);
      } else {
        const inPack = resolvedByOid.get(entry.baseOid);
        if (inPack) base = resolve(inPack);
        else throw new Error(`ref-delta base ${entry.baseOid} is not in the pack`);
      }
      type = base.type;
      data = applyDelta(base.data, entry.data);
      deltaCount += 1;
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const value = { oid, type, data };
    entry.resolved = value;
    resolvedByOid.set(oid, entry);
    if (!objects.has(oid)) objects.set(oid, { type, data });
    return value;
  };
  for (const entry of raw) resolve(entry);
  return { version, count: declaredCount, deltaCount, objects };
}

function writeEntryHeader(type, size) {
  const code = TYPE_CODE[type];
  const bytes = [];
  let remaining = Math.floor(size / 16);
  let first = (code << 4) | (size & 0x0f);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas), trailer included. */
export function writePack(objects) {
  const list = Array.isArray(objects) ? objects : [...objects];
  const parts = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    const data = Buffer.isBuffer(object.data) ? object.data : Buffer.from(object.data);
    parts.push(writeEntryHeader(object.type, data.length));
    parts.push(deflateSync(data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Verify a pack's trailing checksum against its own bytes. */
export function verifyPackChecksum(pack) {
  if (pack.length < 20) return false;
  const trailer = pack.toString('hex', pack.length - 20);
  return trailer === sha1Hex(pack.subarray(0, pack.length - 20));
}

/** The objects reachable from `newRoots` that `serverRoots` does not already reach. */
export function objectsToSend(lookup, serverRoots, newRoots) {
  const have = collectReachable(serverRoots, lookup);
  const wanted = collectReachable(newRoots, lookup);
  const send = [];
  for (const oid of wanted) {
    if (have.has(oid)) continue;
    const object = lookup(oid);
    if (object) send.push({ type: object.type, data: object.data });
  }
  return send;
}
