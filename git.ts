// The git object model, implemented from scratch on node:crypto and node:zlib: SHA-1 object ids,
// loose-object storage in memory, packfile reading (with OFS_DELTA and REF_DELTA resolution against
// the pack itself or the store) and packfile writing (whole objects, no deltas), pkt-line framing,
// and tree/commit parsing and building. Nothing here shells out to a git binary.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_IDS: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const TYPE_NAMES: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The SHA-1 object id of an object: sha1("<type> <byte length>\0" + data). */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** An in-memory loose-object store keyed by object id. */
export class ObjectStore {
  readonly objects = new Map<string, GitObject>();

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  /** Store an object and return its id (idempotent: the same bytes always give the same id). */
  put(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  /** Store an object whose id is already known (from a pack), without rehashing trust issues. */
  putKnown(oid: string, object: GitObject): void {
    if (!this.objects.has(oid)) this.objects.set(oid, object);
  }
}

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

/** Encode one pkt-line payload (text or bytes). Payloads over the 65520-byte packet max are split. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (body.length + 4 > 65_520) throw new Error(`pkt-line payload too large: ${body.length}`);
  const header = Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Encode a sequence of payloads, with the string 'flush' / 'delim' as control packets. */
export function encodePktLines(lines: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(PKT_FLUSH);
    else if (line === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

export interface PktPacket {
  readonly kind: 'data' | 'flush' | 'delim';
  readonly payload: Buffer;
}

/** Split a buffer into pkt-line packets; throws on a malformed length prefix. */
export function decodePktLines(buffer: Buffer, offset = 0): { packets: PktPacket[]; nextOffset: number } {
  const packets: PktPacket[] = [];
  let at = offset;
  while (at + 4 <= buffer.length) {
    const hex = buffer.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length at ${at}: ${JSON.stringify(hex)}`);
    const length = parseInt(hex, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      at += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'data', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (length < 4 || at + length > buffer.length) throw new Error(`pkt-line length ${length} overruns the buffer at ${at}`);
    packets.push({ kind: 'data', payload: buffer.subarray(at + 4, at + length) });
    at += length;
  }
  return { packets, nextOffset: at };
}

/** Frame pack bytes as side-band-64k band-1 packets (each packet carries at most 65515 data bytes). */
export function sidebandPackets(data: Buffer, band = 1, chunkSize = 65_515): Buffer {
  const parts: Buffer[] = [];
  for (let at = 0; at < data.length; at += chunkSize) {
    const slice = data.subarray(at, Math.min(data.length, at + chunkSize));
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), slice])));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// commits and trees
// ---------------------------------------------------------------------------

export interface CommitInfo {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly authorLine: string;
  readonly committerLine: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authorEpoch: number;
  readonly committerName: string;
  readonly committerEmail: string;
  readonly committerEpoch: number;
  readonly message: string;
}

function parseIdent(line: string): { name: string; email: string; epoch: number } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (!match) return { name: line, email: '', epoch: 0 };
  return { name: match[1], email: match[2], epoch: Number(match[3]) };
}

/** Parse a commit object's bytes into its header fields and message. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = ZERO_OID;
  const parents: string[] = [];
  let authorLine = '';
  let committerLine = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
    else if (line.startsWith('committer ')) committerLine = line.slice(10);
  }
  const author = parseIdent(authorLine);
  const committer = parseIdent(committerLine);
  return {
    tree,
    parents,
    authorLine,
    committerLine,
    authorName: author.name,
    authorEmail: author.email,
    authorEpoch: author.epoch,
    committerName: committer.name,
    committerEmail: committer.email,
    committerEpoch: committer.epoch,
    message,
  };
}

/** Format one ident line: `Name <email> epoch +0000`. */
export function formatIdent(name: string, email: string, epoch: number): string {
  return `${name} <${email}> ${epoch} +0000`;
}

/** Build a commit object's bytes. */
export function buildCommit(input: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author}`);
  lines.push(`committer ${input.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${input.message}`, 'utf8');
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object's bytes into entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const mode = data.subarray(at, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    at = nul + 21;
  }
  return entries;
}

/** Git's tree sort key: directories sort as if their name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Build a tree object's bytes from entries (sorted the git way). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree (recursively) into a map of path -> {mode, oid} for files (blobs) only. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = '', out = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
  const tree = store.get(treeOid);
  if (!tree || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** Build nested trees from a flat path -> {mode, oid} map; returns the root tree's oid. */
export function buildTreeFromFiles(store: ObjectStore, files: ReadonlyMap<string, { mode: string; oid: string }>): string {
  interface Dir {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, file] of files) {
    const parts = path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = dir.dirs.get(parts[i]);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(parts[i], next);
      }
      dir = next;
    }
    dir.files.set(parts[parts.length - 1], file);
  }
  const build = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of dir.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, child] of dir.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return store.put('tree', buildTree(entries));
  };
  return build(root);
}

