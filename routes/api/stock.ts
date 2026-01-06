import { Handlers } from "$fresh/server.ts";
import { createRepositories } from "../../persistence/repositories.ts";
import { ensureInventorySystemInitialized } from "../../persistence/migrations.ts";
import type { Stock } from "../../domain/types.ts";

export const handler: Handlers = {
  async GET(req, ctx) {
    const kv = await Deno.openKv();
    const repos = createRepositories(kv);

    try {
      await ensureInventorySystemInitialized(kv);
      
      // Check for optional inventoryId query parameter
      const url = new URL(req.url);
      const inventoryId = url.searchParams.get("inventoryId");
      
      let inventoryStocks;
      if (inventoryId) {
        // Get stocks for specific inventory
        inventoryStocks = await repos.inventoryStock.getAll(inventoryId);
      } else {
        // Get stocks for active inventory
        inventoryStocks = await repos.inventoryStock.getAllForActiveInventory();
      }

      // Convert InventoryStock to Stock format for backward compatibility
      const stocks: Stock[] = inventoryStocks.map(invStock => ({
        nodeId: invStock.nodeId,
        quantity: invStock.quantity,
        lastUpdated: invStock.lastUpdated,
      }));

      return new Response(JSON.stringify(stocks), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    } finally {
      kv.close();
    }
  },
};

