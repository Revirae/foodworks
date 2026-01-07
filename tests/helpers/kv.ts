/**
 * Test helpers for setting up temporary Deno KV instances and seeding test data
 */

import { createRepositories } from "../../persistence/repositories.ts";
import { ensureInventorySystemInitialized } from "../../persistence/migrations.ts";
import { createEmptyGraph, addNode } from "../../domain/dag.ts";
import type {
  Ingredient,
  Recipe,
  Product,
  Node,
  Graph,
} from "../../domain/types.ts";

/**
 * Creates a temporary KV instance for testing
 * Uses a unique temporary directory for each test run
 */
export async function createTestKv(): Promise<Deno.Kv> {
  // Use an in-memory KV instance for tests to avoid filesystem limitations.
  // This keeps tests fast, isolated, and portable across environments.
  return await Deno.openKv(":memory:");
}

/**
 * Cleans up a test KV instance
 */
export async function cleanupTestKv(kv: Deno.Kv): Promise<void> {
  kv.close();
}

/**
 * Sets up a test inventory system with a default inventory
 */
export async function setupTestInventory(kv: Deno.Kv): Promise<string> {
  const repos = createRepositories(kv);
  await ensureInventorySystemInitialized(kv);
  const activeId = await repos.inventory.getActive();
  if (!activeId) {
    throw new Error("Failed to initialize test inventory");
  }
  return activeId;
}

/**
 * Seeds test nodes (ingredients, recipes, products) into the repository
 */
export async function seedTestNodes(
  kv: Deno.Kv,
  nodes: Node[],
): Promise<void> {
  const repos = createRepositories(kv);
  
  for (const node of nodes) {
    if (node.type === "ingredient") {
      await repos.ingredients.save(node as Ingredient);
    } else if (node.type === "recipe") {
      await repos.recipes.save(node as Recipe);
    } else if (node.type === "product") {
      await repos.products.save(node as Product);
    }
  }
  
  // Also create graph edges from node inputs
  for (const node of nodes) {
    if (node.type === "recipe") {
      const recipe = node as Recipe;
      for (const input of recipe.inputs) {
        await repos.graph.addEdge({
          from: input.nodeId,
          to: recipe.id,
          quantity: input.quantity,
        });
      }
    } else if (node.type === "product") {
      const product = node as Product;
      for (const input of product.inputs) {
        await repos.graph.addEdge({
          from: input.nodeId,
          to: product.id,
          quantity: input.quantity,
        });
      }
    }
  }
}

/**
 * Sets initial stock levels for an inventory
 */
export async function setTestStock(
  kv: Deno.Kv,
  inventoryId: string,
  stocks: Array<{ nodeId: string; quantity: number }>,
): Promise<void> {
  const repos = createRepositories(kv);
  
  for (const stock of stocks) {
    await repos.inventoryStock.save({
      inventoryId,
      nodeId: stock.nodeId,
      quantity: stock.quantity,
      lastUpdated: new Date(),
    });
  }
}

/**
 * Builds a graph from all nodes in the repository
 */
export async function buildTestGraph(kv: Deno.Kv): Promise<Graph> {
  const repos = createRepositories(kv);
  const graph = createEmptyGraph();
  
  const allIngredients = await repos.ingredients.getAll();
  const allRecipes = await repos.recipes.getAll();
  const allProducts = await repos.products.getAll();
  const allNodes: Node[] = [...allIngredients, ...allRecipes, ...allProducts];
  
  for (const node of allNodes) {
    addNode(graph, node);
  }
  
  const allEdges = await repos.graph.getAllEdges();
  for (const edge of allEdges) {
    const incoming = graph.edges.get(edge.to) || [];
    graph.edges.set(edge.to, [...incoming, edge]);
    const outgoing = graph.reverseEdges.get(edge.from) || [];
    graph.reverseEdges.set(edge.from, [...outgoing, edge]);
  }
  
  return graph;
}

/**
 * Gets all stock levels for an inventory as a Map
 */
export async function getTestStockMap(
  kv: Deno.Kv,
  inventoryId: string,
): Promise<Map<string, number>> {
  const repos = createRepositories(kv);
  const stocks = await repos.inventoryStock.getAll(inventoryId);
  const stockMap = new Map<string, number>();
  for (const stock of stocks) {
    stockMap.set(stock.nodeId, stock.quantity);
  }
  return stockMap;
}
