/**
 * Stock management and transaction logic
 */

import type {
  NodeId,
  Stock,
  StockTransaction,
  ProductionSimulation,
  Graph,
  Node,
  Portion,
} from "./types.ts";
import { getUpstreamNodes } from "./dag.ts";
import { calculateNodeCost, calculateNodeTime } from "./calculations.ts";

/**
 * Validates that a stock transaction won't result in negative stock
 */
export function validateStockTransaction(
  currentStock: number,
  transactionQuantity: number,
): { valid: boolean; error?: string } {
  const newStock = currentStock + transactionQuantity;
  if (newStock < 0) {
    return {
      valid: false,
      error: `Insufficient stock. Current: ${currentStock}, Required: ${Math.abs(transactionQuantity)}, Shortage: ${Math.abs(newStock)}`,
    };
  }
  return { valid: true };
}

/**
 * Simulates a stock transaction without actually performing it
 */
export function simulateStockTransaction(
  currentStock: number,
  transactionQuantity: number,
): { success: boolean; newStock: number; error?: string } {
  const validation = validateStockTransaction(currentStock, transactionQuantity);
  if (!validation.valid) {
    return {
      success: false,
      newStock: currentStock,
      error: validation.error,
    };
  }

  return {
    success: true,
    newStock: currentStock + transactionQuantity,
  };
}

/**
 * Ensures we can consume the required quantity of a node.
 * For ingredients: consumes from stock (must be available).
 * For recipes/products: consumes from existing stock first, then produces
 * the missing amount (integer-only: produces ceil(shortfall)).
 * Tracks all stock changes including surplus from integer-only production.
 */
function ensureConsumable(
  graph: Graph,
  nodeId: NodeId,
  quantity: number,
  availableStock: Map<NodeId, number>,
  stockChanges: Map<NodeId, number>,
  visited: Set<NodeId> = new Set(),
): { success: boolean; error?: string } {
  const node = graph.nodes.get(nodeId);
  if (!node) {
    return { success: false, error: `Node ${nodeId} not found` };
  }

  // Prevent cycles (should not happen in DAG, but safety check)
  if (visited.has(nodeId)) {
    return { success: false, error: `Circular dependency detected for ${nodeId}` };
  }
  visited.add(nodeId);

  if (node.type === "ingredient") {
    // Ingredients cannot be produced - must be consumed from stock
    const needed = quantity;
    const current = availableStock.get(nodeId) || 0;
    if (current < needed) {
      return { 
        success: false, 
        error: `Insufficient ingredient ${nodeId}. Available: ${current}, Required: ${needed}` 
      };
    }
    // Track consumption
    const previousChange = stockChanges.get(nodeId) || 0;
    stockChanges.set(nodeId, previousChange - needed);
    availableStock.set(nodeId, current - needed);
    return { success: true };
  }

  // Recipe or Product: can be produced
  const inputs = node.type === "recipe"
    ? (node as import("./types.ts").Recipe).inputs
    : (node as import("./types.ts").Product).inputs;

  if (!inputs || !Array.isArray(inputs)) {
    return { success: false, error: `${node.type} ${nodeId} has no inputs` };
  }

  // First, consume from existing stock
  const existingStock = availableStock.get(nodeId) || 0;
  const fromStock = Math.min(existingStock, quantity);
  const shortfall = quantity - fromStock;

  // Consume from stock if available
  if (fromStock > 0) {
    availableStock.set(nodeId, existingStock - fromStock);
    const previousChange = stockChanges.get(nodeId) || 0;
    stockChanges.set(nodeId, previousChange - fromStock);
  }

  // If there's a shortfall, produce it (integer-only: produce ceil(shortfall))
  if (shortfall > 0) {
    // Integer-only production: produce ceil(shortfall) units
    const produceUnits = Math.ceil(shortfall);
    
    // Recursively ensure all inputs are consumable for producing produceUnits
    for (const portion of inputs) {
      const inputNeeded = portion.quantity * produceUnits;
      const result = ensureConsumable(
        graph,
        portion.nodeId,
        inputNeeded,
        availableStock,
        stockChanges,
        new Set(visited), // Fresh visited set for each input path
      );
      if (!result.success) {
        return result;
      }
    }

    // After inputs are consumed, add the produced units to stock
    const currentAfterInputs = availableStock.get(nodeId) || 0;
    availableStock.set(nodeId, currentAfterInputs + produceUnits);
    const previousChange = stockChanges.get(nodeId) || 0;
    stockChanges.set(nodeId, previousChange + produceUnits);

    // Now consume the shortfall (leaving any surplus as leftover stock)
    const stockAfterProduction = availableStock.get(nodeId) || 0;
    if (stockAfterProduction < shortfall) {
      // This should never happen since we just produced produceUnits >= shortfall
      return { 
        success: false, 
        error: `Internal error: produced ${produceUnits} but stock is ${stockAfterProduction} < shortfall ${shortfall}` 
      };
    }
    availableStock.set(nodeId, stockAfterProduction - shortfall);
    const previousChangeAfter = stockChanges.get(nodeId) || 0;
    stockChanges.set(nodeId, previousChangeAfter - shortfall);
  }

  return { success: true };
}

