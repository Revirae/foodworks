import { Handlers } from "$fresh/server.ts";
import type { Product } from "../../domain/types.ts";
import { createRepositories } from "../../persistence/repositories.ts";
import { validateProduct } from "../../domain/validation.ts";
import { emitEntityUpdated, emitCalculationInvalidated, emitGraphChanged } from "../../events/bus.ts";
import { invalidateCalculations } from "../../domain/calculations.ts";
import { wouldCreateCycle } from "../../domain/dag.ts";
import { createEmptyGraph, addNode } from "../../domain/dag.ts";
import type { Node } from "../../domain/types.ts";

export const handler: Handlers = {
  async GET(_req, ctx) {
    const kv = await Deno.openKv();
    const repos = createRepositories(kv);

    try {
      const products = await repos.products.getAll();
      return new Response(JSON.stringify(products), {
        headers: { "Content-Type": "application/json" },
      });
    } finally {
      kv.close();
    }
  },

  async POST(req, ctx) {
    const kv = await Deno.openKv();
    const repos = createRepositories(kv);

    try {
      const data = await req.json() as Partial<Product>;

      // Generate UUID if ID is not provided
      if (!data.id || data.id.trim() === "") {
        data.id = crypto.randomUUID();
      }

      // Set default unit if not provided
      if (!data.unit) {
        data.unit = "unit";
      }

      // Validate
      const validation = validateProduct(data);
      if (!validation.valid) {
        return new Response(
          JSON.stringify({ error: "Validation failed", errors: validation.errors }),
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

      // Validate inputs exist and are recipes/products
      if (data.inputs) {
        for (const portion of data.inputs) {
          // Check for self-reference
          if (portion.nodeId === data.id) {
            return new Response(
              JSON.stringify({ error: `Product cannot use itself as an input` }),
              { status: 400, headers: { "Content-Type": "application/json" } },
            );
          }

          const isIngredient = await repos.ingredients.exists(portion.nodeId);
          if (isIngredient) {
            return new Response(
              JSON.stringify({ error: `Product inputs cannot be ingredients. ${portion.nodeId} is an ingredient` }),
              { status: 400, headers: { "Content-Type": "application/json" } },
            );
          }

          const isRecipe = await repos.recipes.exists(portion.nodeId);
          const isProduct = await repos.products.exists(portion.nodeId);
          if (!isRecipe && !isProduct) {
            return new Response(
              JSON.stringify({ error: `Input node ${portion.nodeId} does not exist` }),
              { status: 400, headers: { "Content-Type": "application/json" } },
            );
          }

          // Check for cycles
          if (wouldCreateCycle(graph, portion.nodeId, data.id!)) {
            return new Response(
              JSON.stringify({ error: `Adding input ${portion.nodeId} would create a circular dependency` }),
              { status: 400, headers: { "Content-Type": "application/json" } },
            );
          }
        }
      }

      // Check if exists
      if (await repos.products.exists(data.id!)) {
        return new Response(
          JSON.stringify({ error: "Product with this ID already exists" }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }

      const product = data as Product;
      product.currentStock = product.currentStock || 0;
      await repos.products.save(product);

      // Initialize stock
      await repos.stock.save({
        nodeId: product.id,
        quantity: product.currentStock,
        lastUpdated: new Date(),
      });

      // Create graph edges
      if (product.inputs) {
        for (const portion of product.inputs) {
          await repos.graph.addEdge({
            from: portion.nodeId,
            to: product.id,
            quantity: portion.quantity,
          });
        }
      }

      // Emit events
      await emitEntityUpdated(product.id, "product", product);
      await emitGraphChanged(product.id, "node_added");
      for (const portion of product.inputs || []) {
        await emitCalculationInvalidated(portion.nodeId);
      }

      return new Response(JSON.stringify(product), {
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

  async PUT(req, ctx) {
    const kv = await Deno.openKv();
    const repos = createRepositories(kv);

    try {
      const data = await req.json() as Partial<Product>;

      if (!data.id || data.id.trim() === "") {
        return new Response(
          JSON.stringify({ error: "id is required" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      const existing = await repos.products.get(data.id);
      if (!existing) {
        return new Response(
          JSON.stringify({ error: "Product not found" }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }

      // Merge update (keep existing fields when omitted)
      const product: Product = {
        ...existing,
        ...data,
        id: existing.id,
        type: "product",
        inputs: data.inputs === undefined ? existing.inputs : data.inputs,
      };

      // Set default unit if not provided
      if (!product.unit) {
        product.unit = "unit";
      }

      // Validate
      const validation = validateProduct(product);
      if (!validation.valid) {
        return new Response(
          JSON.stringify({ error: "Validation failed", errors: validation.errors }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      // Build graph for cycle detection (exclude current incoming edges to this product)
      const graph = createEmptyGraph();
      const allIngredients = await repos.ingredients.getAll();
      const allRecipes = await repos.recipes.getAll();
      const allProducts = await repos.products.getAll();
      const allNodes: Node[] = [...allIngredients, ...allRecipes, ...allProducts];

      for (const node of allNodes) {
        addNode(graph, node);
      }

      const allEdges = await repos.graph.getAllEdges();
      for (const edge of allEdges) {
        if (edge.to === product.id) continue;
        const incoming = graph.edges.get(edge.to) || [];
        graph.edges.set(edge.to, [...incoming, edge]);
        const outgoing = graph.reverseEdges.get(edge.from) || [];
        graph.reverseEdges.set(edge.from, [...outgoing, edge]);
      }

      // Validate inputs exist and are recipes/products
      if (product.inputs) {
        for (const portion of product.inputs) {
          // Check for self-reference
          if (portion.nodeId === product.id) {
            return new Response(
              JSON.stringify({ error: `Product cannot use itself as an input` }),
              { status: 400, headers: { "Content-Type": "application/json" } },
            );
          }

          const isIngredient = await repos.ingredients.exists(portion.nodeId);
          if (isIngredient) {
            return new Response(
              JSON.stringify({ error: `Product inputs cannot be ingredients. ${portion.nodeId} is an ingredient` }),
              { status: 400, headers: { "Content-Type": "application/json" } },
            );
          }

          const isRecipe = await repos.recipes.exists(portion.nodeId);
          const isProduct = await repos.products.exists(portion.nodeId);
          if (!isRecipe && !isProduct) {
            return new Response(
              JSON.stringify({ error: `Input node ${portion.nodeId} does not exist` }),
              { status: 400, headers: { "Content-Type": "application/json" } },
            );
          }

          // Check for cycles
          if (wouldCreateCycle(graph, portion.nodeId, product.id)) {
            return new Response(
              JSON.stringify({ error: `Adding input ${portion.nodeId} would create a circular dependency` }),
              { status: 400, headers: { "Content-Type": "application/json" } },
            );
          }
        }
      }

      product.currentStock = product.currentStock || 0;
      await repos.products.save(product);

      // Keep stock in sync (even if unchanged)
      await repos.stock.save({
        nodeId: product.id,
        quantity: product.currentStock,
        lastUpdated: new Date(),
      });

      // Replace incoming graph edges (inputs) for this product
      const currentEdges = await repos.graph.getEdges(product.id);
      const currentIncoming = currentEdges.filter((e) => e.to === product.id);
      for (const edge of currentIncoming) {
        const removed = await repos.graph.removeEdge(edge.from, product.id);
        if (removed.success) {
          await emitGraphChanged(product.id, "edge_removed", edge);
          await emitCalculationInvalidated(edge.from);
        }
      }

      if (product.inputs) {
        for (const portion of product.inputs) {
          const edge = {
            from: portion.nodeId,
            to: product.id,
            quantity: portion.quantity,
          };
          const added = await repos.graph.addEdge(edge);
          if (!added.success) {
            return new Response(
              JSON.stringify({ error: added.error || "Failed to add edge" }),
              { status: 409, headers: { "Content-Type": "application/json" } },
            );
          }
          await emitGraphChanged(product.id, "edge_added", edge);
          await emitCalculationInvalidated(portion.nodeId);
        }
      }

      await emitEntityUpdated(product.id, "product", product);

      return new Response(JSON.stringify(product), {
        status: 200,
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
      const id = url.searchParams.get("id");

      if (!id) {
        return new Response(
          JSON.stringify({ error: "id is required" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      const product = await repos.products.get(id);
      if (!product) {
        return new Response(
          JSON.stringify({ error: "Product not found" }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }

      // Prevent deletion if referenced by any recipe/product input (portion)
      const allProducts = await repos.products.getAll();
      const dependentProducts = allProducts
        .map((p) => {
          const matching = (Array.isArray(p.inputs) ? p.inputs : []).filter((portion) => portion?.nodeId === id);
          if (matching.length === 0) return null;
          const totalQuantity = matching.reduce((sum, portion) => sum + (portion?.quantity || 0), 0);
          return { id: p.id, name: p.name, quantity: totalQuantity };
        })
        .filter((x): x is { id: string; name: string; quantity: number } => x !== null);

      // Products should not be used as recipe inputs, but guard for existing/legacy data
      const allRecipes = await repos.recipes.getAll();
      const dependentRecipes = allRecipes
        .map((r) => {
          const matching = (Array.isArray(r.inputs) ? r.inputs : []).filter((portion) => portion?.nodeId === id);
          if (matching.length === 0) return null;
          const totalQuantity = matching.reduce((sum, portion) => sum + (portion?.quantity || 0), 0);
          return { id: r.id, name: r.name, quantity: totalQuantity };
        })
        .filter((x): x is { id: string; name: string; quantity: number } => x !== null);

      if (dependentProducts.length > 0 || dependentRecipes.length > 0) {
        const total = dependentProducts.length + dependentRecipes.length;
        return new Response(
          JSON.stringify({
            error:
              `Cannot delete product "${product.name}" because it is used by ${total} node(s). Remove it from those inputs first.`,
            dependencies: {
              products: dependentProducts,
              recipes: dependentRecipes,
            },
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }

      await repos.products.delete(id);
      await repos.stock.delete(id);
      await repos.graph.deleteNodeEdges(id);

      await emitEntityUpdated(id, "product", { id, name: "" });
      await emitGraphChanged(id, "node_removed");
      await emitCalculationInvalidated(id);

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

