import { createTestKv, setupTestInventory, seedTestNodes, setTestStock, buildTestGraph, getTestStockMap } from "./tests/helpers/kv.ts";
import { simulateProduction, getMaxProducibleQuantity } from "./domain/stock.ts";
import { rollbackProductionOrder } from "./services/production.ts";
import { createRepositories } from "./persistence/repositories.ts";

const kv = await createTestKv();
const inventoryId = await setupTestInventory(kv);
const acucar = { id: "acucar", name: "Acucar", type: "ingredient", currentStock: 0, packageSize: 1, packagePrice: 1, unit: "u", unitCost: 1 } as const;
const farinha = { id: "farinha", name: "Farinha", type: "ingredient", currentStock: 0, packageSize: 1, packagePrice: 1, unit: "u", unitCost: 1 } as const;
const ovo = { id: "ovo", name: "Ovo", type: "ingredient", currentStock: 0, packageSize: 1, packagePrice: 1, unit: "u", unitCost: 1 } as const;
const massa = { id: "massa", name: "Massa", type: "recipe", currentStock: 0, description: "", fabricationTime: 1, weight: 1, unit: "u", inputs: [ { nodeId: acucar.id, quantity: 1 }, { nodeId: farinha.id, quantity: 1 }, { nodeId: ovo.id, quantity: 6 } ], totalCost: 1, costPerUnit: 1 } as const;
const bolo = { id: "bolo", name: "Bolo", type: "product", currentStock: 0, productionTime: 1, inputs: [ { nodeId: massa.id, quantity: 0.5 } ], totalCost: 1, totalProductionTime: 1, weight: 1, unit: "u" } as const;

await seedTestNodes(kv, [acucar, farinha, ovo, massa, bolo]);
await setTestStock(kv, inventoryId, [ { nodeId: acucar.id, quantity: 3 }, { nodeId: farinha.id, quantity: 3 }, { nodeId: ovo.id, quantity: 18 } ]);

const repos = createRepositories(kv);
const graph = await buildTestGraph(kv);

async function execute(nodeId: string, qty: number) {
  const stockMap = await getTestStockMap(kv, inventoryId);
  const sim = simulateProduction(graph, nodeId, qty, stockMap);
  if (!sim.canProduce) throw new Error("cannot produce");
  const updates = sim.stockOutcome.map(o => ({ nodeId: o.nodeId, quantity: o.after - o.before }));
  const batch = await repos.inventoryStock.updateStockBatch(inventoryId, updates);
  if (!batch.success) throw new Error(batch.error || "batch failed");
  const orderId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const stockDeltas = sim.stockOutcome.map(o => ({ nodeId: o.nodeId, delta: o.after - o.before }));
  await repos.productionOrder.save({ id: orderId, inventoryId, targetNodeId: nodeId, quantity: qty, totalCost: sim.totalCost, totalTime: sim.totalTime, stockDeltas, createdAt: new Date() });
  return { orderId, sim };
}

async function logState(label: string) {
  const stock = await getTestStockMap(kv, inventoryId);
  const g = await buildTestGraph(kv);
  const max = getMaxProducibleQuantity(g, "bolo", stock);
  console.log(label, { stock: Object.fromEntries(stock), max });
}

await logState("initial");
const p1 = await execute("bolo", 4);
await logState("after 4");
const p2 = await execute("bolo", 1);
await logState("after +1 (mid)");
const p3 = await execute("bolo", 1);
await logState("after +1 (last)");
await rollbackProductionOrder(kv, inventoryId, p2.orderId, { emitEvents: false });
await logState("after rollback mid");
await rollbackProductionOrder(kv, inventoryId, p1.orderId, { emitEvents: false });
await logState("after rollback first");
await rollbackProductionOrder(kv, inventoryId, p3.orderId, { emitEvents: false });
await logState("after rollback last");
kv.close();
