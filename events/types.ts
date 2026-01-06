/**
 * Event type definitions for the event bus
 */

import type { NodeId, NodeType } from "../domain/types.ts";

/**
 * Event type identifiers
 */
export type EventType =
  | "ENTITY_UPDATED"
  | "GRAPH_CHANGED"
  | "STOCK_CHANGED"
  | "INVENTORY_CHANGED"
  | "CALCULATION_INVALIDATED";

/**
 * Entity updated event payload
 */
export interface EntityUpdatedEvent {
  type: "ENTITY_UPDATED";
  nodeId: NodeId;
  nodeType: NodeType;
  data: {
    id: NodeId;
    name: string;
    [key: string]: unknown;
  };
}

/**
 * Graph changed event payload
 */
export interface GraphChangedEvent {
  type: "GRAPH_CHANGED";
  nodeId: NodeId;
  changeType: "edge_added" | "edge_removed" | "node_added" | "node_removed";
  edge?: {
    from: NodeId;
    to: NodeId;
    quantity: number;
  };
}

/**
 * Stock changed event payload
 */
export interface StockChangedEvent {
  type: "STOCK_CHANGED";
  nodeId: NodeId;
  newStock: number;
  previousStock: number;
}

/**
 * Active inventory changed event payload
 */
export interface InventoryChangedEvent {
  type: "INVENTORY_CHANGED";
  inventoryId: string | null;
}

/**
 * Calculation invalidated event payload
 */
export interface CalculationInvalidatedEvent {
  type: "CALCULATION_INVALIDATED";
  nodeId: NodeId;
}

/**
 * Union type for all events
 */
export type Event =
  | EntityUpdatedEvent
  | GraphChangedEvent
  | StockChangedEvent
  | InventoryChangedEvent
  | CalculationInvalidatedEvent;

/**
 * Event handler function type
 */
export type EventHandler = (event: Event) => void | Promise<void>;

