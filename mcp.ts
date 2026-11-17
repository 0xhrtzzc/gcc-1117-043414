// mcp.ts: the Model Context Protocol endpoint at /mcp — JSON-RPC 2.0 over the streamable HTTP
// transport, answered as `application/json`.
//
// The suite probes `server/discover` (the 2026-07-28 revision) and, when a server predates it, falls
// back to the `initialize` handshake; both eras are served here. The tools act on the same store the
// REST surface reads: create_repo, get_repo, create_issue, list_issues, create_pull_request and
// merge_pull_request are the six the agent-native column names, and the rest of the toolset is the
// surrounding convenience (reads, listing, files, branches).

import { repoJson, issueJson, pullJson } from './rest.ts';

/** The identity this server reports in every era. */
const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };

/** The revision this server prefers (the suite's current one). */
const PREFERRED_REVISION = '2026-07-28';

/** Every revision this server answers; the first is the one a fresh client settles on. */
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** The capabilities both eras report. */
const CAPABILITIES = {
  tools: { listChanged: false },
  logging: {},
  prompts: { listChanged: false },
  resources: { listChanged: false },
};

/** JSON-RPC's parse error: a body that is not JSON. */
export const JSON_RPC_PARSE_ERROR = -32700;
/** JSON-RPC's invalid params: a call that cannot be made as it was sent. */
export const JSON_RPC_INVALID_PARAMS = -32602;
/** JSON-RPC's method not found. */
export const JSON_RPC_METHOD_NOT_FOUND = -32601;

/** One tool's input schema. */
function schema(properties, required) {
  return { type: 'object', properties, required, additionalProperties: false };
}

const stringProperty = (description) => ({ type: 'string', description });
const numberProperty = (description) => ({ type: 'number', description });

/**
 * The toolset. It is built once, at module load, and never rebuilt: two `tools/list` answers are the
 * same value, so they serialize byte for byte.
 */
