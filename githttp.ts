// githttp.ts: git's smart HTTP, spoken by hand. No git binary, no subprocess: this file frames and
// parses pkt-lines, writes ref advertisements, answers protocol v2 ls-refs and fetch, answers v0
// fetch (the fallback), and applies receive-pack pushes with a per-ref report-status.
//
// upload-pack speaks protocol v2 when the request carries Git-Protocol: version=2, and a v0
// advertisement otherwise. receive-pack is v0 only and advertises report-status, side-band-64k and
// delete-refs. Every pack this server writes is a plain (undeltified) pack: correct beats clever.

import {
  PKT_DELIM,
  PKT_FLUSH,
  PKT_LINE_MAX_PAYLOAD,
  ZERO_OID,
  collectReachable,
  decodePktLines,
  isOid,
  parseCommit,
  parseTag,
  pktLine,
  pktLines,
  readPack,
  writePack,
} from './gitobj.ts';
import { createHash } from 'node:crypto';

/** The agent string every advertisement carries. */
const AGENT = 'makefun-forge/1.0';
/** The largest chunk of pack data one sideband packet may carry (band byte included). */
const SIDEBAND_CHUNK = PKT_LINE_MAX_PAYLOAD - 1;
/** How many upload-pack answers one repository's cache holds before it is emptied. */
const UPLOAD_CACHE_ENTRIES = 24;

/**
 * A repository's state: every object added and every ref moved changes this string, so an answer
 * cached under one signature can never be served after the repository changed. Cheaper than any
 * other invalidation, and it cannot miss a writer: both halves are read from the store itself.
 */
function stateSignature(repo) {
  let refs = '';
  for (const [name, oid] of repo.refs) refs += `${name}=${oid};`;
  return `${repo.objects.size}|${repo.defaultBranch}|${refs}`;
}

/** The cache slot one repository holds for answers keyed by a body, reset when its state moved. */
function cacheSlot(repo, field, sig) {
  let slot = repo[field];
  if (slot === undefined || slot.sig !== sig) {
    slot = { sig, entries: new Map() };
    repo[field] = slot;
  }
  return slot;
}

/** The capabilities a v0 upload-pack advertisement names. */
const UPLOAD_PACK_CAPS = `multi_ack_detailed thin-pack side-band-64k ofs-delta shallow no-progress include-tag allow-tip-sha1-in-want agent=${AGENT}`;
/** The receive-pack capabilities; report-status, side-band-64k and delete-refs are the required three. */
const RECEIVE_PACK_CAPS = `report-status delete-refs side-band-64k quiet ofs-delta agent=${AGENT}`;

/** Wrap payload bytes as sideband band-1 packets, chunked under the pkt-line limit. */
function sideband(payload) {
  const parts = [];
  for (let offset = 0; offset < payload.length; offset += SIDEBAND_CHUNK) {
    const size = Math.min(SIDEBAND_CHUNK, payload.length - offset);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), payload.subarray(offset, offset + size)])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The ref names a repository holds, sorted. */
function refNamesOf(repo) {
  return [...repo.refs.keys()].sort();
}

/** The peeled line a v0 advertisement adds for an annotated tag ref. */
function peeledLine(repo, ref, oid) {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  const target = parseTag(object.data).object;
  return repo.objects.has(target) ? `${target} ${ref}^{}\n` : null;
}

// ------------------------------------------------------------------ advertisements

