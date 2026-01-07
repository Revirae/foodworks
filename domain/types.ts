/**
 * Core domain types for the food manufacturing DAG system
 */

export type NodeId = string;
export type NodeType = "ingredient" | "recipe" | "product";

/**
 * Represents a portion of another node used as input
 */
export interface Portion {
  nodeId: NodeId;
  quantity: number;
}

/**
 * Base interface for all graph nodes
 */
export interface BaseNode {
  id: NodeId;
  name: string;
  currentStock: number;
}

/**
 * Ingredient - Leaf node (cannot have inputs)
 */
export interface Ingredient extends BaseNode {
  type: "ingredient";
  packageSize: number;
  packagePrice: number;
  /** Unit for packageSize: "kg" | "liter" | "unit" */
  unit: "kg" | "liter" | "unit";
  /** Derived: packagePrice / packageSize */
  unitCost: number;
}

/**
 * Recipe - Composite node (can contain ingredients and other recipes)
 */
export interface Recipe extends BaseNode {
  type: "recipe";
  description?: string;
  fabricationTime: number; // in minutes
  weight: number;
  /** Unit for weight: "kg" | "liter" | "unit" */
  unit: "kg" | "liter" | "unit";
  inputs: Portion[]; // Ingredients and recipes allowed
  /** Derived: sum of input costs */
  totalCost: number;
  /** Derived: totalCost / weight */
  costPerUnit: number;
}

/**
 * Product - Recursive composite node (can contain recipes and other products)
 */
export interface Product extends BaseNode {
  type: "product";
  productionTime: number; // in minutes
  inputs: Portion[]; // Recipes and products allowed
  /** Derived: sum of input costs */
  totalCost: number;
  /** Derived: sum of production times */
  totalProductionTime: number;
  /** Derived: sum of input weights */
  weight: number;
  /** Unit for weight: "kg" | "liter" | "unit" */
  unit: "kg" | "liter" | "unit";
}

/**
 * Union type for all node types
 */
export type Node = Ingredient | Recipe | Product;

/**
 * Stock information for a node
 */
export interface Stock {
  nodeId: NodeId;
  quantity: number;
  lastUpdated: Date;
}

/**
 * Inventory - Container for a named stock snapshot
 */
export interface Inventory {
  id: string;
  name: string;
  createdAt: Date;
  isDefault: boolean;
}

/**
 * InventoryStock - Stock entry within an inventory
 */
export interface InventoryStock {
  inventoryId: string;
  nodeId: NodeId;
  quantity: number;
  lastUpdated: Date;
}

/**
 * Graph edge representing a dependency relationship
 */
export interface GraphEdge {
  from: NodeId;
  to: NodeId;
  quantity: number;
}

/**
 * Graph structure
 */
export interface Graph {
  nodes: Map<NodeId, Node>;
  edges: Map<NodeId, GraphEdge[]>; // Map from 'to' node to its incoming edges
  reverseEdges: Map<NodeId, GraphEdge[]>; // Map from 'from' node to its outgoing edges
}

/**
 * Calculation results
 */
export interface CalculationResult {
  nodeId: NodeId;
  cost: number;
  time: number;
  weight: number;
  cacheKey: string;
  timestamp: number;
}

/**
 * Stock transaction
 */
export interface StockTransaction {
  nodeId: NodeId;
  quantity: number; // Positive for production, negative for consumption
  timestamp: Date;
  reason?: string;
}

/**
 * Production simulation result
 */
export interface ProductionSimulation {
  targetNodeId: NodeId;
  quantity: number;
  requiredInputs: Array<{
    nodeId: NodeId;
    quantity: number;
    available: number;
    sufficient: boolean;
  }>;
  totalCost: number;
  totalTime: number;
  stockOutcome: Array<{
    nodeId: NodeId;
    before: number;
    after: number;
  }>;
  canProduce: boolean;
}

/**
 * Production Order - Record of a production execution
 */
export interface ProductionOrder {
  id: string;
  inventoryId: string;
  targetNodeId: NodeId;
  quantity: number;
  totalCost: number;
  totalTime: number;
  stockDeltas: Array<{
    nodeId: NodeId;
    delta: number; // Positive for production, negative for consumption
  }>;
  createdAt: Date;
}
