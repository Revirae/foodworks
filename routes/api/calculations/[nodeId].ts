import { Handlers } from "$fresh/server.ts";
import { createRepositories } from "../../../persistence/repositories.ts";
import { calculateNodeCost, calculateNodeTime } from "../../../domain/calculations.ts";
import { createEmptyGraph, addNode } from "../../../domain/dag.ts";
import type { Node } from "../../../domain/types.ts";

export const handler: Handlers = {
  async GET(req, ctx) {
    const kv = await Deno.openKv();
    const repos = createRepositories(kv);

    try {
      const nodeId = ctx.params.nodeId;

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

      // Calculate cost and time
      const costResult = calculateNodeCost(graph, nodeId);
      const timeResult = calculateNodeTime(graph, nodeId);

      // Return combined result
      const result = {
        nodeId,
        cost: costResult.cost,
        time: timeResult.time,
        weight: costResult.weight,
        cacheKey: nodeId,
        timestamp: Date.now(),
      };

      return new Response(JSON.stringify(result), {
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

