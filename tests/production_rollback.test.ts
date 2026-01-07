/**
 * Tests for production rollback functionality
 * 
 * Run with: deno test --allow-read --allow-write --unstable-kv tests/production_rollback.test.ts
 */

import { assertEquals, assertRejects } from "https://deno.land/std@0.216.0/assert/mod.ts";
import {
  createTestKv,
  cleanupTestKv,
  setupTestInventory,
  seedTestNodes,
  setTestStock,
  buildTestGraph,
  getTestStockMap,
} from "./helpers/kv.ts";
import { rollbackProductionOrder } from "../services/production.ts";
import { createRepositories } from "../persistence/repositories.ts";
import {
  simulateProduction,
  getMaxProducibleQuantity,
} from "../domain/stock.ts";
import type { Ingredient, Recipe, Product } from "../domain/types.ts";

/**
 * Creates a simple test graph: ingredient -> recipe -> product
 * Recipe uses fractional inputs to create surplus stock
 */
function createTestGraph(): { ingredient: Ingredient; recipe: Recipe; product: Product } {
  const ingredient: Ingredient = {
    id: "ing_a",
    name: "Ingredient A",
    type: "ingredient",
    currentStock: 0,
    packageSize: 1,
    packagePrice: 10,
    unit: "unit",
    unitCost: 10,
  };

  const recipe: Recipe = {
    id: "recipe_r",
    name: "Recipe R",
    type: "recipe",
    currentStock: 0,
    description: "Recipe R",
    fabricationTime: 10,
    weight: 1,
    unit: "unit",
    inputs: [{ nodeId: "ing_a", quantity: 2 }],
    totalCost: 20,
    costPerUnit: 20,
  };

  const product: Product = {
    id: "product_p1",
    name: "Product P1",
    type: "product",
    currentStock: 0,
    productionTime: 5,
    inputs: [{ nodeId: "recipe_r", quantity: 1.5 }], // Fractional input creates surplus
    totalCost: 30,
    totalProductionTime: 15,
    weight: 1,
    unit: "unit",
  };

  return { ingredient, recipe, product };
}

/**
 * Deterministic RNG for reproducible random cycle tests
 */
function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function randomInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

/**
 * Executes production similar to the execute route
 */
async function executeProduction(
  kv: Deno.Kv,
  inventoryId: string,
  nodeId: string,
  quantity: number,
): Promise<string> {
  const repos = createRepositories(kv);
  const graph = await buildTestGraph(kv);
  
  const currentStock = await getTestStockMap(kv, inventoryId);
  
  // Simulate production
  const simulation = simulateProduction(graph, nodeId, quantity, currentStock);
  
  if (!simulation.canProduce) {
    throw new Error("Production not possible - insufficient stock");
  }
  
  // Prepare batch updates from stock outcome
  const updates = simulation.stockOutcome.map(outcome => ({
    nodeId: outcome.nodeId,
    quantity: outcome.after - outcome.before,
  }));
  
  // Execute production atomically
  const batchResult = await repos.inventoryStock.updateStockBatch(inventoryId, updates);
  
  if (!batchResult.success) {
    throw new Error(batchResult.error || "Failed to execute production");
  }
  
  // Create production order record
  const orderId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  const stockDeltas = simulation.stockOutcome.map(outcome => ({
    nodeId: outcome.nodeId,
    delta: outcome.after - outcome.before,
  }));
  
  await repos.productionOrder.save({
    id: orderId,
    inventoryId,
    targetNodeId: nodeId,
    quantity: quantity,
    totalCost: simulation.totalCost,
    totalTime: simulation.totalTime,
    stockDeltas,
    createdAt: new Date(),
  });
  
  return orderId;
}

