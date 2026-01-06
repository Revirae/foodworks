import { Handlers } from "$fresh/server.ts";
import type { Recipe } from "../../domain/types.ts";
import { createRepositories } from "../../persistence/repositories.ts";
import { validateRecipe } from "../../domain/validation.ts";
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
      const recipes = await repos.recipes.getAll();
      return new Response(JSON.stringify(recipes), {
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
      const data = await req.json() as Partial<Recipe>;

      // Generate UUID if ID is not provided
      if (!data.id || data.id.trim() === "") {
        data.id = crypto.randomUUID();
      }

      // Set default unit if not provided
      if (!data.unit) {
        data.unit = "unit";
      }

      // Validate basic recipe structure
      const validation = validateRecipe(data);
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

      // Validate inputs exist and are ingredients or recipes (not products)
      if (data.inputs) {
        for (const portion of data.inputs) {
          // Check for self-reference
          if (portion.nodeId === data.id) {
            return new Response(
              JSON.stringify({ error: `Recipe cannot use itself as an input` }),
              { status: 400, headers: { "Content-Type": "application/json" } },
            );
          }

          const isIngredient = await repos.ingredients.exists(portion.nodeId);
          const isRecipe = await repos.recipes.exists(portion.nodeId);
          const isProduct = await repos.products.exists(portion.nodeId);
          
          if (!isIngredient && !isRecipe) {
            if (isProduct) {
              return new Response(
                JSON.stringify({ error: `Input ${portion.nodeId} is a product. Recipe inputs must be ingredients or recipes.` }),
                { status: 400, headers: { "Content-Type": "application/json" } },
              );
            } else {
              return new Response(
                JSON.stringify({ error: `Input ${portion.nodeId} does not exist` }),
                { status: 400, headers: { "Content-Type": "application/json" } },
              );
            }
          }

          // Check for cycles (only for recipe inputs, as ingredients can't create cycles)
          if (isRecipe) {
            if (wouldCreateCycle(graph, portion.nodeId, data.id!)) {
              return new Response(
                JSON.stringify({ error: `Adding input ${portion.nodeId} would create a circular dependency` }),
                { status: 400, headers: { "Content-Type": "application/json" } },
              );
            }
          }
        }
      }

      // Check if exists
      if (await repos.recipes.exists(data.id!)) {
        return new Response(
          JSON.stringify({ error: "Recipe with this ID already exists" }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }

      const recipe = data as Recipe;
      recipe.currentStock = recipe.currentStock || 0;
      await repos.recipes.save(recipe);

      // Initialize stock
      await repos.stock.save({
        nodeId: recipe.id,
        quantity: recipe.currentStock,
        lastUpdated: new Date(),
      });

      // Create graph edges
      if (recipe.inputs) {
        for (const portion of recipe.inputs) {
          await repos.graph.addEdge({
            from: portion.nodeId,
            to: recipe.id,
            quantity: portion.quantity,
          });
        }
      }

      // Emit events
      await emitEntityUpdated(recipe.id, "recipe", recipe);
      await emitGraphChanged(recipe.id, "node_added");
      for (const portion of recipe.inputs || []) {
        await emitCalculationInvalidated(portion.nodeId);
      }

      return new Response(JSON.stringify(recipe), {
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
      const data = await req.json() as Partial<Recipe>;

      if (!data.id || data.id.trim() === "") {
        return new Response(
          JSON.stringify({ error: "id is required" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      const existing = await repos.recipes.get(data.id);
      if (!existing) {
        return new Response(
          JSON.stringify({ error: "Recipe not found" }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }

      // Merge update (keep existing fields when omitted)
      const recipe: Recipe = {
        ...existing,
        ...data,
        id: existing.id,
        type: "recipe",
        inputs: data.inputs === undefined ? existing.inputs : data.inputs,
      };

      // Set default unit if not provided
      if (!recipe.unit) {
        recipe.unit = "unit";
      }

      // Validate basic recipe structure
      const validation = validateRecipe(recipe);
      if (!validation.valid) {
        return new Response(
          JSON.stringify({ error: "Validation failed", errors: validation.errors }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      // Build graph for cycle detection (exclude current incoming edges to this recipe)
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
        if (edge.to === recipe.id) continue;
        const incoming = graph.edges.get(edge.to) || [];
        graph.edges.set(edge.to, [...incoming, edge]);
        const outgoing = graph.reverseEdges.get(edge.from) || [];
        graph.reverseEdges.set(edge.from, [...outgoing, edge]);
      }

      // Validate inputs exist and are ingredients or recipes (not products)
      if (recipe.inputs) {
        for (const portion of recipe.inputs) {
          // Check for self-reference
          if (portion.nodeId === recipe.id) {
            return new Response(
              JSON.stringify({ error: `Recipe cannot use itself as an input` }),
              { status: 400, headers: { "Content-Type": "application/json" } },
            );
          }

          const isIngredient = await repos.ingredients.exists(portion.nodeId);
          const isRecipe = await repos.recipes.exists(portion.nodeId);
          const isProduct = await repos.products.exists(portion.nodeId);

          if (!isIngredient && !isRecipe) {
            if (isProduct) {
              return new Response(
                JSON.stringify({ error: `Input ${portion.nodeId} is a product. Recipe inputs must be ingredients or recipes.` }),
                { status: 400, headers: { "Content-Type": "application/json" } },
              );
            } else {
              return new Response(
                JSON.stringify({ error: `Input ${portion.nodeId} does not exist` }),
                { status: 400, headers: { "Content-Type": "application/json" } },
              );
            }
          }

          // Check for cycles (only for recipe inputs, as ingredients can't create cycles)
          if (isRecipe) {
            if (wouldCreateCycle(graph, portion.nodeId, recipe.id)) {
              return new Response(
                JSON.stringify({ error: `Adding input ${portion.nodeId} would create a circular dependency` }),
                { status: 400, headers: { "Content-Type": "application/json" } },
              );
            }
          }
        }
      }

      recipe.currentStock = recipe.currentStock || 0;
      await repos.recipes.save(recipe);

      // Keep stock in sync (even if unchanged)
      await repos.stock.save({
        nodeId: recipe.id,
        quantity: recipe.currentStock,
        lastUpdated: new Date(),
      });

      // Replace incoming graph edges (inputs) for this recipe
      const currentEdges = await repos.graph.getEdges(recipe.id);
      const currentIncoming = currentEdges.filter((e) => e.to === recipe.id);
      for (const edge of currentIncoming) {
        const removed = await repos.graph.removeEdge(edge.from, recipe.id);
        if (removed.success) {
          await emitGraphChanged(recipe.id, "edge_removed", edge);
          await emitCalculationInvalidated(edge.from);
        }
      }

      if (recipe.inputs) {
        for (const portion of recipe.inputs) {
          const edge = {
            from: portion.nodeId,
            to: recipe.id,
            quantity: portion.quantity,
          };
          const added = await repos.graph.addEdge(edge);
          if (!added.success) {
            return new Response(
              JSON.stringify({ error: added.error || "Failed to add edge" }),
              { status: 409, headers: { "Content-Type": "application/json" } },
            );
          }
          await emitGraphChanged(recipe.id, "edge_added", edge);
          await emitCalculationInvalidated(portion.nodeId);
        }
      }

      await emitEntityUpdated(recipe.id, "recipe", recipe);

      return new Response(JSON.stringify(recipe), {
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

      const recipe = await repos.recipes.get(id);
      if (!recipe) {
        return new Response(
          JSON.stringify({ error: "Recipe not found" }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }

      // Prevent deletion if referenced by any recipe/product input (portion)
      const allRecipes = await repos.recipes.getAll();
      const dependentRecipes = allRecipes
        .map((r) => {
          const matching = (Array.isArray(r.inputs) ? r.inputs : []).filter((p) => p?.nodeId === id);
          if (matching.length === 0) return null;
          const totalQuantity = matching.reduce((sum, p) => sum + (p?.quantity || 0), 0);
          return { id: r.id, name: r.name, quantity: totalQuantity };
        })
        .filter((x): x is { id: string; name: string; quantity: number } => x !== null);

      const allProducts = await repos.products.getAll();
      const dependentProducts = allProducts
        .map((p) => {
          const matching = (Array.isArray(p.inputs) ? p.inputs : []).filter((portion) => portion?.nodeId === id);
          if (matching.length === 0) return null;
          const totalQuantity = matching.reduce((sum, portion) => sum + (portion?.quantity || 0), 0);
          return { id: p.id, name: p.name, quantity: totalQuantity };
        })
        .filter((x): x is { id: string; name: string; quantity: number } => x !== null);

      if (dependentRecipes.length > 0 || dependentProducts.length > 0) {
        const total = dependentRecipes.length + dependentProducts.length;
        return new Response(
          JSON.stringify({
            error:
              `Cannot delete recipe "${recipe.name}" because it is used by ${total} node(s). Remove it from those inputs first.`,
            dependencies: {
              recipes: dependentRecipes,
              products: dependentProducts,
            },
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }

      await repos.recipes.delete(id);
      await repos.stock.delete(id);
      await repos.graph.deleteNodeEdges(id);

      await emitEntityUpdated(id, "recipe", { id, name: "" });
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

