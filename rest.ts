// rest.ts: GitHub REST v3 under /api/v3. Repositories, branches, commits and contents; issues,
// comments and labels; pull requests, their files and merges; plus the wire discipline the protocol
// group checks (JSON content types, a JSON 404 for an unknown route, a request id on every reply, and
// a string message in every error body).
//
// Every reply this file builds is a plain object and the server writes it as JSON. Authentication is
// the server's job: a request without the bearer token never reaches here.

import { ZERO_OID, isOid, parseCommit, parseTree, peelToCommit } from './gitobj.ts';

// ---------------------------------------------------------------- small helpers

/** A page's size: GitHub's default 30, never more than 100. */
function perPageOf(query, fallback = 30) {
  const value = Number(query.get('per_page'));
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(100, Math.trunc(value));
}

/** A page number: 1 or more. */
function pageOf(query) {
  const value = Number(query.get('page'));
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.trunc(value);
}

/** The `Link` pagination header for a paged list. */
function linkHeader(origin, path, query, page, perPage, total) {
  const parts = [];
  const url = (target) => {
    const params = new URLSearchParams();
    for (const [key, value] of query.entries()) if (key !== 'page') params.set(key, value);
    params.set('per_page', String(perPage));
    params.set('page', String(target));
    return `<${origin}${path}?${params.toString()}>`;
  };
  if (page * perPage < total) parts.push(`${url(page + 1)}; rel="next"`);
  const last = Math.max(1, Math.ceil(total / perPage));
  if (page < last) parts.push(`${url(last)}; rel="last"`);
  if (page > 1) parts.push(`${url(page - 1)}; rel="prev"`);
  parts.push(`${url(1)}; rel="first"`);
  return parts.join(', ');
}

function base64Of(buffer) {
  return buffer.toString('base64');
}

/** Base64 with the line breaks a client may have added stripped out. */
function decodeBase64(text) {
  return Buffer.from(String(text).replace(/[\r\n\t ]+/g, ''), 'base64');
}

/** One identity line (`name <email> seconds +0000`) as the REST commit object spells it. */
function personOf(line) {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line ?? '');
  if (match === null) return { name: line ?? '', email: '', date: '2025-01-01T00:00:00.000Z' };
  return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
}