/**
 * Simulates production of a given quantity of a node with recursive crafting support.
 * Intermediates can be produced from ingredients if not available in stock.
 * Root production always adds Q new units (doesn't consume from existing stock of target).
 */
export function simulateProduction(
  graph: Graph,
  nodeId: NodeId,
  quantity: number,
  currentStock: Map<NodeId, number>,
): ProductionSimulation {
  const node = graph.nodes.get(nodeId);
  if (!node) {
    throw new Error(`Node ${nodeId} not found`);
  }

  // Create a mutable copy of stock for planning
  const availableStock = new Map(currentStock);
  const stockChanges = new Map<NodeId, number>();

  // For root production, we need to ensure inputs are consumable
  // but we don't consume from the target's existing stock (always add Q)
  if (node.type === "recipe" || node.type === "product") {
    const inputs = node.type === "recipe"
      ? (node as import("./types.ts").Recipe).inputs
      : (node as import("./types.ts").Product).inputs;

    if (inputs && inputs.length > 0) {
      // Ensure all inputs are consumable for producing quantity
      for (const portion of inputs) {
        const inputNeeded = portion.quantity * quantity;
        const result = ensureConsumable(
          graph,
          portion.nodeId,
          inputNeeded,
          availableStock,
          stockChanges,
          new Set(),
        );
        if (!result.success) {
          // Build required inputs from actual consumption (ingredients only)
          const ingredientRequirements = new Map<NodeId, number>();
          for (const [changedNodeId, delta] of stockChanges.entries()) {
            const changedNode = graph.nodes.get(changedNodeId);
            if (changedNode?.type === "ingredient" && delta < 0) {
              ingredientRequirements.set(
                changedNodeId,
                (ingredientRequirements.get(changedNodeId) || 0) + Math.abs(delta),
              );
            }
          }

          const inputChecks = Array.from(ingredientRequirements.entries()).map(
            ([inputId, requiredQty]) => {
              const available = currentStock.get(inputId) || 0;
              return {
                nodeId: inputId,
                quantity: requiredQty,
                available,
                sufficient: available >= requiredQty,
              };
            },
          );

          return {
            targetNodeId: nodeId,
            quantity,
            requiredInputs: inputChecks,
            totalCost: 0,
            totalTime: 0,
            stockOutcome: [],
            canProduce: false,
          };
        }
      }
    }
  } else if (node.type === "ingredient") {
    // Ingredients cannot be produced
    return {
      targetNodeId: nodeId,
      quantity,
      requiredInputs: [],
      totalCost: 0,
      totalTime: 0,
      stockOutcome: [],
      canProduce: false,
    };
  }

  // After inputs are consumed, add quantity to target node (always add Q)
  const previousTargetChange = stockChanges.get(nodeId) || 0;
  stockChanges.set(nodeId, previousTargetChange + quantity);
  availableStock.set(nodeId, (availableStock.get(nodeId) || 0) + quantity);

  // Build required inputs from actual ingredient consumption
  const ingredientRequirements = new Map<NodeId, number>();
  for (const [changedNodeId, delta] of stockChanges.entries()) {
    const changedNode = graph.nodes.get(changedNodeId);
    if (changedNode?.type === "ingredient" && delta < 0) {
      ingredientRequirements.set(
        changedNodeId,
        (ingredientRequirements.get(changedNodeId) || 0) + Math.abs(delta),
      );
    }
  }

  const inputChecks = Array.from(ingredientRequirements.entries()).map(
    ([inputId, requiredQty]) => {
      const available = currentStock.get(inputId) || 0;
      return {
        nodeId: inputId,
        quantity: requiredQty,
        available,
        sufficient: available >= requiredQty,
      };
    },
  );

  const canProduce = inputChecks.every((check) => check.sufficient);

  // Build stock outcome from changes (includes all nodes that changed, including intermediates with surplus)
  const stockOutcome: Array<{ nodeId: NodeId; before: number; after: number }> = [];
  
  // Collect all nodes that changed
  const allChangedNodes = new Set([
    ...stockChanges.keys(),
    nodeId, // Output always changes
  ]);

  for (const changedNodeId of allChangedNodes) {
    const before = currentStock.get(changedNodeId) || 0;
    const delta = stockChanges.get(changedNodeId) || 0;
    const after = before + delta;
    stockOutcome.push({ nodeId: changedNodeId, before, after });
  }

  // Calculate total cost and time
  const costResult = calculateNodeCost(graph, nodeId);
  const timeResult = calculateNodeTime(graph, nodeId);
  const totalCost = costResult.cost * quantity;
  const totalTime = timeResult.time * quantity;

  return {
    targetNodeId: nodeId,
    quantity,
    requiredInputs: inputChecks,
    totalCost,
    totalTime,
    stockOutcome,
    canProduce,
  };
}

