import type { Transaction } from '../core/types.js';

const DEFAULT_MAX_SIZE = 10_000;

export class Mempool {
  private transactions = new Map<string, Transaction>();
  private maxSize: number;

  constructor(maxSize: number = DEFAULT_MAX_SIZE) {
    this.maxSize = maxSize;
  }

  add(tx: Transaction): boolean {
    if (this.transactions.has(tx.id)) return false; // duplicate
    if (this.transactions.size >= this.maxSize) {
      // Evict oldest
      const oldest = this.transactions.keys().next().value;
      if (oldest) this.transactions.delete(oldest);
    }
    this.transactions.set(tx.id, tx);
    return true;
  }

  has(txId: string): boolean {
    return this.transactions.has(txId);
  }

  remove(txId: string): void {
    this.transactions.delete(txId);
  }

  removeMany(txIds: string[]): void {
    for (const id of txIds) this.transactions.delete(id);
  }

  getAll(): Transaction[] {
    return Array.from(this.transactions.values());
  }

  getPending(limit: number = 100): Transaction[] {
    const all = this.getAll();
    // Sort by timestamp (deterministic), then hash as tiebreaker
    all.sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      return a.id.localeCompare(b.id);
    });
    return all.slice(0, limit);
  }

  size(): number {
    return this.transactions.size;
  }

  clear(): void {
    this.transactions.clear();
  }
}