/** Peel a ref target to a commit: follow tag objects until a commit (or the object itself). */
export function peelToCommit(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = store.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    const match = /^object ([0-9a-f]{40})/m.exec(object.data.toString('utf8'));
    if (!match) return null;
    current = match[1];
  }
  return null;
}

/** Every object reachable from the given roots (commits walk their trees and parents). */
export function collectReachable(store: ObjectStore, roots: readonly string[], into = new Set<string>()): Set<string> {
  const stack = [...roots];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (into.has(oid)) continue;
    const object = store.get(oid);
    if (!object) continue;
    into.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})/m.exec(object.data.toString('utf8'));
      if (match) stack.push(match[1]);
    }
  }
  return into;
}

/** Is `ancestor` an ancestor of (or equal to) `descendant`, following commit parents? */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/** The merge base (best common ancestor) of two commits, or null when unrelated. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsOfA = new Set<string>();
  const stack = [a];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (ancestorsOfA.has(oid)) continue;
    ancestorsOfA.add(oid);
    const object = store.get(oid);
    if (object?.type === 'commit') stack.push(...parseCommit(object.data).parents);
  }
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const object = store.get(oid);
    if (object?.type === 'commit') queue.push(...parseCommit(object.data).parents);
  }
  return null;
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size mismatch: ${sourceSize} != ${base.length}`);
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (at < delta.length) {
    const opcode = delta[at++];
    if (opcode & 0x80) {
      let offset = 0;
      let size = 0;
      if (opcode & 0x01) offset = delta[at++];
      if (opcode & 0x02) offset |= delta[at++] << 8;
      if (opcode & 0x04) offset |= delta[at++] << 16;
      if (opcode & 0x08) offset |= delta[at++] << 24;
      if (opcode & 0x10) size = delta[at++];
      if (opcode & 0x20) size |= delta[at++] << 8;
      if (opcode & 0x40) size |= delta[at++] << 16;
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (opcode > 0) {
      parts.push(delta.subarray(at, at + opcode));
      produced += opcode;
      at += opcode;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== targetSize || produced !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

interface PackEntry {
  offset: number;
  type: GitObjectType | 'ofs-delta' | 'ref-delta';
  data?: Buffer;
  baseOffset?: number;
  baseOid?: string;
  delta?: Buffer;
}

/**
 * Read a packfile into whole objects. `resolveExternal` supplies objects the pack deltas against
 * but does not carry (thin packs). Returns every object the pack defines, keyed by id.
 */