export const TOOLS = [
  {
    name: 'create_repo',
    title: 'Create repository',
    description: 'Create a repository owned by the authenticated login and return its REST object (id, full_name, default_branch).',
    inputSchema: schema(
      {
        name: stringProperty('the repository name'),
        description: stringProperty('a short description'),
        private: { type: 'boolean', description: 'whether the repository is private' },
      },
      ['name'],
    ),
  },
  {
    name: 'get_repo',
    title: 'Get repository',
    description: 'Read one repository by owner and name; answers its REST object with id, full_name and default_branch.',
    inputSchema: schema(
      { owner: stringProperty('the repository owner login'), repo: stringProperty('the repository name') },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'list_repos',
    title: 'List repositories',
    description: 'List every repository the authenticated login owns.',
    inputSchema: schema({}, []),
  },
  {
    name: 'create_issue',
    title: 'Create issue',
    description: 'Open an issue on a repository and return it (number, title, state, id).',
    inputSchema: schema(
      {
        owner: stringProperty('the repository owner login'),
        repo: stringProperty('the repository name'),
        title: stringProperty('the issue title'),
        body: stringProperty('the issue body'),
      },
      ['owner', 'repo', 'title'],
    ),
  },
  {
    name: 'get_issue',
    title: 'Get issue',
    description: 'Read one issue of a repository by its number; answers its REST object.',
    inputSchema: schema(
      {
        owner: stringProperty('the repository owner login'),
        repo: stringProperty('the repository name'),
        issue_number: numberProperty('the issue number'),
      },
      ['owner', 'repo', 'issue_number'],
    ),
  },
  {
    name: 'list_issues',
    title: 'List issues',
    description: "List a repository's issues, optionally filtered by state (open, closed or all).",
    inputSchema: schema(
      {
        owner: stringProperty('the repository owner login'),
        repo: stringProperty('the repository name'),
        state: stringProperty('open, closed or all'),
      },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'list_labels',
    title: 'List labels',
    description: "List a repository's labels.",
    inputSchema: schema(
      { owner: stringProperty('the repository owner login'), repo: stringProperty('the repository name') },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'get_file_contents',
    title: 'Get file contents',
    description: 'Read one file of a repository at a ref; answers the decoded text and the blob sha.',
    inputSchema: schema(
      {
        owner: stringProperty('the repository owner login'),
        repo: stringProperty('the repository name'),
        path: stringProperty('the repository-relative file path'),
        ref: stringProperty('the branch, tag or commit (the default branch when absent)'),
      },
      ['owner', 'repo', 'path'],
    ),
  },
  {
    name: 'create_branch',
    title: 'Create branch',
    description: "Create a branch at an existing commit (a branch name, or the default branch's tip when no ref is given).",
    inputSchema: schema(
      {
        owner: stringProperty('the repository owner login'),
        repo: stringProperty('the repository name'),
        branch: stringProperty('the new branch name'),
        from: stringProperty('the branch or commit the new branch starts at'),
      },
      ['owner', 'repo', 'branch'],
    ),
  },
  {
    name: 'list_branches',
    title: 'List branches',
    description: "List a repository's branches and the commit each one points at.",
    inputSchema: schema(
      { owner: stringProperty('the repository owner login'), repo: stringProperty('the repository name') },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'create_pull_request',
    title: 'Create pull request',
    description: 'Open a pull request from a head branch into a base branch and return it (number, state, head, base).',
    inputSchema: schema(
      {
        owner: stringProperty('the repository owner login'),
        repo: stringProperty('the repository name'),
        title: stringProperty('the pull request title'),
        body: stringProperty('the pull request body'),
        head: stringProperty('the head branch name'),
        base: stringProperty('the base branch name'),
      },
      ['owner', 'repo', 'title', 'head', 'base'],
    ),
  },
  {
    name: 'get_pull_request',
    title: 'Get pull request',
    description: 'Read one pull request of a repository by its number.',
    inputSchema: schema(
      {
        owner: stringProperty('the repository owner login'),
        repo: stringProperty('the repository name'),
        pull_number: numberProperty('the pull request number'),
      },
      ['owner', 'repo', 'pull_number'],
    ),
  },
  {
    name: 'list_pull_requests',
    title: 'List pull requests',
    description: "List a repository's pull requests, optionally filtered by state (open, closed or all).",
    inputSchema: schema(
      {
        owner: stringProperty('the repository owner login'),
        repo: stringProperty('the repository name'),
        state: stringProperty('open, closed or all'),
      },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'merge_pull_request',
    title: 'Merge pull request',
    description: 'Merge a pull request into its base branch and return the merge commit (number, merged, sha, state).',
    inputSchema: schema(
      {
        owner: stringProperty('the repository owner login'),
        repo: stringProperty('the repository name'),
        pull_number: numberProperty('the pull request number'),
        merge_method: stringProperty('merge, squash or rebase'),
      },
      ['owner', 'repo', 'pull_number'],
    ),
  },
];

/** What one tool answers: a text block, its structured content, and the isError flag on refusal. */
function toolResult(payload, isError = false) {
  const result = { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }] };
  if (isError) result.isError = true;
  else if (typeof payload === 'object' && payload !== null) result.structuredContent = payload;
  return result;
}

/** The required arguments a call did not carry. */
function missingArguments(args, required) {
  const missing = [];
  for (const name of required) {
    const value = args[name];
    if (value === undefined || value === null || value === '' || (typeof value === 'number' && !Number.isFinite(value))) missing.push(name);
  }
  return missing;
}

/** The repository a tool was pointed at, or the refusal to answer with. */
function repositoryOrError(forge, args) {
  const repo = forge.getRepo(args.owner, args.repo);
  return repo === null ? { error: `Repository ${args.owner}/${args.repo} was not found` } : { repo };
}

/**
 * Run one tool. Answers `{result}` for a tool that ran (with `isError` inside when it refused), or
 * `{error:{code, message}}` for a tool name this server does not hold.
 */
export function callTool(forge, name, args) {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) return { error: { code: JSON_RPC_METHOD_NOT_FOUND, message: `Unknown tool: ${name}` } };
  const missing = missingArguments(args, tool.inputSchema.required ?? []);
  if (missing.length > 0) return { result: toolResult(`Missing required argument(s): ${missing.join(', ')}`, true) };
  const refuse = (message) => ({ result: toolResult(message, true) });

  switch (name) {
    case 'create_repo': {
      const created = forge.createRepo(forge.login, String(args.name), {
        description: typeof args.description === 'string' ? args.description : '',
        private: args.private === true,
      });
      if (created === null) return refuse(`A repository named ${args.name} already exists`);
      return { result: toolResult(repoJson(created, forge)) };
    }
    case 'list_repos': {
      const repos = forge.listRepos(forge.login);
      return { result: toolResult({ total_count: repos.length, repositories: repos.map((repo) => repoJson(repo, forge)) }) };
    }
    case 'get_repo': {
      const found = repositoryOrError(forge, args);
      if (found.error !== undefined) return refuse(found.error);
      return { result: toolResult(repoJson(found.repo, forge)) };
    }
    case 'create_issue': {
      const found = repositoryOrError(forge, args);
      if (found.error !== undefined) return refuse(found.error);
      const created = forge.createIssue(found.repo, { title: args.title, body: args.body });
      if (created.error !== undefined) return refuse(created.error);
      return { result: toolResult(issueJson(found.repo, created.issue)) };
    }
    case 'get_issue': {
      const found = repositoryOrError(forge, args);
      if (found.error !== undefined) return refuse(found.error);
      const issue = forge.findIssue(found.repo, Number(args.issue_number));
      if (issue === null) return refuse(`Issue #${args.issue_number} was not found`);
      return { result: toolResult(issueJson(found.repo, issue)) };
    }
    case 'list_issues': {
      const found = repositoryOrError(forge, args);
      if (found.error !== undefined) return refuse(found.error);
      const state = typeof args.state === 'string' && args.state !== '' ? args.state : 'all';
      const list = found.repo.issues.filter((issue) => state === 'all' || issue.state === state);
      return { result: toolResult({ total_count: list.length, issues: list.map((issue) => issueJson(found.repo, issue)) }) };
    }
    case 'list_labels': {
      const found = repositoryOrError(forge, args);
      if (found.error !== undefined) return refuse(found.error);
      return { result: toolResult({ total_count: found.repo.labels.length, labels: found.repo.labels }) };
    }
    case 'get_file_contents': {
      const found = repositoryOrError(forge, args);
      if (found.error !== undefined) return refuse(found.error);
      const repo = found.repo;
      const commit = forge.resolveRef(repo, typeof args.ref === 'string' && args.ref !== '' ? args.ref : repo.defaultBranch);
      const path = String(args.path);
      const entry = commit === null ? null : forge.pathAt(repo, commit, path);
      if (entry === null || entry.kind !== 'file') return refuse(`No file at ${path}`);
      const blob = repo.objects.get(entry.oid);
      const text = blob ? blob.data.toString('utf8') : '';
      return { result: toolResult({ name: path.split('/').pop(), path, sha: entry.oid, size: text.length, content: text, encoding: 'utf-8' }) };
    }
    case 'create_branch': {
      const found = repositoryOrError(forge, args);
      if (found.error !== undefined) return refuse(found.error);
      const repo = found.repo;
      const from = typeof args.from === 'string' && args.from !== '' ? args.from : repo.defaultBranch;
      const oid = forge.resolveRef(repo, from);
      if (oid === null) return refuse(`No commit at ${from}`);
      const ref = `refs/heads/${String(args.branch)}`;
      repo.refs.set(ref, oid);
      return { result: toolResult({ ref, object: { sha: oid, type: forge.refObjectType(repo, oid) } }) };
    }
    case 'list_branches': {
      const found = repositoryOrError(forge, args);
      if (found.error !== undefined) return refuse(found.error);
      const branches = [];
      for (const ref of forge.refNames(found.repo)) {
        if (!ref.startsWith('refs/heads/')) continue;
        const oid = found.repo.refs.get(ref);
        branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid, url: `/api/v3/repos/${found.repo.fullName}/commits/${oid}` } });
      }
      return { result: toolResult({ total_count: branches.length, branches }) };
    }
    case 'create_pull_request': {
      const found = repositoryOrError(forge, args);
      if (found.error !== undefined) return refuse(found.error);
      const repo = found.repo;
      const existing = repo.pulls.find((pull) => pull.head === args.head && pull.base === args.base && pull.state === 'open');
      if (existing !== undefined) return { result: toolResult(pullJson(repo, forge, existing)) };
      const created = forge.createPull(repo, { title: args.title, body: args.body, head: args.head, base: args.base });
      if (created.error !== undefined) return refuse(created.error);
      return { result: toolResult(pullJson(repo, forge, created.pull)) };
    }
    case 'get_pull_request': {
      const found = repositoryOrError(forge, args);
      if (found.error !== undefined) return refuse(found.error);
      const pull = forge.findPull(found.repo, Number(args.pull_number));
      if (pull === null) return refuse(`Pull request #${args.pull_number} was not found`);
      return { result: toolResult(pullJson(found.repo, forge, pull)) };
    }
    case 'list_pull_requests': {
      const found = repositoryOrError(forge, args);
      if (found.error !== undefined) return refuse(found.error);
      const state = typeof args.state === 'string' && args.state !== '' ? args.state : 'all';
      const list = found.repo.pulls.filter((pull) => state === 'all' || pull.state === state);
      return { result: toolResult({ total_count: list.length, pull_requests: list.map((pull) => pullJson(found.repo, forge, pull)) }) };
    }
    case 'merge_pull_request': {
      const found = repositoryOrError(forge, args);
      if (found.error !== undefined) return refuse(found.error);
      const repo = found.repo;
      const pull = forge.findPull(repo, Number(args.pull_number));
      if (pull === null) return refuse(`Pull request #${args.pull_number} was not found`);
      const method = typeof args.merge_method === 'string' && args.merge_method !== '' ? args.merge_method : 'merge';
      const merged = forge.mergePull(repo, pull, method);
      if (merged.status !== 200) return refuse(`Pull request is not mergeable`);
      return { result: toolResult({ number: pull.number, merged: true, sha: merged.sha, state: pull.state, message: 'Pull Request successfully merged' }) };
    }
    default:
      return { error: { code: JSON_RPC_METHOD_NOT_FOUND, message: `Unknown tool: ${name}` } };
  }
}

