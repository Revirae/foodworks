/**
 * Validation script for recursive production system
 * Run with: deno run --allow-read domain/stock.test.ts
 */

import {
  simulateProduction,
  getMaxProducibleQuantity,
} from "./stock.ts";
import { createEmptyGraph, addNode } from "./dag.ts";
import type { Graph, Ingredient, Recipe, Product } from "./types.ts";

/**
 * Test case: p2 needs p1, p1 needs r, r needs ingredient a
 * Tests recursive production with intermediate stock usage
 */
function testRecursiveProduction() {
  console.log("=== Test 1: Recursive Production ===");

  const graph = createEmptyGraph();

  // Create ingredient a
  const ingredientA: Ingredient = {
    id: "a",
    name: "Ingredient A",
    type: "ingredient",
    currentStock: 0,
    packageSize: 1,
    packagePrice: 10,
    unit: "unit",
    unitCost: 10,
  };
  addNode(graph, ingredientA);

  // Create recipe r that needs 2 units of a
  const recipeR: Recipe = {
    id: "r",
    name: "Recipe R",
    type: "recipe",
    currentStock: 0,
    description: "Recipe R",
    fabricationTime: 10,
    weight: 1,
    unit: "unit",
    inputs: [{ nodeId: "a", quantity: 2 }],
    totalCost: 20,
    costPerUnit: 20,
  };
  addNode(graph, recipeR);

  // Create product p1 that needs 1.5 units of r
  const productP1: Product = {
    id: "p1",
    name: "Product P1",
    type: "product",
    currentStock: 0,
    productionTime: 5,
    inputs: [{ nodeId: "r", quantity: 1.5 }],
    totalCost: 30,
    totalProductionTime: 15,
    weight: 1,
    unit: "unit",
  };
  addNode(graph, productP1);

  // Create product p2 that needs 2 units of p1
  const productP2: Product = {
    id: "p2",
    name: "Product P2",
    type: "product",
    currentStock: 0,
    productionTime: 3,
    inputs: [{ nodeId: "p1", quantity: 2 }],
    totalCost: 60,
    totalProductionTime: 21,
    weight: 1,
    unit: "unit",
  };
  addNode(graph, productP2);

  // Test 1a: No existing stock, need to produce everything
  console.log("\n1a. No existing stock:");
  const stock1 = new Map<string, number>([["a", 10]]); // 10 units of ingredient a
  const sim1 = simulateProduction(graph, "p2", 1, stock1);
  console.log(`  Can produce: ${sim1.canProduce}`);
  console.log(`  Required inputs:`, sim1.requiredInputs);
  console.log(`  Stock outcome:`, sim1.stockOutcome);
  // Should need: 2 * 1.5 * 2 = 6 units of a for 1 p2
  // But with integer-only: need ceil(1.5) = 2 units of r per p1, so 2 * 2 = 4 units of r for 2 p1
  // Which needs 4 * 2 = 8 units of a
  const expectedA1 = 8; // 2 p1 * ceil(1.5) r per p1 * 2 a per r = 2 * 2 * 2 = 8
  const actualA1 = sim1.requiredInputs.find((i) => i.nodeId === "a")?.quantity || 0;
  console.log(`  Expected ${expectedA1} units of a, got ${actualA1}: ${actualA1 === expectedA1 ? "✓" : "✗"}`);

  // Test 1b: Existing stock of p1 reduces required production
  console.log("\n1b. With existing stock of p1:");
  const stock2 = new Map<string, number>([
    ["a", 10],
    ["p1", 1], // 1 unit of p1 already exists
  ]);
  const sim2 = simulateProduction(graph, "p2", 1, stock2);
  console.log(`  Can produce: ${sim2.canProduce}`);
  console.log(`  Required inputs:`, sim2.requiredInputs);
  console.log(`  Stock outcome:`, sim2.stockOutcome);
  // Should need: 1 more p1 (2 total - 1 existing = 1), which needs ceil(1.5) = 2 units of r
  // Which needs 2 * 2 = 4 units of a
  const expectedA2 = 4; // 1 p1 * ceil(1.5) r per p1 * 2 a per r = 1 * 2 * 2 = 4
  const actualA2 = sim2.requiredInputs.find((i) => i.nodeId === "a")?.quantity || 0;
  console.log(`  Expected ${expectedA2} units of a, got ${actualA2}: ${actualA2 === expectedA2 ? "✓" : "✗"}`);

  // Test 1c: Integer-only production creates surplus
  console.log("\n1c. Integer-only surplus:");
  const stock3 = new Map<string, number>([["a", 20]]);
  const sim3 = simulateProduction(graph, "p1", 1, stock3);
  console.log(`  Can produce: ${sim3.canProduce}`);
  console.log(`  Stock outcome:`, sim3.stockOutcome);
  // Need 1.5 units of r, but produce ceil(1.5) = 2 units
  // After consuming 1.5, should have 0.5 left in r
  const rOutcome = sim3.stockOutcome.find((o) => o.nodeId === "r");
  if (rOutcome) {
    const rSurplus = rOutcome.after - rOutcome.before;
    console.log(`  R surplus: ${rSurplus} (expected 0.5): ${Math.abs(rSurplus - 0.5) < 0.001 ? "✓" : "✗"}`);
  }
}

