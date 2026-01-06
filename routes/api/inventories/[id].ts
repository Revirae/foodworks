import { Handlers } from "$fresh/server.ts";
import { createRepositories } from "../../../persistence/repositories.ts";
import { ensureInventorySystemInitialized } from "../../../persistence/migrations.ts";
import type { Inventory } from "../../../domain/types.ts";

export const handler: Handlers = {
  async GET(req, ctx) {
    const kv = await Deno.openKv();
    const repos = createRepositories(kv);

    try {
      await ensureInventorySystemInitialized(kv);
      const id = ctx.params.id;
      const inventory = await repos.inventory.get(id);

      if (!inventory) {
        return new Response(
          JSON.stringify({ error: "Inventory not found" }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(JSON.stringify(inventory), {
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
      await ensureInventorySystemInitialized(kv);
      const id = ctx.params.id;
      const data = await req.json() as { name?: string };

      const inventory = await repos.inventory.get(id);
      if (!inventory) {
        return new Response(
          JSON.stringify({ error: "Inventory not found" }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }

      // Update name if provided
      if (data.name !== undefined) {
        inventory.name = data.name.trim();
      }

      await repos.inventory.save(inventory);

      return new Response(JSON.stringify(inventory), {
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
      await ensureInventorySystemInitialized(kv);
      const id = ctx.params.id;

      const inventory = await repos.inventory.get(id);
      if (!inventory) {
        return new Response(
          JSON.stringify({ error: "Inventory not found" }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }

      // Prevent deletion of default inventory
      if (inventory.isDefault) {
        return new Response(
          JSON.stringify({ error: "Cannot delete default inventory" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      // Check if this is the active inventory
      const activeId = await repos.inventory.getActive();
      if (activeId === id) {
        // Switch to default inventory before deleting
        const defaultInventory = await repos.inventory.getDefault();
        if (defaultInventory) {
          await repos.inventory.setActive(defaultInventory.id);
        }
      }

      // Delete all stocks in this inventory
      const stocks = await repos.inventoryStock.getAll(id);
      for (const stock of stocks) {
        await repos.inventoryStock.delete(id, stock.nodeId);
      }

      // Delete the inventory
      await repos.inventory.delete(id);

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
