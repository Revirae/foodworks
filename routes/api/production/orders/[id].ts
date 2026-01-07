import { Handlers } from "$fresh/server.ts";
import { createRepositories } from "../../../../persistence/repositories.ts";
import { ensureInventorySystemInitialized } from "../../../../persistence/migrations.ts";
import { rollbackProductionOrder } from "../../../../services/production.ts";
import type { Node } from "../../../../domain/types.ts";

export const handler: Handlers = {
  async DELETE(req, ctx) {
    const kv = await Deno.openKv();

    try {
      await ensureInventorySystemInitialized(kv);

      const orderId = ctx.params.id;
      if (!orderId) {
        return new Response(
          JSON.stringify({ error: "Order ID is required" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      const repos = createRepositories(kv);

      // Get active inventory ID
      const activeInventoryId = await repos.inventory.getActive();
      if (!activeInventoryId) {
        return new Response(
          JSON.stringify({ error: "No active inventory set" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      // Load all nodes to map IDs to names for error messages
      const allIngredients = await repos.ingredients.getAll();
      const allRecipes = await repos.recipes.getAll();
      const allProducts = await repos.products.getAll();
      const allNodes: Node[] = [...allIngredients, ...allRecipes, ...allProducts];
      const nodeMap = new Map<string, Node>();
      for (const node of allNodes) {
        nodeMap.set(node.id, node);
      }

      // Helper function to get node name or fallback to ID
      const getNodeName = (nodeId: string): string => {
        return nodeMap.get(nodeId)?.name || nodeId;
      };

      // Execute rollback using service function
      const result = await rollbackProductionOrder(kv, activeInventoryId, orderId, {
        emitEvents: true,
        getNodeName,
      });

      if (!result.success) {
        const statusCode = result.error === "Order not found" ? 404 : 400;
        return new Response(
          JSON.stringify({ error: result.error }),
          { status: statusCode, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ success: true, results: result.results }), {
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
