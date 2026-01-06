import { Handlers } from "$fresh/server.ts";
import type { GraphEdge } from "../../../domain/types.ts";
import { createRepositories } from "../../../persistence/repositories.ts";
import { wouldCreateCycle, createEmptyGraph, addNode, addEdge as dagAddEdge } from "../../../domain/dag.ts";
import { emitGraphChanged } from "../../../events/bus.ts";
import type { Node } from "../../../domain/types.ts";

export const handler: Handlers = {
  async GET(req, ctx) {
    const kv = await Deno.openKv();
    const repos = createRepositories(kv);

    try {
      const allEdges = await repos.graph.getAllEdges();
      return new Response(JSON.stringify(allEdges), {
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

  async POST(req, ctx) {
    const kv = await Deno.openKv();
    const repos = createRepositories(kv);

    try {
      const data = await req.json() as Partial<GraphEdge>;

      if (!data.from || !data.to || data.quantity === undefined) {
        return new Response(
          JSON.stringify({ error: "from, to, and quantity are required" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      // Check for self-reference
      if (data.from === data.to) {
        return new Response(
          JSON.stringify({ error: "Cannot create an edge from a node to itself" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      // Build graph for cycle detection
      const graph = createEmptyGraph();
      const allIngredients = await repos.ingredients.getAll();
      const allRecipes = await repos.recipes.getAll();
      const allProducts = await repos.products.getAll();
      const allNodes: Node[] = [...allIngredients, ...allRecipes, ...allProducts];

      for (const node of allNodes) {
        addNode(graph, node);
      }

      // Load existing edges
      const allEdges = await repos.graph.getAllEdges();
      for (const edge of allEdges) {
        const incoming = graph.edges.get(edge.to) || [];
        graph.edges.set(edge.to, [...incoming, edge]);
        const outgoing = graph.reverseEdges.get(edge.from) || [];
        graph.reverseEdges.set(edge.from, [...outgoing, edge]);
      }

      // Check for cycle
      if (wouldCreateCycle(graph, data.from, data.to)) {
        return new Response(
          JSON.stringify({ error: "Adding this edge would create a cycle" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      const edge: GraphEdge = {
        from: data.from,
        to: data.to,
        quantity: data.quantity,
      };

      const result = await repos.graph.addEdge(edge);
      if (!result.success) {
        return new Response(
          JSON.stringify({ error: result.error || "Failed to add edge" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      await emitGraphChanged(edge.to, "edge_added", edge);

      return new Response(JSON.stringify(edge), {
        status: 201,
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

  async DELETE(req, ctx) {
    const kv = await Deno.openKv();
    const repos = createRepositories(kv);

    try {
      const url = new URL(req.url);
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");

      if (!from || !to) {
        return new Response(
          JSON.stringify({ error: "from and to parameters are required" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      const result = await repos.graph.removeEdge(from, to);
      if (!result.success) {
        return new Response(
          JSON.stringify({ error: result.error || "Failed to remove edge" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      await emitGraphChanged(to, "edge_removed", { from, to, quantity: 0 });

      return new Response(JSON.stringify({ success: true }), {
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