Deno.test("Rollback restores stock correctly", async () => {
  const kv = await createTestKv();
  try {
    // Setup
    const inventoryId = await setupTestInventory(kv);
    const { ingredient, recipe, product } = createTestGraph();
    await seedTestNodes(kv, [ingredient, recipe, product]);
    await setTestStock(kv, inventoryId, [{ nodeId: "ing_a", quantity: 20 }]);
    
    const repos = createRepositories(kv);
    const graph = await buildTestGraph(kv);
    
    // Get initial stock and max producible
    const initialStock = await getTestStockMap(kv, inventoryId);
    const initialMax = getMaxProducibleQuantity(graph, "product_p1", initialStock);
    
    // Execute production
    const orderId = await executeProduction(kv, inventoryId, "product_p1", 1);
    
    // Verify stock changed
    const afterProductionStock = await getTestStockMap(kv, inventoryId);
    const afterProductionMax = getMaxProducibleQuantity(graph, "product_p1", afterProductionStock);
    
    // Stock should have changed
    assertEquals(afterProductionStock.get("product_p1") || 0, 1, "Product should be produced");
    assertEquals(afterProductionStock.get("ing_a") || 0, initialStock.get("ing_a")! - 4, "Ingredient should be consumed");
    
    // Rollback
    const rollbackResult = await rollbackProductionOrder(kv, inventoryId, orderId, {
      emitEvents: false,
    });
    
    assertEquals(rollbackResult.success, true, "Rollback should succeed");
    
    // Verify stock restored
    const afterRollbackStock = await getTestStockMap(kv, inventoryId);
    const afterRollbackMax = getMaxProducibleQuantity(graph, "product_p1", afterRollbackStock);
    
    // Stock should be back to initial state for product and ingredients
    assertEquals(afterRollbackStock.get("product_p1") || 0, initialStock.get("product_p1") || 0, "Product stock should be restored");
    assertEquals(afterRollbackStock.get("ing_a") || 0, initialStock.get("ing_a") || 0, "Ingredient stock should be restored");
    assertEquals(afterRollbackStock.get("recipe_r") || 0, initialStock.get("recipe_r") || 0, "Intermediate stock should be restored");
    
    // Max producible should be restored
    assertEquals(afterRollbackMax, initialMax, "Max producible should be restored to initial value");
    
    // Order should be deleted
    const order = await repos.productionOrder.get(inventoryId, orderId);
    assertEquals(order, null, "Order should be deleted after rollback");
  } finally {
    await cleanupTestKv(kv);
  }
});

Deno.test("Rollback fails when output is already consumed", async () => {
  const kv = await createTestKv();
  try {
    // Setup
    const inventoryId = await setupTestInventory(kv);
    const { ingredient, recipe, product } = createTestGraph();
    await seedTestNodes(kv, [ingredient, recipe, product]);
    await setTestStock(kv, inventoryId, [{ nodeId: "ing_a", quantity: 20 }]);
    
    const graph = await buildTestGraph(kv);
    
    // Execute first production
    const orderId1 = await executeProduction(kv, inventoryId, "product_p1", 1);
    
    // Verify first production succeeded
    const stockAfterFirst = await getTestStockMap(kv, inventoryId);
    assertEquals(stockAfterFirst.get("product_p1") || 0, 1, "First production should create product");
    
    // Execute second production that consumes the first product
    // First, we need to create a product that uses product_p1 as input
    const product2: Product = {
      id: "product_p2",
      name: "Product P2",
      type: "product",
      currentStock: 0,
      productionTime: 3,
      inputs: [{ nodeId: "product_p1", quantity: 1 }],
      totalCost: 30,
      totalProductionTime: 18,
      weight: 1,
      unit: "unit",
    };
    await seedTestNodes(kv, [product2]);
    
    // Rebuild graph to include the new product
    const graphWithP2 = await buildTestGraph(kv);
    
    // Execute second production (consumes the first product)
    // Note: executeProduction rebuilds the graph internally, so this is fine
    const orderId2 = await executeProduction(kv, inventoryId, "product_p2", 1);
    
    // Verify second production consumed the first product
    const stockAfterSecond = await getTestStockMap(kv, inventoryId);
    assertEquals(stockAfterSecond.get("product_p1") || 0, 0, "Second production should consume first product");
    assertEquals(stockAfterSecond.get("product_p2") || 0, 1, "Second production should create second product");
    
    // Try to rollback the first order - should fail because product_p1 was consumed
    const rollbackResult = await rollbackProductionOrder(kv, inventoryId, orderId1, {
      emitEvents: false,
    });
    
    assertEquals(rollbackResult.success, false, "Rollback should fail when output is consumed");
    assertEquals(
      rollbackResult.error?.includes("Insufficient stock to rollback"),
      true,
      "Error should mention insufficient stock"
    );
    
    // Verify stock was NOT changed by failed rollback
    const stockAfterFailedRollback = await getTestStockMap(kv, inventoryId);
    assertEquals(stockAfterFailedRollback.get("product_p1") || 0, 0, "Stock should not change after failed rollback");
    assertEquals(stockAfterFailedRollback.get("product_p2") || 0, 1, "Stock should not change after failed rollback");
    
    // Verify order still exists (rollback didn't delete it)
    const repos = createRepositories(kv);
    const order = await repos.productionOrder.get(inventoryId, orderId1);
    assertEquals(order !== null, true, "Order should still exist after failed rollback");
  } finally {
    await cleanupTestKv(kv);
  }
});

