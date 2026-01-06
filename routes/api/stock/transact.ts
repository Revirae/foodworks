import { Handlers } from "$fresh/server.ts";
import { createRepositories } from "../../../persistence/repositories.ts";
import { ensureInventorySystemInitialized } from "../../../persistence/migrations.ts";
import { emitStockChanged } from "../../../events/bus.ts";

export const handler: Handlers = {
  async POST(req, ctx) {
    const kv = await Deno.openKv();
    const repos = createRepositories(kv);

    try {
      await ensureInventorySystemInitialized(kv);
      const data = await req.json() as { nodeId: string; quantity: number };

      if (!data.nodeId || data.quantity === undefined) {
        return new Response(
          JSON.stringify({ error: "nodeId and quantity are required" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      // Get active inventory ID
      const activeInventoryId = await repos.inventory.getActive();
      if (!activeInventoryId) {
        return new Response(
          JSON.stringify({ error: "No active inventory set" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      // Get previous stock from active inventory
      const previousStock = await repos.inventoryStock.get(activeInventoryId, data.nodeId);
      const previousQuantity = previousStock?.quantity || 0;

      // Update stock in active inventory
      const result = await repos.inventoryStock.updateStock(activeInventoryId, data.nodeId, data.quantity);
      if (!result.success) {
        return new Response(
          JSON.stringify({ error: result.error || "Failed to update stock" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      await emitStockChanged(data.nodeId, result.newStock, previousQuantity);

      return new Response(JSON.stringify({ newStock: result.newStock }), {
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