export function readPack(
  pack: Buffer,
  resolveExternal: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack checksum mismatch');
  let at = 12;
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  for (let i = 0; i < count; i += 1) {
    const entryOffset = at;
    let byte = pack[at++];
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[at++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let entry: PackEntry;
    if (typeId === 6) {
      let back = pack[at++];
      let offset = back & 0x7f;
      while (back & 0x80) {
        back = pack[at++];
        offset = ((offset + 1) << 7) | (back & 0x7f);
      }
      entry = { offset: entryOffset, type: 'ofs-delta', baseOffset: entryOffset - offset };
    } else if (typeId === 7) {
      const baseOid = pack.subarray(at, at + 20).toString('hex');
      at += 20;
      entry = { offset: entryOffset, type: 'ref-delta', baseOid };
    } else {
      const name = TYPE_NAMES[typeId];
      if (!name) throw new Error(`bad pack object type ${typeId}`);
      entry = { offset: entryOffset, type: name };
    }
    const inflated = inflateSync(pack.subarray(at));
    // inflateSync consumes the whole stream; find its end by re-inflating incrementally is not
    // possible with the sync API, so use the stream's own accounting through a bounded window:
    entry.data = entry.type === 'ofs-delta' || entry.type === 'ref-delta' ? undefined : inflated;
    if (entry.type === 'ofs-delta' || entry.type === 'ref-delta') entry.delta = inflated;
    if (inflated.length !== size) throw new Error(`pack object size mismatch at ${entryOffset}`);
    at += compressedLength(pack, at, inflated.length);
    entries.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const resolved = new Map<string, GitObject>();
  const resolveEntry = (entry: PackEntry): GitObject => {
    if (entry.type !== 'ofs-delta' && entry.type !== 'ref-delta') {
      return { type: entry.type, data: entry.data as Buffer };
    }
    let base: GitObject | undefined;
    if (entry.type === 'ofs-delta') {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error('ofs-delta base missing from the pack');
      base = resolveEntry(baseEntry);
    } else {
      const inPack = entries.find((candidate) => {
        if (candidate.type === 'ofs-delta' || candidate.type === 'ref-delta') return false;
        return hashObject(candidate.type, candidate.data as Buffer) === entry.baseOid;
      });
      if (inPack) base = { type: inPack.type, data: inPack.data as Buffer };
      else {
        // The base may itself be a resolved delta elsewhere in the pack.
        for (const candidate of entries) {
          if (candidate === entry) continue;
          const object = tryResolve(candidate);
          if (object && hashObject(object.type, object.data) === entry.baseOid) {
            base = object;
            break;
          }
        }
        if (!base) base = resolveExternal(entry.baseOid as string);
      }
    }
    if (!base) throw new Error(`delta base ${entry.baseOid ?? entry.baseOffset} is not available`);
    return { type: base.type, data: applyDelta(base.data, entry.delta as Buffer) };
  };
  const memo = new Map<PackEntry, GitObject>();
  const tryResolve = (entry: PackEntry): GitObject | undefined => {
    const hit = memo.get(entry);
    if (hit) return hit;
    try {
      const object = resolveEntry(entry);
      memo.set(entry, object);
      return object;
    } catch {
      return undefined;
    }
  };
  for (const entry of entries) {
    const object = resolveEntry(entry);
    resolved.set(hashObject(object.type, object.data), object);
  }
  return resolved;
}

/**
 * The number of bytes the zlib stream starting at `at` occupies. Found by inflating with a raw
 * stream and tracking consumed bytes through `inflateSync` on progressively larger windows is
 * wasteful; instead use the fact that Node reports nothing — so scan with a streaming inflate.
 */
function compressedLength(pack: Buffer, at: number, expectedPlain: number): number {
  // A zlib stream is self-terminating. Binary-search the smallest window whose inflate succeeds
  // and yields exactly the expected plaintext: correct, and fast enough for forge-sized packs.
  let lo = 1;
  let hi = pack.length - at;
  const works = (length: number): boolean => {
    try {
      const out = inflateSync(pack.subarray(at, at + length), { maxOutputLength: expectedPlain + 1 });
      return out.length === expectedPlain;
    } catch {
      return false;
    }
  };
  if (!works(hi)) throw new Error('pack zlib stream does not terminate inside the pack');
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (works(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Write a packfile of whole objects (no deltas); returns the pack bytes with a valid trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const compressed = deflateSync(object.data);
    let size = object.data.length;
    const first = (TYPE_IDS[object.type] << 4) | (size & 0x0f);
    size >>= 4;
    const varint: number[] = [];
    if (size === 0) {
      varint.push(first);
    } else {
      varint.push(first | 0x80);
      while (size > 0) {
        let byte = size & 0x7f;
        size >>= 7;
        if (size > 0) byte |= 0x80;
        varint.push(byte);
      }
    }
    parts.push(Buffer.from(varint));
    parts.push(compressed);
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}
