import { Handlers } from "$fresh/server.ts";
import { createRepositories } from "../../../persistence/repositories.ts";
import { ensureInventorySystemInitialized } from "../../../persistence/migrations.ts";
import { simulateProduction } from "../../../domain/stock.ts";
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
        quantity: number;
        stockOverrides?: Array<{ nodeId: string; quantity: number }>;
      };

      if (!data.nodeId || data.quantity === undefined) {
        return new Response(
          JSON.stringify({ error: "nodeId and quantity are required" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      // Enforce integer quantity
      const quantity = Math.floor(data.quantity);
      if (quantity <= 0 || !Number.isFinite(quantity) || quantity !== data.quantity) {
        return new Response(
          JSON.stringify({ error: "quantity must be a positive integer" }),
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

      // Load edges
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

      // Prefer provided working-copy stock overrides if present.
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
          // but clamp them to zero for simulation to avoid rejecting the request.
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

      // Simulate production (uses recursive logic)
      const simulation = simulateProduction(graph, data.nodeId, quantity, currentStock);

      return new Response(JSON.stringify(simulation), {
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

