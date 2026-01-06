import { Handlers } from "$fresh/server.ts";
import { createRepositories } from "../../../persistence/repositories.ts";
import { ensureInventorySystemInitialized } from "../../../persistence/migrations.ts";

export const handler: Handlers = {
  async GET(_req, _ctx) {
    const kv = await Deno.openKv();
    const repos = createRepositories(kv);

    try {
      await ensureInventorySystemInitialized(kv);

      const inventoryId = await repos.inventory.getActive();
      if (!inventoryId) {
        return new Response(JSON.stringify({ inventoryId: null, inventory: null }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      const inventory = await repos.inventory.get(inventoryId);
      return new Response(JSON.stringify({ inventoryId, inventory }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      return new Response(
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    } finally {
      kv.close();
    }
  },
};

