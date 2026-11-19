// Git smart HTTP: ref advertisement (v0 and protocol v2), ls-refs, upload-pack (fetch, v0 and v2,
// with shallow/deepen support) and receive-pack (push, v0, fast-forward only, per-ref report).
// Repositories are created through REST; a push to a missing repository is a 404 on info/refs.

import {
  ZERO_OID,
  collectReachable,
  decodePktLines,
  encodePktLines,
  isAncestor,
  parseCommit,
  peelToCommit,
  pktLine,
  readPack,
  sidebandPackets,
  writePack,
  type GitObject,
} from './git.ts';
import type { Repo } from './store.ts';

const AGENT = 'git-forge/1.0.0';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function jsonError(status: number, message: string): GitResponse {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8') };
}

/** Every ref line a v0 advertisement carries: HEAD first, then refs sorted, tags peeled. */
function advertisedRefs(repo: Repo): Array<{ oid: string; name: string; peeled?: string }> {
  const out: Array<{ oid: string; name: string; peeled?: string }> = [];
  const headTip = repo.refs.get(repo.headRef);
  out.push({ oid: headTip ?? ZERO_OID, name: 'HEAD' });
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name) as string;
    const entry: { oid: string; name: string; peeled?: string } = { oid, name };
    const object = repo.objects.get(oid);
    if (object?.type === 'tag') {
      const peeled = peelToCommit(repo.objects, oid);
      if (peeled) entry.peeled = peeled;
    }
    out.push(entry);
  }
  return out;
}

