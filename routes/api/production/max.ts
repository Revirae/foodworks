import { Handlers } from "$fresh/server.ts";
import { createRepositories } from "../../../persistence/repositories.ts";
import { ensureInventorySystemInitialized } from "../../../persistence/migrations.ts";
import { getMaxProducibleQuantity } from "../../../domain/stock.ts";
import { createEmptyGraph, addNode } from "../../../domain/dag.ts";
import type { Node } from "../../../domain/types.ts";

export const handler: Handlers = {
  async POST(req, ctx) {
    const kv = await Deno.openKv();
    const repos = createRepositories(kv);

    try {
      await ensureInventorySystemInitialized(kv);
      const data = await req.json() as {
        nodeId: string;
        stockOverrides?: Array<{ nodeId: string; quantity: number }>;
      };

      if (!data.nodeId) {
        return new Response(
          JSON.stringify({ error: "nodeId is required" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      // Build graph
      const graph = createEmptyGraph();
      const allIngredients = await repos.ingredients.getAll();
      const allRecipes = await repos.recipes.getAll();
      const allProducts = await repos.products.getAll();
      const allNodes: Node[] = [...allIngredients, ...allRecipes, ...allProducts];

      for (const node of allNodes) {
        addNode(graph, node);
      }

      // Load edges (for graph structure, though we use node.inputs directly)
      const allEdges = await repos.graph.getAllEdges();
      for (const edge of allEdges) {
        const incoming = graph.edges.get(edge.to) || [];
        graph.edges.set(edge.to, [...incoming, edge]);
        const outgoing = graph.reverseEdges.get(edge.from) || [];
        graph.reverseEdges.set(edge.from, [...outgoing, edge]);
      }

      // Check if node exists in graph
      if (!graph.nodes.has(data.nodeId)) {
        return new Response(
          JSON.stringify({ error: `Node ${data.nodeId} not found` }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }

      const currentStock = new Map<string, number>();

      // Prefer provided working-copy stock overrides if present
      if (Array.isArray(data.stockOverrides)) {
        for (const s of data.stockOverrides) {
          if (!s?.nodeId || typeof s.nodeId !== "string") continue;
          if (typeof s.quantity !== "number" || !Number.isFinite(s.quantity)) {
            return new Response(
              JSON.stringify({ error: `Invalid stockOverrides quantity for node ${s.nodeId}` }),
              { status: 400, headers: { "Content-Type": "application/json" } },
            );
          }
          // Allow negative overrides (can happen after out-of-order rollbacks for intermediates)
          // but clamp them to zero for the calculation so we don't reject valid working copies.
          const qty = Math.max(0, s.quantity);
          currentStock.set(s.nodeId, qty);
        }
      } else {
        // Fall back to persisted stock from active inventory
        const activeInventoryId = await repos.inventory.getActive();
        if (!activeInventoryId) {
          return new Response(
            JSON.stringify({ error: "No active inventory set" }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }

        const inventoryStocks = await repos.inventoryStock.getAll(activeInventoryId);
        for (const stock of inventoryStocks) {
          currentStock.set(stock.nodeId, stock.quantity);
        }
      }

      // Calculate max producible quantity
      const maxQuantity = getMaxProducibleQuantity(graph, data.nodeId, currentStock);

      return new Response(JSON.stringify({ maxQuantity }), {
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