/**
 * Test case: Max production respects ingredient constraints
 */
function testMaxProduction() {
  console.log("\n=== Test 2: Max Production ===");

  const graph = createEmptyGraph();

  const ingredientA: Ingredient = {
    id: "a",
    name: "Ingredient A",
    type: "ingredient",
    currentStock: 0,
    packageSize: 1,
    packagePrice: 10,
    unit: "unit",
    unitCost: 10,
  };
  addNode(graph, ingredientA);

  const recipeR: Recipe = {
    id: "r",
    name: "Recipe R",
    type: "recipe",
    currentStock: 0,
    description: "Recipe R",
    fabricationTime: 10,
    weight: 1,
    unit: "unit",
    inputs: [{ nodeId: "a", quantity: 2 }],
    totalCost: 20,
    costPerUnit: 20,
  };
  addNode(graph, recipeR);

  const productP1: Product = {
    id: "p1",
    name: "Product P1",
    type: "product",
    currentStock: 0,
    productionTime: 5,
    inputs: [{ nodeId: "r", quantity: 1 }],
    totalCost: 20,
    totalProductionTime: 15,
    weight: 1,
    unit: "unit",
  };
  addNode(graph, productP1);

  // With 10 units of a, can make 5 units of r, which can make 5 units of p1
  const stock = new Map<string, number>([["a", 10]]);
  const max = getMaxProducibleQuantity(graph, "p1", stock);
  console.log(`  Max producible p1 with 10 units of a: ${max}`);
  console.log(`  Expected 5, got ${max}: ${max === 5 ? "✓" : "✗"}`);

  // With 0 units of a, cannot produce
  const stockEmpty = new Map<string, number>([["a", 0]]);
  const maxEmpty = getMaxProducibleQuantity(graph, "p1", stockEmpty);
  console.log(`  Max producible p1 with 0 units of a: ${maxEmpty}`);
  console.log(`  Expected 0, got ${maxEmpty}: ${maxEmpty === 0 ? "✓" : "✗"}`);
}

/**
 * Test case: Root production always adds Q units
 */
function testRootProduction() {
  console.log("\n=== Test 3: Root Production Always Adds Q ===");

  const graph = createEmptyGraph();

  const ingredientA: Ingredient = {
    id: "a",
    name: "Ingredient A",
    type: "ingredient",
    currentStock: 0,
    packageSize: 1,
    packagePrice: 10,
    unit: "unit",
    unitCost: 10,
  };
  addNode(graph, ingredientA);

  const productP1: Product = {
    id: "p1",
    name: "Product P1",
    type: "product",
    currentStock: 0,
    productionTime: 5,
    inputs: [{ nodeId: "a", quantity: 1 }],
    totalCost: 10,
    totalProductionTime: 5,
    weight: 1,
    unit: "unit",
  };
  addNode(graph, productP1);

  // Start with 5 units of p1 already in stock
  const stock = new Map<string, number>([
    ["a", 10],
    ["p1", 5], // Already have 5 units
  ]);

  // Produce 3 more units
  const sim = simulateProduction(graph, "p1", 3, stock);
  console.log(`  Can produce: ${sim.canProduce}`);
  console.log(`  Stock outcome:`, sim.stockOutcome);

  const p1Outcome = sim.stockOutcome.find((o) => o.nodeId === "p1");
  if (p1Outcome) {
    const finalStock = p1Outcome.after;
    console.log(`  Final p1 stock: ${finalStock} (expected 8 = 5 existing + 3 produced)`);
    console.log(`  ${finalStock === 8 ? "✓" : "✗"}`);
  }
}

// Run all tests
try {
  console.log("Running recursive production validation tests...\n");
  testRecursiveProduction();
  testMaxProduction();
  testRootProduction();
  console.log("\n=== Tests Complete ===");
} catch (error) {
  console.error("Test error:", error);
  throw error;
}
