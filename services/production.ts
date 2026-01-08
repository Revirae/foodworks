/**
 * Production service functions for executing and rolling back production orders
 */

import { createRepositories } from "../persistence/repositories.ts";
import { emitStockChanged } from "../events/bus.ts";
import { createEmptyGraph, addNode } from "../domain/dag.ts";
import type { Node, ProductionOrder, Graph, NodeId } from "../domain/types.ts";

export interface RollbackResult {
  success: boolean;
  results?: Array<{ nodeId: string; newStock: number }>;
  error?: string;
}

/**
 * Recursively expands a node into its ultimate ingredient requirements.
 * Intermediates (recipes/products) are expanded recursively until we reach ingredients.
 * 
 * @param graph - The production graph
 * @param nodeId - The node to expand
 * @param quantity - The quantity of the node to expand
 * @param ingredientRequirements - Map to accumulate ingredient requirements
 * @param visited - Set to prevent cycles
 */
function expandToIngredients(
  graph: Graph,
  nodeId: NodeId,
  quantity: number,
  ingredientRequirements: Map<NodeId, number>,
  visited: Set<NodeId> = new Set(),
): void {
  const node = graph.nodes.get(nodeId);
  if (!node) {
    return;
  }

  // Prevent cycles
  if (visited.has(nodeId)) {
    return;
  }
  visited.add(nodeId);

  if (node.type === "ingredient") {
    // Base case: accumulate ingredient requirement
    const current = ingredientRequirements.get(nodeId) || 0;
    ingredientRequirements.set(nodeId, current + quantity);
    return;
  }

  // Recipe or Product: expand through inputs
  const inputs = node.type === "recipe"
    ? (node as import("../domain/types.ts").Recipe).inputs
    : (node as import("../domain/types.ts").Product).inputs;

  if (!inputs || inputs.length === 0) {
    return;
  }

  // Recursively expand each input
  for (const portion of inputs) {
    const inputQuantity = portion.quantity * quantity;
    expandToIngredients(
      graph,
      portion.nodeId,
      inputQuantity,
      ingredientRequirements,
      new Set(visited), // Fresh visited set for each input path
    );
  }
}

/**
 * Rolls back a production order by strictly decomposing the product into ingredients.
 * 
 * Rollback model:
 * - Final product: consume it (must exist, validated up front)
 * - Ingredients: restore them by expanding the product through the graph to ultimate ingredients
 * - Intermediates: never restored (read-only during rollback)
 * 
 * This ensures rollback is a strict "unproduce" operation that only affects
 * final products and ingredients, preventing intermediate stock inflation.
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

  // Load all nodes to build graph and identify node types
  const allIngredients = await repos.ingredients.getAll();
  const allRecipes = await repos.recipes.getAll();
  const allProducts = await repos.products.getAll();
  const allNodes: Node[] = [...allIngredients, ...allRecipes, ...allProducts];
  
  // Build graph for expansion
  const graph = createEmptyGraph();
  for (const node of allNodes) {
    addNode(graph, node);
  }
  
  // Load edges
  const allEdges = await repos.graph.getAllEdges();
  for (const edge of allEdges) {
    const incoming = graph.edges.get(edge.to) || [];
    graph.edges.set(edge.to, [...incoming, edge]);
    const outgoing = graph.reverseEdges.get(edge.from) || [];
    graph.reverseEdges.set(edge.from, [...outgoing, edge]);
  }

  // Build node map for names
  const nodeMap = new Map<string, Node>();
  for (const node of allNodes) {
    nodeMap.set(node.id, node);
  }
  const nodeNameFn = getNodeName || ((nodeId: string): string => {
    return nodeMap.get(nodeId)?.name || nodeId;
  });

  // Identify ingredients
  const ingredientIds = new Set(allIngredients.map(i => i.id));

  // Validate final product exists and can be consumed
  const currentFinalStock = await repos.inventoryStock.get(inventoryId, order.targetNodeId);
  const availableFinalStock = currentFinalStock?.quantity || 0;
  
  if (availableFinalStock < order.quantity) {
    const targetNodeName = nodeNameFn(order.targetNodeId);
    return {
      success: false,
      error: `Insufficient stock to rollback. Need ${order.quantity} ${order.quantity === 1 ? "unit" : "units"} of ${targetNodeName}, but only ${availableFinalStock.toFixed(2)} ${availableFinalStock === 1 ? "unit" : "units"} available.`,
    };
  }

  // Expand the final product into ingredient requirements
  const ingredientRequirements = new Map<NodeId, number>();
  expandToIngredients(graph, order.targetNodeId, order.quantity, ingredientRequirements);

  // Get previous stock values for event emission
  const previousStocks = new Map<string, number>();
  const affectedNodeIds = new Set<NodeId>([order.targetNodeId, ...ingredientRequirements.keys()]);
  for (const nodeId of affectedNodeIds) {
    const stock = await repos.inventoryStock.get(inventoryId, nodeId);
    previousStocks.set(nodeId, stock?.quantity || 0);
  }

  // Execute rollback atomically
  // - Final product: consume it
  // - Ingredients: restore them (clamp to 0 minimum)
  // - Intermediates: never touched (read-only)
  const atomic = kv.atomic();
  const results: Array<{ nodeId: string; newStock: number }> = [];

  // Consume final product
  const currentFinalQuantity = previousStocks.get(order.targetNodeId) || 0;
  const finalProductNewQuantity = Math.max(0, currentFinalQuantity - order.quantity);
  atomic.set(
    ["inventory_stock", inventoryId, order.targetNodeId],
    {
      inventoryId,
      nodeId: order.targetNodeId,
      quantity: finalProductNewQuantity,
      lastUpdated: new Date(),
    }
  );
  results.push({ nodeId: order.targetNodeId, newStock: finalProductNewQuantity });

  // Restore ingredients only
  for (const [ingredientId, restoreQuantity] of ingredientRequirements.entries()) {
    const currentIngredientStock = await repos.inventoryStock.get(inventoryId, ingredientId);
    const currentIngredientQuantity = currentIngredientStock?.quantity || 0;
    const ingredientNewQuantity = Math.max(0, currentIngredientQuantity + restoreQuantity);
    
    atomic.set(
      ["inventory_stock", inventoryId, ingredientId],
      {
        inventoryId,
        nodeId: ingredientId,
        quantity: ingredientNewQuantity,
        lastUpdated: new Date(),
      }
    );
    results.push({ nodeId: ingredientId, newStock: ingredientNewQuantity });
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
