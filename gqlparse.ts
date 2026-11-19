// A small GraphQL document parser: operations, fragments, aliases, arguments with variables,
// enum/list/object literals — the subset the gh-shaped documents use.

export type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, ValueNode>;
  selectionSet: SelectionNode[] | null;
}

export type SelectionNode =
  | FieldNode
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionNode[] };

export interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>;
}

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'ellipsis';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'ellipsis', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:=@$!|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: source.slice(i + 3, end < 0 ? source.length : end) });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc === 'u' ? String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16)) : esc;
          j += esc === 'u' ? 6 : 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) j += 1;
      const text = source.slice(i, j);
      tokens.push({ kind: /[.eE]/.test(text) ? 'float' : 'int', value: text });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in the GraphQL document`);
  }
  return tokens;
}

class Parser {
  private at = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private next(): Token {
    const token = this.tokens[this.at];
    if (!token) throw new Error('unexpected end of the GraphQL document');
    this.at += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}", found "${token.value}"`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === value) {
      this.at += 1;
      return true;
    }
    return false;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>();
    while (this.at < this.tokens.length) {
      const token = this.peek() as Token;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error(`unexpected token "${token.value}"`);
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | null = null;
        if (this.peek()?.kind === 'name') name = this.next().value;
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.skipBalancedParens();
        this.skipDirectives();
        operations.push({ type: token.value === 'mutation' ? 'mutation' : 'query', name, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.next().value;
        const onToken = this.next();
        if (onToken.value !== 'on') throw new Error('expected "on" in a fragment definition');
        const typeCondition = this.next().value;
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected definition "${token.value}"`);
    }
    return { operations, fragments };
  }

  private skipBalancedParens(): void {
    let depth = 0;
    do {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
    } while (depth > 0);
  }

  private skipDirectives(): void {
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.next(); // directive name
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.skipBalancedParens();
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek() as Token;
    if (token.kind === 'ellipsis') {
      this.next();
      const nextTok = this.peek();
      if (nextTok?.kind === 'name' && nextTok.value === 'on') {
        this.next();
        const typeCondition = this.next().value;
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      const name = this.next().value;
      this.skipDirectives();
      return { kind: 'spread', name };
    }
    let name = this.next().value;
    let alias: string | null = null;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.next().value;
    }
    const args: Record<string, ValueNode> = {};
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const argName = this.next().value;
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'var', name: this.next().value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const key = this.next().value;
        this.expectPunct(':');
        fields[key] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token "${token.value}"`);
  }
}

export function parseGraphQL(source: string): DocumentNode {
  return new Parser(tokenize(source)).parseDocument();
}

/** Turn a value node into a plain JS value with the operation's variables. */
export function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'bool':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => valueOf(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = valueOf(value, variables);
      return out;
    }
  }
}
