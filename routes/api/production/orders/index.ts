import { Handlers } from "$fresh/server.ts";
import { createRepositories } from "../../../../persistence/repositories.ts";
import { ensureInventorySystemInitialized } from "../../../../persistence/migrations.ts";
import type { ProductionOrder } from "../../../../domain/types.ts";

export const handler: Handlers = {
  async GET(req, ctx) {
    const kv = await Deno.openKv();
    const repos = createRepositories(kv);

    try {
      await ensureInventorySystemInitialized(kv);

      // Get active inventory ID
      const activeInventoryId = await repos.inventory.getActive();
      if (!activeInventoryId) {
        return new Response(
          JSON.stringify({ error: "No active inventory set" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      // Get all orders for the active inventory
      const orders = await repos.productionOrder.getAll(activeInventoryId);

      return new Response(JSON.stringify(orders), {
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

  async POST(req, ctx) {
    const kv = await Deno.openKv();
    const repos = createRepositories(kv);

    try {
      await ensureInventorySystemInitialized(kv);
      const data = await req.json() as {
        targetNodeId: string;
        quantity: number;
        totalCost: number;
        totalTime: number;
        stockDeltas: Array<{ nodeId: string; delta: number }>;
      };

      if (!data.targetNodeId || data.quantity === undefined) {
        return new Response(
          JSON.stringify({ error: "targetNodeId and quantity are required" }),
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

      // Create order ID
      const orderId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      // Create production order
      const order: ProductionOrder = {
        id: orderId,
        inventoryId: activeInventoryId,
        targetNodeId: data.targetNodeId,
        quantity: data.quantity,
        totalCost: data.totalCost ?? 0,
        totalTime: data.totalTime ?? 0,
        stockDeltas: data.stockDeltas ?? [],
        createdAt: new Date(),
      };

      await repos.productionOrder.save(order);

      return new Response(JSON.stringify(order), {
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
