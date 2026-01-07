/**
 * Repository pattern for data persistence using Deno KV
 */

import type {
  NodeId,
  Ingredient,
  Recipe,
  Product,
  Node,
  GraphEdge,
  Stock,
  Inventory,
  InventoryStock,
  ProductionOrder,
} from "../domain/types.ts";
import {
  ingredientKey,
  recipeKey,
  productKey,
  graphEdgesKey,
  inventoryKey,
  inventoryStockKey,
  activeInventoryKey,
  productionOrderKey,
} from "./schema.ts";
import { addEdge as dagAddEdge, removeEdge as dagRemoveEdge } from "../domain/dag.ts";
import { debug } from "../utils/log.ts";

/**
 * Base repository interface
 */
interface BaseRepository<T> {
  get(id: NodeId): Promise<T | null>;
  getAll(): Promise<T[]>;
  save(entity: T): Promise<void>;
  delete(id: NodeId): Promise<void>;
  exists(id: NodeId): Promise<boolean>;
}

/**
 * Ingredient Repository
 */
export class IngredientRepository implements BaseRepository<Ingredient> {
  constructor(private kv: Deno.Kv) {}

  async get(id: NodeId): Promise<Ingredient | null> {
    const result = await this.kv.get<Ingredient>(["ingredient", id]);
    return result.value;
  }

  async getAll(): Promise<Ingredient[]> {
    const ingredients: Ingredient[] = [];
    // List all keys with prefix ["ingredient"]
    debug("Repository", "getAll() - listing with prefix: [\"ingredient\"]");
    const iter = this.kv.list<Ingredient>({ prefix: ["ingredient"] });
    let count = 0;
    for await (const entry of iter) {
      count++;
      debug("Repository", `getAll() - found entry ${count}: key=`, entry.key, "value exists=", !!entry.value);
      if (entry.value) {
        ingredients.push(entry.value);
      }
    }
    debug("Repository", `getAll() - total entries found: ${count}, ingredients returned: ${ingredients.length}`);
    return ingredients;
  }

  async save(ingredient: Ingredient): Promise<void> {
    // Store key as ["ingredient", id] for proper prefix matching
    await this.kv.set(["ingredient", ingredient.id], ingredient);
  }

  async delete(id: NodeId): Promise<void> {
    await this.kv.delete(["ingredient", id]);
  }

  async exists(id: NodeId): Promise<boolean> {
    const result = await this.kv.get<Ingredient>(["ingredient", id]);
    return result.value !== null;
  }
}

/**
 * Recipe Repository
 */
export class RecipeRepository implements BaseRepository<Recipe> {
  constructor(private kv: Deno.Kv) {}

  async get(id: NodeId): Promise<Recipe | null> {
    const result = await this.kv.get<Recipe>(["recipe", id]);
    return result.value;
  }

  async getAll(): Promise<Recipe[]> {
    const recipes: Recipe[] = [];
    const iter = this.kv.list<Recipe>({ prefix: ["recipe"] });
    for await (const entry of iter) {
      if (entry.value) {
        recipes.push(entry.value);
      }
    }
    return recipes;
  }

  async save(recipe: Recipe): Promise<void> {
    await this.kv.set(["recipe", recipe.id], recipe);
  }

  async delete(id: NodeId): Promise<void> {
    await this.kv.delete(["recipe", id]);
  }

  async exists(id: NodeId): Promise<boolean> {
    const result = await this.kv.get<Recipe>(["recipe", id]);
    return result.value !== null;
  }
}

/**
 * Product Repository
 */
export class ProductRepository implements BaseRepository<Product> {
  constructor(private kv: Deno.Kv) {}

  async get(id: NodeId): Promise<Product | null> {
    const result = await this.kv.get<Product>(["product", id]);
    return result.value;
  }

  async getAll(): Promise<Product[]> {
    const products: Product[] = [];
    const iter = this.kv.list<Product>({ prefix: ["product"] });
    for await (const entry of iter) {
      if (entry.value) {
        products.push(entry.value);
      }
    }
    return products;
  }

  async save(product: Product): Promise<void> {
    await this.kv.set(["product", product.id], product);
  }

  async delete(id: NodeId): Promise<void> {
    await this.kv.delete(["product", id]);
  }

  async exists(id: NodeId): Promise<boolean> {
    const result = await this.kv.get<Product>(["product", id]);
    return result.value !== null;
  }
}

/**
 * Graph Repository for managing edges
 */
export class GraphRepository {
  constructor(private kv: Deno.Kv) {}

