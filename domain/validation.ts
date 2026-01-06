/**
 * Validation rules for entities and operations
 */

import type {
  NodeId,
  Ingredient,
  Recipe,
  Product,
  Portion,
  Node,
  Graph,
} from "./types.ts";
import { getNodeDepth } from "./dag.ts";

/**
 * Validates an ingredient
 */
export function validateIngredient(
  ingredient: Partial<Ingredient>,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!ingredient.name || ingredient.name.trim() === "") {
    errors.push("Ingredient name is required");
  }

  if (ingredient.packageSize === undefined || ingredient.packageSize <= 0) {
    errors.push("Package size must be greater than 0");
  }

  if (ingredient.packagePrice === undefined || ingredient.packagePrice < 0) {
    errors.push("Package price must be non-negative");
  }

  if (ingredient.unit && !["kg", "liter", "unit"].includes(ingredient.unit)) {
    errors.push("Unit must be one of: kg, liter, unit");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validates a recipe
 */
export function validateRecipe(
  recipe: Partial<Recipe>,
  graph?: Graph,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!recipe.name || recipe.name.trim() === "") {
    errors.push("Recipe name is required");
  }

  if (
    recipe.fabricationTime === undefined ||
    recipe.fabricationTime < 0
  ) {
    errors.push("Fabrication time must be non-negative");
  }

  if (recipe.weight === undefined || recipe.weight <= 0) {
    errors.push("Weight must be greater than 0");
  }

  if (recipe.unit && !["kg", "liter", "unit"].includes(recipe.unit)) {
    errors.push("Unit must be one of: kg, liter, unit");
  }

  // Validate inputs (must be ingredients or recipes, not products)
  if (recipe.inputs) {
    if (recipe.inputs.length === 0) {
      errors.push("Recipe must have at least one input");
    }

    if (graph) {
      for (const portion of recipe.inputs) {
        const inputNode = graph.nodes.get(portion.nodeId);
        if (!inputNode) {
          errors.push(`Input node ${portion.nodeId} does not exist`);
        } else if (inputNode.type === "product") {
          errors.push(
            `Recipe inputs cannot be products. ${portion.nodeId} is a product`,
          );
        } else if (inputNode.type !== "ingredient" && inputNode.type !== "recipe") {
          errors.push(
            `Recipe inputs must be ingredients or recipes. ${portion.nodeId} is a ${inputNode.type}`,
          );
        }

        if (portion.quantity <= 0) {
          errors.push(`Portion quantity for ${portion.nodeId} must be greater than 0`);
        }
      }
    } else {
      // Basic validation without graph
      for (const portion of recipe.inputs) {
        if (!portion.nodeId || portion.nodeId.trim() === "") {
          errors.push("Portion nodeId is required");
        }
        if (portion.quantity <= 0) {
          errors.push(`Portion quantity must be greater than 0`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validates a product
 */
export function validateProduct(
  product: Partial<Product>,
  graph?: Graph,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!product.name || product.name.trim() === "") {
    errors.push("Product name is required");
  }

  if (
    product.productionTime === undefined ||
    product.productionTime < 0
  ) {
    errors.push("Production time must be non-negative");
  }

  if (product.unit && !["kg", "liter", "unit"].includes(product.unit)) {
    errors.push("Unit must be one of: kg, liter, unit");
  }

  // Validate inputs (must be recipes or products, not ingredients)
  if (product.inputs) {
    if (product.inputs.length === 0) {
      errors.push("Product must have at least one input");
    }

    if (graph) {
      for (const portion of product.inputs) {
        const inputNode = graph.nodes.get(portion.nodeId);
        if (!inputNode) {
          errors.push(`Input node ${portion.nodeId} does not exist`);
        } else if (inputNode.type === "ingredient") {
          errors.push(
            `Product inputs cannot be ingredients. ${portion.nodeId} is an ingredient`,
          );
        }

        if (portion.quantity <= 0) {
          errors.push(`Portion quantity for ${portion.nodeId} must be greater than 0`);
        }
      }
    } else {
      // Basic validation without graph
      for (const portion of product.inputs) {
        if (!portion.nodeId || portion.nodeId.trim() === "") {
          errors.push("Portion nodeId is required");
        }
        if (portion.quantity <= 0) {
          errors.push(`Portion quantity must be greater than 0`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validates a portion
 */
export function validatePortion(
  portion: Partial<Portion>,
  graph?: Graph,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!portion.nodeId || portion.nodeId.trim() === "") {
    errors.push("Portion nodeId is required");
  }

  if (portion.quantity === undefined || portion.quantity <= 0) {
    errors.push("Portion quantity must be greater than 0");
  }

  if (graph) {
    if (!graph.nodes.has(portion.nodeId!)) {
      errors.push(`Node ${portion.nodeId} does not exist in graph`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validates that a recipe's inputs only contain ingredients or recipes (not products)
 */
export function validateRecipeInputs(
  inputs: Portion[],
  graph: Graph,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  for (const portion of inputs) {
    const node = graph.nodes.get(portion.nodeId);
    if (!node) {
      errors.push(`Input node ${portion.nodeId} does not exist`);
    } else if (node.type === "product") {
      errors.push(
        `Recipe inputs cannot be products. ${portion.nodeId} is a product`,
      );
    } else if (node.type !== "ingredient" && node.type !== "recipe") {
      errors.push(
        `Recipe inputs must be ingredients or recipes. ${portion.nodeId} is a ${node.type}`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validates that a product's inputs only contain recipes or products (not ingredients)
 */
export function validateProductInputs(
  inputs: Portion[],
  graph: Graph,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  for (const portion of inputs) {
    const node = graph.nodes.get(portion.nodeId);
    if (!node) {
      errors.push(`Input node ${portion.nodeId} does not exist`);
    } else if (node.type === "ingredient") {
      errors.push(
        `Product inputs cannot be ingredients. ${portion.nodeId} is an ingredient`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validates a node based on its type
 */
export function validateNode(
  node: Partial<Node>,
  graph?: Graph,
): { valid: boolean; errors: string[] } {
  if (!node.type) {
    return { valid: false, errors: ["Node type is required"] };
  }

  switch (node.type) {
    case "ingredient":
      return validateIngredient(node as Partial<Ingredient>);
    case "recipe":
      return validateRecipe(node as Partial<Recipe>, graph);
    case "product":
      return validateProduct(node as Partial<Product>, graph);
    default:
      return {
        valid: false,
        errors: [`Unknown node type: ${(node as any).type}`],
      };
  }
}

