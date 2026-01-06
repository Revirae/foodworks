/**
 * Utilities for optimistic UI updates with rollback
 */

export interface OptimisticUpdate<T> {
  id: string;
  original: T;
  optimistic: T;
  rollback: () => Promise<void>;
  timestamp: number;
}

export class OptimisticUpdateManager<T> {
  private updates = new Map<string, OptimisticUpdate<T>>();
  private maxHistory = 50;

  /**
   * Registers an optimistic update
   */
  register(
    id: string,
    original: T,
    optimistic: T,
    rollback: () => Promise<void>,
  ): void {
    this.updates.set(id, {
      id,
      original,
      optimistic,
      rollback,
      timestamp: Date.now(),
    });

    // Clean up old updates
    if (this.updates.size > this.maxHistory) {
      const oldest = Array.from(this.updates.values())
        .sort((a, b) => a.timestamp - b.timestamp)[0];
      this.updates.delete(oldest.id);
    }
  }

  /**
   * Gets the optimistic value for an ID, or returns the original
   */
  get(id: string, original: T): T {
    const update = this.updates.get(id);
    return update ? update.optimistic : original;
  }

  /**
   * Commits an update (removes from pending)
   */
  commit(id: string): void {
    this.updates.delete(id);
  }

  /**
   * Rolls back an update
   */
  async rollback(id: string): Promise<void> {
    const update = this.updates.get(id);
    if (update) {
      await update.rollback();
      this.updates.delete(id);
    }
  }

  /**
   * Rolls back all pending updates
   */
  async rollbackAll(): Promise<void> {
    const updates = Array.from(this.updates.values());
    await Promise.all(updates.map(u => u.rollback()));
    this.updates.clear();
  }

  /**
   * Clears all updates without rolling back
   */
  clear(): void {
    this.updates.clear();
  }

  /**
   * Checks if there are pending updates
   */
  hasPending(): boolean {
    return this.updates.size > 0;
  }
}