Deno.test("Rollback restores max producible after multiple productions", async () => {
  const kv = await createTestKv();
  try {
    // Setup
    const inventoryId = await setupTestInventory(kv);
    const { ingredient, recipe, product } = createTestGraph();
    await seedTestNodes(kv, [ingredient, recipe, product]);
    await setTestStock(kv, inventoryId, [{ nodeId: "ing_a", quantity: 20 }]);
    
    const repos = createRepositories(kv);
    const graph = await buildTestGraph(kv);
    
    // Get initial max producible
    const initialStock = await getTestStockMap(kv, inventoryId);
    const initialMax = getMaxProducibleQuantity(graph, "product_p1", initialStock);
    
    // Execute first production
    const orderId1 = await executeProduction(kv, inventoryId, "product_p1", 1);
    const stockAfterFirst = await getTestStockMap(kv, inventoryId);
    const maxAfterFirst = getMaxProducibleQuantity(graph, "product_p1", stockAfterFirst);
    
    // Execute second production
    const orderId2 = await executeProduction(kv, inventoryId, "product_p1", 1);
    const stockAfterSecond = await getTestStockMap(kv, inventoryId);
    const maxAfterSecond = getMaxProducibleQuantity(graph, "product_p1", stockAfterSecond);
    
    // Max producible should decrease after each production
    assertEquals(maxAfterFirst < initialMax, true, "Max producible should decrease after first production");
    assertEquals(maxAfterSecond < maxAfterFirst, true, "Max producible should decrease after second production");
    
    // Rollback first order
    const rollbackResult1 = await rollbackProductionOrder(kv, inventoryId, orderId1, {
      emitEvents: false,
    });
    assertEquals(rollbackResult1.success, true, "First rollback should succeed");
    
    // Verify max producible recovers (may match initial due to intermediate handling)
    const stockAfterRollback1 = await getTestStockMap(kv, inventoryId);
    const maxAfterRollback1 = getMaxProducibleQuantity(graph, "product_p1", stockAfterRollback1);
    assertEquals(maxAfterRollback1, initialMax, "Max producible should be restored after first rollback");
    
    // Rollback second order
    const rollbackResult2 = await rollbackProductionOrder(kv, inventoryId, orderId2, {
      emitEvents: false,
    });
    assertEquals(rollbackResult2.success, true, "Second rollback should succeed");
    
    // Verify max producible restored to initial
    const stockAfterRollback2 = await getTestStockMap(kv, inventoryId);
    const maxAfterRollback2 = getMaxProducibleQuantity(graph, "product_p1", stockAfterRollback2);
    assertEquals(maxAfterRollback2, initialMax, "Max producible should be restored to initial after all rollbacks");
    
    // Verify stock restored (ingredients and final product)
    assertEquals(stockAfterRollback2.get("product_p1") || 0, initialStock.get("product_p1") || 0, "Product stock should be restored");
    assertEquals(stockAfterRollback2.get("ing_a") || 0, initialStock.get("ing_a") || 0, "Ingredient stock should be restored");
  } finally {
    await cleanupTestKv(kv);
  }
});