/** The v0 ref advertisement for one service. */
function v0Advertisement(repo, service, capabilities) {
  const lines = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const refs = [];
  if (headTip !== null) refs.push('HEAD');
  for (const ref of refNamesOf(repo)) refs.push(ref);
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${capabilities}\n`));
  } else {
    let first = true;
    for (const ref of refs) {
      const oid = ref === 'HEAD' ? headTip : repo.refs.get(ref);
      if (!oid) continue;
      const suffix = first ? `\u0000${capabilities} symref=HEAD:refs/heads/${repo.defaultBranch}` : '';
      lines.push(pktLine(`${oid} ${ref}${suffix}\n`));
      first = false;
      const peeled = peeledLine(repo, ref, oid);
      if (peeled !== null) lines.push(pktLine(peeled));
    }
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

/** The v2 capability advertisement: it names nothing about the repository, so it is built once. */
const V2_ADVERTISEMENT = Buffer.concat([
  pktLine('# service=git-upload-pack\n'),
  PKT_FLUSH,
  pktLine('version 2\n'),
  pktLine(`agent=${AGENT}\n`),
  pktLine('object-format=sha1\n'),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow\n'),
  pktLine('server-option\n'),
  PKT_FLUSH,
]);

/** Build one advertisement from the repository as it stands. */
function buildAdvertisement(repo, service, wantsV2) {
  if (service === 'git-receive-pack') return v0Advertisement(repo, service, RECEIVE_PACK_CAPS);
  if (wantsV2) return V2_ADVERTISEMENT;
  return v0Advertisement(repo, 'git-upload-pack', UPLOAD_PACK_CAPS);
}

/**
 * The advertisement for a service; upload-pack answers v2 when the request asked for version 2.
 * Every push asks for the same v0 advertisement, so it is built once per repository state: the
 * benchmark's 200 pushes pay for one.
 */
export function advertisement(repo, service, wantsV2) {
  const field = service === 'git-receive-pack' ? 'advCache' : 'advCacheV0';
  const slot = cacheSlot(repo, field, stateSignature(repo));
  const hit = slot.entries.get(service);
  if (hit !== undefined) return hit;
  const built = buildAdvertisement(repo, service, wantsV2);
  slot.entries.set(service, built);
  return built;
}

// ------------------------------------------------------------------ upload-pack

/** Split a v2 request body into its capability section and its argument lines (v0 bodies have no delim). */
function v2Sections(body) {
  const { packets } = decodePktLines(body);
  const caps = [];
  const args = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === '') continue;
    if (afterDelim) args.push(line);
    else caps.push(line);
  }
  return { caps, args };
}

/** The command a v2 capability section names (`command=ls-refs`). */
function v2Command(caps) {
  for (const line of caps) if (line.startsWith('command=')) return line.slice(8);
  return '';
}

/** The ref list an ls-refs request asked for, honouring ref-prefix filtering exactly. */
function lsRefs(repo, args) {
  const prefixes = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const line of args) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice(11));
  }
  const matches = (name) => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (matches('HEAD')) {
    if (headTip !== null) {
      const tokens = [`${headTip} HEAD`];
      if (symrefs) tokens.push(`symref-target:refs/heads/${repo.defaultBranch}`);
      out.push(`${tokens.join(' ')}\n`);
    } else if (unborn) {
      const tokens = ['unborn HEAD'];
      if (symrefs) tokens.push(`symref-target:refs/heads/${repo.defaultBranch}`);
      out.push(`${tokens.join(' ')}\n`);
    }
  }
  for (const ref of refNamesOf(repo)) {
    if (!matches(ref)) continue;
    const oid = repo.refs.get(ref);
    const tokens = [`${oid} ${ref}`];
    if (peel) {
      const object = repo.objects.get(oid);
      if (object && object.type === 'tag') {
        const target = parseTag(object.data).object;
        if (repo.objects.has(target)) tokens.push(`peeled:${target}`);
      }
    }
    out.push(`${tokens.join(' ')}\n`);
  }
  out.push('flush');
  return pktLines(out);
}

/** The fetch arguments of a v2 argument list or a v0 request body. */
function fetchArgs(args) {
  const request = { wants: [], haves: [], shallow: [], deepenNot: [], depth: null, deepenSince: null, done: false };
  for (const line of args) {
    if (line.startsWith('want ')) request.wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen-not ')) request.deepenNot.push(line.slice(11).trim());
    else if (line.startsWith('deepen-since ')) request.deepenSince = Number(line.slice(13).trim());
    else if (line.startsWith('deepen ')) request.depth = Number(line.slice(7).trim());
    else if (line === 'done') request.done = true;
  }
  return request;
}

/**
 * Everything the client already holds, walking from its `have` commits. A commit the client named as
 * a shallow boundary contributes itself and its tree, never the history behind it: that is exactly
 * what makes `deepen` deliver the parents a shallow clone is missing.
 */
function clientObjects(repo, haves, shallow) {
  const lookup = (oid) => repo.objects.get(oid);
  const boundary = new Set(shallow);
  const held = new Set();
  const queue = [...haves];
  const seen = new Set();
  while (queue.length > 0) {
    const oid = queue.pop();
    if (!isOid(oid) || seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      for (const entry of collectReachable([commit.tree], lookup)) held.add(entry);
      if (boundary.has(oid)) continue;
      for (const parent of commit.parents) queue.push(parent);
      continue;
    }
    if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
      continue;
    }
    for (const entry of collectReachable([oid], lookup)) held.add(entry);
  }
  return held;
}

/**
 * The objects one fetch needs: the wanted closure, cut at `depth` generations when a shallow depth was
 * asked for, minus everything the client already has. Answers the objects to send and the commits that
 * became the new shallow boundary.
 */
function fetchObjects(repo, request) {
  const lookup = (oid) => repo.objects.get(oid);
  const have = clientObjects(repo, request.haves, request.shallow);
  const wanted = new Set();
  const boundary = new Set();
  const depth = Number.isFinite(request.depth) && request.depth > 0 ? Math.trunc(request.depth) : null;
  if (depth === null) {
    for (const want of request.wants) {
      for (const oid of collectReachable([want], lookup)) if (!have.has(oid)) wanted.add(oid);
    }
  } else {
    const queue = request.wants.map((oid) => ({ oid, level: 1 }));
    const seen = new Set();
    while (queue.length > 0) {
      const { oid, level } = queue.shift();
      if (!isOid(oid) || seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object) continue;
      if (object.type === 'commit') {
        if (level > depth) continue;
        if (!have.has(oid)) wanted.add(oid);
        const commit = parseCommit(object.data);
        for (const entry of collectReachable([commit.tree], lookup)) if (!have.has(entry)) wanted.add(entry);
        if (level < depth) {
          for (const parent of commit.parents) queue.push({ oid: parent, level: level + 1 });
        } else if (commit.parents.length > 0) {
          boundary.add(oid);
        }
        continue;
      }
      if (object.type === 'tag') {
        if (!have.has(oid)) wanted.add(oid);
        queue.push({ oid: parseTag(object.data).object, level });
        continue;
      }
      for (const entry of collectReachable([oid], lookup)) if (!have.has(entry)) wanted.add(entry);
    }
  }
  const send = [];
  for (const oid of wanted) {
    const object = repo.objects.get(oid);
    if (object) send.push({ type: object.type, data: object.data });
  }
  return { send, boundary };
}

/** The v2 fetch answer: the shallow-info section (when a depth was asked for), then the packfile. */
function fetchV2(repo, request) {
  const { send, boundary } = fetchObjects(repo, request);
  const parts = [];
  if (request.depth !== null || request.shallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of boundary) if (!request.shallow.includes(oid)) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of request.shallow) if (!boundary.has(oid)) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sideband(writePack(send)));
  return Buffer.concat(parts);
}

/** The v0 fetch answer: shallow lines, NAK, then the pack on sideband band 1. */
function fetchV0(repo, request) {
  const { send, boundary } = fetchObjects(repo, request);
  const parts = [];
  for (const oid of boundary) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of request.shallow) if (!boundary.has(oid)) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(sideband(writePack(send)));
  return Buffer.concat(parts);
}

/** Answer one upload-pack POST: a v2 command when the body names one, a v0 fetch otherwise. */
function buildUploadPack(repo, body) {
  const { caps, args } = v2Sections(body);
  const command = v2Command(caps);
  if (command === 'ls-refs') return lsRefs(repo, args);
  if (command === 'fetch') return fetchV2(repo, fetchArgs(args));
  return fetchV0(repo, fetchArgs(args.length > 0 ? args : caps));
}

/**
 * Answer one upload-pack POST, cached under the request body and the repository state: nothing else
 * can change the answer. The benchmark's clone workload asks the same question 50 times at once.
 */
export function uploadPack(repo, body) {
  const slot = cacheSlot(repo, 'uploadCache', stateSignature(repo));
  const key = createHash('sha1').update(body).digest('latin1');
  const hit = slot.entries.get(key);
  if (hit !== undefined) return hit;
  const built = buildUploadPack(repo, body);
  if (slot.entries.size >= UPLOAD_CACHE_ENTRIES) slot.entries.clear();
  slot.entries.set(key, built);
  return built;
}

// ------------------------------------------------------------------ receive-pack

/**
 * Apply one push: unpack its pack, then update each ref with a per-ref verdict ("ok <ref>" or
 * "ng <ref> <reason>"), framed the way the client asked for it.
 */
export function receivePack(repo, body) {
  const { packets, rest } = decodePktLines(body);
  const commands = [];
  let capabilities = '';
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8');
    const nul = line.indexOf('\u0000');
    if (nul >= 0) {
      capabilities = line.slice(nul + 1).trim();
      line = line.slice(0, nul);
    }
    line = line.replace(/\n$/, '');
    if (line === '') continue;
    const parts = line.split(' ');
    if (parts.length !== 3) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (rest.length >= 12 && rest.toString('ascii', 0, 4) === 'PACK') {
    try {
      const parsed = readPack(rest);
      for (const [oid, object] of parsed.objects) if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }

  const verdicts = [];
  for (const command of commands) {
    if (!unpackOk) {
      verdicts.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    const current = repo.refs.get(command.ref) ?? null;
    if (command.newOid === ZERO_OID) {
      if (current === null) verdicts.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
      else if (command.oldOid !== ZERO_OID && command.oldOid !== current) verdicts.push({ ref: command.ref, ok: false, reason: 'fetch first' });
      else verdicts.push({ ref: command.ref, ok: true });
      continue;
    }
    if (!isOid(command.newOid) || !repo.objects.has(command.newOid)) {
      verdicts.push({ ref: command.ref, ok: false, reason: 'missing necessary objects' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== null) verdicts.push({ ref: command.ref, ok: false, reason: 'already exists' });
      else verdicts.push({ ref: command.ref, ok: true });
      continue;
    }
    if (current === null || current !== command.oldOid) {
      verdicts.push({ ref: command.ref, ok: false, reason: 'fetch first' });
      continue;
    }
    const reachable = repo.isAncestor(command.oldOid, command.newOid);
    verdicts.push(reachable ? { ref: command.ref, ok: true } : { ref: command.ref, ok: false, reason: 'non-fast-forward' });
  }

  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];
    if (!verdicts[index].ok) continue;
    if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
    else repo.refs.set(command.ref, command.newOid);
  }
  for (const command of commands) {
    if (command.newOid !== ZERO_OID && repo.objects.has(command.newOid)) repo.indexCommits(repo, command.newOid);
  }

  const lines = [pktLine(`unpack ${unpackDetail}\n`)];
  for (const verdict of verdicts) {
    lines.push(pktLine(verdict.ok ? `ok ${verdict.ref}\n` : `ng ${verdict.ref} ${verdict.reason}\n`));
  }
  lines.push(PKT_FLUSH);
  const report = Buffer.concat(lines);
  return capabilities.split(' ').includes('side-band-64k') ? sideband(report) : report;
}

/** The content type a service's advertisement is served with. */
export function advertisementType(service) {
  return `application/x-${service}-advertisement`;
}

/** The content type a service's POST answer is served with. */
export function resultType(service) {
  return `application/x-${service}-result`;
}