  async getEdges(nodeId: NodeId): Promise<GraphEdge[]> {
    const result = await this.kv.get<GraphEdge[]>([graphEdgesKey(nodeId)]);
    return result.value || [];
  }

  async getAllEdges(): Promise<GraphEdge[]> {
    const edges: GraphEdge[] = [];
    const iter = this.kv.list<GraphEdge[]>({ prefix: [graphEdgesKey("")] });
    for await (const { value } of iter) {
      edges.push(...value);
    }
    return edges;
  }

  async saveEdges(nodeId: NodeId, edges: GraphEdge[]): Promise<void> {
    await this.kv.set([graphEdgesKey(nodeId)], edges);
  }

  async addEdge(edge: GraphEdge): Promise<{ success: boolean; error?: string }> {
    // Get existing edges for the target node
    const existingEdges = await this.getEdges(edge.to);

    // Check if edge already exists
    const edgeExists = existingEdges.some(
      (e) => e.from === edge.from && e.to === edge.to,
    );
    if (edgeExists) {
      return { success: false, error: "Edge already exists" };
    }

    // Add the new edge
    const newEdges = [...existingEdges, edge];
    await this.saveEdges(edge.to, newEdges);

    // Also store reverse edge for efficient lookup
    const reverseEdges = await this.getEdges(edge.from);
    const newReverseEdges = [...reverseEdges, edge];
    await this.saveEdges(edge.from, newReverseEdges);

    return { success: true };
  }

  async removeEdge(from: NodeId, to: NodeId): Promise<{ success: boolean; error?: string }> {
    // Remove from target node's edges
    const edges = await this.getEdges(to);
    const filteredEdges = edges.filter((e) => !(e.from === from && e.to === to));
    if (filteredEdges.length === edges.length) {
      return { success: false, error: "Edge does not exist" };
    }
    await this.saveEdges(to, filteredEdges);

    // Remove from source node's reverse edges
    const reverseEdges = await this.getEdges(from);
    const filteredReverseEdges = reverseEdges.filter(
      (e) => !(e.from === from && e.to === to),
    );
    await this.saveEdges(from, filteredReverseEdges);

    return { success: true };
  }

  async deleteNodeEdges(nodeId: NodeId): Promise<void> {
    // Delete incoming edges
    await this.kv.delete([graphEdgesKey(nodeId)]);

    // Delete outgoing edges (need to find all nodes that have this as a source)
    // This is a bit inefficient but necessary for cleanup
    const allEdges = await this.getAllEdges();
    const nodesToUpdate = new Set<NodeId>();
    for (const edge of allEdges) {
      if (edge.from === nodeId) {
        nodesToUpdate.add(edge.to);
      }
    }

    // Remove edges from target nodes
    for (const targetNodeId of nodesToUpdate) {
      const edges = await this.getEdges(targetNodeId);
      const filteredEdges = edges.filter((e) => e.from !== nodeId);
      await this.saveEdges(targetNodeId, filteredEdges);
    }
  }
}

/**
 * Stock Repository
 */
export class StockRepository implements BaseRepository<Stock> {
  constructor(private kv: Deno.Kv) {}

  async get(nodeId: NodeId): Promise<Stock | null> {
    const result = await this.kv.get<Stock>(["stock", nodeId]);
    return result.value;
  }

  async getAll(): Promise<Stock[]> {
    const stocks: Stock[] = [];
    const iter = this.kv.list<Stock>({ prefix: ["stock"] });
    for await (const { value } of iter) {
      stocks.push(value);
    }
    return stocks;
  }

  async save(stock: Stock): Promise<void> {
    await this.kv.set(["stock", stock.nodeId], stock);
  }

  async delete(nodeId: NodeId): Promise<void> {
    await this.kv.delete(["stock", nodeId]);
  }

  async exists(nodeId: NodeId): Promise<boolean> {
    const result = await this.kv.get<Stock>(["stock", nodeId]);
    return result.value !== null;
  }

  /**
   * Updates stock atomically
   */
  async updateStock(
    nodeId: NodeId,
    quantity: number,
  ): Promise<{ success: boolean; newStock: number; error?: string }> {
    const currentStock = await this.get(nodeId);
    const currentQuantity = currentStock?.quantity || 0;
    const newQuantity = currentQuantity + quantity;

    if (newQuantity < 0) {
      return {
        success: false,
        newStock: currentQuantity,
        error: `Insufficient stock. Current: ${currentQuantity}, Required: ${Math.abs(quantity)}`,
      };
    }

    const stock: Stock = {
      nodeId,
      quantity: newQuantity,
      lastUpdated: new Date(),
    };

    await this.save(stock);
    return { success: true, newStock: newQuantity };
  }

