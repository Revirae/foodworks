import { Handlers } from "$fresh/server.ts";
import { createRepositories } from "../../../../persistence/repositories.ts";
import { ensureInventorySystemInitialized } from "../../../../persistence/migrations.ts";
import type { InventoryStock, NodeId } from "../../../../domain/types.ts";

type SaveStocksBody = {
  stocks: Array<{ nodeId: NodeId; quantity: number }>;
};

export const handler: Handlers = {
  async POST(req, ctx) {
    const kv = await Deno.openKv();
    const repos = createRepositories(kv);

    try {
      await ensureInventorySystemInitialized(kv);
      const inventoryId = ctx.params.id;

      const inventory = await repos.inventory.get(inventoryId);
      if (!inventory) {
        return new Response(
          JSON.stringify({ error: "Inventory not found" }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }

      const body = await req.json() as SaveStocksBody;
      if (!body || !Array.isArray(body.stocks)) {
        return new Response(
          JSON.stringify({ error: "Body must be { stocks: Array<{ nodeId, quantity }> }" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      // Validate (non-negative, finite)
      for (const s of body.stocks) {
        if (!s?.nodeId || typeof s.nodeId !== "string") {
          return new Response(
            JSON.stringify({ error: "Each stock entry must include nodeId" }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
        if (typeof s.quantity !== "number" || !Number.isFinite(s.quantity) || s.quantity < 0) {
          return new Response(
            JSON.stringify({ error: `Invalid quantity for node ${s.nodeId}` }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
      }

      // Overwrite all inventory_stock rows for this inventory.
      const existing = await repos.inventoryStock.getAll(inventoryId);
      const atomic = kv.atomic();

      for (const row of existing) {
        atomic.delete(["inventory_stock", inventoryId, row.nodeId]);
      }

      const EPS = 0.000_001;
      let savedCount = 0;
      for (const s of body.stocks) {
        // Don't store near-zero values; absence == 0 in UI/business logic.
        if (s.quantity <= EPS) continue;

        const stock: InventoryStock = {
          inventoryId,
          nodeId: s.nodeId,
          quantity: s.quantity,
          lastUpdated: new Date(),
        };
        atomic.set(["inventory_stock", inventoryId, s.nodeId], stock);
        savedCount++;
      }

      const commit = await atomic.commit();
      if (!commit.ok) {
        return new Response(
          JSON.stringify({ error: "Failed to commit inventory stock overwrite" }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ success: true, inventoryId, savedCount }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      return new Response(
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    } finally {
      kv.close();
    }
  },
};

