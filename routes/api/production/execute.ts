import { Handlers } from "$fresh/server.ts";
import { createRepositories } from "../../../persistence/repositories.ts";
import { ensureInventorySystemInitialized } from "../../../persistence/migrations.ts";
import { simulateProduction } from "../../../domain/stock.ts";
import { createEmptyGraph, addNode } from "../../../domain/dag.ts";
import { emitStockChanged } from "../../../events/bus.ts";
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

      const usingOverrides = Array.isArray(data.stockOverrides);

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

      if (usingOverrides) {
        for (const s of data.stockOverrides!) {
          if (!s?.nodeId || typeof s.nodeId !== "string") continue;
          if (typeof s.quantity !== "number" || !Number.isFinite(s.quantity)) continue;
          // Clamp negatives to zero to avoid user-facing errors from stale working copies
          const qty = Math.max(0, s.quantity);
          currentStock.set(s.nodeId, qty);
        }
      } else {
        // Get active inventory ID
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

      // Simulate production to validate and get required transactions (uses recursive logic)
      const simulation = simulateProduction(graph, data.nodeId, quantity, currentStock);

      if (!simulation.canProduce) {
        return new Response(
          JSON.stringify({ 
            error: "Production not possible - insufficient stock",
            missingInputs: simulation.requiredInputs.filter(i => !i.sufficient)
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      // Working-copy mode: apply outcome in-memory only (no DB writes).
      if (usingOverrides) {
        // Return all nodes that changed (from stockOutcome)
        // stockOutcome already only includes nodes that changed, so include all of them
        // Frontend will merge with existing working copy and handle zeros correctly
        const updatedStockOverrides: Array<{ nodeId: string; quantity: number }> = [];
        const EPS = 0.000_001;
        for (const outcome of simulation.stockOutcome) {
          // Include all outcomes - if after is <= 0, send 0 so frontend can delete the entry
          const finalQuantity = outcome.after > EPS ? outcome.after : 0;
          updatedStockOverrides.push({ nodeId: outcome.nodeId, quantity: finalQuantity });
        }

        return new Response(JSON.stringify({
          success: true,
          simulation,
          updatedStockOverrides,
        }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // Persisted mode: apply updates to active inventory (existing behavior).
      const activeInventoryId = await repos.inventory.getActive();
      if (!activeInventoryId) {
        return new Response(
          JSON.stringify({ error: "No active inventory set" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      // Prepare batch updates from stock outcome
      // Inputs are consumed (negative), output is produced (positive)
      const updates = simulation.stockOutcome.map(outcome => ({
        nodeId: outcome.nodeId,
        quantity: outcome.after - outcome.before, // This will be negative for inputs, positive for output
      }));

      // Get previous stock values for event emission
      const previousStocks = new Map<string, number>();
      for (const update of updates) {
        const stock = await repos.inventoryStock.get(activeInventoryId, update.nodeId);
        previousStocks.set(update.nodeId, stock?.quantity || 0);
      }

      // Execute production atomically in active inventory
      const batchResult = await repos.inventoryStock.updateStockBatch(activeInventoryId, updates);

      if (!batchResult.success) {
        return new Response(
          JSON.stringify({ error: batchResult.error || "Failed to execute production" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      // Emit stock change events for all affected nodes
      for (const result of batchResult.results) {
        const previous = previousStocks.get(result.nodeId) || 0;
        await emitStockChanged(result.nodeId, result.newStock, previous);
      }

      // Create production order record
      const orderId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const stockDeltas = simulation.stockOutcome.map(outcome => ({
        nodeId: outcome.nodeId,
        delta: outcome.after - outcome.before,
      }));

      await repos.productionOrder.save({
        id: orderId,
        inventoryId: activeInventoryId,
        targetNodeId: data.nodeId,
        quantity: quantity,
        totalCost: simulation.totalCost,
        totalTime: simulation.totalTime,
        stockDeltas,
        createdAt: new Date(),
      });

      return new Response(JSON.stringify({ 
        success: true,
        results: batchResult.results,
        simulation,
        orderId,
      }), {
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