  /**
   * Performs multiple stock updates atomically
   */
  async updateStockBatch(
    updates: Array<{ nodeId: NodeId; quantity: number }>,
  ): Promise<{ success: boolean; results: Array<{ nodeId: NodeId; newStock: number }>; error?: string }> {
    // Get current stock for all nodes
    const currentStocks = new Map<NodeId, number>();
    for (const update of updates) {
      const stock = await this.get(update.nodeId);
      currentStocks.set(update.nodeId, stock?.quantity || 0);
    }

    // Validate all updates
    for (const update of updates) {
      const current = currentStocks.get(update.nodeId) || 0;
      const newQuantity = current + update.quantity;
      if (newQuantity < 0) {
        return {
          success: false,
          results: [],
          error: `Insufficient stock for node ${update.nodeId}. Current: ${current}, Required: ${Math.abs(update.quantity)}`,
        };
      }
    }

    // Perform all updates in a transaction
    const atomic = this.kv.atomic();
    const results: Array<{ nodeId: NodeId; newStock: number }> = [];

    for (const update of updates) {
      const current = currentStocks.get(update.nodeId) || 0;
      const newQuantity = current + update.quantity;
      const stock: Stock = {
        nodeId: update.nodeId,
        quantity: newQuantity,
        lastUpdated: new Date(),
      };
      atomic.set(["stock", update.nodeId], stock);
      results.push({ nodeId: update.nodeId, newStock: newQuantity });
    }

    const commitResult = await atomic.commit();
    if (!commitResult.ok) {
      return {
        success: false,
        results: [],
        error: "Failed to commit stock transaction",
      };
    }

    return { success: true, results };
  }
}

/**
 * Inventory Repository
 */
export class InventoryRepository {
  constructor(private kv: Deno.Kv) {}

  async get(id: string): Promise<Inventory | null> {
    const result = await this.kv.get<Inventory>(["inventory", id]);
    return result.value;
  }

  async getAll(): Promise<Inventory[]> {
    const inventories: Inventory[] = [];
    const iter = this.kv.list<Inventory>({ prefix: ["inventory"] });
    for await (const { value } of iter) {
      if (value) {
        inventories.push(value);
      }
    }
    return inventories;
  }

  async save(inventory: Inventory): Promise<void> {
    await this.kv.set(["inventory", inventory.id], inventory);
  }

  async delete(id: string): Promise<void> {
    await this.kv.delete(["inventory", id]);
  }

  async exists(id: string): Promise<boolean> {
    const result = await this.kv.get<Inventory>(["inventory", id]);
    return result.value !== null;
  }

  async getDefault(): Promise<Inventory | null> {
    const inventories = await this.getAll();
    return inventories.find(inv => inv.isDefault) || null;
  }

  async setActive(id: string): Promise<void> {
    await this.kv.set([activeInventoryKey()], id);
  }

  async getActive(): Promise<string | null> {
    const result = await this.kv.get<string>([activeInventoryKey()]);
    return result.value || null;
  }
}

/**
 * Inventory Stock Repository
 */
export class InventoryStockRepository {
  constructor(private kv: Deno.Kv) {}

  async get(inventoryId: string, nodeId: NodeId): Promise<InventoryStock | null> {
    const result = await this.kv.get<InventoryStock>(["inventory_stock", inventoryId, nodeId]);
    return result.value;
  }

  async getAll(inventoryId: string): Promise<InventoryStock[]> {
    const stocks: InventoryStock[] = [];
    const iter = this.kv.list<InventoryStock>({ prefix: ["inventory_stock", inventoryId] });
    for await (const { value } of iter) {
      if (value) {
        stocks.push(value);
      }
    }
    return stocks;
  }

  async save(stock: InventoryStock): Promise<void> {
    await this.kv.set(["inventory_stock", stock.inventoryId, stock.nodeId], stock);
  }

  async delete(inventoryId: string, nodeId: NodeId): Promise<void> {
    await this.kv.delete(["inventory_stock", inventoryId, nodeId]);
  }

  async getAllForActiveInventory(): Promise<InventoryStock[]> {
    const inventoryRepo = new InventoryRepository(this.kv);
    const activeId = await inventoryRepo.getActive();
    if (!activeId) {
      return [];
    }
    return this.getAll(activeId);
  }