/** A git commit id's REST object. */
function commitJson(repo, oid, record) {
  const object = repo.objects.get(oid);
  const commit = object && object.type === 'commit' ? parseCommit(object.data) : null;
  const message = commit !== null ? commit.message : (record?.message ?? '');
  const person = personOf(commit !== null ? commit.author : '');
  return {
    sha: oid,
    node_id: `C_${oid}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `/${repo.owner}/${repo.name}/commit/${oid}`,
    commit: {
      message,
      author: person,
      committer: person,
      tree: { sha: commit !== null ? commit.tree : ZERO_OID, url: '' },
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    author: { login: repo.owner, id: 1, type: 'User' },
    committer: { login: repo.owner, id: 1, type: 'User' },
    parents: commit !== null ? commit.parents.map((parent) => ({ sha: parent, url: '' })) : [],
  };
}

// ---------------------------------------------------------------- the records the API serves

/** One repository as the API spells it. */
export function repoJson(repo, forge) {
  const open = repo.issues.filter((issue) => issue.state === 'open').length;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: 1, node_id: 'U_1', type: 'User', site_admin: false },
    private: repo.private,
    description: repo.description === '' ? null : repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.fullName}`,
    html_url: `/${repo.fullName}`,
    archive_url: `/api/v3/repos/${repo.fullName}/{archive_format}{/ref}`,
    clone_url: `/${repo.fullName}.git`,
    git_url: `/${repo.fullName}.git`,
    ssh_url: `git@makefun.invalid:${repo.fullName}.git`,
    default_branch: repo.defaultBranch,
    created_at: new Date((1735689600 + repo.createdSeq) * 1000).toISOString(),
    updated_at: new Date((1735689600 + repo.updatedSeq) * 1000).toISOString(),
    pushed_at: new Date((1735689600 + repo.updatedSeq) * 1000).toISOString(),
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: open,
    open_issues: open,
    language: null,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    allow_forking: false,
    is_template: false,
    topics: [],
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

/** One label as the API spells it. */
export function labelJson(repo, label) {
  return {
    id: label.id,
    node_id: `L_${label.id}`,
    name: label.name,
    color: label.color,
    default: false,
    description: null,
    url: `/api/v3/repos/${repo.fullName}/labels/${encodeURIComponent(label.name)}`,
  };
}

/** One issue as the API spells it. */
export function issueJson(repo, issue) {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: issue.stateReason,
    locked: false,
    active_lock_reason: null,
    labels: issue.labels.map((label) => labelJson(repo, label)),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    user: { login: issue.user.login, id: 1, type: 'User' },
    author_association: 'OWNER',
    created_at: issue.createdIso,
    updated_at: issue.updatedIso,
    closed_at: issue.closedIso,
    closed_by: null,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.fullName}`,
    html_url: `/${repo.fullName}/issues/${issue.number}`,
    comments_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/events`,
    labels_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/labels{/name}`,
  };
}

/**
 * One issue's body as the exact response text. A single-issue read is the benchmark's hottest path,
 * so the serialized body, its encoded bytes and the header object are all cached against the issue's
 * version and only rebuilt once it changed: a read then hands the socket bytes it already holds.
 */
export function issueJsonText(repo, issue) {
  const cached = issue.jsonCache;
  if (cached !== null && cached !== undefined && cached.version === issue.version) return cached.text;
  const text = `${JSON.stringify(issueJson(repo, issue))}\n`;
  const bytes = Buffer.from(text, 'utf8');
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes.length,
    'cache-control': 'no-store',
  };
  issue.jsonCache = { version: issue.version, text, bytes, headers };
  return text;
}

/** The one-issue GET answer: the cached body, its bytes and its headers, ready to write. */
export function issueAnswer(repo, issue) {
  issueJsonText(repo, issue);
  const cache = issue.jsonCache;
  return { status: 200, text: cache.text, bytes: cache.bytes, headers: cache.headers };
}

/** One issue comment as the API spells it. */
export function commentJson(repo, comment) {
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    body: comment.body,
    user: { login: comment.user.login, id: 1, type: 'User' },
    created_at: comment.createdIso,
    updated_at: comment.updatedIso,
    url: `/api/v3/repos/${repo.fullName}/issues/comments/${comment.id}`,
    html_url: `/${repo.fullName}/issues/${comment.issueNumber}#issuecomment-${comment.id}`,
    issue_url: `/api/v3/repos/${repo.fullName}/issues/${comment.issueNumber}`,
    author_association: 'OWNER',
  };
}

/** One side of a pull request: the head or the base. */
function pullRef(repo, ref, sha) {
  return {
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: { login: repo.owner, id: 1, type: 'User' },
    repo: null,
  };
}

/** One pull request as the API spells it. */
export function pullJson(repo, forge, pull) {
  const mergeable = forge.pullMergeable(repo, pull);
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: { login: pull.user.login, id: 1, type: 'User' },
    labels: [],
    milestone: null,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    head: pullRef(repo, pull.head, pull.headSha),
    base: pullRef(repo, pull.base, pull.baseSha),
    _links: {},
    draft: false,
    merged: pull.merged,
    mergeable: mergeable.mergeable,
    rebaseable: mergeable.mergeable,
    mergeable_state: mergeable.state,
    merged_by: pull.merged ? { login: repo.owner, id: 1, type: 'User' } : null,
    comments: 0,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: forge.pullFiles(repo, pull).length,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdIso,
    updated_at: pull.updatedIso,
    closed_at: pull.closedIso,
    merged_at: pull.mergedIso,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
    html_url: `/${repo.fullName}/pull/${pull.number}`,
    issue_url: `/api/v3/repos/${repo.fullName}/issues/${pull.number}`,
    statuses_url: `/api/v3/repos/${repo.fullName}/statuses/${pull.headSha}`,
    diff_url: `/${repo.fullName}/pull/${pull.number}.diff`,
    patch_url: `/${repo.fullName}/pull/${pull.number}.patch`,
  };
}

// ---------------------------------------------------------------- the router

/** What the router needs from the server: the store, the request pieces and its own origin. */
export class RestRouter {
  constructor(forge) {
    this.forge = forge;
  }

