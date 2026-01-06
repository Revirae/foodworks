import { useState, useEffect } from "preact/hooks";
import { useSignalEffect } from "@preact/signals";
import type { Node, NodeId, Stock, Inventory, Graph, NodeType } from "../../domain/types.ts";
import { eventBus } from "../../events/bus.ts";
import { workingStockQuantities } from "../../state/inventorySignals.ts";
import { createEmptyGraph, addNode } from "../../domain/dag.ts";
import { checkStockAvailability, detectLowStock, getProductionReadiness } from "../../domain/stock.ts";
import { calculateNodeCost, clearCalculationCache } from "../../domain/calculations.ts";
import { convertToDisplay } from "../../utils/units.ts";

export interface WorkspaceNodeRow {
  node: Node;
  stock: number; // Current stock quantity (from working copy or saved stocks)
  isLowStock: boolean;
  readiness: "ready" | "low_stock" | "insufficient";
  // "Craftable" means: can we produce +1 more from inputs (ignores existing stock).
  // Only meaningful for recipes/products.
  craftable?: boolean;
  unitCost: number;
  // For ingredients: package info
  packageDisplay?: { value: number; unit: string };
  stockInPackages?: string;
}

export interface WorkspaceData {
  nodes: Node[];
  stocks: Map<NodeId, Stock>;
  graph: Graph;
  inventories: Inventory[];
  activeInventory: Inventory | null;
  rows: WorkspaceNodeRow[];
  loading: boolean;
  error: string | null;
  hasUnsavedChanges: boolean;
  savedStocks: Map<NodeId, number>;
}

const EPSILON = 0.000_001;
const LOW_STOCK_THRESHOLD = 10;