  async updateStock(
    inventoryId: string,
    nodeId: NodeId,
    quantity: number,
  ): Promise<{ success: boolean; newStock: number; error?: string }> {
    const currentStock = await this.get(inventoryId, nodeId);
    const currentQuantity = currentStock?.quantity || 0;
    const newQuantity = currentQuantity + quantity;

    if (newQuantity < 0) {
      return {
        success: false,
        newStock: currentQuantity,
        error: `Insufficient stock. Current: ${currentQuantity}, Required: ${Math.abs(quantity)}`,
      };
    }

    const stock: InventoryStock = {
      inventoryId,
      nodeId,
      quantity: newQuantity,
      lastUpdated: new Date(),
    };

    await this.save(stock);
    return { success: true, newStock: newQuantity };
  }

  async copyInventory(fromId: string, toId: string): Promise<void> {
    const sourceStocks = await this.getAll(fromId);
    const atomic = this.kv.atomic();

    for (const sourceStock of sourceStocks) {
      const newStock: InventoryStock = {
        inventoryId: toId,
        nodeId: sourceStock.nodeId,
        quantity: sourceStock.quantity,
        lastUpdated: new Date(),
      };
      atomic.set(["inventory_stock", toId, sourceStock.nodeId], newStock);
    }

    await atomic.commit();
  }

  /**
   * Performs multiple stock updates atomically for an inventory
   */
  async updateStockBatch(
    inventoryId: string,
    updates: Array<{ nodeId: NodeId; quantity: number }>,
  ): Promise<{ success: boolean; results: Array<{ nodeId: NodeId; newStock: number }>; error?: string }> {
    // Get current stock for all nodes
    const currentStocks = new Map<NodeId, number>();
    for (const update of updates) {
      const stock = await this.get(inventoryId, update.nodeId);
      currentStocks.set(update.nodeId, stock?.quantity || 0);
    }

    // Validate all updates
    for (const update of updates) {
      const current = currentStocks.get(update.nodeId) || 0;
      const newQuantity = current + update.quantity;
      if (newQuantity < 0) {
        return {
          success: false,
          results: [],
          error: `Insufficient stock for node ${update.nodeId}. Current: ${current}, Required: ${Math.abs(update.quantity)}`,
        };
      }
    }

    // Perform all updates in a transaction
    const atomic = this.kv.atomic();
    const results: Array<{ nodeId: NodeId; newStock: number }> = [];

    for (const update of updates) {
      const current = currentStocks.get(update.nodeId) || 0;
      const newQuantity = current + update.quantity;
      const stock: InventoryStock = {
        inventoryId,
        nodeId: update.nodeId,
        quantity: newQuantity,
        lastUpdated: new Date(),
      };
      atomic.set(["inventory_stock", inventoryId, update.nodeId], stock);
      results.push({ nodeId: update.nodeId, newStock: newQuantity });
    }

    const commitResult = await atomic.commit();
    if (!commitResult.ok) {
      return {
        success: false,
        results: [],
        error: "Failed to commit stock transaction",
      };
    }

    return { success: true, results };
  }
}

/**
 * Production Order Repository
 */
export class ProductionOrderRepository {
  constructor(private kv: Deno.Kv) {}

  async get(inventoryId: string, orderId: string): Promise<ProductionOrder | null> {
    const result = await this.kv.get<ProductionOrder>(["production_order", inventoryId, orderId]);
    return result.value;
  }

  async getAll(inventoryId: string): Promise<ProductionOrder[]> {
    const orders: ProductionOrder[] = [];
    const iter = this.kv.list<ProductionOrder>({ prefix: ["production_order", inventoryId] });
    for await (const { value } of iter) {
      if (value) {
        orders.push(value);
      }
    }
    // Sort by createdAt descending (most recent first)
    return orders.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async save(order: ProductionOrder): Promise<void> {
    await this.kv.set(["production_order", order.inventoryId, order.id], order);
  }

  async delete(inventoryId: string, orderId: string): Promise<void> {
    await this.kv.delete(["production_order", inventoryId, orderId]);
  }

  async exists(inventoryId: string, orderId: string): Promise<boolean> {
    const result = await this.kv.get<ProductionOrder>(["production_order", inventoryId, orderId]);
    return result.value !== null;
  }
}

/**
 * Factory function to create all repositories
 */
export function createRepositories(kv: Deno.Kv) {
  return {
    ingredients: new IngredientRepository(kv),
    recipes: new RecipeRepository(kv),
    products: new ProductRepository(kv),
    graph: new GraphRepository(kv),
    stock: new StockRepository(kv),
    inventory: new InventoryRepository(kv),
    inventoryStock: new InventoryStockRepository(kv),
    productionOrder: new ProductionOrderRepository(kv),
  };
}

