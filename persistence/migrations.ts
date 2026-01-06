/**
 * Database migration utilities
 */

import { createRepositories } from "./repositories.ts";
import type { Inventory } from "../domain/types.ts";

/**
 * Migrates existing stock entries to the "Main" inventory
 * This should be called on app startup if "Main" inventory doesn't exist
 */
export async function migrateToInventorySystem(kv: Deno.Kv): Promise<void> {
  const repos = createRepositories(kv);

  // Check if "Main" inventory already exists
  const defaultInventory = await repos.inventory.getDefault();
  if (defaultInventory) {
    // Migration already done
    return;
  }

  // Create "Main" inventory
  const mainInventory: Inventory = {
    id: "main",
    name: "Main",
    createdAt: new Date(),
    isDefault: true,
  };

  await repos.inventory.save(mainInventory);

  // Migrate all existing stocks to "Main" inventory
  const existingStocks = await repos.stock.getAll();
  
  for (const stock of existingStocks) {
    const inventoryStock = {
      inventoryId: "main",
      nodeId: stock.nodeId,
      quantity: stock.quantity,
      lastUpdated: stock.lastUpdated,
    };
    
    await repos.inventoryStock.save(inventoryStock);
  }

  // Set "Main" as active inventory
  await repos.inventory.setActive("main");
}

/**
 * Ensures the inventory system is initialized
 * Creates "Main" inventory if it doesn't exist and sets it as active
 */
export async function ensureInventorySystemInitialized(kv: Deno.Kv): Promise<void> {
  const repos = createRepositories(kv);

  // Check if any inventory exists
  const inventories = await repos.inventory.getAll();
  
  if (inventories.length === 0) {
    // No inventories exist, run migration
    await migrateToInventorySystem(kv);
  } else {
    // Check if active inventory is set
    const activeId = await repos.inventory.getActive();
    if (!activeId) {
      // Set default inventory as active
      const defaultInventory = await repos.inventory.getDefault();
      if (defaultInventory) {
        await repos.inventory.setActive(defaultInventory.id);
      } else {
        // No default, set first inventory as active
        await repos.inventory.setActive(inventories[0].id);
      }
    }
  }
}