Deno.test("Repeated produce→rollback cycles maintain stock stability", async () => {
  const kv = await createTestKv();
  try {
    // Setup
    const inventoryId = await setupTestInventory(kv);
    const { ingredient, recipe, product } = createTestGraph();
    await seedTestNodes(kv, [ingredient, recipe, product]);
    await setTestStock(kv, inventoryId, [{ nodeId: "ing_a", quantity: 100 }]);
    
    const graph = await buildTestGraph(kv);
    
    // Get initial stock
    const initialStock = await getTestStockMap(kv, inventoryId);
    const initialIngredientStock = initialStock.get("ing_a") || 0;
    const initialProductStock = initialStock.get("product_p1") || 0;
    const initialMax = getMaxProducibleQuantity(graph, "product_p1", initialStock);
    
    // Perform multiple produce→rollback cycles
    const cycles = 5;
    for (let i = 0; i < cycles; i++) {
      // Produce
      const orderId = await executeProduction(kv, inventoryId, "product_p1", 1);
      const stockAfterProduction = await getTestStockMap(kv, inventoryId);
      
      // Verify production changed stock
      assertEquals(stockAfterProduction.get("product_p1") || 0, initialProductStock + 1, `Product should be produced in cycle ${i + 1}`);
      assertEquals(stockAfterProduction.get("ing_a") || 0, initialIngredientStock - 4, `Ingredient should be consumed in cycle ${i + 1}`);
      
      // Rollback
      const rollbackResult = await rollbackProductionOrder(kv, inventoryId, orderId, {
        emitEvents: false,
      });
      assertEquals(rollbackResult.success, true, `Rollback should succeed in cycle ${i + 1}`);
      
      // Verify stock restored
      const stockAfterRollback = await getTestStockMap(kv, inventoryId);
      assertEquals(stockAfterRollback.get("product_p1") || 0, initialProductStock, `Product should be restored after cycle ${i + 1}`);
      assertEquals(stockAfterRollback.get("ing_a") || 0, initialIngredientStock, `Ingredient should be restored after cycle ${i + 1}`);
    }
    
    // Final verification: stock should be exactly as initial
    const finalStock = await getTestStockMap(kv, inventoryId);
    assertEquals(finalStock.get("product_p1") || 0, initialProductStock, "Final product stock should match initial");
    assertEquals(finalStock.get("ing_a") || 0, initialIngredientStock, "Final ingredient stock should match initial");
    
    // Max producible should also be restored
    const finalMax = getMaxProducibleQuantity(graph, "product_p1", finalStock);
    assertEquals(finalMax, initialMax, "Max producible should be stable after cycles");
  } finally {
    await cleanupTestKv(kv);
  }
});

Deno.test("Randomized produce→rollback cycles keep stock and max stable", async () => {
  const kv = await createTestKv();
  try {
    const rng = createRng(42);

    // Setup with comfortable ingredient stock to allow varied quantities
    const inventoryId = await setupTestInventory(kv);
    const { ingredient, recipe, product } = createTestGraph();
    await seedTestNodes(kv, [ingredient, recipe, product]);
    await setTestStock(kv, inventoryId, [{ nodeId: "ing_a", quantity: 200 }]);

    const graph = await buildTestGraph(kv);
    const initialStock = await getTestStockMap(kv, inventoryId);
    const initialMax = getMaxProducibleQuantity(graph, "product_p1", initialStock);

    const orders: string[] = [];
    const cycles = 8;

    // Produce with random quantities between 1 and 4
    for (let i = 0; i < cycles; i++) {
      const qty = randomInt(rng, 1, 4);
      const orderId = await executeProduction(kv, inventoryId, "product_p1", qty);
      orders.push(orderId);
    }

    // Rollback in shuffled order
    for (let i = orders.length - 1; i >= 0; i--) {
      const swapIdx = randomInt(rng, 0, i);
      [orders[i], orders[swapIdx]] = [orders[swapIdx], orders[i]];
    }

    for (const orderId of orders) {
      const rollbackResult = await rollbackProductionOrder(kv, inventoryId, orderId, {
        emitEvents: false,
      });
      assertEquals(rollbackResult.success, true, `Rollback should succeed for order ${orderId}`);
    }

    const finalStock = await getTestStockMap(kv, inventoryId);
    const finalMax = getMaxProducibleQuantity(graph, "product_p1", finalStock);

    assertEquals(finalStock.get("product_p1") || 0, initialStock.get("product_p1") || 0, "Product stock should match initial after rollbacks");
    assertEquals(finalStock.get("ing_a") || 0, initialStock.get("ing_a") || 0, "Ingredient stock should match initial after rollbacks");
    assertEquals(finalStock.get("recipe_r") || 0, initialStock.get("recipe_r") || 0, "Intermediate stock should match initial after rollbacks");
    assertEquals(finalMax, initialMax, "Max producible should return to initial after randomized cycles");
  } finally {
    await cleanupTestKv(kv);
  }
});