/** GET /info/refs for either service. */
export function infoRefs(repo: Repo | null, service: string, protocolHeader: string | null): GitResponse {
  if (!repo) return jsonError(404, 'Not Found');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return jsonError(400, 'Bad Request');
  const wantsV2 = service === 'git-upload-pack' && (protocolHeader ?? '').includes('version=2');
  if (wantsV2) {
    const body = encodePktLines([
      'version 2\n',
      `agent=${AGENT}\n`,
      'ls-refs=unborn peel symrefs\n',
      'fetch=shallow wait-for-done\n',
      'object-format=sha1\n',
      'flush',
    ]);
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
  }
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k ofs-delta shallow symref=HEAD:${repo.headRef} agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const lines: (string | 'flush')[] = [`# service=${service}\n`, 'flush'];
  const refs = advertisedRefs(repo);
  if (repo.refs.size === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    refs.forEach((ref, index) => {
      lines.push(index === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`);
      if (ref.peeled) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    });
  }
  lines.push('flush');
  return { status: 200, contentType: `application/x-${service}-advertisement`, body: encodePktLines(lines) };
}

/** One ls-refs / fetch argument set, parsed from the v2 command body after the delim packet. */
interface V2Args {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  done: boolean;
}

function parseV2Args(packets: readonly { kind: string; payload: Buffer }[]): V2Args {
  const args: V2Args = {
    peel: false,
    symrefs: false,
    unborn: false,
    prefixes: [],
    wants: [],
    haves: [],
    shallow: [],
    deepen: null,
    deepenSince: null,
    deepenNot: [],
    done: false,
  };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line === 'done') args.done = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice(11));
    else if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.deepen = Number(line.slice(7));
    else if (line.startsWith('deepen-since ')) args.deepenSince = Number(line.slice(13));
    else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11).trim());
  }
  return args;
}

/** POST git-upload-pack with a protocol v2 command (ls-refs or fetch). */
export function uploadPackV2(repo: Repo, body: Buffer): GitResponse {
  const { packets } = decodePktLines(body);
  const first = packets.find((packet) => packet.kind === 'data');
  const commandLine = first?.payload.toString('utf8').replace(/\n$/, '') ?? '';
  const args = parseV2Args(packets.slice(1));
  if (commandLine === 'command=ls-refs') {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefs(repo, args) };
  }
  if (commandLine === 'command=fetch') {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV2(repo, args) };
  }
  return jsonError(400, 'Bad Request');
}

function lsRefs(repo: Repo, args: V2Args): Buffer {
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const lines: (string | 'flush')[] = [];
  const headTip = repo.refs.get(repo.headRef);
  if (keep('HEAD')) {
    if (headTip) {
      lines.push(`${headTip} HEAD${args.symrefs ? ` symref-target:${repo.headRef}` : ''}\n`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD${args.symrefs ? ` symref-target:${repo.headRef}` : ''}\n`);
    }
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const object = repo.objects.get(oid);
      if (object?.type === 'tag') {
        const peeled = peelToCommit(repo.objects, oid);
        if (peeled) line += ` peeled:${peeled}`;
      }
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/**
 * Work out which objects a fetch sends: the closure of the wants, minus what the client holds
 * (the haves' full closure and its shallow boundary commits' own trees), cut at the shallow
 * boundary the depth arguments describe.
 */
function planFetch(repo: Repo, args: V2Args): FetchPlan {
  const store = repo.objects;
  // The client's shallow commits: it holds the commit and its tree, but not its parents — so a
  // shallow commit listed as a have excludes only itself and its tree, never its ancestors.
  const clientShallow = new Set(args.shallow.filter((oid) => store.has(oid)));
  const exclude = new Set<string>();
  const excludeShallowCommit = (oid: string): void => {
    const commit = store.get(oid);
    if (commit?.type === 'commit') {
      exclude.add(oid);
      collectReachable(store, [parseCommit(commit.data).tree], exclude);
    }
  };
  for (const have of args.haves) {
    if (clientShallow.has(have)) excludeShallowCommit(have);
    else collectReachable(store, [have], exclude);
  }
  for (const oid of clientShallow) if (!exclude.has(oid)) excludeShallowCommit(oid);
  for (const not of args.deepenNot) collectReachable(store, [not], exclude);
  const depth = args.deepen;
  const since = args.deepenSince;
  if (depth === null && since === null) {
    // Full fetch: the wants' closure minus what the client holds, never crossing the parents of
    // the client's shallow boundary commits.
    const send = new Set<string>();
    const stack = [...args.wants];
    while (stack.length) {
      const oid = stack.pop() as string;
      if (send.has(oid) || exclude.has(oid)) continue;
      const object = store.get(oid);
      if (!object) continue;
      send.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        stack.push(commit.tree);
        if (!clientShallow.has(oid)) for (const parent of commit.parents) stack.push(parent);
      } else if (object.type === 'tree') {
        stack.push(...treeChildren(store, oid));
      } else if (object.type === 'tag') {
        const target = tagTarget(object.data);
        if (target) stack.push(target);
      }
    }
    return { objects: objectsOf(store, send), shallow: [], unshallow: [] };
  }
  // Shallow fetch: BFS by commit generations from the wants.
  const generation = new Map<string, number>();
  const commitQueue: Array<{ oid: string; gen: number }> = [];
  const extraRoots: string[] = [];
  for (const want of args.wants) {
    const object = store.get(want);
    if (!object) continue;
    if (object.type === 'commit') commitQueue.push({ oid: want, gen: 0 });
    else extraRoots.push(want);
  }
  const includedCommits = new Set<string>();
  const boundary = new Set<string>();
  while (commitQueue.length) {
    const { oid, gen } = commitQueue.shift() as { oid: string; gen: number };
    if (generation.has(oid) && (generation.get(oid) as number) <= gen) continue;
    generation.set(oid, gen);
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    const withinDepth = depth !== null ? gen < depth : true;
    const withinSince = since !== null ? commit.committerEpoch >= since : true;
    if (!withinDepth || !withinSince) {
      boundary.add(oid);
      continue;
    }
    includedCommits.add(oid);
    for (const parent of commit.parents) commitQueue.push({ oid: parent, gen: gen + 1 });
  }
  // The new boundary: included commits whose parents are not included (and exist).
  const newShallow = new Set<string>();
  for (const oid of includedCommits) {
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.some((parent) => !includedCommits.has(parent) && store.has(parent))) newShallow.add(oid);
  }
  for (const oid of boundary) {
    // A commit just outside the cut is not sent, so it cannot be the client's boundary; the
    // boundary is the last included generation. Nothing to add here.
    void oid;
  }
  const send = new Set<string>();
  for (const oid of includedCommits) {
    if (!exclude.has(oid)) send.add(oid);
    const object = store.get(oid);
    if (object?.type === 'commit') collectReachable(store, [parseCommit(object.data).tree], send);
  }
  for (const root of extraRoots) collectReachable(store, [root], send);
  for (const oid of [...send]) if (exclude.has(oid)) send.delete(oid);
  const unshallow = [...clientShallow].filter((oid) => includedCommits.has(oid) && !newShallow.has(oid));
  return { objects: objectsOf(store, send), shallow: [...newShallow], unshallow };
}

function treeChildren(store: Repo['objects'], treeOid: string): string[] {
  const object = store.get(treeOid);
  if (!object || object.type !== 'tree') return [];
  const children: string[] = [];
  const data = object.data;
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const nul = data.indexOf(0x00, space + 1);
    children.push(data.subarray(nul + 1, nul + 21).toString('hex'));
    at = nul + 21;
  }
  return children;
}

function tagTarget(data: Buffer): string | null {
  const match = /^object ([0-9a-f]{40})/m.exec(data.toString('utf8'));
  return match ? match[1] : null;
}

