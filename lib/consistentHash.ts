// Consistent-hash ring with virtual nodes. Maps a prefix key -> cache node.
// Adding/removing a node remaps only ~K/N keys, unlike `hash % N` which would
// shuffle nearly everything. Positions are 64-bit (BigInt) so they don't
// collide after truncation.
import { createHash } from 'crypto';

export function hashKey(key: string): bigint {
  const hex = createHash('md5').update(key).digest('hex').slice(0, 16);
  return BigInt('0x' + hex);
}

export interface RingDebug {
  key: string;
  key_hash: string;
  owner_node: string | null;
  ring_position: string | null;
  total_vnodes: number;
}

export class HashRing {
  private readonly vnodes: number;
  private positions: bigint[] = []; // sorted ascending
  private owner = new Map<string, string>(); // position(string) -> node
  private members = new Set<string>();

  constructor(vnodes = 150) {
    this.vnodes = vnodes;
  }

  addNode(node: string): void {
    if (this.members.has(node)) return;
    this.members.add(node);
    for (let i = 0; i < this.vnodes; i++) {
      const pos = hashKey(`${node}#${i}`);
      this.owner.set(pos.toString(), node);
      this.positions.push(pos);
    }
    this.positions.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  removeNode(node: string): void {
    if (!this.members.has(node)) return;
    this.members.delete(node);
    for (let i = 0; i < this.vnodes; i++) {
      this.owner.delete(hashKey(`${node}#${i}`).toString());
    }
    this.positions = this.positions.filter((p) => this.owner.has(p.toString()));
  }

  // index of the first vnode clockwise from h (wraps to 0 past the end)
  private indexFor(h: bigint): number {
    let lo = 0;
    let hi = this.positions.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.positions[mid] <= h) lo = mid + 1;
      else hi = mid;
    }
    return lo === this.positions.length ? 0 : lo;
  }

  nodeFor(key: string): string | null {
    if (this.positions.length === 0) return null;
    const pos = this.positions[this.indexFor(hashKey(key))];
    return this.owner.get(pos.toString()) ?? null;
  }

  describe(key: string): RingDebug {
    const h = hashKey(key);
    const pos = this.positions.length ? this.positions[this.indexFor(h)] : null;
    return {
      key,
      key_hash: h.toString(),
      owner_node: this.nodeFor(key),
      ring_position: pos ? pos.toString() : null,
      total_vnodes: this.positions.length,
    };
  }

  distribution(keys: string[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const node of this.members) out[node] = 0;
    for (const key of keys) {
      const node = this.nodeFor(key);
      if (node) out[node] = (out[node] || 0) + 1;
    }
    return out;
  }
}
