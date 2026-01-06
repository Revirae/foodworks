import { Handlers } from "$fresh/server.ts";
import { createRepositories } from "../../../../persistence/repositories.ts";
import { ensureInventorySystemInitialized } from "../../../../persistence/migrations.ts";

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

      const stocks = await repos.inventoryStock.getAll(id);
      return new Response(JSON.stringify(stocks), {
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