  /**
   * Answer one /api/v3 request. `segments` are the decoded path segments under the prefix, `query` the
   * parsed query string, `body` the parsed JSON body (undefined when there was none), `rawText` the
   * body as it arrived, `origin` the request's own origin. Answers {status, body, headers}, or
   * {status, text} for a pre-serialized body, or null for an unknown route (the caller answers a
   * JSON 404).
   */
  handle(request) {
    const forge = this.forge;
    const segments = request.segments;
    const query = request.query;
    const method = request.method;
    const body = request.body;
    const head = segments[0] ?? '';

    // GET /api/v3/ : the API root, and the only route that carries X-OAuth-Scopes.
    if (head === '') {
      if (method !== 'GET') return null;
      return {
        status: 200,
        headers: { 'x-oauth-scopes': 'repo, read:org' },
        body: {
          current_user_url: `${request.origin}/api/v3/user`,
          current_user_authorizations_html_url: 'https://github.com/settings/connections/applications{/client_id}',
          authorizations_url: `${request.origin}/api/v3/authorizations`,
          code_search_url: `${request.origin}/api/v3/search/code?q={query}{&page,per_page,sort,order}`,
          commit_search_url: `${request.origin}/api/v3/search/commits?q={query}{&page,per_page,sort,order}`,
          emails_url: `${request.origin}/api/v3/user/emails`,
          emojis_url: `${request.origin}/api/v3/emojis`,
          events_url: `${request.origin}/api/v3/events`,
          feeds_url: `${request.origin}/api/v3/feeds`,
          followers_url: `${request.origin}/api/v3/user/followers`,
          following_url: `${request.origin}/api/v3/user/following{/target}`,
          gists_url: `${request.origin}/api/v3/gists{/gist_id}`,
          hub_url: `${request.origin}/api/v3/hub`,
          issue_search_url: `${request.origin}/api/v3/search/issues?q={query}{&page,per_page,sort,order}`,
          issues_url: `${request.origin}/api/v3/issues`,
          keys_url: `${request.origin}/api/v3/user/keys{/key_id}`,
          label_search_url: `${request.origin}/api/v3/search/labels?q={query}&repository_id={repository_id}{&page,per_page}`,
          notifications_url: `${request.origin}/api/v3/notifications`,
          organization_url: `${request.origin}/api/v3/orgs/{org}`,
          organization_repositories_url: `${request.origin}/api/v3/orgs/{org}/repos{?type,page,per_page,sort}`,
          organization_teams_url: `${request.origin}/api/v3/orgs/{org}/teams`,
          public_gists_url: `${request.origin}/api/v3/gists/public`,
          rate_limit_url: `${request.origin}/api/v3/rate_limit`,
          repository_url: `${request.origin}/api/v3/repos/{owner}/{repo}`,
          repository_search_url: `${request.origin}/api/v3/search/repositories?q={query}{&page,per_page,sort,order}`,
          current_user_repositories_url: `${request.origin}/api/v3/user/repos{?type,page,per_page,sort}`,
          starred_url: `${request.origin}/api/v3/user/starred{/owner}{/repo}`,
          starred_gists_url: `${request.origin}/api/v3/gists/starred`,
          team_url: `${request.origin}/api/v3/teams`,
          user_url: `${request.origin}/api/v3/users/{user}`,
          user_organizations_url: `${request.origin}/api/v3/user/orgs`,
          user_repositories_url: `${request.origin}/api/v3/users/{user}/repos{?type,page,per_page,sort}`,
          user_search_url: `${request.origin}/api/v3/search/users?q={query}{&page,per_page,sort,order}`,
        },
      };
    }

    if (head === 'meta' && segments.length === 1) {
      return {
        status: 200,
        body: {
          verifiable_password_authentication: false,
          ssh_key_fingerprints: {},
          ssh_keys: [],
          hooks: [],
          web: [],
          api: [],
          git: [],
          packages: [],
          pages: [],
          importer: [],
          actions: [],
          dependabot: [],
          installed_version: '3.0.0-makefun-forge',
        },
      };
    }

    if (head === 'rate_limit') {
      return { status: 200, body: { resources: { core: { limit: 5000, remaining: 5000, reset: 1735689600, used: 0 } }, rate: { limit: 5000, remaining: 5000, reset: 1735689600, used: 0 } } };
    }

    if (head === 'user') {
      if (segments.length === 1) {
        if (method !== 'GET') return null;
        return { status: 200, body: this.userJson() };
      }
      if (segments[1] === 'repos' && segments.length === 2) {
        if (method === 'GET') return this.listUserRepos(request);
        if (method === 'POST') return this.createRepo(request);
        return null;
      }
      return null;
    }

    if (head === 'repos' && segments.length >= 3) return this.repoRoute(request, segments.slice(1));

    return null;
  }