/**
 * Answer one JSON-RPC request. `parsed` is the request's body already parsed (main.ts answers a body
 * that is not JSON itself). The answer is {status, body}; body is null for a notification, and main.ts
 * answers that with an empty 202.
 */
export function handleMcpRequest(forge, text, parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 200, body: { jsonrpc: '2.0', id: null, error: { code: JSON_RPC_INVALID_PARAMS, message: 'Invalid Request' } } };
  }
  const id = parsed.id === undefined ? null : parsed.id;
  const method = typeof parsed.method === 'string' ? parsed.method : '';
  const params = parsed.params !== null && typeof parsed.params === 'object' && !Array.isArray(parsed.params) ? parsed.params : {};

  const ok = (result) => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
  const fail = (code, message) => ({ status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } });

  if (method === 'server/discover') {
    return ok({
      resultType: 'complete',
      supportedVersions: SUPPORTED_VERSIONS.slice(),
      capabilities: { ...CAPABILITIES },
      instructions: 'A GitHub-compatible forge: repositories, issues, pull requests and file contents over MCP.',
      serverInfo: { ...SERVER_INFO },
      _meta: {
        'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO },
        'io.modelcontextprotocol/protocolVersion': PREFERRED_REVISION,
      },
    });
  }
  if (method === 'initialize') {
    const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : PREFERRED_REVISION;
    const revision = SUPPORTED_VERSIONS.includes(asked) ? asked : PREFERRED_REVISION;
    return ok({
      protocolVersion: revision,
      capabilities: { ...CAPABILITIES },
      serverInfo: { ...SERVER_INFO },
      instructions: 'A GitHub-compatible forge served by makefun-forge.',
    });
  }
  if (method === 'notifications/initialized' || method === 'initialized' || method === 'notifications/cancelled') {
    return { status: 202, body: null };
  }
  if (method === 'ping') return ok({});
  if (method === 'tools/list') return ok({ tools: TOOLS });
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    if (name === '') return fail(JSON_RPC_INVALID_PARAMS, 'tools/call needs a tool name');
    const args = params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {};
    const outcome = callTool(forge, name, args);
    if (outcome.error !== undefined) return fail(outcome.error.code, outcome.error.message);
    return ok(outcome.result);
  }
  if (method === 'resources/list') return ok({ resources: [] });
  if (method === 'prompts/list') return ok({ prompts: [] });
  if (method === 'logging/setLevel') return ok({});
  if (method === 'completion/complete') return ok({ completion: { values: [], total: 0, hasMore: false } });
  return fail(JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
}

/** The parse-error answer (a body that is not JSON), spelled the way the transport asks for it. */
export function parseErrorBody() {
  return { jsonrpc: '2.0', id: null, error: { code: JSON_RPC_PARSE_ERROR, message: 'Parse error' } };
}
