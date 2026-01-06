/**
 * Referential integrity checks for graph edges and node relationships
 */

import type { NodeId, GraphEdge } from "../domain/types.ts";
import {
  IngredientRepository,
  RecipeRepository,
  ProductRepository,
  GraphRepository,
} from "./repositories.ts";

/**
 * Checks if a node exists before creating an edge
 */
export async function validateEdgeNodes(
  from: NodeId,
  to: NodeId,
  repositories: {
    ingredients: IngredientRepository;
    recipes: RecipeRepository;
    products: ProductRepository;
  },
): Promise<{ valid: boolean; error?: string }> {
  // Check if source node exists
  const fromExists =
    await repositories.ingredients.exists(from) ||
    await repositories.recipes.exists(from) ||
    await repositories.products.exists(from);

  if (!fromExists) {
    return { valid: false, error: `Source node ${from} does not exist` };
  }

  // Check if target node exists
  const toExists =
    await repositories.ingredients.exists(to) ||
    await repositories.recipes.exists(to) ||
    await repositories.products.exists(to);

  if (!toExists) {
    return { valid: false, error: `Target node ${to} does not exist` };
  }

  // Check for self-loops
  if (from === to) {
    return { valid: false, error: "Cannot create self-loop" };
  }

  return { valid: true };
}

/**
 * Validates that all edges reference existing nodes
 */
export async function validateGraphEdges(
  edges: GraphEdge[],
  repositories: {
    ingredients: IngredientRepository;
    recipes: RecipeRepository;
    products: ProductRepository;
  },
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  for (const edge of edges) {
    const validation = await validateEdgeNodes(
      edge.from,
      edge.to,
      repositories,
    );
    if (!validation.valid) {
      errors.push(`Edge ${edge.from} -> ${edge.to}: ${validation.error}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Cleans up orphaned edges when a node is deleted
 */
export async function cleanupOrphanedEdges(
  nodeId: NodeId,
  graphRepo: GraphRepository,
): Promise<void> {
  await graphRepo.deleteNodeEdges(nodeId);
}

/**
 * Validates that recipe inputs only reference ingredients or recipes (not products)
 */
export async function validateRecipeInputs(
  inputIds: NodeId[],
  repositories: {
    ingredients: IngredientRepository;
    recipes: RecipeRepository;
    products: ProductRepository;
  },
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  for (const inputId of inputIds) {
    // Check if it's an ingredient or recipe (both are valid)
    const isIngredient = await repositories.ingredients.exists(inputId);
    const isRecipe = await repositories.recipes.exists(inputId);
    const isProduct = await repositories.products.exists(inputId);
    
    if (isProduct) {
      errors.push(
        `Recipe input ${inputId} cannot be a product. Only ingredients and recipes are allowed.`,
      );
    } else if (!isIngredient && !isRecipe) {
      errors.push(`Recipe input ${inputId} does not exist`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validates that product inputs only reference recipes or products (not ingredients)
 */
export async function validateProductInputs(
  inputIds: NodeId[],
  repositories: {
    ingredients: IngredientRepository;
    recipes: RecipeRepository;
    products: ProductRepository;
  },
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  for (const inputId of inputIds) {
    // Check if it's an ingredient (which would be invalid)
    const isIngredient = await repositories.ingredients.exists(inputId);
    if (isIngredient) {
      errors.push(
        `Product input ${inputId} cannot be an ingredient. Only recipes and products are allowed.`,
      );
      continue;
    }

    // Check if it exists as recipe or product
    const isRecipe = await repositories.recipes.exists(inputId);
    const isProduct = await repositories.products.exists(inputId);
    if (!isRecipe && !isProduct) {
      errors.push(`Product input ${inputId} does not exist`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validates referential integrity of the entire graph
 */
export async function validateGraphIntegrity(
  repositories: {
    ingredients: IngredientRepository;
    recipes: RecipeRepository;
    products: ProductRepository;
    graph: GraphRepository;
  },
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];
  const allEdges = await repositories.graph.getAllEdges();

  // Validate all edges reference existing nodes
  const edgeValidation = await validateGraphEdges(allEdges, repositories);
  if (!edgeValidation.valid) {
    errors.push(...edgeValidation.errors);
  }

  // Validate recipe inputs
  const recipes = await repositories.recipes.getAll();
  for (const recipe of recipes) {
    const inputIds = recipe.inputs.map((p) => p.nodeId);
    const recipeValidation = await validateRecipeInputs(inputIds, repositories);
    if (!recipeValidation.valid) {
      errors.push(
        ...recipeValidation.errors.map((e) => `Recipe ${recipe.id}: ${e}`),
      );
    }
  }

  // Validate product inputs
  const products = await repositories.products.getAll();
  for (const product of products) {
    const inputIds = product.inputs.map((p) => p.nodeId);
    const productValidation = await validateProductInputs(inputIds, repositories);
    if (!productValidation.valid) {
      errors.push(
        ...productValidation.errors.map((e) => `Product ${product.id}: ${e}`),
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