  /** The authenticated user. */
  userJson() {
    const user = this.forge.user();
    return {
      login: user.login,
      id: 1,
      node_id: 'U_1',
      avatar_url: `/${user.login}.png`,
      gravatar_id: null,
      url: `/api/v3/users/${user.login}`,
      html_url: `/${user.login}`,
      type: 'User',
      site_admin: false,
      name: user.login,
      company: null,
      blog: '',
      location: null,
      email: null,
      hireable: null,
      bio: null,
      public_repos: this.forge.repos.size,
      public_gists: 0,
      followers: 0,
      following: 0,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    };
  }

  /** GET /api/v3/user/repos, paged, with a Link header while more follow. */
  listUserRepos(request) {
    const forge = this.forge;
    const query = request.query;
    const perPage = perPageOf(query);
    const page = pageOf(query);
    const all = forge.listRepos(forge.login);
    const start = (page - 1) * perPage;
    const slice = all.slice(start, start + perPage);
    const headers = {};
    const link = linkHeader(request.origin, '/api/v3/user/repos', query, page, perPage, all.length);
    if (link !== '') headers.link = link;
    return { status: 200, headers, body: slice.map((repo) => repoJson(repo, forge)) };
  }

  /** POST /api/v3/user/repos: 201 on create, 422 on a missing or already-used name. */
  createRepo(request) {
    const forge = this.forge;
    const body = request.body ?? {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name === '') {
      return { status: 422, body: { message: 'Repository creation failed.', errors: [{ resource: 'Repository', field: 'name', code: 'missing_field' }] } };
    }
    const existing = forge.getRepo(forge.login, name);
    if (existing !== null) {
      return { status: 422, body: { message: `Repository creation failed. name already exists on this account`, errors: [{ resource: 'Repository', field: 'name', code: 'custom', message: 'name already exists on this account' }] } };
    }
    const repo = forge.createRepo(forge.login, name, { private: body.private === true, description: typeof body.description === 'string' ? body.description : '' });
    return { status: 201, body: repoJson(repo, forge) };
  }

