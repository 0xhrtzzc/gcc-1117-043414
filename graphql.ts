// graphql.ts: GitHub's GraphQL v4 surface at /api/graphql.
//
// Nothing here is a schema library. The file holds a tokenizer, a recursive-descent parser for the
// documents gh and github-mcp-server actually send (named operations with variables and defaults,
// aliases, arguments carrying inline enums, lists and input objects, inline fragments `... on Type`
// and the anonymous `{ ... }` shorthand), and an executor that resolves those selections against the
// same store the REST surface serves. An unknown field is a GraphQL error inside a 200 body, an
// unknown repository is data.repository = null with no errors, and main.ts answers a batch one
// operation at a time, in the order the operations arrived.

/** The path this surface answers on (main.ts routes /api/graphql here). */
export const GRAPHQL_PATH = '/api/graphql';

/** Every object type's fields, as `__type(name:)` reports them. */
const OBJECT_TYPES = {
  Query: ['viewer', 'user', 'repository', 'node', 'search', '__type', '__typename'],
  Mutation: [
    'createIssue', 'closeIssue', 'reopenIssue', 'createPullRequest', 'mergePullRequest', 'addComment',
    'createRepository', 'createRef', 'updateRef', 'deleteRef', 'addLabelsToLabelable', '__typename',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
    'visibility', 'createdAt', 'updatedAt', 'url', 'isEmpty', 'isFork', 'isArchived', 'stargazerCount',
    'forkCount', 'watchers', 'object', 'ref', 'refs', 'label', 'labels', 'repositoryTopics', '__typename',
  ],
  User: ['id', 'login', 'name', 'email', 'url', 'avatarUrl', 'isViewer', 'createdAt', '__typename'],
  Issue: [
    'id', 'number', 'title', 'state', 'stateReason', 'body', 'bodyText', 'bodyHTML', 'createdAt',
    'updatedAt', 'closedAt', 'author', 'editor', 'comments', 'labels', 'repository', 'url', 'isPinned',
    'locked', 'includesCreatedEdit', 'isReadByViewer', '__typename',
  ],
  PullRequest: [
    'id', 'number', 'state', 'merged', 'mergedAt', 'headRefName', 'baseRefName', 'headRefOid',
    'baseRefOid', 'mergeable', 'files', 'title', 'body', 'createdAt', 'updatedAt', 'closedAt',
    'author', 'isDraft', 'changedFiles', 'additions', 'deletions', 'url', 'repository', 'commits',
    'reviewDecision', 'mergeStateStatus', '__typename',
  ],
  Ref: ['id', 'name', 'prefix', 'target', 'repository', '__typename'],
  Label: ['id', 'name', 'color', 'description', '__typename'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  PullRequestCommitConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor', '__typename'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType', 'viewerViewedState', '__typename'],
  IssueComment: ['id', 'body', 'createdAt', 'updatedAt', 'author', 'url', '__typename'],
  CreateIssuePayload: ['issue', 'clientMutationId', '__typename'],
  CloseIssuePayload: ['issue', 'clientMutationId', '__typename'],
  ReopenIssuePayload: ['issue', 'clientMutationId', '__typename'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId', '__typename'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId', '__typename'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId', '__typename'],
  CreateRepositoryPayload: ['repository', 'clientMutationId', '__typename'],
  CreateRefPayload: ['ref', 'clientMutationId', '__typename'],
  UpdateRefPayload: ['ref', 'clientMutationId', '__typename'],
  DeleteRefPayload: ['clientMutationId', '__typename'],
  AddLabelsToLabelablePayload: ['labelable', 'clientMutationId', '__typename'],
  IssueCommentEdge: ['cursor', 'node', '__typename'],
  Commit: ['oid', 'message', 'messageHeadline', 'url', 'committedDate', '__typename'],
  CommitConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  Actor: ['login', 'id', '__typename'],
  __Type: ['kind', 'name', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes', '__typename'],
  __Field: ['name', 'description', 'isDeprecated', 'deprecationReason', 'type', 'args', '__typename'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason', '__typename'],
  __InputValue: ['name', 'description', 'type', 'defaultValue', '__typename'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives', '__typename'],
};

/** Every enum type's values, as `__type(name:)` reports them. */
const ENUM_TYPES = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  IssueStateReason: ['COMPLETED', 'NOT_PLANNED', 'REOPENED'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  PullRequestReviewDecision: ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  RepositoryVisibility: ['PUBLIC', 'PRIVATE', 'INTERNAL'],
  PullRequestChangedFileChangeType: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED'],
};

/** The page info a connection that does no paging of its own reports. */
const EMPTY_PAGE_INFO = { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };

/** The punctuation that stands alone as its own token. */
const PUNCTUATION = '{}()[]:!$=@|';

/** The keywords that open an operation, so the parser knows what it is reading. */
const OPERATION_KEYWORDS = new Set(['query', 'mutation', 'subscription']);

// ---------------------------------------------------------------- tokenizer

/**
 * Split a document into tokens. Every token remembers the line and column it starts at, so an error
 * can point at it; commas are insignificant, as the grammar says, and a `#` comment runs to the end of
 * its line.
 */
function tokenize(source) {
  const tokens = [];
  let index = 0;
  let line = 1;
  let column = 1;
  const push = (kind, value) => {
    tokens.push({ kind, value, line, column });
  };
  while (index < source.length) {
    const char = source[index];
    if (char === '\n') {
      index += 1;
      line += 1;
      column = 1;
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\r' || char === ',') {
      index += 1;
      column += 1;
      continue;
    }
    if (char === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (PUNCTUATION.includes(char)) {
      push(char, char);
      index += 1;
      column += 1;
      continue;
    }
    if (char === '.') {
      if (source.startsWith('...', index)) {
        push('...', '...');
        index += 3;
        column += 3;
        continue;
      }
      throw new Error(`unexpected '.' at line ${line}`);
    }
    if (char === '"') {
      if (source.startsWith('"""', index)) {
        const end = source.indexOf('"""', index + 3);
        if (end < 0) throw new Error('unterminated block string');
        push('string', source.slice(index + 3, end));
        index = end + 3;
        continue;
      }
      let end = index + 1;
      while (end < source.length && source[end] !== '"') end += source[end] === '\\' ? 2 : 1;
      if (end >= source.length) throw new Error(`unterminated string at line ${line}`);
      push('string', JSON.parse(source.slice(index, end + 1)));
      index = end + 1;
      continue;
    }
    if (/[0-9]/.test(char) || (char === '-' && /[0-9]/.test(source[index + 1] ?? ''))) {
      let end = index + 1;
      while (end < source.length && /[0-9.eE+-]/.test(source[end])) end += 1;
      push('number', Number(source.slice(index, end)));
      index = end;
      continue;
    }
    if (/[_A-Za-z]/.test(char)) {
      let end = index + 1;
      while (end < source.length && /[_0-9A-Za-z]/.test(source[end])) end += 1;
      push('name', source.slice(index, end));
      index = end;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(char)} at line ${line}`);
  }
  return tokens;
}

// ---------------------------------------------------------------- parser

/**
 * Parse a whole document: its operations (each with its variable definitions and defaults) and its
 * named fragments. A selection is one of `field`, `inline` (`... on Type`) or `spread` (a named
 * fragment).
 */
function parseDocument(tokens) {
  let position = 0;
  const peek = () => tokens[position] ?? null;
  const next = () => tokens[position++] ?? null;
  const expect = (kind, value) => {
    const token = next();
    if (token === null || token.kind !== kind || (value !== undefined && token.value !== value)) {
      throw new Error(`expected ${value ?? kind}, got ${token === null ? 'end of document' : JSON.stringify(token.value)}`);
    }
    return token;
  };

  /** One argument value: a variable, a literal, or an inline list or input object of them. */
  const parseValue = () => {
    const token = peek();
    if (token === null) throw new Error('expected a value');
    if (token.kind === '$') {
      next();
      return { kind: 'var', name: expect('name').value };
    }
    if (token.kind === 'number') {
      next();
      return { kind: 'number', value: token.value };
    }
    if (token.kind === 'string') {
      next();
      return { kind: 'string', value: token.value };
    }
    if (token.kind === 'name') {
      next();
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === '[') {
      next();
      const items = [];
      while (peek() !== null && peek().kind !== ']') items.push(parseValue());
      expect(']');
      return { kind: 'list', items };
    }
    if (token.kind === '{') {
      next();
      const fields = [];
      while (peek() !== null && peek().kind !== '}') {
        const name = expect('name');
        expect(':');
        fields.push({ name: name.value, value: parseValue() });
      }
      expect('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token.value)}`);
  };

  const parseArguments = () => {
    const args = [];
    if (peek() === null || peek().kind !== '(') return args;
    next();
    while (peek() !== null && peek().kind !== ')') {
      const name = expect('name');
      expect(':');
      args.push({ name: name.value, value: parseValue() });
    }
    expect(')');
    return args;
  };

  /** Directives are parsed and dropped: none the suite sends changes a selection's shape. */
  const skipDirectives = () => {
    while (peek() !== null && peek().kind === '@') {
      next();
      expect('name');
      parseArguments();
    }
  };

  const parseSelectionSet = () => {
    expect('{');
    const selections = [];
    while (peek() !== null && peek().kind !== '}') {
      const token = peek();
      if (token.kind === '...') {
        next();
        if (peek() !== null && peek().kind === 'name' && peek().value === 'on') {
          next();
          const typeCondition = expect('name').value;
          skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selections: parseSelectionSet() });
          continue;
        }
        const name = expect('name');
        skipDirectives();
        selections.push({ kind: 'spread', name: name.value });
        continue;
      }
      const first = expect('name');
      let alias = null;
      let name = first.value;
      if (peek() !== null && peek().kind === ':') {
        next();
        alias = first.value;
        name = expect('name').value;
      }
      const args = parseArguments();
      skipDirectives();
      const children = peek() !== null && peek().kind === '{' ? parseSelectionSet() : [];
      selections.push({ kind: 'field', alias, name, args, selections: children });
    }
    expect('}');
    return selections;
  };

  /** A variable definition's type reference, which the executor needs only to skip. */
  const skipType = () => {
    if (peek() !== null && peek().kind === '[') {
      next();
      skipType();
      expect(']');
    } else {
      expect('name');
    }
    if (peek() !== null && peek().kind === '!') next();
  };

  const operations = [];
  const fragments = new Map();
  while (peek() !== null) {
    const token = peek();
    if (token.kind === 'name' && OPERATION_KEYWORDS.has(token.value)) {
      next();
      let name = null;
      if (peek() !== null && peek().kind === 'name') name = next().value;
      const defaults = new Map();
      if (peek() !== null && peek().kind === '(') {
        next();
        while (peek() !== null && peek().kind !== ')') {
          expect('$');
          const variable = expect('name').value;
          expect(':');
          skipType();
          if (peek() !== null && peek().kind === '=') {
            next();
            defaults.set(variable, parseValue());
          }
        }
        expect(')');
      }
      skipDirectives();
      operations.push({ type: token.value, name, defaults, selections: parseSelectionSet() });
      continue;
    }
    if (token.kind === 'name' && token.value === 'fragment') {
      next();
      const name = expect('name').value;
      expect('name', 'on');
      expect('name');
      skipDirectives();
      fragments.set(name, parseSelectionSet());
      continue;
    }
    if (token.kind === '{') {
      operations.push({ type: 'query', name: null, defaults: new Map(), selections: parseSelectionSet() });
      continue;
    }
    throw new Error(`unexpected token ${JSON.stringify(token.value)}`);
  }
  return { operations, fragments };
}

// ---------------------------------------------------------------- global ids

/**
 * A global (Relay) id: the base64 of one small tagged text naming the type and the object behind it —
 * a repository's numeric id, or a repository's id and an issue's or pull request's number. It is
 * therefore never the plain number, it is equal on every read of the same object, and it round-trips
 * through `node(id:)` and back into the mutation inputs.
 */
function globalId(kind, id) {
  return Buffer.from(`04:${kind}:${id}`, 'utf8').toString('base64');
}

/** The type and the object a global id names, or null when the value is not one this forge made. */
function parseGlobalId(value) {
  if (typeof value !== 'string' || value === '') return null;
  const parts = Buffer.from(value, 'base64').toString('utf8').split(':');
  if (parts.length < 3 || parts[0] !== '04') return null;
  return { kind: parts[1], id: parts.slice(2).join(':') };
}

/** A page's cursor: the base64 of `cursor:<number>`, over the last number the page held. */
function cursorFor(number) {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

/** The number a cursor names, or null when the value is not one of ours. */
function numberFromCursor(value) {
  if (typeof value !== 'string' || value === '') return null;
  const text = Buffer.from(value, 'base64').toString('utf8');
  if (!text.startsWith('cursor:')) return null;
  const number = Number(text.slice(7));
  return Number.isInteger(number) ? number : null;
}

// ---------------------------------------------------------------- the executor

/**
 * Executes one parsed operation against the store. A node in flight is `{t, v}`: the name of its type
 * and the store record behind it, null for an unset one. Selections resolve against the node's own
 * type, and every failure — an unknown field, an input naming no object — is collected in `errors`
 * while the rest of the selection set still resolves.
 */
export class GraphqlExecutor {
  constructor(forge, variables) {
    this.forge = forge;
    this.variables = variables ?? {};
    this.errors = [];
  }

  /** One parsed value: a variable's value, a literal, or a list or object built from them. */
  resolveValue(node) {
    if (node === null || node === undefined) return null;
    if (node.kind === 'var') {
      return Object.prototype.hasOwnProperty.call(this.variables, node.name) ? this.variables[node.name] : null;
    }
    if (node.kind === 'list') return node.items.map((item) => this.resolveValue(item));
    if (node.kind === 'object') {
      const out = {};
      for (const field of node.fields) out[field.name] = this.resolveValue(field.value);
      return out;
    }
    return node.value;
  }

  argsOf(selection) {
    const out = {};
    for (const argument of selection.args) out[argument.name] = this.resolveValue(argument.value);
    return out;
  }

  /** Run one operation: its data, plus the errors collected while resolving it. */
  run(operation) {
    const type = operation.type === 'mutation' ? 'Mutation' : 'Query';
    return { data: this.select({ t: type, v: null }, operation.selections, []), errors: this.errors };
  }

  /** Resolve a selection set against one node: scalars as they are, lists entry by entry. */
  select(node, selections, path) {
    if (node === null) return null;
    const out = {};
    for (const selection of selections) {
      if (selection.kind === 'spread') continue;
      if (selection.kind === 'inline') {
        if (selection.typeCondition === undefined || selection.typeCondition === node.t || (node.t === 'User' && selection.typeCondition === 'Actor')) {
          Object.assign(out, this.select(node, selection.selections, path));
        }
        continue;
      }
      const key = selection.alias ?? selection.name;
      if (selection.name === '__typename') {
        out[key] = node.t;
        continue;
      }
      const fields = OBJECT_TYPES[node.t];
      if (!fields || !fields.includes(selection.name)) {
        this.errors.push({
          message: `Cannot query field "${selection.name}" on type "${node.t}".`,
          locations: [{ line: 1, column: 1 }],
          path: [...path, key],
        });
        out[key] = null;
        continue;
      }
      const resolved = this.resolveField(node, selection.name, this.argsOf(selection));
      if (resolved === null || resolved === undefined) {
        out[key] = null;
        continue;
      }
      if (Array.isArray(resolved)) {
        out[key] = resolved.map((entry) => (isNode(entry) ? this.selectionOf(entry, selection, key, path) : entry));
        continue;
      }
      out[key] = isNode(resolved) ? this.selectionOf(resolved, selection, key, path) : resolved;
    }
    return out;
  }

  /** One node in flight behind one selected field: null when it holds nothing, else its selections. */
  selectionOf(node, selection, key, path) {
    if (node.v === null || node.v === undefined) return null;
    return this.select(node, selection.selections, [...path, key]);
  }

  /** Resolve one field of one node: a scalar, a node in flight, a list of them, or null. */
  resolveField(node, name, args) {
    const forge = this.forge;
    const value = node.v;
    switch (node.t) {
      case 'Query': {
        if (name === 'viewer' || name === 'user') return { t: 'User', v: forge.user() };
        if (name === 'repository') {
          const repo = forge.getRepo(args.owner, args.name);
          return repo !== null && forge.isOwner(args.owner) ? { t: 'Repository', v: repo } : null;
        }
        if (name === 'node') {
          const parsed = parseGlobalId(args.id);
          return parsed === null ? null : this.nodeOf(parsed.kind, parsed.id);
        }
        if (name === '__type') return this.typeOf(args.name);
        return null;
      }
      case 'Mutation':
        return this.mutation(name, args);
      case 'Repository':
        return this.repositoryField(value, name, args);
      case 'Issue':
        return this.issueField(value, name);
      case 'PullRequest':
        return this.pullField(value, name, args);
      case 'Ref': {
        if (name === 'name') return value.name;
        if (name === 'prefix') return value.prefix ?? '';
        if (name === 'id') return globalId('Ref', value.target);
        if (name === 'target') return value.target === null || value.target === undefined ? null : { t: 'Commit', v: { oid: value.target } };
        if (name === 'repository') return value.repo ? { t: 'Repository', v: value.repo } : null;
        return null;
      }
      case 'User': {
        if (name === 'login' || name === 'name') return value.login;
        if (name === 'id') return globalId('User', 1);
        if (name === 'email') return '';
        if (name === 'url' || name === 'avatarUrl') return `/${value.login}`;
        if (name === 'isViewer') return true;
        return null;
      }
      case 'Label': {
        if (name === 'name') return value.name;
        if (name === 'color') return value.color;
        if (name === 'id') return globalId('Label', value.id);
        if (name === 'description') return null;
        return null;
      }
      case 'IssueComment': {
        if (name === 'id') return globalId('IssueComment', value.id);
        if (name === 'body') return value.body;
        if (name === 'createdAt' || name === 'updatedAt') return value.createdIso;
        if (name === 'author') return { t: 'User', v: forge.user() };
        if (name === 'url') return '';
        return null;
      }
      case 'IssueCommentEdge': {
        if (name === 'node') return { t: 'IssueComment', v: value };
        if (name === 'cursor') return '';
        return null;
      }
      case 'IssueConnection': {
        if (name === 'nodes') return value.nodes.map((issue) => ({ t: 'Issue', v: issue }));
        if (name === 'totalCount') return value.totalCount;
        if (name === 'pageInfo') return { t: 'PageInfo', v: value.pageInfo };
        if (name === 'edges') return value.nodes.map((entry, index) => ({ cursor: `c${index}`, node: { t: 'Issue', v: entry } }));
        return null;
      }
      case 'PullRequestConnection': {
        if (name === 'nodes') return value.nodes.map((pull) => ({ t: 'PullRequest', v: pull }));
        if (name === 'totalCount') return value.totalCount;
        if (name === 'pageInfo') return { t: 'PageInfo', v: value.pageInfo };
        return null;
      }
      case 'PullRequestChangedFileConnection': {
        if (name === 'nodes') return value.nodes.map((file) => ({ t: 'PullRequestChangedFile', v: file }));
        if (name === 'totalCount') return value.totalCount;
        if (name === 'pageInfo') return { t: 'PageInfo', v: EMPTY_PAGE_INFO };
        return null;
      }
      case 'LabelConnection': {
        if (name === 'nodes') return value.nodes.map((label) => ({ t: 'Label', v: label }));
        if (name === 'totalCount') return value.totalCount;
        if (name === 'pageInfo') return { t: 'PageInfo', v: EMPTY_PAGE_INFO };
        return null;
      }
      case 'IssueCommentConnection': {
        if (name === 'nodes') return value.nodes.map((comment) => ({ t: 'IssueComment', v: comment }));
        if (name === 'totalCount') return value.totalCount;
        if (name === 'pageInfo') return { t: 'PageInfo', v: EMPTY_PAGE_INFO };
        return null;
      }
      case 'PullRequestChangedFile': {
        if (name === 'path') return value.path;
        if (name === 'additions') return value.additions;
        if (name === 'deletions') return value.deletions;
        if (name === 'changeType') return value.status === 'added' ? 'ADDED' : value.status === 'removed' ? 'DELETED' : 'MODIFIED';
        return null;
      }
      case 'PageInfo': {
        if (name === 'hasNextPage') return value.hasNextPage === true;
        if (name === 'hasPreviousPage') return value.hasPreviousPage === true;
        if (name === 'startCursor') return value.startCursor ?? null;
        if (name === 'endCursor') return value.endCursor ?? null;
        return null;
      }
      case 'CreateIssuePayload':
      case 'CloseIssuePayload':
      case 'ReopenIssuePayload': {
        if (name === 'issue') return value.issue === null || value.issue === undefined ? null : { t: 'Issue', v: value.issue };
        return null;
      }
      case 'CreatePullRequestPayload':
      case 'MergePullRequestPayload': {
        if (name === 'pullRequest') return value.pullRequest === null || value.pullRequest === undefined ? null : { t: 'PullRequest', v: value.pullRequest };
        return null;
      }
      case 'CreateRepositoryPayload': {
        if (name === 'repository') return value.repository === null || value.repository === undefined ? null : { t: 'Repository', v: value.repository };
        return null;
      }
      case 'AddCommentPayload': {
        if (name === 'commentEdge') return { t: 'IssueCommentEdge', v: value };
        return null;
      }
      case '__Type': {
        if (name === 'name') return value.name;
        if (name === 'kind') return value.kind;
        if (name === 'description') return null;
        if (name === 'fields') return (value.fields ?? []).map((entry) => ({ t: '__Field', v: entry }));
        if (name === 'enumValues') return (value.enumValues ?? []).map((entry) => ({ t: '__EnumValue', v: entry }));
        if (name === 'inputFields' || name === 'interfaces' || name === 'possibleTypes') return [];
        return null;
      }
      case '__Field': {
        if (name === 'name') return value.name;
        if (name === 'isDeprecated') return false;
        if (name === 'args') return [];
        if (name === 'description' || name === 'deprecationReason' || name === 'type') return null;
        return null;
      }
      case '__EnumValue': {
        if (name === 'name') return value.name;
        if (name === 'isDeprecated') return false;
        if (name === 'description' || name === 'deprecationReason') return null;
        return null;
      }
      default:
        return null;
    }
  }

  /** The node behind a global id, or null when nothing carries it. */
  nodeOf(kind, id) {
    const forge = this.forge;
    const parts = String(id).split(':');
    if (kind === 'Repository') {
      for (const repo of forge.repos.values()) if (String(repo.id) === String(parts[0])) return { t: 'Repository', v: repo };
      return null;
    }
    if (kind !== 'Issue' && kind !== 'PullRequest') return null;
    for (const repo of forge.repos.values()) {
      if (String(repo.id) !== String(parts[0])) continue;
      const number = Number(parts[1]);
      if (kind === 'Issue') {
        const issue = forge.findIssue(repo, number);
        return issue === null ? null : { t: 'Issue', v: issue };
      }
      const pull = forge.findPull(repo, number);
      return pull === null ? null : { t: 'PullRequest', v: pull };
    }
    return null;
  }

  /** The repository a global id names: the mutation inputs take repositories by id. */
  repoOfGlobalId(id) {
    const parsed = parseGlobalId(id);
    if (parsed === null) return null;
    for (const repo of this.forge.repos.values()) if (String(repo.id) === String(parsed.id)) return repo;
    return null;
  }

  /** Introspection for `__type(name:)`: an object type's fields, or an enum type's values. */
  typeOf(name) {
    if (typeof name !== 'string') return null;
    if (Object.prototype.hasOwnProperty.call(OBJECT_TYPES, name)) {
      return { t: '__Type', v: { name, kind: 'OBJECT', fields: OBJECT_TYPES[name].map((field) => ({ name: field })), enumValues: [] } };
    }
    if (Object.prototype.hasOwnProperty.call(ENUM_TYPES, name)) {
      return { t: '__Type', v: { name, kind: 'ENUM', fields: [], enumValues: ENUM_TYPES[name].map((entry) => ({ name: entry })) } };
    }
    return null;
  }

  /** Resolve one mutation: the payload node its selection set names, or null for an unknown one. */
  mutation(name, args) {
    const forge = this.forge;
    const input = args.input ?? {};
    if (name === 'createIssue') {
      const repo = this.repoOfGlobalId(input.repositoryId);
      if (repo === null) return { t: 'CreateIssuePayload', v: { issue: null } };
      const created = forge.createIssue(repo, { title: input.title, body: input.body, labels: input.labels });
      if (created.error !== undefined) {
        this.errors.push({ message: created.error, path: ['createIssue'] });
        return { t: 'CreateIssuePayload', v: { issue: null } };
      }
      return { t: 'CreateIssuePayload', v: { issue: created.issue } };
    }
    if (name === 'closeIssue' || name === 'reopenIssue') {
      const parsed = parseGlobalId(input.issueId);
      const node = parsed === null ? null : this.nodeOf('Issue', parsed.id);
      const issue = node === null ? null : node.v;
      const payloadType = name === 'closeIssue' ? 'CloseIssuePayload' : 'ReopenIssuePayload';
      if (issue === null) {
        this.errors.push({ message: 'Could not resolve to a node with the global id', path: [name] });
        return { t: payloadType, v: { issue: null } };
      }
      issue.state = name === 'closeIssue' ? 'closed' : 'open';
      issue.closedIso = name === 'closeIssue' ? forge.tick().iso : null;
      issue.updatedIso = forge.tick().iso;
      forge.touchIssue(issue);
      return { t: payloadType, v: { issue } };
    }
    if (name === 'createPullRequest') {
      const repo = this.repoOfGlobalId(input.repositoryId);
      if (repo === null) return { t: 'CreatePullRequestPayload', v: { pullRequest: null } };
      const created = forge.createPull(repo, {
        title: input.title,
        body: input.body,
        head: input.headRefName,
        base: input.baseRefName,
      });
      if (created.error !== undefined) {
        this.errors.push({ message: created.error, path: ['createPullRequest'] });
        return { t: 'CreatePullRequestPayload', v: { pullRequest: null } };
      }
      return { t: 'CreatePullRequestPayload', v: { pullRequest: created.pull } };
    }
    if (name === 'mergePullRequest') {
      const parsed = parseGlobalId(input.pullRequestId);
      const node = parsed === null ? null : this.nodeOf('PullRequest', parsed.id);
      const pull = node === null ? null : node.v;
      const repo = pull === null ? null : pull.repo ?? null;
      if (pull === null || repo === null) {
        this.errors.push({ message: 'Could not resolve to a PullRequest with the global id', path: ['mergePullRequest'] });
        return { t: 'MergePullRequestPayload', v: { pullRequest: null } };
      }
      const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'merge';
      if (forge.mergePull(repo, pull, method).status !== 200) {
        this.errors.push({ message: 'Pull request is not mergeable', path: ['mergePullRequest'] });
      }
      return { t: 'MergePullRequestPayload', v: { pullRequest: pull } };
    }
    if (name === 'addComment') {
      const parsed = parseGlobalId(input.subjectId);
      const node = parsed === null ? null : this.nodeOf('Issue', parsed.id);
      const issue = node === null ? null : node.v;
      const repo = issue === null ? null : issue.repo ?? null;
      if (issue === null || repo === null) {
        this.errors.push({ message: 'Could not resolve to an Issue with the global id', path: ['addComment'] });
        return { t: 'AddCommentPayload', v: null };
      }
      return { t: 'AddCommentPayload', v: forge.createComment(repo, issue, input.body) };
    }
    if (name === 'createRepository') {
      const repo = forge.createRepo(forge.login, input.name, { private: input.private === true, description: input.description });
      return { t: 'CreateRepositoryPayload', v: { repository: repo } };
    }
    return null;
  }

  /** One repository field. */
  repositoryField(repo, name, args) {
    const forge = this.forge;
    switch (name) {
      case 'id':
        return globalId('Repository', repo.id);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return repo.fullName;
      case 'owner':
        return { t: 'User', v: forge.user() };
      case 'description':
        return repo.description === '' ? null : repo.description;
      case 'isPrivate':
        return repo.private;
      case 'visibility':
        return repo.private ? 'PRIVATE' : 'PUBLIC';
      case 'isEmpty':
        return repo.refs.size === 0;
      case 'isFork':
      case 'isArchived':
        return false;
      case 'stargazerCount':
      case 'forkCount':
        return 0;
      case 'url':
        return `/${repo.fullName}`;
      case 'createdAt':
        return new Date((1735689600 + repo.createdSeq) * 1000).toISOString();
      case 'updatedAt':
        return new Date((1735689600 + repo.updatedSeq) * 1000).toISOString();
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'defaultBranchRef': {
        const tip = forge.branchTip(repo, repo.defaultBranch);
        return tip === null ? null : { t: 'Ref', v: { name: repo.defaultBranch, prefix: 'refs/heads/', target: tip, repo } };
      }
      case 'ref': {
        const oid = repo.refs.get(String(args.qualifiedName));
        return oid === undefined ? null : { t: 'Ref', v: { name: String(args.qualifiedName).replace(/^refs\/(heads|tags)\//, ''), prefix: '', target: oid, repo } };
      }
      case 'object':
        return null;
      case 'issue': {
        const issue = forge.findIssue(repo, args.number);
        return issue === null ? null : { t: 'Issue', v: issue };
      }
      case 'label': {
        const label = forge.labelRecord(repo, args.name);
        return label === null ? null : { t: 'Label', v: label };
      }
      case 'labels':
        return { t: 'LabelConnection', v: { nodes: repo.labels, totalCount: repo.labels.length } };
      case 'issues': {
        const wanted = Array.isArray(args.states) && args.states.length > 0 ? args.states : null;
        let list = repo.issues.filter((issue) => wanted === null || wanted.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
        const orderBy = args.orderBy ?? {};
        if (orderBy.field === 'UPDATED_AT') list = list.slice().sort((a, b) => (a.updatedIso < b.updatedIso ? -1 : a.updatedIso > b.updatedIso ? 1 : a.number - b.number));
        else if (orderBy.field === 'COMMENTS') list = list.slice().sort((a, b) => a.comments.length - b.comments.length || a.number - b.number);
        else list = list.slice().sort((a, b) => a.number - b.number);
        // Newest first is the default, and a tie inside one moment is broken by the higher number first.
        if (orderBy.direction !== 'ASC') list.reverse();
        let start = 0;
        const after = numberFromCursor(args.after);
        if (after !== null) {
          const found = list.findIndex((issue) => issue.number === after);
          start = found < 0 ? 0 : found + 1;
        }
        const first = Number.isFinite(args.first) && args.first > 0 ? Math.trunc(args.first) : 30;
        const page = list.slice(start, start + first);
        const last = page[page.length - 1];
        return {
          t: 'IssueConnection',
          v: {
            nodes: page,
            totalCount: list.length,
            pageInfo: {
              hasNextPage: start + page.length < list.length,
              hasPreviousPage: start > 0,
              startCursor: page.length === 0 ? null : cursorFor(page[0].number),
              endCursor: last === undefined ? null : cursorFor(last.number),
            },
          },
        };
      }
      case 'pullRequests': {
        const list = repo.pulls.slice().sort((a, b) => b.number - a.number);
        const first = Number.isFinite(args.first) && args.first > 0 ? Math.trunc(args.first) : 30;
        const page = list.slice(0, first);
        return {
          t: 'PullRequestConnection',
          v: {
            nodes: page,
            totalCount: list.length,
            pageInfo: { hasNextPage: list.length > page.length, hasPreviousPage: false, startCursor: null, endCursor: null },
          },
        };
      }
      case 'pullRequest': {
        const pull = forge.findPull(repo, args.number);
        return pull === null ? null : { t: 'PullRequest', v: pull };
      }
      default:
        return null;
    }
  }

  /** One issue field. */
  issueField(issue, name) {
    const forge = this.forge;
    const repo = issue.repo;
    switch (name) {
      case 'id':
        return globalId('Issue', `${repo ? repo.id : 0}:${issue.number}`);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'stateReason':
        return issue.state === 'closed' ? 'COMPLETED' : null;
      case 'body':
      case 'bodyText':
      case 'bodyHTML':
        return issue.body;
      case 'createdAt':
        return issue.createdIso;
      case 'updatedAt':
        return issue.updatedIso;
      case 'closedAt':
        return issue.closedIso;
      case 'author':
        return { t: 'User', v: forge.user() };
      case 'comments':
        return { t: 'IssueCommentConnection', v: { nodes: issue.comments, totalCount: issue.comments.length } };
      case 'labels':
        return { t: 'LabelConnection', v: { nodes: issue.labels, totalCount: issue.labels.length } };
      case 'repository':
        return repo ? { t: 'Repository', v: repo } : null;
      case 'url':
        return repo ? `/${repo.fullName}/issues/${issue.number}` : '';
      case 'locked':
      case 'isPinned':
      case 'includesCreatedEdit':
      case 'isReadByViewer':
        return false;
      default:
        return null;
    }
  }

  /** One pull request field. */
  pullField(pull, name, args) {
    const forge = this.forge;
    const repo = pull.repo;
    switch (name) {
      case 'id':
        return globalId('PullRequest', `${repo ? repo.id : 0}:${pull.number}`);
      case 'number':
        return pull.number;
      case 'state':
        return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'merged':
        return pull.merged;
      case 'mergedAt':
        return pull.mergedIso;
      case 'headRefName':
        return pull.head;
      case 'baseRefName':
        return pull.base;
      case 'headRefOid':
        return pull.headSha;
      case 'baseRefOid':
        return repo ? forge.branchTip(repo, pull.base) ?? pull.baseSha : pull.baseSha;
      case 'mergeable': {
        if (pull.merged || pull.state !== 'open' || repo === null) return 'UNKNOWN';
        return forge.pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
      }
      case 'files': {
        if (repo === null) return { t: 'PullRequestChangedFileConnection', v: { nodes: [], totalCount: 0 } };
        const files = forge.pullFiles(repo, pull);
        const first = Number.isFinite(args.first) && args.first > 0 ? Math.trunc(args.first) : files.length;
        return { t: 'PullRequestChangedFileConnection', v: { nodes: files.slice(0, first), totalCount: files.length } };
      }
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'createdAt':
        return pull.createdIso;
      case 'updatedAt':
        return pull.updatedIso;
      case 'closedAt':
        return pull.closedIso;
      case 'author':
        return { t: 'User', v: forge.user() };
      case 'isDraft':
        return false;
      case 'url':
        return repo ? `/${repo.fullName}/pull/${pull.number}` : '';
      case 'changedFiles':
        return repo === null ? 0 : forge.pullFiles(repo, pull).length;
      case 'additions':
      case 'deletions':
        return 0;
      case 'repository':
        return repo ? { t: 'Repository', v: repo } : null;
      case 'mergeStateStatus':
      case 'reviewDecision':
        return pull.merged ? 'UNKNOWN' : 'CLEAN';
      default:
        return null;
    }
  }
}

/** Whether a resolved value is a node in flight (`{t, v}`) rather than a scalar or a list. */
function isNode(value) {
  return typeof value === 'object' && value !== null && 't' in value;
}

// ---------------------------------------------------------------- the surface

/**
 * Execute one GraphQL request body: `{query, variables}` in, `{body}` out, where the body is
 * `{data, ...}` plus an `errors` array only when something failed. A document that cannot be read at
 * all is answered as a GraphQL error rather than thrown, so main.ts always has a body to send.
 */
export function executeOperation(forge, request) {
  const document = request?.query;
  if (typeof document !== 'string' || document.trim() === '') {
    return { body: { errors: [{ message: 'A query document is required', locations: [] }] }, errors: 1 };
  }
  let parsed;
  try {
    parsed = parseDocument(tokenize(document));
  } catch (err) {
    return { body: { errors: [{ message: err instanceof Error ? err.message : String(err), locations: [] }] }, errors: 1 };
  }
  if (parsed.operations.length === 0) {
    return { body: { errors: [{ message: 'The document holds no operation', locations: [] }] }, errors: 1 };
  }
  const operation = parsed.operations[0];
  const variables = {};
  for (const [name, node] of operation.defaults) variables[name] = node.value;
  const given = request?.variables;
  if (given !== null && typeof given === 'object' && !Array.isArray(given)) {
    for (const [key, value] of Object.entries(given)) variables[key] = value;
  }
  const result = new GraphqlExecutor(forge, variables).run(operation);
  const body = { data: result.data };
  if (result.errors.length > 0) body.errors = result.errors;
  return { body, errors: result.errors.length };
}

/** Whether a document's first operation is a mutation (the REST layer's own spelling of the type). */
export function operationTypeOf(document) {
  if (typeof document !== 'string') return 'query';
  return document.trimStart().startsWith('mutation') ? 'mutation' : 'query';
}
