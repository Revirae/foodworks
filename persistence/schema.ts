/**
 * Deno KV schema definitions and key namespace utilities
 */

export const SCHEMA_VERSION = 1;

/**
 * Key namespace prefixes
 */
export const KEY_PREFIXES = {
  INGREDIENT: "ingredient",
  RECIPE: "recipe",
  PRODUCT: "product",
  GRAPH_EDGES: "graph:edges",
  STOCK: "stock",
  META: "meta",
  INVENTORY: "inventory",
  INVENTORY_STOCK: "inventory_stock",
} as const;

/**
 * Creates an ingredient key
 */
export function ingredientKey(id: string): string {
  return `${KEY_PREFIXES.INGREDIENT}:${id}`;
}

/**
 * Creates a recipe key
 */
export function recipeKey(id: string): string {
  return `${KEY_PREFIXES.RECIPE}:${id}`;
}

/**
 * Creates a product key
 */
export function productKey(id: string): string {
  return `${KEY_PREFIXES.PRODUCT}:${id}`;
}

/**
 * Creates a graph edges key for a node
 */
export function graphEdgesKey(nodeId: string): string {
  return `${KEY_PREFIXES.GRAPH_EDGES}:${nodeId}`;
}

/**
 * Creates a stock key
 */
export function stockKey(nodeId: string): string {
  return `${KEY_PREFIXES.STOCK}:${nodeId}`;
}

/**
 * Creates a metadata key
 */
export function metaKey(key: string): string {
  return `${KEY_PREFIXES.META}:${key}`;
}

/**
 * Creates an inventory key
 */
export function inventoryKey(id: string): string {
  return `${KEY_PREFIXES.INVENTORY}:${id}`;
}

/**
 * Creates an inventory stock key
 */
export function inventoryStockKey(inventoryId: string, nodeId: string): string {
  return `${KEY_PREFIXES.INVENTORY_STOCK}:${inventoryId}:${nodeId}`;
}

/**
 * Creates an active inventory key
 */
export function activeInventoryKey(): string {
  return metaKey("active_inventory_id");
}

/**
 * Schema version key
 */
export const SCHEMA_VERSION_KEY = metaKey("schema_version");

/**
 * Parses a key to extract its type and ID
 */
export function parseKey(
  key: string,
): { type: "ingredient" | "recipe" | "product" | "graph_edges" | "stock" | "meta" | "unknown"; id?: string } {
  if (key.startsWith(`${KEY_PREFIXES.INGREDIENT}:`)) {
    return {
      type: "ingredient",
      id: key.slice(KEY_PREFIXES.INGREDIENT.length + 1),
    };
  }
  if (key.startsWith(`${KEY_PREFIXES.RECIPE}:`)) {
    return {
      type: "recipe",
      id: key.slice(KEY_PREFIXES.RECIPE.length + 1),
    };
  }
  if (key.startsWith(`${KEY_PREFIXES.PRODUCT}:`)) {
    return {
      type: "product",
      id: key.slice(KEY_PREFIXES.PRODUCT.length + 1),
    };
  }
  if (key.startsWith(`${KEY_PREFIXES.GRAPH_EDGES}:`)) {
    return {
      type: "graph_edges",
      id: key.slice(KEY_PREFIXES.GRAPH_EDGES.length + 1),
    };
  }
  if (key.startsWith(`${KEY_PREFIXES.STOCK}:`)) {
    return {
      type: "stock",
      id: key.slice(KEY_PREFIXES.STOCK.length + 1),
    };
  }
  if (key.startsWith(`${KEY_PREFIXES.META}:`)) {
    return {
      type: "meta",
      id: key.slice(KEY_PREFIXES.META.length + 1),
    };
  }
  return { type: "unknown" };
}

/**
 * Gets the Deno KV instance
 * In Fresh, this should be accessed from the request context
 */
export function getKv(): Deno.Kv {
  // This will be overridden by Fresh's KV store
  // For now, throw an error to indicate it needs to be provided
  throw new Error(
    "KV instance must be provided. Use Fresh's Deno.openKv() or pass from context",
  );
}

/**
 * Migration utilities
 */
export async function checkSchemaVersion(kv: Deno.Kv): Promise<number> {
  const result = await kv.get<number>([SCHEMA_VERSION_KEY]);
  return result.value ?? 0;
}

export async function setSchemaVersion(kv: Deno.Kv, version: number): Promise<void> {
  await kv.set([SCHEMA_VERSION_KEY], version);
}

export async function migrateSchema(kv: Deno.Kv): Promise<void> {
  const currentVersion = await checkSchemaVersion(kv);
  if (currentVersion < SCHEMA_VERSION) {
    // Perform migrations here as schema evolves
    // For now, just update the version
    await setSchemaVersion(kv, SCHEMA_VERSION);
  }
}