Deno.test("Fractional intermediate decomposition in rollback doesn't inflate max producible", async () => {
  const kv = await createTestKv();
  try {
    // Setup - product needs 1.5 units of recipe (fractional input)
    const inventoryId = await setupTestInventory(kv);
    const { ingredient, recipe, product } = createTestGraph();
    await seedTestNodes(kv, [ingredient, recipe, product]);
    await setTestStock(kv, inventoryId, [{ nodeId: "ing_a", quantity: 50 }]);
    
    const graph = await buildTestGraph(kv);
    
    // Get initial max producible
    const initialStock = await getTestStockMap(kv, inventoryId);
    const initialMax = getMaxProducibleQuantity(graph, "product_p1", initialStock);
    
    // Execute production (creates fractional surplus in recipe)
    const orderId = await executeProduction(kv, inventoryId, "product_p1", 1);
    
    // Verify production succeeded
    const stockAfterProduction = await getTestStockMap(kv, inventoryId);
    const maxAfterProduction = getMaxProducibleQuantity(graph, "product_p1", stockAfterProduction);
    assertEquals(maxAfterProduction < initialMax, true, "Max producible should decrease after production");
    
    // Rollback - intermediates are reference-only, fractional decomposition is allowed
    const rollbackResult = await rollbackProductionOrder(kv, inventoryId, orderId, {
      emitEvents: false,
    });
    assertEquals(rollbackResult.success, true, "Rollback should succeed with fractional intermediates");
    
    // Verify stock restored
    const stockAfterRollback = await getTestStockMap(kv, inventoryId);
    const maxAfterRollback = getMaxProducibleQuantity(graph, "product_p1", stockAfterRollback);
    
    // Max producible should be restored (not inflated)
    assertEquals(maxAfterRollback, initialMax, "Max producible should be restored, not inflated");
    
    // Ingredient stock should be fully restored
    assertEquals(stockAfterRollback.get("ing_a") || 0, initialStock.get("ing_a") || 0, "Ingredient should be fully restored");
    
    // Product should be consumed
    assertEquals(stockAfterRollback.get("product_p1") || 0, initialStock.get("product_p1") || 0, "Product should be consumed");
    // Intermediate should also be restored when available
    assertEquals(stockAfterRollback.get("recipe_r") || 0, initialStock.get("recipe_r") || 0, "Intermediate should be restored");
  } finally {
    await cleanupTestKv(kv);
  }
});

