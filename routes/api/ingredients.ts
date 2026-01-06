import { Handlers } from "$fresh/server.ts";
import type { Ingredient } from "../../domain/types.ts";
import { createRepositories } from "../../persistence/repositories.ts";
import { validateIngredient } from "../../domain/validation.ts";
import { calculateIngredientUnitCost } from "../../domain/calculations.ts";
import { emitEntityUpdated, emitCalculationInvalidated } from "../../events/bus.ts";
import { invalidateCalculations } from "../../domain/calculations.ts";
import { debug, error as logError } from "../../utils/log.ts";

export const handler: Handlers = {
  async GET(_req, ctx) {
    const kv = await Deno.openKv();
    const repos = createRepositories(kv);

    try {
      debug("API", "GET /api/ingredients - fetching all ingredients");
      const ingredients = await repos.ingredients.getAll();
      debug("API", `GET /api/ingredients - found ${ingredients.length} ingredients`);
      return new Response(JSON.stringify(ingredients), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      logError("GET /api/ingredients - error:", error);
      throw error;
    } finally {
      kv.close();
    }
  },

  async POST(req, ctx) {
    const kv = await Deno.openKv();
    const repos = createRepositories(kv);

    try {
      const data = await req.json() as Partial<Ingredient>;

      // Generate UUID if ID is not provided
      if (!data.id || data.id.trim() === "") {
        data.id = crypto.randomUUID();
      }

      // Set default unit if not provided
      if (!data.unit) {
        data.unit = "unit";
      }

      // Calculate unit cost
      if (data.packageSize && data.packagePrice !== undefined) {
        data.unitCost = calculateIngredientUnitCost({
          id: data.id || "",
          name: data.name || "",
          type: "ingredient",
          packageSize: data.packageSize,
          packagePrice: data.packagePrice,
          unit: data.unit || "unit",
          unitCost: 0,
          currentStock: data.currentStock || 0,
        });
      }

      // Validate
      const validation = validateIngredient(data);
      if (!validation.valid) {
        return new Response(
          JSON.stringify({ error: "Validation failed", errors: validation.errors }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      // Check if exists
      if (await repos.ingredients.exists(data.id!)) {
        return new Response(
          JSON.stringify({ error: "Ingredient with this ID already exists" }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }

      const ingredient = data as Ingredient;
      debug("API", `POST /api/ingredients - saving ingredient with id: ${ingredient.id}, key: ["ingredient", "${ingredient.id}"]`);
      await repos.ingredients.save(ingredient);
      debug("API", `POST /api/ingredients - ingredient saved successfully`);

      // Initialize stock
      await repos.stock.save({
        nodeId: ingredient.id,
        quantity: ingredient.currentStock || 0,
        lastUpdated: new Date(),
      });

      // Emit events
      await emitEntityUpdated(ingredient.id, "ingredient", ingredient);
      await emitCalculationInvalidated(ingredient.id);

      return new Response(JSON.stringify(ingredient), {
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
      const data = await req.json() as Partial<Ingredient>;

      if (!data.id || data.id.trim() === "") {
        return new Response(
          JSON.stringify({ error: "id is required" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      const existing = await repos.ingredients.get(data.id);
      if (!existing) {
        return new Response(
          JSON.stringify({ error: "Ingredient not found" }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }

      // Merge update (keep existing fields when omitted)
      const merged: Ingredient = {
        ...existing,
        ...data,
        id: existing.id,
        type: "ingredient",
      };

      // Set default unit if not provided
      if (!merged.unit) {
        merged.unit = "unit";
      }

      // Calculate unit cost
      if (merged.packageSize && merged.packagePrice !== undefined) {
        merged.unitCost = calculateIngredientUnitCost(merged);
      }

      // Validate
      const validation = validateIngredient(merged);
      if (!validation.valid) {
        return new Response(
          JSON.stringify({ error: "Validation failed", errors: validation.errors }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      await repos.ingredients.save(merged);

      // Keep stock in sync (even if unchanged)
      await repos.stock.save({
        nodeId: merged.id,
        quantity: merged.currentStock || 0,
        lastUpdated: new Date(),
      });

      await emitEntityUpdated(merged.id, "ingredient", merged);
      await emitCalculationInvalidated(merged.id);

      return new Response(JSON.stringify(merged), {
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

      const ingredient = await repos.ingredients.get(id);
      if (!ingredient) {
        return new Response(
          JSON.stringify({ error: "Ingredient not found" }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }

      // Prevent deletion if referenced by any recipe input (portion)
      const recipes = await repos.recipes.getAll();
      const dependentRecipes = recipes
        .map((recipe) => {
          const matching = (Array.isArray(recipe.inputs) ? recipe.inputs : [])
            .filter((p) => p?.nodeId === id);
          if (matching.length === 0) return null;
          const totalQuantity = matching.reduce((sum, p) => sum + (p?.quantity || 0), 0);
          return { id: recipe.id, name: recipe.name, quantity: totalQuantity };
        })
        .filter((x): x is { id: string; name: string; quantity: number } => x !== null);

      if (dependentRecipes.length > 0) {
        return new Response(
          JSON.stringify({
            error:
              `Cannot delete ingredient "${ingredient.name}" because it is used by ${dependentRecipes.length} recipe(s). Remove it from those recipes first.`,
            dependencies: {
              recipes: dependentRecipes,
            },
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }

      await repos.ingredients.delete(id);
      await repos.stock.delete(id);
      await repos.graph.deleteNodeEdges(id);

      await emitEntityUpdated(id, "ingredient", { id, name: "" });
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

