import { useState, useEffect } from "preact/hooks";
import { useSignalEffect } from "@preact/signals";
import type { Node, Stock, NodeType, NodeId, Inventory } from "../domain/types.ts";
import { eventBus, emitInventoryChanged, emitStockChanged } from "../events/bus.ts";
import type { Event } from "../events/types.ts";
import { checkStockAvailability, getProductionReadiness } from "../domain/stock.ts";
import { createEmptyGraph, addNode } from "../domain/dag.ts";
import { calculateNodeCost, clearCalculationCache } from "../domain/calculations.ts";
import { workingStockQuantities } from "../state/inventorySignals.ts";

interface StockDashboardProps {
  lowStockThreshold?: number;
}

export default function StockDashboard({ lowStockThreshold = 10 }: StockDashboardProps) {
  const [stocks, setStocks] = useState<Map<NodeId, Stock>>(new Map());
  const [nodes, setNodes] = useState<Node[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<NodeType | "all">("all");
  const [editingStock, setEditingStock] = useState<NodeId | null>(null);
  const [editQuantity, setEditQuantity] = useState(0);
  const [graph, setGraph] = useState(createEmptyGraph());
  const [inventories, setInventories] = useState<Inventory[]>([]);
  const [activeInventory, setActiveInventory] = useState<Inventory | null>(null);
  const [showCreateInventory, setShowCreateInventory] = useState(false);
  const [newInventoryName, setNewInventoryName] = useState("");
  const [copyFromActive, setCopyFromActive] = useState(false);
  const [savedStocks, setSavedStocks] = useState<Map<NodeId, number>>(new Map());
  const [hasChanges, setHasChanges] = useState(false);
  const [pendingInventorySwitchId, setPendingInventorySwitchId] = useState<string | null>(null);
  const [showUnsavedSwitchPrompt, setShowUnsavedSwitchPrompt] = useState(false);
  const [pendingDeleteNodeId, setPendingDeleteNodeId] = useState<NodeId | null>(null);
  const [pendingDeleteDependents, setPendingDeleteDependents] = useState<string[]>([]);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [pendingDeleteInventoryId, setPendingDeleteInventoryId] = useState<string | null>(null);
  const [showDeleteInventoryConfirm, setShowDeleteInventoryConfirm] = useState(false);
  const [showUnsavedDeleteInventoryPrompt, setShowUnsavedDeleteInventoryPrompt] = useState(false);

  const EPSILON = 0.000_001;
  const currencyFmt = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });

  function getNodeUnitCost(nodeId: NodeId): number {
    // Preferred: canonical cost calculator (covers ingredient/recipe/product consistently).
    if (graph.nodes.has(nodeId)) {
      try {
        return calculateNodeCost(graph, nodeId).cost;
      } catch {
        // fall through to heuristics
      }
    }

    // Fallback: rely on pre-derived fields from node payloads (if any).
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return 0;
    if (node.type === "ingredient") return node.unitCost;
    if (node.type === "recipe") return node.costPerUnit;
    if (node.type === "product") return node.totalCost;
    return 0;
  }

  const totalInventoryPrice = Array.from(stocks.values()).reduce((sum, s) => {
    if (!(typeof s.quantity === "number") || !Number.isFinite(s.quantity) || s.quantity <= 0) return sum;
    return sum + getNodeUnitCost(s.nodeId) * s.quantity;
  }, 0);

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

  function setWorkingFromStocks(currentStocks: Map<NodeId, Stock>) {
    const quantities = new Map<NodeId, number>();
    for (const [nodeId, stock] of currentStocks.entries()) {
      quantities.set(nodeId, stock.quantity);
    }
    workingStockQuantities.value = quantities;
  }

  function getDependentLabels(nodeId: NodeId): string[] {
    // Use recipe/product `inputs` (source of truth for production) to find dependents.
    const directDependents = new Map<NodeId, Set<NodeId>>();
    for (const n of nodes) {
      if (n.type !== "recipe" && n.type !== "product") continue;
      const inputs = n.inputs || [];
      for (const portion of inputs) {
        if (!directDependents.has(portion.nodeId)) {
          directDependents.set(portion.nodeId, new Set());
        }
        directDependents.get(portion.nodeId)!.add(n.id);
      }
    }

    const dependents = new Set<NodeId>();
    const queue: NodeId[] = [nodeId];
    const visited = new Set<NodeId>([nodeId]);

    while (queue.length > 0) {
      const current = queue.shift()!;
      const outs = directDependents.get(current);
      if (!outs) continue;
      for (const target of outs) {
        if (!visited.has(target)) {
          visited.add(target);
          dependents.add(target);
          queue.push(target);
        }
      }
    }

    const labels: string[] = [];
    for (const depId of dependents) {
      const node = nodes.find((n) => n.id === depId);
      if (node) labels.push(node.name);
      else labels.push(depId);
    }

    return labels.sort((a, b) => a.localeCompare(b));
  }

  function requestDelete(nodeId: NodeId) {
    const labels = getDependentLabels(nodeId);
    if (labels.length === 0) {
      const current = stocks.get(nodeId);
      if (current && current.quantity > 0) {
        handleStockUpdate(nodeId, -current.quantity);
      }
      return;
    }
    setPendingDeleteNodeId(nodeId);
    setPendingDeleteDependents(labels);
    setShowDeleteConfirm(true);
  }
  
  useEffect(() => {
    loadData();
    loadInventories();
    
    const unsubscribe = eventBus.subscribe("STOCK_CHANGED", () => {
      loadStocks(); // This will reset hasChanges
    });
    
    const unsubscribe2 = eventBus.subscribe("ENTITY_UPDATED", () => {
      loadData();
    });
    
    return () => {
      unsubscribe();
      unsubscribe2();
    };
  }, []);

  // Check for changes whenever stocks change
  useEffect(() => {
    if (savedStocks.size > 0 && stocks.size > 0) {
      checkForChanges(stocks, savedStocks);
    }
  }, [stocks, savedStocks]);

  // Sync local state from working-copy updates (e.g. production execution).
  // Use useSignalEffect to react to signal changes
  useSignalEffect(() => {
    const workingQuantities = workingStockQuantities.value;
    if (!workingQuantities) return;
    if (quantitiesMatch(stocks, workingQuantities)) return;

    const nextStocks = new Map<NodeId, Stock>();
    for (const [nodeId, quantity] of workingQuantities.entries()) {
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
  
  async function loadData() {
    setLoading(true);
    setError(null);
    
    try {
      // Ensure cost/time calculations reflect latest entity data (ingredient price, recipe inputs, etc.).
      clearCalculationCache();
      await Promise.all([loadNodes(), loadStocks(), loadGraph()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  }
  
  async function loadNodes() {
    const [ingredientsRes, recipesRes, productsRes] = await Promise.all([
      fetch("/api/ingredients"),
      fetch("/api/recipes"),
      fetch("/api/products"),
    ]);
    
    const ingredients: Node[] = await ingredientsRes.json();
    const recipes: Node[] = await recipesRes.json();
    const products: Node[] = await productsRes.json();
    
    setNodes([...ingredients, ...recipes, ...products]);
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
      setHasChanges(false);
    } catch (err) {
      console.error("Failed to load stocks:", err);
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

      // Prefer the server's active inventory ID to drive the dropdown selection.
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

      // If server doesn't know, keep current selection if it still exists.
      if (activeInventory && invs.some((i) => i.id === activeInventory.id)) {
        return;
      }

      // Final fallback: default or first.
      const defaultInv = invs.find((inv) => inv.isDefault);
      setActiveInventory(defaultInv || invs[0] || null);
    } catch (err) {
      console.error("Failed to load inventories:", err);
    }
  }

  async function activateInventory(inventoryId: string) {
    try {
      const response = await fetch(`/api/inventories/${inventoryId}/activate`, {
        method: "POST",
      });
      
      if (!response.ok) {
        throw new Error("Failed to activate inventory");
      }
      
      const inv = inventories.find(i => i.id === inventoryId);
      setActiveInventory(inv || null);
      await loadStocks(); // Reload stocks for the new active inventory (this will reset hasChanges)
      await emitInventoryChanged(inventoryId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to switch inventory");
    }
  }

  async function handleInventoryChange(inventoryId: string) {
    if (hasChanges) {
      setPendingInventorySwitchId(inventoryId);
      setShowUnsavedSwitchPrompt(true);
      return;
    }
    await activateInventory(inventoryId);
  }

  async function performDeleteInventory(inventoryId: string) {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/inventories/${inventoryId}`, { method: "DELETE" });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to delete inventory");
      }

      // Reload inventories/stocks so UI reflects server's active inventory.
      await handleReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete inventory");
    } finally {
      setLoading(false);
    }
  }

  function requestDeleteInventory() {
    if (!activeInventory) return;
    if (activeInventory.isDefault) {
      setError("Cannot delete default inventory");
      return;
    }
    setPendingDeleteInventoryId(activeInventory.id);

    if (hasChanges) {
      setShowUnsavedDeleteInventoryPrompt(true);
      return;
    }
    setShowDeleteInventoryConfirm(true);
  }

  async function handleCreateInventory() {
    if (!newInventoryName.trim()) {
      setError("Inventory name is required");
      return;
    }

    try {
      const response = await fetch("/api/inventories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newInventoryName.trim(),
          copyFromActive,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to create inventory");
      }

      const newInventory: Inventory = await response.json();
      setInventories([...inventories, newInventory]);
      setNewInventoryName("");
      setShowCreateInventory(false);
      setCopyFromActive(false);
      
      // Optionally activate the new inventory
      await handleInventoryChange(newInventory.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create inventory");
    }
  }

  async function handleReload() {
    setLoading(true);
    setError(null);
    try {
      // Order matters: keep dropdown aligned with server active inventory.
      await loadInventories();
      await loadStocks();
      // loadStocks will reset hasChanges to false
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reload");
    } finally {
      setLoading(false);
    }
  }

  async function handleSave(): Promise<boolean> {
    if (!activeInventory) {
      setError("No active inventory to save");
      return false;
    }

    if (!hasChanges) {
      return true; // Nothing to save
    }

    setLoading(true);
    setError(null);

    const previousSaved = new Map(savedStocks);

    try {
      const payloadStocks = Array.from(stocks.entries())
        .map(([nodeId, stock]) => ({ nodeId, quantity: stock.quantity }))
        .filter((s) => typeof s.quantity === "number" && Number.isFinite(s.quantity) && s.quantity >= 0);

      const response = await fetch(`/api/inventories/${activeInventory.id}/save-stocks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stocks: payloadStocks }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to save inventory stocks");
      }

      // Notify other islands *once* after save succeeds (they reload stocks on STOCK_CHANGED).
      const nodeIds = new Set<NodeId>([...previousSaved.keys(), ...stocks.keys()]);
      for (const nodeId of nodeIds) {
        const prev = previousSaved.get(nodeId) ?? 0;
        const next = stocks.get(nodeId)?.quantity ?? 0;
        if (Math.abs(next - prev) > EPSILON) {
          await emitStockChanged(nodeId, next, prev);
          break;
        }
      }

      // Mark working copy as saved.
      const newSavedStocks = new Map<NodeId, number>();
      for (const [nodeId, stock] of stocks.entries()) {
        newSavedStocks.set(nodeId, stock.quantity);
      }
      setSavedStocks(newSavedStocks);
      setHasChanges(false);

      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save inventory");
      return false;
    } finally {
      setLoading(false);
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
    }
  }
  
  async function handleStockUpdate(nodeId: NodeId, quantity: number) {
    setError(null);

    const current = stocks.get(nodeId) || { nodeId, quantity: 0, lastUpdated: new Date() };
    const newQuantity = current.quantity + quantity;

    if (newQuantity < 0) {
      setError(`Insufficient stock. Current: ${current.quantity}, Required: ${Math.abs(quantity)}`);
      return;
    }

    const updatedStocks = new Map(stocks);
    updatedStocks.set(nodeId, { ...current, quantity: newQuantity, lastUpdated: new Date() });
    setStocks(updatedStocks);
    setWorkingFromStocks(updatedStocks);

    checkForChanges(updatedStocks, savedStocks);

    setEditingStock(null);
    setEditQuantity(0);
  }

  function checkForChanges(currentStocks: Map<NodeId, Stock>, savedState: Map<NodeId, number>) {
    let hasChangesFlag = false;
    
    // Check if any stock quantity differs from saved state
    for (const [nodeId, stock] of currentStocks.entries()) {
      const savedQuantity = savedState.get(nodeId) || 0;
      if (Math.abs(stock.quantity - savedQuantity) > 0.001) { // Use small epsilon for float comparison
        hasChangesFlag = true;
        break;
      }
    }
    
    // Also check if any saved stock is missing in current (quantity became 0)
    for (const [nodeId, savedQuantity] of savedState.entries()) {
      const currentStock = currentStocks.get(nodeId);
      if (!currentStock || Math.abs(currentStock.quantity - savedQuantity) > 0.001) {
        hasChangesFlag = true;
        break;
      }
    }
    
    setHasChanges(hasChangesFlag);
  }
  
  function getReadinessStatus(nodeId: NodeId): "ready" | "low_stock" | "insufficient" {
    // Check if node exists in graph before checking readiness
    if (!graph.nodes.has(nodeId)) {
      return "insufficient";
    }
    
    const stockMap = new Map<NodeId, number>();
    for (const [id, stock] of stocks.entries()) {
      stockMap.set(id, stock.quantity);
    }
    return getProductionReadiness(graph, nodeId, stockMap, lowStockThreshold);
  }
  
  function getReadinessColor(status: "ready" | "low_stock" | "insufficient"): string {
    switch (status) {
      case "ready":
        return "#10b981";
      case "low_stock":
        return "#f59e0b";
      case "insufficient":
        return "#ef4444";
    }
  }
  
  function getReadinessLabel(status: "ready" | "low_stock" | "insufficient"): string {
    switch (status) {
      case "ready":
        return "Ready";
      case "low_stock":
        return "Low Stock";
      case "insufficient":
        return "Insufficient";
    }
  }
  
  const filteredNodes = nodes.filter(node => {
    if (filterType === "all") return true;
    return node.type === filterType;
  });
  
  const sortedNodes = [...filteredNodes].sort((a, b) => {
    const stockA = stocks.get(a.id)?.quantity || 0;
    const stockB = stocks.get(b.id)?.quantity || 0;
    return stockA - stockB; // Sort by stock level (lowest first)
  });

  // Stock quantities map used for craftability checks.
  const stockQuantities = new Map<NodeId, number>();
  for (const [id, s] of stocks.entries()) {
    stockQuantities.set(id, s.quantity);
  }
  
  if (loading && stocks.size === 0) {
    return (
      <div class="card">
        <h2>Stock Dashboard</h2>
        <p>Loading...</p>
      </div>
    );
  }
  
  return (
    <div class="card">
      <h2>Stock Dashboard</h2>
      
      {error && <div class="error">{error}</div>}

      {showUnsavedSwitchPrompt && pendingInventorySwitchId && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1rem",
            zIndex: 30,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setShowUnsavedSwitchPrompt(false);
              setPendingInventorySwitchId(null);
            }
          }}
        >
          <div
            style={{
              background: "#fff",
              borderRadius: "8px",
              padding: "1rem",
              maxWidth: "520px",
              width: "100%",
              boxShadow: "0 10px 25px rgba(0,0,0,0.1)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0, marginBottom: "0.5rem" }}>Unsaved changes</h3>
            <p style={{ marginTop: 0, marginBottom: "1rem", color: "#4b5563" }}>
              You have unsaved stock changes. What would you like to do before switching inventories?
            </p>
            <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button
                class="button"
                disabled={loading}
                onClick={async () => {
                  const targetId = pendingInventorySwitchId;
                  const ok = await handleSave();
                  if (ok && targetId) {
                    setShowUnsavedSwitchPrompt(false);
                    setPendingInventorySwitchId(null);
                    await activateInventory(targetId);
                  }
                }}
              >
                Save & Switch
              </button>
              <button
                class="button button-secondary"
                disabled={loading}
                onClick={async () => {
                  const targetId = pendingInventorySwitchId;
                  setShowUnsavedSwitchPrompt(false);
                  setPendingInventorySwitchId(null);
                  if (targetId) {
                    await activateInventory(targetId);
                  }
                }}
              >
                Discard & Switch
              </button>
              <button
                class="button button-secondary"
                disabled={loading}
                onClick={() => {
                  setShowUnsavedSwitchPrompt(false);
                  setPendingInventorySwitchId(null);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {showUnsavedDeleteInventoryPrompt && pendingDeleteInventoryId && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1rem",
            zIndex: 30,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setShowUnsavedDeleteInventoryPrompt(false);
              setPendingDeleteInventoryId(null);
            }
          }}
        >
          <div
            style={{
              background: "#fff",
              borderRadius: "8px",
              padding: "1rem",
              maxWidth: "560px",
              width: "100%",
              boxShadow: "0 10px 25px rgba(0,0,0,0.1)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0, marginBottom: "0.5rem" }}>Unsaved changes</h3>
            <p style={{ marginTop: 0, marginBottom: "1rem", color: "#4b5563" }}>
              You have unsaved stock changes. What would you like to do before deleting this inventory?
            </p>
            <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button
                class="button"
                disabled={loading}
                onClick={async () => {
                  const id = pendingDeleteInventoryId;
                  const ok = await handleSave();
                  if (ok && id) {
                    setShowUnsavedDeleteInventoryPrompt(false);
                    setPendingDeleteInventoryId(null);
                    await performDeleteInventory(id);
                  }
                }}
              >
                Save & Delete
              </button>
              <button
                class="button button-secondary"
                style={{ background: "#ef4444", color: "white", border: "none" }}
                disabled={loading}
                onClick={async () => {
                  const id = pendingDeleteInventoryId;
                  setShowUnsavedDeleteInventoryPrompt(false);
                  setPendingDeleteInventoryId(null);
                  if (id) {
                    await performDeleteInventory(id);
                  }
                }}
              >
                Discard & Delete
              </button>
              <button
                class="button button-secondary"
                disabled={loading}
                onClick={() => {
                  setShowUnsavedDeleteInventoryPrompt(false);
                  setPendingDeleteInventoryId(null);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {showDeleteInventoryConfirm && pendingDeleteInventoryId && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1rem",
            zIndex: 30,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setShowDeleteInventoryConfirm(false);
              setPendingDeleteInventoryId(null);
            }
          }}
        >
          <div
            style={{
              background: "#fff",
              borderRadius: "8px",
              padding: "1rem",
              maxWidth: "560px",
              width: "100%",
              boxShadow: "0 10px 25px rgba(0,0,0,0.1)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0, marginBottom: "0.5rem" }}>Delete inventory?</h3>
            <p style={{ marginTop: 0, marginBottom: "0.5rem", color: "#4b5563" }}>
              This will permanently delete this inventory and all its stock entries.
            </p>
            <p style={{ marginTop: 0, marginBottom: "1rem", color: "#6b7280", fontSize: "0.875rem" }}>
              If this inventory is active, the server will switch the active inventory back to the default one.
            </p>
            <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button
                class="button"
                style={{ background: "#ef4444", color: "white", border: "none" }}
                disabled={loading}
                onClick={async () => {
                  const id = pendingDeleteInventoryId;
                  setShowDeleteInventoryConfirm(false);
                  setPendingDeleteInventoryId(null);
                  if (id) {
                    await performDeleteInventory(id);
                  }
                }}
              >
                Delete
              </button>
              <button
                class="button button-secondary"
                disabled={loading}
                onClick={() => {
                  setShowDeleteInventoryConfirm(false);
                  setPendingDeleteInventoryId(null);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {showDeleteConfirm && pendingDeleteNodeId && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1rem",
            zIndex: 30,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setShowDeleteConfirm(false);
              setPendingDeleteNodeId(null);
              setPendingDeleteDependents([]);
            }
          }}
        >
          <div
            style={{
              background: "#fff",
              borderRadius: "8px",
              padding: "1rem",
              maxWidth: "560px",
              width: "100%",
              boxShadow: "0 10px 25px rgba(0,0,0,0.1)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0, marginBottom: "0.5rem" }}>Cannot delete: used by other nodes</h3>
            <p style={{ marginTop: 0, marginBottom: "0.75rem", color: "#4b5563" }}>
              Remove this node from these inputs first:
            </p>
            <div
              style={{
                maxHeight: "220px",
                overflowY: "auto",
                border: "1px solid #e5e7eb",
                borderRadius: "6px",
                padding: "0.5rem 0.75rem",
                marginBottom: "1rem",
                background: "#f9fafb",
              }}
            >
              {pendingDeleteDependents.map((label) => (
                <div key={label} style={{ padding: "0.125rem 0" }}>
                  {label}
                </div>
              ))}
            </div>

            <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button
                class="button button-secondary"
                disabled={loading}
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setPendingDeleteNodeId(null);
                  setPendingDeleteDependents([]);
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* Inventory Management Section */}
      <div style={{ marginBottom: "1rem", padding: "0.75rem", background: "#f9fafb", borderRadius: "4px" }}>
        <div style={{ display: "flex", gap: "1rem", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: "1rem", alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <label class="label" style={{ margin: 0 }}>Active Inventory:</label>
              <select
                class="input"
                value={activeInventory?.id || ""}
                onChange={(e) => {
                  const selectedId = (e.target as HTMLSelectElement).value;
                  if (selectedId) {
                    handleInventoryChange(selectedId);
                  }
                }}
                style={{ width: "auto", minWidth: "150px" }}
              >
                {inventories.map(inv => (
                  <option key={inv.id} value={inv.id}>
                    {inv.name} {inv.isDefault ? "(Default)" : ""}
                  </option>
                ))}
              </select>
            </div>
            
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <label class="label" style={{ margin: 0 }}>Filter by type:</label>
              <select
                class="input"
                value={filterType}
                onChange={(e) => setFilterType((e.target as HTMLSelectElement).value as NodeType | "all")}
                style={{ width: "auto" }}
              >
                <option value="all">All</option>
                <option value="ingredient">Ingredients</option>
                <option value="recipe">Recipes</option>
                <option value="product">Products</option>
              </select>
            </div>
          </div>
          
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
            {!showCreateInventory ? (
              <>
                <button
                  class="button icon-button"
                  style={{ padding: "0.5rem 1rem", fontSize: "0.875rem" }}
                  onClick={handleReload}
                  disabled={loading}
                  title="Reload"
                  aria-label="Reload"
                >
                  ↻
                </button>
                <button
                  class="button icon-button"
                  style={{ padding: "0.5rem 1rem", fontSize: "0.875rem" }}
                  onClick={handleSave}
                  disabled={loading || !activeInventory || !hasChanges}
                  title="Save"
                  aria-label="Save"
                >
                  ⤓
                </button>
                <button
                  class="button button-secondary"
                  style={{
                    padding: "0.5rem 1rem",
                    fontSize: "0.875rem",
                    background: "#ef4444",
                    color: "white",
                    border: "none",
                  }}
                  onClick={requestDeleteInventory}
                  disabled={loading || !activeInventory || activeInventory.isDefault}
                >
                  Delete Inventory
                </button>
                <button
                  class="button icon-button"
                  style={{ padding: "0.5rem 1rem", fontSize: "0.875rem" }}
                  onClick={() => setShowCreateInventory(true)}
                  title="Create New"
                  aria-label="Create New"
                >
                  ＋
                </button>
              </>
            ) : (
              <>
                <input
                  type="text"
                  class="input"
                  placeholder="Inventory name"
                  value={newInventoryName}
                  onInput={(e) => setNewInventoryName((e.target as HTMLInputElement).value)}
                  style={{ width: "150px" }}
                  autoFocus
                />
                <label style={{ display: "flex", alignItems: "center", gap: "0.25rem", fontSize: "0.875rem" }}>
                  <input
                    type="checkbox"
                    checked={copyFromActive}
                    onChange={(e) => setCopyFromActive((e.target as HTMLCheckboxElement).checked)}
                  />
                  Copy from active
                </label>
                <button
                  class="button"
                  style={{ padding: "0.5rem 1rem", fontSize: "0.875rem" }}
                  onClick={handleCreateInventory}
                  disabled={!newInventoryName.trim()}
                >
                  Create
                </button>
                <button
                  class="button button-secondary"
                  style={{ padding: "0.5rem 1rem", fontSize: "0.875rem" }}
                  onClick={() => {
                    setShowCreateInventory(false);
                    setNewInventoryName("");
                    setCopyFromActive(false);
                  }}
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Current Inventory Summary */}
      <div
        style={{
          marginBottom: "1rem",
          padding: "0.75rem",
          background: "#ffffff",
          borderRadius: "4px",
          border: "1px solid #e5e7eb",
          display: "flex",
          gap: "0.75rem",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "#6b7280" }}>
            Current inventory
          </div>
          <div style={{ fontSize: "0.875rem", color: "#111827" }}>
            Total price
          </div>
        </div>
        <div style={{ fontSize: "1.125rem", fontWeight: 700, color: "#111827" }}>
          {currencyFmt.format(totalInventoryPrice)}
        </div>
      </div>
      
      <div style={{ maxHeight: "500px", overflowY: "auto" }}>
        <table class="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Stock</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedNodes.map(node => {
              const stock = stocks.get(node.id) || { nodeId: node.id, quantity: 0, lastUpdated: new Date() };
              const readiness = getReadinessStatus(node.id);
              const isEditing = editingStock === node.id;
              const isIngredient = node.type === "ingredient";
              const isRecipeOrProduct = node.type === "recipe" || node.type === "product";
              const hasAnyStock = stock.quantity > 0.000_001;
              const craftable = isRecipeOrProduct
                ? checkStockAvailability(
                  graph,
                  node.id,
                  1,
                  stockQuantities,
                ).available
                : false;

              // Display rules:
              // - Ingredients: only warn at zero stock.
              // - Recipes/Products: warn when not craftable.
              const shouldWarn = (isIngredient && !hasAnyStock) || (isRecipeOrProduct && !craftable);
              
              return (
                <tr
                  key={node.id}
                  style={{
                    background: shouldWarn ? "#fef2f2" : undefined,
                  }}
                >
                  <td>{node.name}</td>
                  <td>
                    {isEditing ? (
                      <input
                        type="number"
                        class="input"
                        value={editQuantity}
                        onInput={(e) => setEditQuantity(parseFloat((e.target as HTMLInputElement).value) || 0)}
                        style={{ width: "100px" }}
                        autoFocus
                      />
                    ) : (
                      <span style={{ fontWeight: stock.quantity === 0 ? 600 : 400 }}>
                        {stock.quantity.toFixed(2)}
                      </span>
                    )}
                  </td>
                  <td>
                    {isEditing ? (
                      <div style={{ display: "flex", gap: "0.25rem" }}>
                        <button
                          class="button icon-button"
                          style={{ padding: "0.25rem 0.5rem", fontSize: "0.75rem" }}
                          onClick={() => {
                            const diff = editQuantity - stock.quantity;
                            handleStockUpdate(node.id, diff);
                          }}
                          disabled={loading}
                          title="Save"
                          aria-label="Save"
                        >
                          ⤓
                        </button>
                        <button
                          class="button button-secondary"
                          style={{
                            padding: "0.25rem 0.5rem",
                            fontSize: "0.75rem",
                            background: "#ef4444",
                            color: "white",
                            border: "none",
                          }}
                          onClick={() => {
                            requestDelete(node.id);
                          }}
                          disabled={loading || stock.quantity <= 0}
                        >
                          Delete
                        </button>
                        <button
                          class="button button-secondary"
                          style={{ padding: "0.25rem 0.5rem", fontSize: "0.75rem" }}
                          onClick={() => {
                            setEditingStock(null);
                            setEditQuantity(0);
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div style={{ display: "flex", gap: "0.25rem" }}>
                        <button
                          class="button icon-button"
                          style={{ padding: "0.25rem 0.5rem", fontSize: "0.75rem" }}
                          onClick={() => {
                            setEditingStock(node.id);
                            setEditQuantity(stock.quantity);
                          }}
                          title="Edit"
                          aria-label="Edit"
                        >
                          ✎
                        </button>
                        <button
                          class="button"
                          style={{ padding: "0.25rem 0.5rem", fontSize: "0.75rem" }}
                          onClick={() => handleStockUpdate(node.id, 1)}
                          disabled={loading}
                        >
                          +1
                        </button>
                        <button
                          class="button button-secondary"
                          style={{ padding: "0.25rem 0.5rem", fontSize: "0.75rem" }}
                          onClick={() => handleStockUpdate(node.id, -1)}
                          disabled={loading || stock.quantity <= 0}
                        >
                          -1
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      
      {sortedNodes.length === 0 && (
        <p style={{ color: "#6b7280", marginTop: "1rem" }}>No nodes found.</p>
      )}
    </div>
  );
}