Deno.test("Rollback restores intermediate surplus when available", async () => {
  const kv = await createTestKv();
  try {
    // Setup - product needs 1.5 units of recipe, which creates surplus
    const inventoryId = await setupTestInventory(kv);
    const { ingredient, recipe, product } = createTestGraph();
    await seedTestNodes(kv, [ingredient, recipe, product]);
    await setTestStock(kv, inventoryId, [{ nodeId: "ing_a", quantity: 20 }]);
    
    const graph = await buildTestGraph(kv);
    
    // Execute production - this should create surplus recipe stock (produces 2, consumes 1.5)
    const orderId = await executeProduction(kv, inventoryId, "product_p1", 1);
    
    // Verify surplus was created
    const stockAfterProduction = await getTestStockMap(kv, inventoryId);
    const recipeStock = stockAfterProduction.get("recipe_r") || 0;
    assertEquals(recipeStock, 0.5, "Recipe surplus should be 0.5 (produced 2, consumed 1.5)");
    
    // Rollback - intermediates are reference-only, so recipe stock should remain unchanged
    const rollbackResult = await rollbackProductionOrder(kv, inventoryId, orderId, {
      emitEvents: false,
    });
    assertEquals(rollbackResult.success, true, "Rollback should succeed");
    
    // Verify intermediate stock is restored during rollback
    const stockAfterRollback = await getTestStockMap(kv, inventoryId);
    const recipeStockAfter = stockAfterRollback.get("recipe_r") || 0;
    assertEquals(recipeStockAfter, 0, "Recipe stock should be restored to initial");
    
    // Verify ingredient was restored
    assertEquals(stockAfterRollback.get("ing_a") || 0, 20, "Ingredient should be fully restored");
    
    // Verify product was consumed
    assertEquals(stockAfterRollback.get("product_p1") || 0, 0, "Product should be consumed");
  } finally {
    await cleanupTestKv(kv);
  }
});

Deno.test("Rollback succeeds even when intermediate surplus is consumed", async () => {
  const kv = await createTestKv();
  try {
    // Setup - product needs 1.5 units of recipe, which creates surplus
    const inventoryId = await setupTestInventory(kv);
    const { ingredient, recipe, product } = createTestGraph();
    await seedTestNodes(kv, [ingredient, recipe, product]);
    await setTestStock(kv, inventoryId, [{ nodeId: "ing_a", quantity: 20 }]);
    
    // Execute first production - creates surplus recipe stock
    const orderId1 = await executeProduction(kv, inventoryId, "product_p1", 1);
    
    // Verify surplus was created
    const stockAfterFirst = await getTestStockMap(kv, inventoryId);
    const recipeStock = stockAfterFirst.get("recipe_r") || 0;
    assertEquals(recipeStock, 0.5, "Recipe surplus should be 0.5");
    assertEquals(stockAfterFirst.get("product_p1") || 0, 1, "Product should be produced");
    
    // Create a product that consumes the recipe surplus
    const product2: Product = {
      id: "product_p2",
      name: "Product P2",
      type: "product",
      currentStock: 0,
      productionTime: 3,
      inputs: [{ nodeId: "recipe_r", quantity: 0.5 }], // Consumes the surplus
      totalCost: 10,
      totalProductionTime: 13,
      weight: 1,
      unit: "unit",
    };
    await seedTestNodes(kv, [product2]);
    
    // Execute second production - consumes the recipe surplus
    const orderId2 = await executeProduction(kv, inventoryId, "product_p2", 1);
    
    // Verify surplus was consumed
    const stockAfterSecond = await getTestStockMap(kv, inventoryId);
    assertEquals(stockAfterSecond.get("recipe_r") || 0, 0, "Recipe surplus should be consumed");
    assertEquals(stockAfterSecond.get("product_p1") || 0, 1, "Product p1 should still exist");
    
    // Rollback the first order - should succeed because we only need final product stock
    // Intermediates are reference-only, so their stock doesn't matter
    const rollbackResult = await rollbackProductionOrder(kv, inventoryId, orderId1, {
      emitEvents: false,
    });
    
    assertEquals(rollbackResult.success, true, "Rollback should succeed even when intermediate surplus is consumed");
    
    // Verify stock changes: product consumed, ingredients restored, intermediate unchanged
    const stockAfterRollback = await getTestStockMap(kv, inventoryId);
    assertEquals(stockAfterRollback.get("product_p1") || 0, 0, "Product should be consumed");
    assertEquals(stockAfterRollback.get("ing_a") || 0, 20, "Ingredient should be restored");
    assertEquals(stockAfterRollback.get("recipe_r") || 0, -0.5, "Recipe stock can go negative for intermediates during rollback ordering");
    
    // Verify order was deleted
    const repos = createRepositories(kv);
    const order = await repos.productionOrder.get(inventoryId, orderId1);
    assertEquals(order, null, "Order should be deleted after successful rollback");
  } finally {
    await cleanupTestKv(kv);
  }
});