function objectsOf(store: Repo['objects'], oids: ReadonlySet<string>): GitObject[] {
  const out: GitObject[] = [];
  for (const oid of oids) {
    const object = store.get(oid);
    if (object) out.push(object);
  }
  return out;
}

function fetchV2(repo: Repo, args: V2Args): Buffer {
  const store = repo.objects;
  const plan = planFetch(repo, args);
  const parts: Buffer[] = [];
  // acknowledgments: ACK the haves the store knows as commits, NAK when none, ready when done.
  const ackLines: (string | 'delim')[] = ['acknowledgments\n'];
  const common = args.haves.filter((oid) => store.get(oid)?.type === 'commit');
  if (common.length === 0) ackLines.push('NAK\n');
  else for (const oid of common) ackLines.push(`ACK ${oid}\n`);
  if (args.done) ackLines.push('ready\n');
  ackLines.push('delim');
  parts.push(encodePktLines(ackLines));
  if (plan.shallow.length || plan.unshallow.length) {
    const shallowLines: (string | 'delim')[] = ['shallow-info\n'];
    for (const oid of plan.shallow) shallowLines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) shallowLines.push(`unshallow ${oid}\n`);
    shallowLines.push('delim');
    parts.push(encodePktLines(shallowLines));
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPackets(writePack(plan.objects), 1));
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

/** POST git-upload-pack, protocol v0: wants/haves negotiation, then a sideband pack. */
export function uploadPackV0(repo: Repo, body: Buffer): GitResponse {
  let packets: ReturnType<typeof decodePktLines>['packets'];
  try {
    packets = decodePktLines(body).packets;
  } catch {
    return jsonError(400, 'Bad Request');
  }
  const args: V2Args = {
    peel: false, symrefs: false, unborn: false, prefixes: [], wants: [], haves: [], shallow: [],
    deepen: null, deepenSince: null, deepenNot: [], done: false,
  };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0]);
      else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) args.deepen = Number(line.slice(7));
      else if (line.startsWith('deepen-since ')) args.deepenSince = Number(line.slice(13));
      else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11).trim());
    } else {
      if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
      else if (line === 'done') args.done = true;
    }
  }
  const store = repo.objects;
  const plan = planFetch(repo, args);
  const parts: Buffer[] = [];
  const common = args.haves.filter((oid) => store.get(oid)?.type === 'commit');
  parts.push(pktLine(common.length ? `ACK ${common[0]}\n` : 'NAK\n'));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPackets(writePack(plan.objects), 1));
  parts.push(Buffer.from('0000', 'ascii'));
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST git-receive-pack: apply fast-forward-only ref updates from a command list + pack. */
export function receivePack(repo: Repo, body: Buffer): GitResponse {
  let decoded: ReturnType<typeof decodePktLines>;
  try {
    decoded = decodePktLines(body);
  } catch {
    return jsonError(400, 'Bad Request');
  }
  const commands: PushCommand[] = [];
  let sideband = false;
  for (const packet of decoded.packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      const caps = line.slice(nul + 1);
      if (caps.split(' ').includes('side-band-64k')) sideband = true;
      line = line.slice(0, nul);
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match) commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }
  const packBytes = body.subarray(decoded.nextOffset);
  const store = repo.objects;
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => store.get(oid));
      for (const [oid, object] of objects) store.putKnown(oid, object);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }
  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError.replace(/\n/g, ' ')}\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const command of commands) {
      const reason = applyCommand(repo, command);
      reportLines.push(reason === null ? `ok ${command.ref}\n` : `ng ${command.ref} ${reason}\n`);
    }
  }
  const report = encodePktLines([...reportLines, 'flush']);
  const responseBody = sideband ? Buffer.concat([sidebandPackets(report, 1, 65_512), Buffer.from('0000', 'ascii')]) : report;
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: responseBody };
}

/** Apply one push command; returns null on success or the ng reason. */
function applyCommand(repo: Repo, command: PushCommand): string | null {
  const store = repo.objects;
  const current = repo.refs.get(command.ref) ?? ZERO_OID;
  if (command.oldOid !== current) return 'stale info';
  if (command.newOid === ZERO_OID) {
    repo.refs.delete(command.ref);
    return null;
  }
  if (!store.has(command.newOid)) return 'invalid object';
  if (command.oldOid !== ZERO_OID && command.ref.startsWith('refs/heads/')) {
    const oldCommit = peelToCommit(store, command.oldOid);
    const newCommit = peelToCommit(store, command.newOid);
    if (oldCommit && newCommit && !isAncestor(store, oldCommit, newCommit)) return 'non-fast-forward';
  }
  repo.refs.set(command.ref, command.newOid);
  return null;
}