export function useWorkspaceData() {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [stocks, setStocks] = useState<Map<NodeId, Stock>>(new Map());
  const [savedStocks, setSavedStocks] = useState<Map<NodeId, number>>(new Map());
  const [graph, setGraph] = useState<Graph>(createEmptyGraph());
  const [inventories, setInventories] = useState<Inventory[]>([]);
  const [activeInventory, setActiveInventory] = useState<Inventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  // Sync working copy to local stocks state
  useSignalEffect(() => {
    const working = workingStockQuantities.value;
    if (!working) return;

    // Check if quantities match (to avoid unnecessary updates)
    let matches = true;
    if (stocks.size !== working.size) {
      matches = false;
    } else {
      for (const [nodeId, quantity] of working.entries()) {
        const currentStock = stocks.get(nodeId);
        if (!currentStock || Math.abs(currentStock.quantity - quantity) > EPSILON) {
          matches = false;
          break;
        }
      }
    }
    if (matches) return;

    // Update stocks from working copy
    const nextStocks = new Map<NodeId, Stock>();
    for (const [nodeId, quantity] of working.entries()) {
      const existing = stocks.get(nodeId);
      nextStocks.set(nodeId, {
        nodeId,
        quantity,
        lastUpdated: existing?.lastUpdated ?? new Date(),
      });
    }
    setStocks(nextStocks);
    checkForChanges(nextStocks, savedStocks);
  });

  function quantitiesMatch(
    current: Map<NodeId, Stock>,
    quantities: Map<NodeId, number>,
  ): boolean {
    for (const [nodeId, stock] of current.entries()) {
      const q = quantities.get(nodeId) ?? 0;
      if (Math.abs((stock.quantity ?? 0) - q) > EPSILON) return false;
    }
    for (const [nodeId, q] of quantities.entries()) {
      const currentQ = current.get(nodeId)?.quantity ?? 0;
      if (Math.abs(currentQ - q) > EPSILON) return false;
    }
    return true;
  }

  function checkForChanges(currentStocks: Map<NodeId, Stock>, savedState: Map<NodeId, number>) {
    let hasChangesFlag = false;

    for (const [nodeId, stock] of currentStocks.entries()) {
      const savedQuantity = savedState.get(nodeId) || 0;
      if (Math.abs(stock.quantity - savedQuantity) > 0.001) {
        hasChangesFlag = true;
        break;
      }
    }

    for (const [nodeId, savedQuantity] of savedState.entries()) {
      const currentStock = currentStocks.get(nodeId);
      if (!currentStock || Math.abs(currentStock.quantity - savedQuantity) > 0.001) {
        hasChangesFlag = true;
        break;
      }
    }

    setHasUnsavedChanges(hasChangesFlag);
  }

  async function loadNodes() {
    try {
      const [ingredientsRes, recipesRes, productsRes] = await Promise.all([
        fetch("/api/ingredients"),
        fetch("/api/recipes"),
        fetch("/api/products"),
      ]);

      if (!ingredientsRes.ok || !recipesRes.ok || !productsRes.ok) {
        throw new Error("Failed to load nodes");
      }

      const ingredients: Node[] = await ingredientsRes.json();
      const recipes: Node[] = await recipesRes.json();
      const products: Node[] = await productsRes.json();

      setNodes([...ingredients, ...recipes, ...products]);
    } catch (err) {
      console.error("Failed to load nodes:", err);
      throw err;
    }
  }

  async function loadStocks() {
    try {
      const response = await fetch("/api/stock");
      if (!response.ok) {
        throw new Error("Failed to load stocks");
      }

      const stocksList: Stock[] = await response.json();
      const stocksMap = new Map<NodeId, Stock>();
      const savedMap = new Map<NodeId, number>();
      for (const stock of stocksList) {
        stocksMap.set(stock.nodeId, stock);
        savedMap.set(stock.nodeId, stock.quantity);
      }
      setStocks(stocksMap);
      setSavedStocks(savedMap);
      workingStockQuantities.value = new Map(savedMap);
      setHasUnsavedChanges(false);
    } catch (err) {
      console.error("Failed to load stocks:", err);
      throw err;
    }
  }

  async function loadGraph() {
    try {
      const [ingredientsRes, recipesRes, productsRes, edgesRes] = await Promise.all([
        fetch("/api/ingredients"),
        fetch("/api/recipes"),
        fetch("/api/products"),
        fetch("/api/graph/edges"),
      ]);

      const ingredients: Node[] = await ingredientsRes.json();
      const recipes: Node[] = await recipesRes.json();
      const products: Node[] = await productsRes.json();
      const edges = await edgesRes.json();

      const allNodes = [...ingredients, ...recipes, ...products];
      const graphData = createEmptyGraph();

      for (const node of allNodes) {
        addNode(graphData, node);
      }

      for (const edge of edges) {
        const incoming = graphData.edges.get(edge.to) || [];
        graphData.edges.set(edge.to, [...incoming, edge]);
        const outgoing = graphData.reverseEdges.get(edge.from) || [];
        graphData.reverseEdges.set(edge.from, [...outgoing, edge]);
      }

      setGraph(graphData);
    } catch (err) {
      console.error("Failed to load graph:", err);
      throw err;
    }
  }

  async function loadInventories() {
    try {
      const [invsRes, activeRes] = await Promise.all([
        fetch("/api/inventories"),
        fetch("/api/inventories/active"),
      ]);

      if (!invsRes.ok) {
        throw new Error("Failed to load inventories");
      }

      const invs: Inventory[] = await invsRes.json();
      setInventories(invs);

      if (activeRes.ok) {
        const activeData = await activeRes.json() as {
          inventoryId: string | null;
          inventory: Inventory | null;
        };
        if (activeData.inventoryId) {
          const activeInv = invs.find((i) => i.id === activeData.inventoryId) || null;
          setActiveInventory(activeInv);
          return;
        }
      }

      if (activeInventory && invs.some((i) => i.id === activeInventory.id)) {
        return;
      }

      const defaultInv = invs.find((inv) => inv.isDefault);
      setActiveInventory(defaultInv || invs[0] || null);
    } catch (err) {
      console.error("Failed to load inventories:", err);
      throw err;
    }
  }

  async function loadData() {
    setLoading(true);
    setError(null);

    try {
      clearCalculationCache();
      await Promise.all([loadNodes(), loadStocks(), loadGraph(), loadInventories()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  }

  // Reload entities/graph without touching stocks (keeps working-copy stock edits intact)
  async function reloadEntities() {
    setLoading(true);
    setError(null);
    try {
      clearCalculationCache();
      await Promise.all([loadNodes(), loadGraph()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load entities");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();

    const unsubscribeStock = eventBus.subscribe("STOCK_CHANGED", () => {
      loadStocks();
    });

    const unsubscribeEntity = eventBus.subscribe("ENTITY_UPDATED", () => {
      // Important: don't overwrite working stock edits when entities change
      reloadEntities();
    });

    const unsubscribeInventory = eventBus.subscribe("INVENTORY_CHANGED", () => {
      loadInventories();
    });

    return () => {
      unsubscribeStock();
      unsubscribeEntity();
      unsubscribeInventory();
    };
  }, []);

  // Check for changes when stocks or savedStocks change
  useEffect(() => {
    if (savedStocks.size > 0 && stocks.size > 0) {
      checkForChanges(stocks, savedStocks);
    }
  }, [stocks, savedStocks]);

  // Derive rows from nodes + stocks + graph
  const stockMap = new Map<NodeId, number>();
  for (const [nodeId, stock] of stocks.entries()) {
    stockMap.set(nodeId, stock.quantity);
  }

  const rows: WorkspaceNodeRow[] = nodes.map((node) => {
    const stock = stocks.get(node.id) || { nodeId: node.id, quantity: 0, lastUpdated: new Date() };
    const stockQuantity = stock.quantity;
    // UI semantics: for ingredients we only want a "no stock" warning at zero,
    // not a persistent low-stock warning for small positive quantities.
    const isLowStock = node.type === "ingredient"
      ? stockQuantity <= EPSILON
      : detectLowStock(stock, LOW_STOCK_THRESHOLD);
    const readiness = getProductionReadiness(graph, node.id, stockMap, LOW_STOCK_THRESHOLD);
    const craftable = (node.type === "recipe" || node.type === "product")
      ? checkStockAvailability(graph, node.id, 1, stockMap).available
      : undefined;

    let unitCost = 0;
    try {
      if (graph.nodes.has(node.id)) {
        unitCost = calculateNodeCost(graph, node.id).cost;
      } else if (node.type === "ingredient") {
        unitCost = (node as any).unitCost || 0;
      } else if (node.type === "recipe") {
        unitCost = (node as any).costPerUnit || 0;
      } else if (node.type === "product") {
        unitCost = (node as any).totalCost || 0;
      }
    } catch {
      // Fallback to 0
    }

    const row: WorkspaceNodeRow = {
      node,
      stock: stockQuantity,
      isLowStock,
      readiness,
      craftable,
      unitCost,
    };

    // Add package info for ingredients
    if (node.type === "ingredient") {
      const ingredient = node as any;
      if (ingredient.packageSize && ingredient.unit) {
        const packageDisplay = convertToDisplay(ingredient.packageSize, ingredient.unit);
        row.packageDisplay = packageDisplay;
        const stockInPackages = ingredient.packageSize > 0
          ? (stockQuantity / ingredient.packageSize).toFixed(2)
          : "0";
        row.stockInPackages = stockInPackages;
      }
    }

    return row;
  });

  return {
    nodes,
    stocks,
    graph,
    inventories,
    activeInventory,
    rows,
    loading,
    error,
    hasUnsavedChanges,
    savedStocks,
    loadData,
    reloadEntities,
    loadStocks,
    loadInventories,
    setActiveInventory,
    setStocks,
    setSavedStocks,
    setHasUnsavedChanges,
  };
}
