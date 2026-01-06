/**
 * Typed event bus for island communication
 */

import type { Event, EventHandler, EventType } from "./types.ts";

/**
 * Event bus implementation
 */
class EventBus {
  private handlers = new Map<EventType, Set<EventHandler>>();
  private allHandlers = new Set<EventHandler>();

  /**
   * Subscribes to a specific event type
   */
  subscribe(eventType: EventType, handler: EventHandler): () => void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler);

    // Return unsubscribe function
    return () => {
      this.handlers.get(eventType)?.delete(handler);
    };
  }

  /**
   * Subscribes to all events
   */
  subscribeAll(handler: EventHandler): () => void {
    this.allHandlers.add(handler);

    // Return unsubscribe function
    return () => {
      this.allHandlers.delete(handler);
    };
  }

  /**
   * Unsubscribes from a specific event type
   */
  unsubscribe(eventType: EventType, handler: EventHandler): void {
    this.handlers.get(eventType)?.delete(handler);
  }

  /**
   * Unsubscribes from all events
   */
  unsubscribeAll(handler: EventHandler): void {
    this.allHandlers.delete(handler);
  }

  /**
   * Emits an event to all subscribed handlers
   */
  async emit(event: Event): Promise<void> {
    // Call handlers subscribed to this specific event type
    const typeHandlers = this.handlers.get(event.type);
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        try {
          await handler(event);
        } catch (error) {
          console.error(`Error in event handler for ${event.type}:`, error);
        }
      }
    }

    // Call handlers subscribed to all events
    for (const handler of this.allHandlers) {
      try {
        await handler(event);
      } catch (error) {
        console.error(`Error in global event handler:`, error);
      }
    }
  }

  /**
   * Clears all handlers (useful for testing)
   */
  clear(): void {
    this.handlers.clear();
    this.allHandlers.clear();
  }
}

/**
 * Global event bus instance
 */
export const eventBus = new EventBus();

/**
 * Convenience functions for emitting events
 */
export function emitEntityUpdated(
  nodeId: string,
  nodeType: "ingredient" | "recipe" | "product",
  data: { id: string; name: string; [key: string]: unknown },
): Promise<void> {
  return eventBus.emit({
    type: "ENTITY_UPDATED",
    nodeId,
    nodeType,
    data,
  });
}

export function emitGraphChanged(
  nodeId: string,
  changeType: "edge_added" | "edge_removed" | "node_added" | "node_removed",
  edge?: { from: string; to: string; quantity: number },
): Promise<void> {
  return eventBus.emit({
    type: "GRAPH_CHANGED",
    nodeId,
    changeType,
    edge,
  });
}

export function emitStockChanged(
  nodeId: string,
  newStock: number,
  previousStock: number,
): Promise<void> {
  return eventBus.emit({
    type: "STOCK_CHANGED",
    nodeId,
    newStock,
    previousStock,
  });
}

export function emitInventoryChanged(inventoryId: string | null): Promise<void> {
  return eventBus.emit({
    type: "INVENTORY_CHANGED",
    inventoryId,
  });
}

export function emitCalculationInvalidated(nodeId: string): Promise<void> {
  return eventBus.emit({
    type: "CALCULATION_INVALIDATED",
    nodeId,
  });
}