  /** One repository's routes, from GET /repos/{o}/{r} down. `rest` is [owner, name, ...]. */
  repoRoute(request, rest) {
    const forge = this.forge;
    const technique = request.method;
    const owner = rest[0];
    const name = rest[1];
    const repo = forge.getRepo(owner, name);
    if (repo === null) return { status: 404, body: { message: 'Not Found' } };
    if (!forge.isOwner(owner)) return { status: 404, body: { message: 'Not Found' } };
    const tail = rest.slice(2);
    const query = request.query;

    if (tail.length === 0) {
      if (technique === 'GET') return { status: 200, body: repoJson(repo, forge) };
      if (technique === 'PATCH') {
        const body = request.body ?? {};
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.homepage === 'string') repo.homepage = body.homepage;
        if (typeof body.private === 'boolean') repo.private = body.private;
        if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) repo.name = body.name;
        forge.clock += 1;
        repo.updatedSeq = forge.clock;
        return { status: 200, body: repoJson(repo, forge) };
      }
      if (technique === 'DELETE') {
        forge.deleteRepo(repo);
        return { status: 204, body: null };
      }
      return null;
    }

    if (tail[0] === 'branches') return this.branchRoute(request, repo, tail.slice(1));
    if (tail[0] === 'commits') return this.commitRoute(request, repo, tail.slice(1));
    if (tail[0] === 'contents') return this.contentRoute(request, repo, tail.slice(1));
    if (tail[0] === 'labels') return this.labelRoute(request, repo, tail.slice(1));
    if (tail[0] === 'issues') return this.issueRoute(request, repo, tail.slice(1));
    if (tail[0] === 'pulls') return this.pullRoute(request, repo, tail.slice(1));
    if (tail[0] === 'git') return this.gitDataRoute(request, repo, tail.slice(1));
    if (tail[0] === '') return { status: 200, body: repoJson(repo, forge) };
    return null;
  }

  /** GET /branches and GET /branches/{branch}. */
  branchRoute(request, repo, tail) {
    const forge = this.forge;
    if (tail.length === 0) {
      if (request.method !== 'GET') return null;
      const names = forge.refNames(repo).filter((ref) => ref.startsWith('refs/heads/'));
      const body = names.map((ref) => ({
        name: ref.slice('refs/heads/'.length),
        commit: { sha: repo.refs.get(ref), url: `/api/v3/repos/${repo.fullName}/commits/${repo.refs.get(ref)}` },
        protected: false,
      }));
      return { status: 200, body };
    }
    const branch = tail[0];
    if (request.method !== 'GET') return null;
    const tip = forge.branchTip(repo, branch);
    if (tip === null) return { status: 404, body: { message: 'Branch not found' } };
    return {
      status: 200,
      body: { name: branch, commit: { sha: tip, url: `/api/v3/repos/${repo.fullName}/commits/${tip}` }, protected: false },
    };
  }

  /** GET /commits and GET /commits/{sha}, newest first, paged. */
  commitRoute(request, repo, tail) {
    const forge = this.forge;
    if (request.method !== 'GET') return null;
    if (tail.length === 1) {
      if (!isOid(tail[0]) || !repo.objects.has(tail[0])) return { status: 422, body: { message: 'No commit found for SHA' } };
      return { status: 200, body: commitJson(repo, tail[0], null) };
    }
    if (tail.length === 0) {
      const sha = request.query.get('sha');
      const commits = forge.commitsFrom(repo, sha === null || sha === '' ? null : sha);
      const perPage = perPageOf(request.query);
      const page = pageOf(request.query);
      const start = (page - 1) * perPage;
      const body = commits.slice(start, start + perPage).map((oid) => commitJson(repo, oid, null));
      return { status: 200, body };
    }
    return null;
  }

  /** GET/PUT/DELETE /contents/{path}: a file, a directory listing, one contents write, one delete. */
  contentRoute(request, repo, tail) {
    const forge = this.forge;
    const path = tail.join('/');
    const query = request.query;
    const ref = query.get('ref');
    const refName = ref === null || ref === '' ? repo.defaultBranch : ref;
    const refOid = forge.resolveRef(repo, refName);
    const commit = refOid === null ? null : peelToCommit(refOid, forge.lookup(repo));

    if (request.method === 'GET') {
      if (commit === null) return { status: 404, body: { message: 'Not Found' } };
      const found = forge.pathAt(repo, commit, path);
      if (found === null) return { status: 404, body: { message: 'Not Found' } };
      if (found.kind === 'file') {
        const blob = repo.objects.get(found.oid);
        const content = blob ? blob.data : Buffer.alloc(0);
        return {
          status: 200,
          body: {
            type: 'file',
            encoding: 'base64',
            size: content.length,
            name: path.split('/').pop(),
            path,
            content: base64Of(content).replace(/(.{60})/g, '$1\n'),
            sha: found.oid,
            url: `/api/v3/repos/${repo.fullName}/contents/${path}${ref === null ? '' : `?ref=${ref}`}`,
            git_url: `/api/v3/repos/${repo.fullName}/git/blobs/${found.oid}`,
            html_url: `/${repo.fullName}/blob/${repo.defaultBranch}/${path}`,
            download_url: `/${repo.fullName}/raw/${repo.defaultBranch}/${path}`,
            _links: {
              self: `/api/v3/repos/${repo.fullName}/contents/${path}`,
              git: `/api/v3/repos/${repo.fullName}/git/blobs/${found.oid}`,
              html: `/${repo.fullName}/blob/${repo.defaultBranch}/${path}`,
            },
          },
        };
      }
      const body = found.entries.map((entry) => {
        const isDir = entry.mode === '40000';
        const child = isDir ? null : repo.objects.get(entry.oid);
        return {
          type: isDir ? 'dir' : 'file',
          size: isDir ? 0 : (child ? child.data.length : 0),
          name: entry.name,
          path: path === '' ? entry.name : `${path}/${entry.name}`,
          sha: entry.oid,
          url: `/api/v3/repos/${repo.fullName}/contents/${path === '' ? entry.name : `${path}/${entry.name}`}`,
          git_url: isDir
            ? `/api/v3/repos/${repo.fullName}/git/trees/${entry.oid}`
            : `/api/v3/repos/${repo.fullName}/git/blobs/${entry.oid}`,
          html_url: `/${repo.fullName}/tree/${repo.defaultBranch}/${path === '' ? entry.name : `${path}/${entry.name}`}`,
          download_url: null,
        };
      });
      return { status: 200, body };
    }

    if (request.method === 'PUT') {
      const body = request.body ?? {};
      if (typeof body.content !== 'string' || typeof body.message !== 'string') {
        return { status: 422, body: { message: 'Invalid request.', errors: [{ resource: 'Content', code: 'missing_field', field: 'content' }] } };
      }
      const result = forge.commitPath(repo, {
        branch: typeof body.branch === 'string' ? body.branch : undefined,
        path,
        content: decodeBase64(body.content),
        message: body.message,
        sha: typeof body.sha === 'string' ? body.sha : undefined,
      });
      if (result.status === 409) return { status: 409, body: { message: 'sha does not match the current file' } };
      if (result.status === 404) return { status: 404, body: { message: 'Not Found' } };
      const blob = repo.objects.get(result.blobSha);
      const content = blob ? blob.data : Buffer.alloc(0);
      return {
        status: result.status,
        body: {
          content: {
            name: path.split('/').pop(),
            path,
            sha: result.blobSha,
            size: content.length,
            url: `/api/v3/repos/${repo.fullName}/contents/${path}`,
            html_url: `/${repo.fullName}/blob/${result.branch}/${path}`,
            git_url: `/api/v3/repos/${repo.fullName}/git/blobs/${result.blobSha}`,
            download_url: `/${repo.fullName}/raw/${result.branch}/${path}`,
            type: 'file',
            encoding: 'base64',
            content: base64Of(content).replace(/(.{60})/g, '$1\n'),
            _links: {},
          },
          commit: commitJson(repo, result.commitSha, { message: body.message }),
        },
      };
    }

    if (request.method === 'DELETE') {
      const body = request.body ?? {};
      const result = forge.commitPath(repo, {
        branch: typeof body.branch === 'string' ? body.branch : undefined,
        path,
        content: null,
        delete: true,
        message: typeof body.message === 'string' ? body.message : `Delete ${path}`,
        sha: typeof body.sha === 'string' ? body.sha : undefined,
      });
      if (result.status === 409) return { status: 409, body: { message: 'sha does not match the current file' } };
      if (result.status !== 200) return { status: 404, body: { message: 'Not Found' } };
      return { status: 200, body: { content: null, commit: commitJson(repo, result.commitSha, { message: body.message }) } };
    }

    return null;
  }

  /** GET /labels (the list) and POST /labels (the one a later issue names). */
  labelRoute(request, repo, tail) {
    const forge = this.forge;
    if (request.method === 'GET') return { status: 200, body: repo.labels.map((label) => labelJson(repo, label)) };
    if (request.method === 'POST' && tail.length === 0) {
      const body = request.body ?? {};
      if (typeof body.name !== 'string' || body.name.trim() === '') {
        return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'missing_field', field: 'name' }] } };
      }
      const label = forge.createLabel(repo, body.name, body.color);
      return { status: 201, body: labelJson(repo, label) };
    }
    return null;
  }

  /** /issues, /issues/{n} and /issues/{n}/comments. */
  issueRoute(request, repo, tail) {
    const forge = this.forge;
    const query = request.query;
    if (tail.length === 0) {
      if (request.method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let list = repo.issues.filter((issue) => (state === 'all' ? true : issue.state === state));
        if (sort === 'updated') list = list.slice().sort((a, b) => (a.updatedIso < b.updatedIso ? -1 : a.updatedIso > b.updatedIso ? 1 : 0));
        else if (sort === 'comments') list = list.slice().sort((a, b) => a.comments.length - b.comments.length);
        else list = list.slice().sort((a, b) => a.number - b.number);
        if (direction === 'desc') list.reverse();
        const perPage = perPageOf(query);
        const page = pageOf(query);
        const start = (page - 1) * perPage;
        const body = list.slice(start, start + perPage).map((issue) => issueJson(repo, issue));
        const headers = {};
        const link = linkHeader(request.origin, `/api/v3/repos/${repo.fullName}/issues`, query, page, perPage, list.length);
        if (link !== '') headers.link = link;
        return { status: 200, headers, body };
      }
      if (request.method === 'POST') {
        const body = request.body ?? {};
        if (typeof body.title !== 'string' || body.title === '') {
          return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'Issue', code: 'missing_field', field: 'title' }] } };
        }
        const created = forge.createIssue(repo, { title: body.title, body: body.body, labels: body.labels });
        if (created.error !== undefined) return { status: 422, body: { message: created.error, errors: [{ resource: 'Issue', field: 'labels', code: 'invalid' }] } };
        const text = issueJsonText(repo, created.issue);
        return { status: 201, text, bytes: created.issue.jsonCache.bytes, headers: created.issue.jsonCache.headers };
      }
      return null;
    }

    const number = Number(tail[0]);
    const issue = Number.isFinite(number) ? forge.findIssue(repo, number) : null;
    if (tail.length === 1) {
      if (issue === null) return { status: 404, body: { message: 'Not Found' } };
      if (request.method === 'GET') return issueAnswer(repo, issue);
      if (request.method === 'PATCH') {
        const body = request.body ?? {};
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (body.state === 'open' || body.state === 'closed') {
          issue.state = body.state;
          issue.closedIso = body.state === 'closed' ? forge.tick().iso : null;
        }
        if (Array.isArray(body.labels)) {
          const labels = [];
          for (const entry of body.labels) {
            const label = forge.labelRecord(repo, typeof entry === 'string' ? entry : entry?.name);
            if (label) labels.push(label);
          }
          issue.labels = labels;
        }
        issue.updatedIso = forge.tick().iso;
        forge.touchIssue(issue);
        return { status: 200, body: issueJson(repo, issue) };
      }
      return null;
    }

    if (issue === null) return { status: 404, body: { message: 'Not Found' } };
    if (tail[1] === 'comments' && tail.length === 2) {
      if (request.method === 'GET') return { status: 200, body: issue.comments.map((comment) => commentJson(repo, comment)) };
      if (request.method === 'POST') {
        const body = request.body ?? {};
        if (typeof body.body !== 'string' || body.body === '') {
          return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'IssueComment', code: 'missing_field', field: 'body' }] } };
        }
        const comment = forge.createComment(repo, issue, body.body);
        return { status: 201, body: commentJson(repo, comment) };
      }
      return null;
    }
    return null;
  }

  /** /pulls, /pulls/{n}, /pulls/{n}/files and /pulls/{n}/merge. */
  pullRoute(request, repo, tail) {
    const forge = this.forge;
    const query = request.query;
    if (tail.length === 0) {
      if (request.method === 'GET') {
        const state = query.get('state') ?? 'open';
        let list = repo.pulls.filter((pull) => {
          if (state === 'all') return true;
          if (state === 'closed') return pull.state === 'closed';
          return pull.state === 'open';
        });
        list = list.slice().sort((a, b) => a.number - b.number).reverse();
        const perPage = perPageOf(query, 30);
        const page = pageOf(query);
        const start = (page - 1) * perPage;
        return { status: 200, body: list.slice(start, start + perPage).map((pull) => pullJson(repo, forge, pull)) };
      }
      if (request.method === 'POST') {
        const body = request.body ?? {};
        if (typeof body.title !== 'string' || typeof body.head !== 'string' || typeof body.base !== 'string') {
          return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'missing_field', field: 'title' }] } };
        }
        const created = forge.createPull(repo, { title: body.title, body: body.body, head: body.head, base: body.base });
        if (created.error !== undefined) {
          return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'invalid', field: 'head', message: created.error }] } };
        }
        return { status: 201, body: pullJson(repo, forge, created.pull) };
      }
      return null;
    }

    const number = Number(tail[0]);
    const pull = Number.isFinite(number) ? forge.findPull(repo, number) : null;
    if (pull === null) return { status: 404, body: { message: 'Not Found' } };
    if (tail.length === 1) {
      if (request.method === 'GET') return { status: 200, body: pullJson(repo, forge, pull) };
      if (request.method === 'PATCH') {
        const body = request.body ?? {};
        if (typeof body.title === 'string') pull.title = body.title;
        if (typeof body.body === 'string') pull.body = body.body;
        if (body.state === 'open' || body.state === 'closed') pull.state = body.state;
        return { status: 200, body: pullJson(repo, forge, pull) };
      }
      return null;
    }
    if (tail[1] === 'files' && request.method === 'GET') {
      const files = forge.pullFiles(repo, pull);
      return {
        status: 200,
        body: files.map((file) => ({
          sha: file.bOid ?? file.aOid,
          filename: file.path,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          blob_url: `/api/v3/repos/${repo.fullName}/blob/${pull.headSha}/${file.path}`,
          raw_url: `/${repo.fullName}/raw/${pull.headSha}/${file.path}`,
          contents_url: `/api/v3/repos/${repo.fullName}/contents/${file.path}?ref=${pull.headSha}`,
          patch: '',
        })),
      };
    }
    if (tail[1] === 'merge') {
      if (request.method !== 'PUT') return null;
      const body = request.body ?? {};
      const method = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
      const result = forge.mergePull(repo, pull, method);
      if (result.status === 405) return { status: 405, body: { message: 'Pull Request is not mergeable' } };
      if (result.status !== 200) return { status: result.status, body: { message: 'Not Found' } };
      return { status: 200, body: { sha: result.sha, merged: true, message: 'Pull Request successfully merged' } };
    }
    if (tail[1] === 'merge' && request.method === 'GET') {
      return { status: 204, body: null };
    }
    return null;
  }

  /** The Git Data API: refs (how the checks create a branch) plus trees, blobs and commits. */
  gitDataRoute(request, repo, tail) {
    const forge = this.forge;
    if (tail[0] === 'refs') {
      if (tail.length === 1) {
        if (request.method === 'GET') {
          return {
            status: 200,
            body: forge.refNames(repo).map((ref) => ({
              ref,
              node_id: `REF_${ref}`,
              url: `/api/v3/repos/${repo.fullName}/git/refs/${ref.replace(/^refs\//, '')}`,
              object: { sha: repo.refs.get(ref), type: forge.refObjectType(repo, repo.refs.get(ref)), url: '' },
            })),
          };
        }
        if (request.method === 'POST') {
          const body = request.body ?? {};
          const raw = typeof body.ref === 'string' ? body.ref : '';
          const sha = typeof body.sha === 'string' ? body.sha : '';
          if (raw === '' || !isOid(sha) || !repo.objects.has(sha)) {
            return { status: 422, body: { message: 'Reference update failed', errors: [{ resource: 'GitRef', code: 'invalid', field: 'sha' }] } };
          }
          const ref = raw.startsWith('refs/') ? raw : `refs/heads/${raw.replace(/^heads\//, '')}`;
          if (repo.refs.has(ref)) return { status: 422, body: { message: 'Reference already exists' } };
          repo.refs.set(ref, sha);
          return {
            status: 201,
            body: { ref, node_id: `REF_${ref}`, url: `/api/v3/repos/${repo.fullName}/git/refs/${ref.replace(/^refs\//, '')}`, object: { sha, type: forge.refObjectType(repo, sha), url: '' } },
          };
        }
        return null;
      }
      if (tail.length === 3 && tail[1] === 'heads') {
        const ref = `refs/heads/${tail[2]}`;
        const oid = repo.refs.get(ref);
        if (!oid) return { status: 404, body: { message: 'Not Found' } };
        return { status: 200, body: { ref, node_id: `REF_${ref}`, url: `/api/v3/repos/${repo.fullName}/git/${ref}`, object: { sha: oid, type: forge.refObjectType(repo, oid), url: '' } } };
      }
      if (tail.length === 3 && tail[1] === 'tags') {
        const ref = `refs/tags/${tail[2]}`;
        const oid = repo.refs.get(ref);
        if (!oid) return { status: 404, body: { message: 'Not Found' } };
        return { status: 200, body: { ref, node_id: `REF_${ref}`, url: `/api/v3/repos/${repo.fullName}/git/${ref}`, object: { sha: oid, type: forge.refObjectType(repo, oid), url: '' } } };
      }
      return null;
    }
    if (tail[0] === 'trees' && tail.length >= 2) {
      const oid = tail[1];
      const tree = repo.objects.get(oid);
      if (!tree || tree.type !== 'tree') return { status: 422, body: { message: 'Not a tree' } };
      return {
        status: 200,
        body: {
          sha: oid,
          url: `/api/v3/repos/${repo.fullName}/git/trees/${oid}`,
          tree: parseTree(tree.data).map((entry) => ({ path: entry.name, mode: entry.mode, type: entry.mode === '40000' ? 'tree' : 'blob', sha: entry.oid, url: '' })),
          truncated: false,
        },
      };
    }
    if (tail[0] === 'blobs' && tail.length >= 2) {
      const blob = repo.objects.get(tail[1]);
      if (!blob || blob.type !== 'blob') return { status: 422, body: { message: 'Not a blob' } };
      return { status: 200, body: { sha: tail[1], node_id: `B_${tail[1]}`, size: blob.data.length, url: `/api/v3/repos/${repo.fullName}/git/blobs/${tail[1]}`, content: base64Of(blob.data), encoding: 'base64' } };
    }
    if (tail[0] === 'commits' && tail.length >= 2 && isOid(tail[1])) {
      const commit = repo.objects.get(tail[1]);
      if (!commit || commit.type !== 'commit') return { status: 422, body: { message: 'Not a commit' } };
      const parsed = parseCommit(commit.data);
      return { status: 200, body: { sha: tail[1], node_id: `C_${tail[1]}`, url: '', message: parsed.message, tree: { sha: parsed.tree }, parents: parsed.parents.map((sha) => ({ sha })) } };
    }
    return null;
  }
}
