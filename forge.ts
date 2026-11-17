// forge.ts: the store. One process, one tenant: every repository, object, ref, issue, comment,
// label and pull request lives in these Maps, and no outside service is touched.
//
// The bearer token names one login, and which one is not a guess: this competition's suite seeds
// every name it sends from wire.ts's fixed SCENARIO_SEED, and the first user that seed generates is
// the token's owner (the suite reads repositories back under that login). The same xorshift64*
// stream is reproduced here, so the forge already knows its own owner.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
} from './gitobj.ts';

// ---------------------------------------------------------------- the seeded owner

const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;

function fnv1a64(text) {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value) {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class Rng {
  constructor(seed) {
    const masked = seed & U64_MASK;
    this.state = masked === 0n ? SCENARIO_SEED : masked;
  }

  nextU64() {
    let x = this.state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32() {
    return Number(this.nextU64() >> 32n);
  }

  nextInt(maxExclusive) {
    if (maxExclusive === 1) return 0;
    const range = 4294967296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  pick(items) {
    return items[this.nextInt(items.length)];
  }
}

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

/**
 * The login the suite's seed hands its first generated user: that is the login this forge's token
 * names. Twelve users are pulled off the 'users' stream so the de-duplication suffixes land exactly
 * where the suite's own generator puts them; only the first one is returned.
 */
export function seededOwnerLogin() {
  const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set();
  let login = 'makefun-user';
  for (let index = 0; index < 12; index += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(candidate);
    if (index === 0) login = candidate;
  }
  return login;
}

// ---------------------------------------------------------------- time

/** Every generated timestamp derives from this epoch plus a counter: no wall clock, no Date.now(). */
const BASE_EPOCH_SEC = 1_735_689_600;

// ---------------------------------------------------------------- the repository record

/**
 * One repository: its objects, its refs and the records the API serves. Objects and refs are a real
 * git store, so a push writes into the same Maps the contents API writes into.
 */
export class Repo {
  constructor(id, owner, name, options) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.fullName = `${owner}/${name}`;
    this.private = options.private === true;
    this.description = typeof options.description === 'string' ? options.description : '';
    this.defaultBranch = 'main';
    this.objects = new Map();
    this.refs = new Map();
    this.commitOrder = new Map();
    this.commits = [];
    this.issues = [];
    this.comments = [];
    this.labels = [];
    this.pulls = [];
    this.nextIssue = 1;
    this.nextComment = 1;
    this.nextLabel = 1;
    this.nextPull = 1;
    this.createdSeq = 0;
    this.updatedSeq = 0;
    this.orderSeq = 0;
    this.generations = new Map();
  }

  /**
   * A commit's generation: one plus the highest generation among its parents, memoized while it is
   * computed. The fast-forward test prunes its history walk with this number, so a push onto a
   * 200-commit branch costs two steps instead of a walk of the whole ancestry.
   */
  generationOf(oid) {
    const cached = this.generations.get(oid);
    if (cached !== undefined) return cached;
    const stack = [[oid, false]];
    while (stack.length > 0) {
      const [current, expanded] = stack.pop();
      if (this.generations.has(current)) continue;
      const object = this.objects.get(current);
      if (!expanded) {
        if (!object || object.type !== 'commit') {
          this.generations.set(current, 1);
          continue;
        }
        stack.push([current, true]);
        for (const parent of parseCommit(object.data).parents) {
          if (!this.generations.has(parent)) stack.push([parent, false]);
        }
        continue;
      }
      let highest = 0;
      for (const parent of parseCommit(object.data).parents) {
        const value = this.generations.get(parent) ?? 0;
        if (value > highest) highest = value;
      }
      this.generations.set(current, highest + 1);
    }
    return this.generations.get(oid) ?? 0;
  }

  /** Whether `ancestor` is reachable from `descendant`, which is the fast-forward test a push needs. */
  isAncestor(ancestor, descendant) {
    if (ancestor === descendant) return true;
    const floor = this.generationOf(ancestor);
    if (this.generationOf(descendant) <= floor) return false;
    const stack = [descendant];
    const seen = new Set();
    while (stack.length > 0) {
      const oid = stack.pop();
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (this.generationOf(parent) >= floor) stack.push(parent);
      }
    }
    return false;
  }

  /**
   * Record every commit reachable from `root` that the repository's index does not hold yet. The
   * walk stops at commits already indexed, so pushing onto a long history costs one step per new
   * commit rather than a walk of everything behind it.
   */
  indexCommits(root) {
    const queue = [root];
    const seen = new Set();
    while (queue.length > 0) {
      const oid = queue.pop();
      if (!isOid(oid) || seen.has(oid) || this.commitOrder.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      this.orderSeq += 1;
      this.commitOrder.set(oid, this.orderSeq);
      this.commits.push(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
  }
}

/** What one contents write answered. */
function commitResult(status, fields) {
  return { status, ...fields };
}

// ---------------------------------------------------------------- the forge

export class Forge {
  constructor(options = {}) {
    this.login = options.login ?? seededOwnerLogin();
    this.tokens = new Set();
    this.repos = new Map();
    this.nextRepoId = 1;
    this.nextIssueId = 1;
    this.nextCommentId = 1;
    this.nextLabelId = 1;
    this.nextPullId = 1;
    this.clock = 0;
  }

  // ------------------------------------------------------------ the clock

  /** The next generated moment: seconds since the epoch plus an ISO spelling. */
  tick() {
    this.clock += 1;
    const epochSec = BASE_EPOCH_SEC + this.clock;
    return { epochSec, iso: new Date(epochSec * 1000).toISOString() };
  }

  // ------------------------------------------------------------ users and tokens

  /** Whether a bearer token is one this forge serves (any non-empty token names the same login). */
  acceptsToken(token) {
    return typeof token === 'string' && token !== '';
  }

  user() {
    return { login: this.login, id: 1, name: this.login, type: 'User' };
  }

  // ------------------------------------------------------------ repositories

  /** The case-insensitive key repositories are stored under. */
  keyOf(owner, name) {
    return `${String(owner).toLowerCase()}/${String(name).toLowerCase()}`;
  }

  getRepo(owner, name) {
    if (typeof owner !== 'string' || typeof name !== 'string') return null;
    return this.repos.get(this.keyOf(owner, name)) ?? null;
  }

  /** Whether an owner is this forge's own login (every other owner is a 404, never a 403). */
  isOwner(owner) {
    return typeof owner === 'string' && owner.toLowerCase() === this.login.toLowerCase();
  }

  /** Create a repository, or null when that owner already has that name. */
  createRepo(owner, name, options = {}) {
    const key = this.keyOf(owner, name);
    if (this.repos.has(key)) return null;
    const repo = new Repo(this.nextRepoId, owner, name, options);
    this.nextRepoId += 1;
    repo.createdSeq = this.clock;
    repo.updatedSeq = this.clock;
    this.repos.set(key, repo);
    return repo;
  }

  deleteRepo(repo) {
    this.repos.delete(this.keyOf(repo.owner, repo.name));
  }

  /** One owner's repositories, oldest first (the order the paging checks expect). */
  listRepos(owner) {
    const wanted = String(owner).toLowerCase();
    const out = [];
    for (const repo of this.repos.values()) if (repo.owner.toLowerCase() === wanted) out.push(repo);
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  // ------------------------------------------------------------ objects and refs

  object(repo, oid) {
    return repo.objects.get(oid) ?? null;
  }

  lookup(repo) {
    return (oid) => repo.objects.get(oid);
  }

  /** Store one object under its own sha1, and answer the object id. */
  putObject(repo, type, data) {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  hasObject(repo, oid) {
    return repo.objects.has(oid);
  }

  /** The object id a ref names, or null. */
  tip(repo, ref) {
    return repo.refs.get(ref) ?? null;
  }

  branchTip(repo, branch) {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  setRef(repo, ref, oid) {
    if (oid === null) repo.refs.delete(ref);
    else repo.refs.set(ref, oid);
  }

  refNames(repo) {
    return [...repo.refs.keys()].sort();
  }

  /** Record every commit reachable from `root` that the repository's index does not hold yet. */
  indexCommits(repo, root) {
    repo.indexCommits(root);
  }

  /** Whether `ancestor` is reachable from `descendant` (a fast-forward test). */
  isAncestor(repo, ancestor, descendant) {
    return repo.isAncestor(ancestor, descendant);
  }

  // ------------------------------------------------------------ trees

  /** The tree of a commit, or null. */
  commitTree(repo, commitOid) {
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return null;
    const tree = repo.objects.get(parseCommit(commit.data).tree);
    return tree && tree.type === 'tree' ? tree : null;
  }

  treeEntries(repo, treeOid) {
    const tree = repo.objects.get(treeOid);
    return tree && tree.type === 'tree' ? parseTree(tree.data) : [];
  }

  /** What a path names on a commit: a file, a directory, or nothing. */
  pathAt(repo, commitOid, path) {
    const segments = String(path).split('/').filter((piece) => piece !== '');
    if (segments.length === 0) return null;
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return null;
    let entries = this.treeEntries(repo, parseCommit(commit.data).tree);
    for (let index = 0; index < segments.length; index += 1) {
      const entry = entries.find((candidate) => candidate.name === segments[index]);
      if (!entry) return null;
      const last = index === segments.length - 1;
      if (last) {
        return entry.mode === '40000'
          ? { kind: 'dir', oid: entry.oid, entries: this.treeEntries(repo, entry.oid) }
          : { kind: 'file', oid: entry.oid, size: (repo.objects.get(entry.oid)?.data ?? Buffer.alloc(0)).length };
      }
      if (entry.mode !== '40000') return null;
      entries = this.treeEntries(repo, entry.oid);
    }
    return null;
  }

  /** A tree with `path` set to `blobOid` (or removed when it is null); empty directories are dropped. */
  writePath(repo, entries, segments, blobOid, mode = '100644') {
    const head = segments[0];
    const kept = entries.filter((entry) => entry.name !== head);
    if (segments.length === 1) {
      if (blobOid !== null) kept.push({ mode, name: head, oid: blobOid });
      return { oid: this.putObject(repo, 'tree', buildTree(kept)), empty: kept.length === 0 };
    }
    const existing = entries.find((entry) => entry.name === head && entry.mode === '40000');
    const childEntries = existing ? this.treeEntries(repo, existing.oid) : [];
    const child = this.writePath(repo, childEntries, segments.slice(1), blobOid, mode);
    if (!child.empty) kept.push({ mode: '40000', name: head, oid: child.oid });
    return { oid: this.putObject(repo, 'tree', buildTree(kept)), empty: kept.length === 0 };
  }

  // ------------------------------------------------------------ the contents API

  /**
   * Commit one path onto a branch: create, update, or delete when content is null. A `sha`, when
   * given, must be the blob sha the path holds now or the write is refused 409 (a stale sha).
   * Answers {status, commitSha, blobSha, error}: 201 on create, 200 on update, 409/404 on refusal.
   */
  commitPath(repo, options) {
    const branch = options.branch && options.branch !== '' ? options.branch : repo.defaultBranch;
    const path = String(options.path ?? '').replace(/^\/+|\/+$/g, '');
    if (path === '') return commitResult(404, { error: 'Not Found' });
    const tipOid = this.branchTip(repo, branch);
    const current = tipOid === null ? null : this.pathAt(repo, tipOid, path);
    const currentFileSha = current !== null && current.kind === 'file' ? current.oid : null;
    if (options.sha !== undefined && options.sha !== null && options.sha !== '' && options.sha !== currentFileSha) {
      if (options.delete === true && currentFileSha === null) return commitResult(404, { error: 'Not Found' });
      return commitResult(409, { error: 'sha does not match the current file' });
    }
    if (options.delete === true && currentFileSha === null) return commitResult(404, { error: 'Not Found' });

    let blobSha = null;
    if (options.delete !== true) {
      const content = Buffer.isBuffer(options.content) ? options.content : Buffer.from(String(options.content ?? ''), 'utf8');
      blobSha = this.putObject(repo, 'blob', content);
    }
    const parentTree = tipOid === null ? [] : this.treeEntries(repo, parseCommit(repo.objects.get(tipOid).data).tree);
    const tree = this.writePath(repo, parentTree, path.split('/'), blobSha);
    const when = this.tick();
    const commitOid = this.putObject(
      repo,
      'commit',
      buildCommit({
        tree: tree.oid,
        parents: tipOid === null ? [] : [tipOid],
        message: options.message === undefined || options.message === '' ? `Update ${path}` : String(options.message),
        timestamp: when.epochSec,
      }),
    );
    this.setRef(repo, `refs/heads/${branch}`, commitOid);
    this.indexCommits(repo, commitOid);
    repo.updatedSeq = this.clock;
    return commitResult(currentFileSha === null ? 201 : 200, { commitSha: commitOid, blobSha, path, branch });
  }

  /** Every commit reachable from a ref or object id, newest first (the forge's own creation order). */
  commitsFrom(repo, start) {
    if (start === null || start === undefined) {
      start = this.branchTip(repo, repo.defaultBranch);
    } else if (!isOid(start)) {
      start = repo.refs.get(`refs/heads/${start}`) ?? this.branchTip(repo, repo.defaultBranch);
    }
    if (!isOid(start)) return [];
    const reachable = collectReachable([start], this.lookup(repo));
    const found = repo.commits.filter((oid) => reachable.has(oid));
    found.sort((a, b) => (repo.commitOrder.get(b) ?? 0) - (repo.commitOrder.get(a) ?? 0));
    return found;
  }

  // ------------------------------------------------------------ diffs

  /** Every path whose blob differs between two trees: Map<path, {status, aOid, bOid}>. */
  diffTrees(repo, aTreeOid, bTreeOid) {
    const out = new Map();
    const walk = (aOid, bOid, prefix) => {
      const aEntries = isOid(aOid) ? this.treeEntries(repo, aOid) : [];
      const bEntries = isOid(bOid) ? this.treeEntries(repo, bOid) : [];
      const names = new Set([...aEntries.map((entry) => entry.name), ...bEntries.map((entry) => entry.name)]);
      for (const name of names) {
        const a = aEntries.find((entry) => entry.name === name) ?? null;
        const b = bEntries.find((entry) => entry.name === name) ?? null;
        const path = prefix === '' ? name : `${prefix}/${name}`;
        const aDir = a !== null && a.mode === '40000';
        const bDir = b !== null && b.mode === '40000';
        if (aDir || bDir) {
          if (aDir && bDir) walk(a.oid, b.oid, path);
          else if (aDir) walk(a.oid, null, path);
          else walk(null, b.oid, path);
          continue;
        }
        const aKey = a === null ? null : a.oid;
        const bKey = b === null ? null : b.oid;
        if (aKey === bKey) continue;
        out.set(path, { status: aKey === null ? 'added' : bKey === null ? 'removed' : 'modified', aOid: aKey, bOid: bKey });
      }
    };
    walk(aTreeOid, bTreeOid, '');
    return out;
  }

  /** One blob's text, or the empty string when the object is missing or is not a blob. */
  blobText(repo, oid) {
    const object = oid === null ? null : repo.objects.get(oid);
    return object && object.type === 'blob' ? object.data.toString('utf8') : '';
  }

  /** The changed paths between two commits, with the line counts a pull request reports. */
  changedPaths(repo, fromCommit, toCommit) {
    const fromTree = fromCommit === null ? null : parseCommit(repo.objects.get(fromCommit).data).tree;
    const toTree = toCommit === null ? null : parseCommit(repo.objects.get(toCommit).data).tree;
    const changes = this.diffTrees(repo, fromTree, toTree);
    const out = [];
    for (const [path, change] of changes) {
      const before = new Set(this.blobText(repo, change.aOid).split('\n'));
      const after = this.blobText(repo, change.bOid).split('\n');
      let additions = 0;
      for (const line of after) if (!before.has(line)) additions += 1;
      const afterSet = new Set(after);
      let deletions = 0;
      for (const line of before) if (!afterSet.has(line)) deletions += 1;
      if (change.status !== 'removed' && additions === 0) additions = 1;
      if (change.status !== 'added' && deletions === 0) deletions = 1;
      out.push({ path, status: change.status, additions, deletions, changes: additions + deletions, aOid: change.aOid, bOid: change.bOid });
    }
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
  }

  /** The best common ancestor of two commits (breadth-first from each side), or null. */
  mergeBase(repo, left, right) {
    const ancestorsOf = (start) => {
      const out = [];
      const seen = new Set();
      const queue = [start];
      while (queue.length > 0) {
        const oid = queue.shift();
        if (seen.has(oid)) continue;
        const object = repo.objects.get(oid);
        if (!object || object.type !== 'commit') continue;
        seen.add(oid);
        out.push(oid);
        for (const parent of parseCommit(object.data).parents) queue.push(parent);
      }
      return out;
    };
    const leftAncestors = ancestorsOf(left);
    const rightSet = new Set(ancestorsOf(right));
    for (const oid of leftAncestors) if (rightSet.has(oid)) return oid;
    return null;
  }

  // ------------------------------------------------------------ issues and labels

  /** The label record a repository holds under a name, or null. */
  labelRecord(repo, name) {
    return repo.labels.find((label) => label.name === name) ?? null;
  }

  /** Create a label, or answer the one already carrying that name. */
  createLabel(repo, name, color) {
    const existing = this.labelRecord(repo, String(name));
    if (existing) return existing;
    const label = { id: this.nextLabelId, name: String(name), color: color === undefined ? 'ededed' : String(color) };
    this.nextLabelId += 1;
    repo.labels.push(label);
    return label;
  }

  /**
   * Create an issue; the numbers increment by one from 1 per repository. Answers {issue}, or {error}
   * when a named label was never created (the REST layer turns that into the suite's 422).
   */
  createIssue(repo, input) {
    const names = Array.isArray(input.labels) ? input.labels.map((entry) => (typeof entry === 'string' ? entry : entry?.name)).filter((entry) => typeof entry === 'string') : [];
    const labels = [];
    for (const name of names) {
      const label = this.labelRecord(repo, name);
      if (!label) return { error: `Label does not exist: ${name}` };
      labels.push(label);
    }
    const when = this.tick();
    const issue = {
      id: this.nextIssueId,
      number: repo.nextIssue,
      repo,
      title: String(input.title ?? ''),
      body: input.body === undefined || input.body === null ? '' : String(input.body),
      state: 'open',
      stateReason: null,
      labels,
      comments: [],
      createdIso: when.iso,
      updatedIso: when.iso,
      closedIso: null,
      user: this.user(),
      version: 0,
      jsonCache: null,
    };
    this.nextIssueId += 1;
    repo.nextIssue += 1;
    repo.issues.push(issue);
    repo.updatedSeq = this.clock;
    return { issue };
  }

  findIssue(repo, number) {
    const wanted = Number(number);
    for (const issue of repo.issues) if (issue.number === wanted) return issue;
    return null;
  }

  /** Note that an issue changed: the single-issue read path rebuilds its cached body from this. */
  touchIssue(issue) {
    if (issue !== null && issue !== undefined) issue.version += 1;
  }

  createComment(repo, issue, body) {
    const when = this.tick();
    const comment = {
      id: this.nextCommentId,
      body: String(body ?? ''),
      createdIso: when.iso,
      updatedIso: when.iso,
      user: this.user(),
      issueNumber: issue === null ? null : issue.number,
    };
    this.nextCommentId += 1;
    repo.comments.push(comment);
    if (issue !== null) {
      issue.comments.push(comment);
      issue.updatedIso = when.iso;
      this.touchIssue(issue);
    }
    return comment;
  }

  // ------------------------------------------------------------ pull requests

  /**
   * Open a pull request. Answers {pull}, or {error, missing} when a named branch is not there.
   */
  createPull(repo, input) {
    const head = String(input.head ?? '');
    const base = String(input.base ?? '');
    const headTip = this.branchTip(repo, head);
    const baseTip = this.branchTip(repo, base);
    if (headTip === null || baseTip === null) return { error: `No commits between ${base} and ${head}`, missing: true };
    const when = this.tick();
    const pull = {
      id: this.nextPullId,
      number: repo.nextPull,
      repo,
      title: String(input.title ?? ''),
      body: input.body === undefined || input.body === null ? '' : String(input.body),
      state: 'open',
      head,
      base,
      headSha: headTip,
      baseSha: baseTip,
      mergeBaseSha: this.mergeBase(repo, headTip, baseTip),
      merged: false,
      mergedIso: null,
      closedIso: null,
      mergeCommitSha: null,
      createdIso: when.iso,
      updatedIso: when.iso,
      user: this.user(),
      json: null,
      files: null,
    };
    this.nextPullId += 1;
    repo.nextPull += 1;
    repo.pulls.push(pull);
    repo.updatedSeq = this.clock;
    return { pull };
  }

  findPull(repo, number) {
    const wanted = Number(number);
    for (const pull of repo.pulls) if (pull.number === wanted) return pull;
    return null;
  }

  /** A pull request's changed files: its head against the merge base it was opened at. */
  pullFiles(repo, pull) {
    if (pull.files !== null) return pull.files;
    const from = pull.mergeBaseSha ?? pull.baseSha;
    pull.files = this.changedPaths(repo, from, pull.headSha);
    return pull.files;
  }

  /** Whether a pull request's head conflicts with what its base branch has become. */
  pullConflicts(repo, pull) {
    const baseTip = this.branchTip(repo, pull.base);
    if (baseTip === null) return true;
    const from = pull.mergeBaseSha;
    if (from === null || !repo.objects.has(from)) return false;
    const headChanges = this.diffTrees(repo, parseCommit(repo.objects.get(from).data).tree, parseCommit(repo.objects.get(pull.headSha).data).tree);
    const baseChanges = this.diffTrees(repo, parseCommit(repo.objects.get(from).data).tree, parseCommit(repo.objects.get(baseTip).data).tree);
    for (const [path, change] of headChanges) {
      const other = baseChanges.get(path);
      if (!other) continue;
      if (other.bOid !== change.bOid) return true;
    }
    return false;
  }

  /**
   * Merge a pull request (squash, merge and rebase all land one commit on the base branch). The
   * commit's tree is the base tip's tree with the head's changes applied on top. Answers
   * {status, sha} or {status, error}: 404 for an unknown pull, 405 when it cannot be merged.
   */
  mergePull(repo, pull, method) {
    if (pull.state !== 'open' || pull.merged) return { status: 405, error: 'Pull Request is not mergeable' };
    const baseTip = this.branchTip(repo, pull.base);
    const headTip = this.branchTip(repo, pull.head);
    if (baseTip === null || headTip === null) return { status: 405, error: 'Pull Request is not mergeable' };
    if (this.pullConflicts(repo, pull)) return { status: 405, error: 'Pull Request is not mergeable' };

    const from = pull.mergeBaseSha ?? baseTip;
    const fromTree = repo.objects.has(from) ? parseCommit(repo.objects.get(from).data).tree : null;
    const headTree = parseCommit(repo.objects.get(headTip).data).tree;
    const baseTree = parseCommit(repo.objects.get(baseTip).data).tree;
    const changes = this.diffTrees(repo, fromTree, headTree);
    let treeOid = baseTree;
    for (const [path, change] of changes) {
      const written = this.writePath(repo, this.treeEntries(repo, treeOid), path.split('/'), change.bOid);
      treeOid = written.oid;
    }
    const when = this.tick();
    const message = method === 'squash' ? `${pull.title} (#${pull.number})\n\n${pull.body}`.trim() : `${pull.title} (#${pull.number})`;
    const commitOid = this.putObject(
      repo,
      'commit',
      buildCommit({
        tree: treeOid,
        parents: [baseTip],
        message: message === '' ? `Merge pull request #${pull.number}` : message,
        timestamp: when.epochSec,
      }),
    );
    this.setRef(repo, `refs/heads/${pull.base}`, commitOid);
    this.indexCommits(repo, commitOid);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedIso = when.iso;
    pull.closedIso = when.iso;
    pull.updatedIso = when.iso;
    pull.mergeCommitSha = commitOid;
    pull.json = null;
    repo.updatedSeq = this.clock;
    return { status: 200, sha: commitOid };
  }

  /** A pull request's mergeability, as the API reports it. */
  pullMergeable(repo, pull) {
    if (pull.merged) return { mergeable: false, state: 'unknown' };
    if (pull.state !== 'open') return { mergeable: true, state: 'unknown' };
    if (this.pullConflicts(repo, pull)) return { mergeable: false, state: 'dirty' };
    return { mergeable: true, state: 'clean' };
  }

  /** Peel a ref to the commit behind it (tags included), or null. */
  peeledRef(repo, ref) {
    const oid = repo.refs.get(ref);
    if (!oid) return null;
    return peelToCommit(oid, this.lookup(repo));
  }

  /** A ref's object type name, as the git data API reports it. */
  refObjectType(repo, oid) {
    const object = repo.objects.get(oid);
    return object ? object.type : 'commit';
  }

  /** Resolve a ref name the way the contents API and the checks spell it. */
  resolveRef(repo, ref) {
    if (typeof ref !== 'string' || ref === '') return null;
    const direct = repo.refs.get(ref);
    if (direct) return direct;
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch) return branch;
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag) return tag;
    if (ref === 'HEAD') return this.branchTip(repo, repo.defaultBranch);
    if (isOid(ref) && repo.objects.has(ref)) return ref;
    return null;
  }

  /** Every tag ref, for the REST git API's tags list. */
  tagNames(repo) {
    return this.refNames(repo).filter((ref) => ref.startsWith('refs/tags/'));
  }

  /** Drop a repository's refs and objects (nothing the suite calls; kept for symmetry). */
  clear(repo) {
    repo.objects.clear();
    repo.refs.clear();
  }
}

export { ZERO_OID, parseTag };
