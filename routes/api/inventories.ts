import { Handlers } from "$fresh/server.ts";
import { createRepositories } from "../../persistence/repositories.ts";
import { ensureInventorySystemInitialized } from "../../persistence/migrations.ts";
import type { Inventory } from "../../domain/types.ts";

export const handler: Handlers = {
  async GET(req, ctx) {
    const kv = await Deno.openKv();
    const repos = createRepositories(kv);

    try {
      await ensureInventorySystemInitialized(kv);
      const inventories = await repos.inventory.getAll();
      return new Response(JSON.stringify(inventories), {
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
      await ensureInventorySystemInitialized(kv);
      const data = await req.json() as { name: string; copyFromActive?: boolean };

      if (!data.name || data.name.trim() === "") {
        return new Response(
          JSON.stringify({ error: "name is required" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      // Generate ID from name (lowercase, replace spaces with underscores)
      const id = data.name.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");

      // Check if inventory with this ID already exists
      if (await repos.inventory.exists(id)) {
        return new Response(
          JSON.stringify({ error: "Inventory with this name already exists" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      const inventory: Inventory = {
        id,
        name: data.name.trim(),
        createdAt: new Date(),
        isDefault: false,
      };

      await repos.inventory.save(inventory);

      // Optionally copy stocks from active inventory
      if (data.copyFromActive) {
        const activeId = await repos.inventory.getActive();
        if (activeId) {
          await repos.inventoryStock.copyInventory(activeId, id);
        }
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
};
