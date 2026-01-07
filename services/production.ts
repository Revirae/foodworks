/**
 * Production service functions for executing and rolling back production orders
 */

import { createRepositories } from "../persistence/repositories.ts";
import { emitStockChanged } from "../events/bus.ts";
import type { Node, ProductionOrder } from "../domain/types.ts";

export interface RollbackResult {
  success: boolean;
  results?: Array<{ nodeId: string; newStock: number }>;
  error?: string;
}

/**
 * Rolls back a production order by decomposing the product into ingredients.
 * 
 * Rollback model: reverse every stock delta from the order.
 * - Final product must exist so we can consume it (guarded up front).
 * - Ingredients are restored.
 * - Intermediates are rolled back when possible, but if they've been
 *   consumed elsewhere we clamp to the available stock to avoid failing
 *   the rollback.
 * 
 * @param kv - Deno KV instance
 * @param inventoryId - Active inventory ID
 * @param orderId - Production order ID to rollback
 * @param options - Optional configuration
 * @returns Rollback result with success status and updated stock levels
 */
export async function rollbackProductionOrder(
  kv: Deno.Kv,
  inventoryId: string,
  orderId: string,
  options: {
    emitEvents?: boolean;
    getNodeName?: (nodeId: string) => string;
  } = {},
): Promise<RollbackResult> {
  const repos = createRepositories(kv);
  const { emitEvents = true, getNodeName } = options;

  // Get the order
  const order = await repos.productionOrder.get(inventoryId, orderId);
  if (!order) {
    return {
      success: false,
      error: "Order not found",
    };
  }

  // Load all nodes to map IDs to names for error messages and identify node types
  let nodeMap: Map<string, Node> | null = null;
  let nodeNameFn: (nodeId: string) => string;
  let allIngredients: import("../domain/types.ts").Ingredient[];
  
  if (getNodeName) {
    nodeNameFn = getNodeName;
    // Still need to load ingredients to identify them
    allIngredients = await repos.ingredients.getAll();
  } else {
    allIngredients = await repos.ingredients.getAll();
    const allRecipes = await repos.recipes.getAll();
    const allProducts = await repos.products.getAll();
    const allNodes: Node[] = [...allIngredients, ...allRecipes, ...allProducts];
    nodeMap = new Map<string, Node>();
    for (const node of allNodes) {
      nodeMap.set(node.id, node);
    }
    nodeNameFn = (nodeId: string): string => {
      return nodeMap!.get(nodeId)?.name || nodeId;
    };
  }

  // Identify ingredients for filtering rollback updates
  const ingredientIds = new Set(allIngredients.map(i => i.id));
  
  // Identify the role of each node for rollback handling
  const classifyNode = (nodeId: string): "ingredient" | "final" | "intermediate" => {
    if (ingredientIds.has(nodeId)) return "ingredient";
    if (nodeId === order.targetNodeId) return "final";
    return "intermediate";
  };

  // Find the final product delta (needs to be consumed)
  const finalProductDelta = order.stockDeltas.find(d => d.nodeId === order.targetNodeId);
  if (finalProductDelta && finalProductDelta.delta > 0) {
    // Final product was produced, so rollback needs to consume it
    const currentStock = await repos.inventoryStock.get(inventoryId, order.targetNodeId);
    const availableStock = currentStock?.quantity || 0;
    const requiredStock = finalProductDelta.delta; // Original delta was positive (produced)
    
    if (availableStock < requiredStock) {
      const targetNodeName = nodeNameFn(order.targetNodeId);
      return {
        success: false,
        error: `Insufficient stock to rollback. Need ${requiredStock} ${requiredStock === 1 ? "unit" : "units"} of ${targetNodeName}, but only ${availableStock.toFixed(2)} ${availableStock === 1 ? "unit" : "units"} available.`,
      };
    }
  }
  
  // Build rollback updates for every node touched by the order.
  // Intermediates are included but clamped to available stock if their
  // produced surplus has already been consumed elsewhere.
  const rollbackUpdates = order.stockDeltas.map((delta) => ({
    nodeId: delta.nodeId,
    quantity: -delta.delta, // Reverse the delta
    originalDelta: delta.delta,
    role: classifyNode(delta.nodeId),
  }));

  // Get previous stock values for event emission
  const previousStocks = new Map<string, number>();
  for (const update of rollbackUpdates) {
    const stock = await repos.inventoryStock.get(inventoryId, update.nodeId);
    previousStocks.set(update.nodeId, stock?.quantity || 0);
  }

  // Execute rollback atomically
  // Rollback model:
  // - Final product: consume it (validated above)
  // - Ingredients: restore them (clamp to 0 minimum for safety)
  // - Intermediates: rollback the recorded delta, but clamp consumption to
  //   what remains so prior usage elsewhere does not block the rollback
  const atomic = kv.atomic();
  const results: Array<{ nodeId: string; newStock: number }> = [];

  for (const update of rollbackUpdates) {
    const currentStock = await repos.inventoryStock.get(inventoryId, update.nodeId);
    const currentQuantity = currentStock?.quantity || 0;

    const appliedQuantity = update.quantity;

    // Skip noop updates
    if (appliedQuantity === 0) {
      continue;
    }

    // For ingredients and final products, clamp to 0 (they cannot go negative).
    // For intermediates, allow temporary negatives so that out-of-order rollbacks
    // still net back to the original stock once all related orders are reversed.
    const unclampedQuantity = currentQuantity + appliedQuantity;
    const finalQuantity = update.role === "intermediate"
      ? unclampedQuantity
      : Math.max(0, unclampedQuantity);
    
    const stock = {
      inventoryId,
      nodeId: update.nodeId,
      quantity: finalQuantity,
      lastUpdated: new Date(),
    };
    atomic.set(["inventory_stock", inventoryId, update.nodeId], stock);
    results.push({ nodeId: update.nodeId, newStock: finalQuantity });
  }

  const commitResult = await atomic.commit();
  if (!commitResult.ok) {
    return {
      success: false,
      error: "Failed to commit rollback transaction",
    };
  }

  // Emit stock change events for all affected nodes
  if (emitEvents) {
    for (const result of results) {
      const previous = previousStocks.get(result.nodeId) || 0;
      await emitStockChanged(result.nodeId, result.newStock, previous);
    }
  }

  // Delete the order
  await repos.productionOrder.delete(inventoryId, orderId);

  return {
    success: true,
    results,
  };
}