/**
 * Checks if sufficient stock is available for production
 */
export function checkStockAvailability(
  graph: Graph,
  nodeId: NodeId,
  quantity: number,
  currentStock: Map<NodeId, number>,
): { available: boolean; missingInputs: Array<{ nodeId: NodeId; required: number; available: number }> } {
  // Check if node exists in graph
  if (!graph.nodes.has(nodeId)) {
    return {
      available: false,
      missingInputs: [{ nodeId, required: quantity, available: 0 }],
    };
  }

  const simulation = simulateProduction(graph, nodeId, quantity, currentStock);
  const missingInputs = simulation.requiredInputs
    .filter((input) => !input.sufficient)
    .map((input) => ({
      nodeId: input.nodeId,
      required: input.quantity,
      available: input.available,
    }));

  return {
    available: simulation.canProduce,
    missingInputs,
  };
}

/**
 * Detects low stock levels
 */
export function detectLowStock(
  stock: Stock,
  threshold: number = 10,
): boolean {
  return stock.quantity <= threshold;
}

/**
 * Gets production readiness status
 */
export function getProductionReadiness(
  graph: Graph,
  nodeId: NodeId,
  currentStock: Map<NodeId, number>,
  lowStockThreshold: number = 10,
): "ready" | "low_stock" | "insufficient" {
  // Check if node exists in graph
  if (!graph.nodes.has(nodeId)) {
    return "insufficient";
  }

  // Check if the node itself has sufficient stock
  const nodeStock = currentStock.get(nodeId) || 0;
  if (nodeStock > lowStockThreshold) {
    return "ready";
  }

  // Check if we can produce more
  const availability = checkStockAvailability(graph, nodeId, 1, currentStock);
  if (availability.available) {
    return nodeStock <= lowStockThreshold ? "low_stock" : "ready";
  }

  return "insufficient";
}

/**
 * Gets the maximum producible quantity (integer) using binary search.
 * Uses the recursive simulation logic for consistency.
 */
export function getMaxProducibleQuantity(
  graph: Graph,
  nodeId: NodeId,
  currentStock: Map<NodeId, number>,
  maxBound: number = 1_000_000,
): number {
  if (!graph.nodes.has(nodeId)) {
    return 0;
  }

  // Check if we can produce at least 1
  const testSim = simulateProduction(graph, nodeId, 1, currentStock);
  if (!testSim.canProduce) {
    return 0;
  }

  // Binary search for max quantity
  let low = 1;
  let high = Math.min(maxBound, 1_000_000);
  let result = 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const sim = simulateProduction(graph, nodeId, mid, currentStock);
    
    if (sim.canProduce) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return result;
}

/**
 * Creates a stock transaction
 */
export function createStockTransaction(
  nodeId: NodeId,
  quantity: number,
  reason?: string,
): StockTransaction {
  return {
    nodeId,
    quantity,
    timestamp: new Date(),
    reason,
  };
}

