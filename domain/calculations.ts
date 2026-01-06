/**
 * Cost, time, and weight calculations for the DAG
 */

import type {
  Node,
  NodeId,
  NodeType,
  Ingredient,
  Recipe,
  Product,
  Graph,
  CalculationResult,
  Portion,
} from "./types.ts";
import { topologicalSort } from "./dag.ts";

/**
 * Calculation cache entry
 */
interface CacheEntry {
  nodeId: NodeId;
  cost: number;
  time: number;
  weight: number;
  timestamp: number;
}

/**
 * In-memory calculation cache
 */
class CalculationCache {
  private cache = new Map<NodeId, CacheEntry>();
  private dependencyMap = new Map<NodeId, Set<NodeId>>(); // What nodes depend on this one

  /**
   * Gets a calculation result from cache
   */
  get(nodeId: NodeId): CacheEntry | null {
    return this.cache.get(nodeId) || null;
  }

  /**
   * Sets a calculation result in cache
   */
  set(nodeId: NodeId, entry: CacheEntry): void {
    this.cache.set(nodeId, entry);
  }

  /**
   * Invalidates a node and all its dependents
   */
  invalidate(nodeId: NodeId, visited: Set<NodeId> = new Set()): void {
    if (visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);

    // Invalidate this node
    this.cache.delete(nodeId);

    // Invalidate all dependents
    const dependents = this.dependencyMap.get(nodeId) || new Set();
    for (const dependent of dependents) {
      this.invalidate(dependent, visited);
    }
  }

  /**
   * Records a dependency relationship
   */
  addDependency(dependent: NodeId, dependency: NodeId): void {
    if (!this.dependencyMap.has(dependency)) {
      this.dependencyMap.set(dependency, new Set());
    }
    this.dependencyMap.get(dependency)!.add(dependent);
  }

  /**
   * Clears all cache entries
   */
  clear(): void {
    this.cache.clear();
    this.dependencyMap.clear();
  }
}

const globalCache = new CalculationCache();

/**
 * Calculates the unit cost of an ingredient
 */
export function calculateIngredientUnitCost(ingredient: Ingredient): number {
  if (ingredient.packageSize === 0) {
    return 0;
  }
  return ingredient.packagePrice / ingredient.packageSize;
}

/**
 * Calculates the cost of a portion
 */
function calculatePortionCost(
  graph: Graph,
  portion: Portion,
  cache: CalculationCache = globalCache,
): number {
  const node = graph.nodes.get(portion.nodeId);
  if (!node) {
    return 0;
  }

  const calcResult = calculateNodeCost(graph, portion.nodeId, cache);
  return calcResult.cost * portion.quantity;
}

/**
 * Calculates the time contribution of a portion
 */
function calculatePortionTime(
  graph: Graph,
  portion: Portion,
  nodeType: NodeType,
  cache: CalculationCache = globalCache,
): number {
  const node = graph.nodes.get(portion.nodeId);
  if (!node) {
    return 0;
  }

  const calcResult = calculateNodeTime(graph, portion.nodeId, cache);

  if (nodeType === "recipe") {
    // For recipes, we use fabricationTime per unit
    const recipe = node as Recipe;
    return calcResult.time + recipe.fabricationTime * portion.quantity;
  } else if (nodeType === "product") {
    // For products, we use productionTime per unit
    const product = node as Product;
    return calcResult.time + product.productionTime * portion.quantity;
  }

  return calcResult.time;
}

/**
 * Calculates the weight contribution of a portion
 */
function calculatePortionWeight(
  graph: Graph,
  portion: Portion,
  cache: CalculationCache = globalCache,
): number {
  const node = graph.nodes.get(portion.nodeId);
  if (!node) {
    return 0;
  }

  const calcResult = calculateNodeWeight(graph, portion.nodeId, cache);
  return calcResult.weight * portion.quantity;
}

/**
 * Calculates the total cost of a node (bottom-up from ingredients)
 */
export function calculateNodeCost(
  graph: Graph,
  nodeId: NodeId,
  cache: CalculationCache = globalCache,
): CalculationResult {
  // Check cache first - if we have a full result, return it
  const cached = cache.get(nodeId);
  if (cached) {
    return {
      nodeId,
      cost: cached.cost,
      time: cached.time,
      weight: cached.weight,
      cacheKey: nodeId,
      timestamp: cached.timestamp,
    };
  }

  // Calculate all values together to avoid circular recursion
  const fullResult = calculateNodeAll(graph, nodeId, cache);
  
  // Cache the result
  cache.set(nodeId, {
    nodeId,
    cost: fullResult.cost,
    time: fullResult.time,
    weight: fullResult.weight,
    timestamp: fullResult.timestamp,
  });

  return fullResult;
}

