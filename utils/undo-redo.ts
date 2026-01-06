/**
 * Undo/Redo functionality for graph edits
 */

export interface HistoryState {
  id: string;
  type: "edge_added" | "edge_removed" | "node_moved";
  data: Record<string, unknown>;
  timestamp: number;
}

export class UndoRedoManager {
  private history: HistoryState[] = [];
  private currentIndex = -1;
  private maxHistory = 100;

  /**
   * Adds a new state to history
   */
  push(state: Omit<HistoryState, "id" | "timestamp">): void {
    // Remove any states after current index (when undoing and then making a new change)
    this.history = this.history.slice(0, this.currentIndex + 1);

    const newState: HistoryState = {
      ...state,
      id: `${Date.now()}-${Math.random()}`,
      timestamp: Date.now(),
    };

    this.history.push(newState);
    this.currentIndex = this.history.length - 1;

    // Limit history size
    if (this.history.length > this.maxHistory) {
      this.history.shift();
      this.currentIndex--;
    }
  }

  /**
   * Gets the current state
   */
  getCurrent(): HistoryState | null {
    if (this.currentIndex < 0 || this.currentIndex >= this.history.length) {
      return null;
    }
    return this.history[this.currentIndex];
  }

  /**
   * Undo - moves to previous state
   */
  undo(): HistoryState | null {
    if (this.canUndo()) {
      this.currentIndex--;
      return this.getCurrent();
    }
    return null;
  }

  /**
   * Redo - moves to next state
   */
  redo(): HistoryState | null {
    if (this.canRedo()) {
      this.currentIndex++;
      return this.getCurrent();
    }
    return null;
  }

  /**
   * Checks if undo is possible
   */
  canUndo(): boolean {
    return this.currentIndex > 0;
  }

  /**
   * Checks if redo is possible
   */
  canRedo(): boolean {
    return this.currentIndex < this.history.length - 1;
  }

  /**
   * Clears all history
   */
  clear(): void {
    this.history = [];
    this.currentIndex = -1;
  }

  /**
   * Gets history length
   */
  getLength(): number {
    return this.history.length;
  }
}

