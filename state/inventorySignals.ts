import { signal } from "@preact/signals";
import type { Inventory, NodeId } from "../domain/types.ts";

export const activeInventoryId = signal<string | null>(null);
export const inventories = signal<Inventory[]>([]);
export const activeInventory = signal<Inventory | null>(null);

/**
 * Working-copy stock quantities (NOT persisted until Save).
 *
 * - `null` means "not loaded yet" (fall back to server inventory state).
 * - When set, production simulation/execution should prefer this over persisted stock.
 */
export const workingStockQuantities = signal<Map<NodeId, number> | null>(null);

/**
 * Loads all inventories from the API
 */
export async function loadInventories(): Promise<void> {
  try {
    const response = await fetch("/api/inventories");
    if (!response.ok) {
      console.error("Failed to load inventories");
      return;
    }
    const invs: Inventory[] = await response.json();
    inventories.value = invs;
    
    // Update active inventory if we have an active ID
    if (activeInventoryId.value) {
      const active = invs.find(inv => inv.id === activeInventoryId.value);
      activeInventory.value = active || null;
    }
  } catch (error) {
    console.error("Error loading inventories:", error);
  }
}

/**
 * Loads the active inventory ID from the API
 */
export async function loadActiveInventory(): Promise<void> {
  try {
    const response = await fetch("/api/inventories/active");
    if (!response.ok) {
      await loadInventories();
      return;
    }
    const data = await response.json() as { inventoryId: string | null; inventory: Inventory | null };
    activeInventoryId.value = data.inventoryId;
    activeInventory.value = data.inventory;

    // Ensure inventories list is loaded (for UI dropdowns).
    if (inventories.value.length === 0) {
      await loadInventories();
    }
  } catch (error) {
    console.error("Error loading active inventory:", error);
  }
}

/**
 * Sets the active inventory
 */
export async function setActiveInventory(inventoryId: string): Promise<void> {
  try {
    const response = await fetch(`/api/inventories/${inventoryId}/activate`, {
      method: "POST",
    });
    
    if (!response.ok) {
      throw new Error("Failed to activate inventory");
    }
    
    activeInventoryId.value = inventoryId;
    const inv = inventories.value.find(i => i.id === inventoryId);
    activeInventory.value = inv || null;
  } catch (error) {
    console.error("Error setting active inventory:", error);
    throw error;
  }
}