/**
 * Calculates the total production time of a node
 */
export function calculateNodeTime(
  graph: Graph,
  nodeId: NodeId,
  cache: CalculationCache = globalCache,
): CalculationResult {
  // Check cache first
  const cached = cache.get(nodeId);
  if (cached) {
    return {
      nodeId,
      cost: cached.cost,
      time: cached.time,
      weight: cached.weight,
      cacheKey: nodeId,
      timestamp: cached.timestamp,
    };
  }

  // Calculate all values together to avoid circular recursion
  const fullResult = calculateNodeAll(graph, nodeId, cache);
  
  // Cache the result
  cache.set(nodeId, {
    nodeId,
    cost: fullResult.cost,
    time: fullResult.time,
    weight: fullResult.weight,
    timestamp: fullResult.timestamp,
  });

  return fullResult;
}

/**
 * Calculates the total weight of a node
 */
export function calculateNodeWeight(
  graph: Graph,
  nodeId: NodeId,
  cache: CalculationCache = globalCache,
): CalculationResult {
  // Check cache first
  const cached = cache.get(nodeId);
  if (cached) {
    return {
      nodeId,
      cost: cached.cost,
      time: cached.time,
      weight: cached.weight,
      cacheKey: nodeId,
      timestamp: cached.timestamp,
    };
  }

  // Calculate all values together to avoid circular recursion
  const fullResult = calculateNodeAll(graph, nodeId, cache);
  
  // Cache the result
  cache.set(nodeId, {
    nodeId,
    cost: fullResult.cost,
    time: fullResult.time,
    weight: fullResult.weight,
    timestamp: fullResult.timestamp,
  });

  return fullResult;
}

/**
 * Calculates cost, time, and weight together to avoid circular recursion
 */
function calculateNodeAll(
  graph: Graph,
  nodeId: NodeId,
  cache: CalculationCache = globalCache,
): CalculationResult {
  const node = graph.nodes.get(nodeId);
  if (!node) {
    throw new Error(`Node ${nodeId} not found`);
  }

  let cost = 0;
  let time = 0;
  let weight = 0;

  if (node.type === "ingredient") {
    // Ingredient cost is its unit cost
    const ingredient = node as Ingredient;
    cost = calculateIngredientUnitCost(ingredient);
    time = 0;
    weight = 0;
  } else if (node.type === "recipe") {
    // Recipe: sum of input costs, times, and explicit weight
    const recipe = node as Recipe;
    for (const portion of recipe.inputs) {
      const inputResult = calculateNodeAll(graph, portion.nodeId, cache);
      cost += inputResult.cost * portion.quantity;
      time += inputResult.time * portion.quantity;
      weight += inputResult.weight * portion.quantity;
      cache.addDependency(nodeId, portion.nodeId);
    }
    time += recipe.fabricationTime;
    weight = recipe.weight;
  } else if (node.type === "product") {
    // Product: sum of input costs, times, and weights
    const product = node as Product;
    for (const portion of product.inputs) {
      const inputResult = calculateNodeAll(graph, portion.nodeId, cache);
      cost += inputResult.cost * portion.quantity;
      time += inputResult.time * portion.quantity;
      weight += inputResult.weight * portion.quantity;
      cache.addDependency(nodeId, portion.nodeId);
    }
    time += product.productionTime;
  }

  return {
    nodeId,
    cost,
    time,
    weight,
    cacheKey: nodeId,
    timestamp: Date.now(),
  };
}

/**
 * Recalculates all nodes in topological order
 */
export function recalculateAll(graph: Graph): Map<NodeId, CalculationResult> {
  const results = new Map<NodeId, CalculationResult>();
  const sortedNodes = topologicalSort(graph);

  for (const nodeId of sortedNodes) {
    const costResult = calculateNodeCost(graph, nodeId);
    results.set(nodeId, costResult);
  }

  return results;
}

/**
 * Invalidates calculation cache for a node and its dependents
 */
export function invalidateCalculations(nodeId: NodeId): void {
  globalCache.invalidate(nodeId);
}

/**
 * Clears the calculation cache
 */
export function clearCalculationCache(): void {
  globalCache.clear();
}

