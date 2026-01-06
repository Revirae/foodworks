import { useState, useEffect, useRef } from "preact/hooks";
import { useSignalEffect } from "@preact/signals";
import type { Node, NodeId, ProductionSimulation } from "../domain/types.ts";
import { eventBus } from "../events/bus.ts";
import { productionSimulatorOpen, productionSimulatorTargetId } from "../state/entitySignals.ts";
import { workingStockQuantities } from "../state/inventorySignals.ts";
import { createEmptyGraph, addNode } from "../domain/dag.ts";
import { checkStockAvailability } from "../domain/stock.ts";

interface SimulationHistory {
  id: string;
  simulation: ProductionSimulation;
  timestamp: Date;
}

interface InputTreeNode {
  nodeId: NodeId;
  required: number;
  available: number;
  sufficient: boolean;
  children: InputTreeNode[];
}

export default function ProductionSimulator() {
  const [quantity, setQuantity] = useState(1);
  const [maxQuantity, setMaxQuantity] = useState<number | null>(null);
  const [loadingMax, setLoadingMax] = useState(false);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [graph, setGraph] = useState(createEmptyGraph());
  const [simulation, setSimulation] = useState<ProductionSimulation | null>(null);
  const [loading, setLoading] = useState(false);
  const [producing, setProducing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<SimulationHistory[]>([]);
  const [expandedNodes, setExpandedNodes] = useState<Set<NodeId>>(new Set());
  const prevOpenRef = useRef(false);
  const craftableCacheRef = useRef<Map<string, boolean>>(new Map());

  // IMPORTANT: craftability depends on the current working stock.
  // Clear cache whenever working stock changes (e.g. after "Produce" consumes inputs).
  useSignalEffect(() => {
    workingStockQuantities.value; // track
    craftableCacheRef.current.clear();
  });
  
  useEffect(() => {
    loadNodes();
    
    const unsubscribe = eventBus.subscribe("ENTITY_UPDATED", () => {
      loadNodes();
    });
    
    return () => {
      unsubscribe();
    };
  }, []);
  
  // Auto-load max producible when modal opens
  useEffect(() => {
    const isOpen = productionSimulatorOpen.value;
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = isOpen;
    
    if (isOpen && !wasOpen && productionSimulatorTargetId.value) {
      setSimulation(null);
      setQuantity(1);
      setMaxQuantity(null);
      setError(null);
      loadMaxProducible();
    }
  }, [productionSimulatorOpen.value, productionSimulatorTargetId.value]);

  async function loadMaxProducible() {
    const currentSelectedNodeId = productionSimulatorTargetId.value;
    if (!currentSelectedNodeId) {
      return;
    }

    setLoadingMax(true);
    setError(null);

    try {
      const working = workingStockQuantities.value;
      const stockOverrides = working
        ? Array.from(working.entries()).map(([nodeId, quantity]) => ({ nodeId, quantity }))
        : undefined;

      const response = await fetch("/api/production/max", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeId: currentSelectedNodeId,
          ...(stockOverrides ? { stockOverrides } : {}),
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to load max producible");
      }

      const result = await response.json() as { maxQuantity: number };
      setMaxQuantity(result.maxQuantity);
      
      // Set default quantity to max (or 1 if max > 0)
      if (result.maxQuantity > 0) {
        setQuantity(result.maxQuantity);
      } else {
        setQuantity(1);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load max producible");
      setMaxQuantity(0);
    } finally {
      setLoadingMax(false);
    }
  }
  
  async function loadNodes() {
    try {
      const [ingredientsRes, recipesRes, productsRes] = await Promise.all([
        fetch("/api/ingredients"),
        fetch("/api/recipes"),
        fetch("/api/products"),
      ]);
      
      const ingredients: Node[] = await ingredientsRes.json();
      const recipes: Node[] = await recipesRes.json();
      const products: Node[] = await productsRes.json();
      
      const all = [...ingredients, ...recipes, ...products];
      setNodes(all);

      // Build a minimal graph (edges not needed for craftability simulation; node inputs are the source of truth).
      const g = createEmptyGraph();
      for (const n of all) addNode(g, n);
      setGraph(g);
      craftableCacheRef.current.clear();
    } catch (err) {
      console.error("Failed to load nodes:", err);
    }
  }
  
  async function handleSimulate() {
    const currentSelectedNodeId = productionSimulatorTargetId.value;
    if (!currentSelectedNodeId) {
      setError("Please select a node to simulate");
      return;
    }
    
    // Validate integer quantity
    const qtyInt = Math.floor(quantity);
    if (qtyInt <= 0 || !Number.isFinite(qtyInt) || qtyInt !== quantity) {
      setError("Quantity must be a positive integer");
      return;
    }
    if (maxQuantity !== null && qtyInt > maxQuantity) {
      setError(`Quantity cannot exceed maximum producible (${maxQuantity})`);
      return;
    }
    
    setLoading(true);
    setError(null);
    
    try {
      const working = workingStockQuantities.value;
      const stockOverrides = working
        ? Array.from(working.entries()).map(([nodeId, quantity]) => ({ nodeId, quantity }))
        : undefined;

      const response = await fetch("/api/production/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeId: currentSelectedNodeId,
          quantity: Math.floor(quantity),
          ...(stockOverrides ? { stockOverrides } : {}),
        }),
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to simulate production");
      }
      
      const simResult: ProductionSimulation = await response.json();
      setSimulation(simResult);
      
      // Add to history
      const historyItem: SimulationHistory = {
        id: `${Date.now()}-${Math.random()}`,
        simulation: simResult,
        timestamp: new Date(),
      };
      setHistory([historyItem, ...history].slice(0, 10)); // Keep last 10
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to simulate production");
    } finally {
      setLoading(false);
    }
  }
  
  function formatTime(minutes: number): string {
    if (minutes < 60) {
      return `${minutes.toFixed(1)} minutes`;
    }
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins.toFixed(0)}m`;
  }

  function buildInputTree(
    nodeId: NodeId,
    requiredQty: number,
    currentStock: Map<NodeId, number>,
    visited: Set<NodeId> = new Set(),
  ): InputTreeNode | null {
    if (visited.has(nodeId)) return null; // Prevent cycles
    visited.add(nodeId);

    const node = nodes.find(n => n.id === nodeId);
    if (!node) return null;

    const available = currentStock.get(nodeId) || 0;
    const sufficient = available >= requiredQty;

    if (node.type === "ingredient") {
      // Leaf node - no children
      return {
        nodeId,
        required: requiredQty,
        available,
        sufficient,
        children: [],
      };
    }

    // Recipe or Product - build children from inputs
    const inputs = node.type === "recipe"
      ? (node as import("../domain/types.ts").Recipe).inputs
      : (node as import("../domain/types.ts").Product).inputs;

    const children: InputTreeNode[] = [];
    for (const portion of inputs) {
      const childRequired = requiredQty * portion.quantity;
      const child = buildInputTree(portion.nodeId, childRequired, currentStock, new Set(visited));
      if (child) {
        children.push(child);
      }
    }

    return {
      nodeId,
      required: requiredQty,
      available,
      sufficient,
      children,
    };
  }

  function getCurrentStockMap(): Map<NodeId, number> {
    const currentStock = new Map<NodeId, number>();
    const working = workingStockQuantities.value;
    if (working) {
      for (const [nodeId, qty] of working.entries()) currentStock.set(nodeId, qty);
      return currentStock;
    }
    // Fallback: best-effort from simulation data (ingredient-only)
    if (simulation) {
      for (const input of simulation.requiredInputs) currentStock.set(input.nodeId, input.available);
    }
    return currentStock;
  }

  function getInputTree(): { tree: InputTreeNode[]; currentStock: Map<NodeId, number> } {
    if (!simulation || !productionSimulatorTargetId.value) return { tree: [], currentStock: new Map() };

    const currentStock = getCurrentStockMap();

    const targetNode = nodes.find(n => n.id === simulation.targetNodeId);
    if (!targetNode || (targetNode.type !== "recipe" && targetNode.type !== "product")) {
      return { tree: [], currentStock };
    }

    const inputs = targetNode.type === "recipe"
      ? (targetNode as import("../domain/types.ts").Recipe).inputs
      : (targetNode as import("../domain/types.ts").Product).inputs;

    const tree: InputTreeNode[] = [];
    for (const portion of inputs) {
      const requiredQty = simulation.quantity * portion.quantity;
      const node = buildInputTree(portion.nodeId, requiredQty, currentStock);
      if (node) {
        tree.push(node);
      }
    }

    return { tree, currentStock };
  }

  function toggleExpanded(nodeId: NodeId) {
    const next = new Set(expandedNodes);
    if (next.has(nodeId)) {
      next.delete(nodeId);
    } else {
      next.add(nodeId);
    }
    setExpandedNodes(next);
  }

  function renderInputTreeNode(node: InputTreeNode, currentStock: Map<NodeId, number>, depth: number = 0): JSX.Element {
    const nodeData = nodes.find(n => n.id === node.nodeId);
    const isExpanded = expandedNodes.has(node.nodeId);
    const hasChildren = node.children.length > 0;
    const isIngredient = nodeData?.type === "ingredient";

    // If a recipe/product is short in stock but can be produced from its own inputs, show a different status.
    let status: "sufficient" | "craftable" | "shortage" = "shortage";
    if (node.sufficient) {
      status = "sufficient";
    } else if (!isIngredient && graph.nodes.has(node.nodeId)) {
      // IMPORTANT: Required qty can be fractional (due to portion quantities).
      // When a recipe/product is used as an input, the engine can satisfy fractional
      // requirements by producing integer units (ceil(shortfall)) and consuming the needed fraction.
      // So we consider it "craftable" only if we can produce ceil(required - available) whole units.
      const missing = Math.max(0, node.required - node.available);
      const produceUnits = Math.ceil(missing);
      const key = `${node.nodeId}:produce:${produceUnits}`;
      const cached = craftableCacheRef.current.get(key);
      const craftable = typeof cached === "boolean"
        ? cached
        : (() => {
          try {
            if (produceUnits <= 0) {
              craftableCacheRef.current.set(key, true);
              return true;
            }
            const availability = checkStockAvailability(graph, node.nodeId, produceUnits, currentStock);
            craftableCacheRef.current.set(key, availability.available);
            return availability.available;
          } catch {
            craftableCacheRef.current.set(key, false);
            return false;
          }
        })();
      status = craftable ? "craftable" : "shortage";
    }

    const rowBg = status === "sufficient"
      ? "#f0fdf4"
      : status === "craftable"
      ? "#eff6ff"
      : "#fef2f2";

    return (
      <>
        <tr
          key={node.nodeId}
          style={{
            background: rowBg,
          }}
        >
          <td style={{ paddingLeft: `${depth * 1.5}rem` }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              {hasChildren && (
                <button
                  onClick={() => toggleExpanded(node.nodeId)}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    padding: "0.25rem",
                    fontSize: "0.875rem",
                    color: "#6b7280",
                  }}
                >
                  {isExpanded ? "▼" : "▶"}
                </button>
              )}
              {!hasChildren && <span style={{ width: "1.5rem", display: "inline-block" }} />}
              <span>{nodeData?.name || node.nodeId}</span>
              {!isIngredient && (
                <span style={{ fontSize: "0.75rem", color: "#9ca3af", marginLeft: "0.25rem" }}>
                  ({nodeData?.type})
                </span>
              )}
            </div>
          </td>
          <td>{node.required.toFixed(2)}</td>
          <td>{node.available.toFixed(2)}</td>
          <td>
            {status === "sufficient" && (
              <span style={{ color: "#10b981" }}>✓ Sufficient</span>
            )}
            {status === "craftable" && (
              <span style={{ color: "#3b82f6" }}>
                ↻ Will produce ({(node.required - node.available).toFixed(2)} needed)
              </span>
            )}
            {status === "shortage" && (
              <span style={{ color: "#ef4444" }}>
                ✗ Shortage: {(node.required - node.available).toFixed(2)}
              </span>
            )}
          </td>
        </tr>
        {hasChildren && isExpanded && node.children.map(child => renderInputTreeNode(child, currentStock, depth + 1))}
      </>
    );
  }
  
  function handleClose() {
    productionSimulatorOpen.value = false;
    productionSimulatorTargetId.value = null;
    setSimulation(null);
    setQuantity(1);
    setMaxQuantity(null);
    setError(null);
  }
  
  function loadFromHistory(historyItem: SimulationHistory) {
    productionSimulatorTargetId.value = historyItem.simulation.targetNodeId;
    setQuantity(historyItem.simulation.quantity);
    setSimulation(historyItem.simulation);
  }

  async function handleProduce() {
    const currentSelectedNodeId = productionSimulatorTargetId.value;
    if (!currentSelectedNodeId || !simulation || !simulation.canProduce) {
      setError("Cannot produce - production not possible");
      return;
    }
    
    setProducing(true);
    setError(null);
    
    try {
      const working = workingStockQuantities.value;
      const stockOverrides = working
        ? Array.from(working.entries()).map(([nodeId, quantity]) => ({ nodeId, quantity }))
        : undefined;

      const response = await fetch("/api/production/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeId: currentSelectedNodeId,
          quantity: Math.floor(quantity),
          ...(stockOverrides ? { stockOverrides } : {}),
        }),
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to execute production");
      }

      const result = await response.json().catch(() => ({}));
      if (Array.isArray(result.updatedStockOverrides) && workingStockQuantities.value) {
        // Merge changes: preserve existing entries, update only changed nodes
        const next = new Map(workingStockQuantities.value);
        const EPS = 0.000_001;
        for (const s of result.updatedStockOverrides) {
          if (!s?.nodeId) continue;
          if (typeof s.quantity !== "number" || !Number.isFinite(s.quantity)) continue;
          if (s.quantity < 0) {
            // Negative quantities shouldn't happen, but handle gracefully
            console.warn(`Negative quantity for ${s.nodeId} in production result`);
            continue;
          }
          if (s.quantity <= EPS) {
            // Remove near-zero entries
            next.delete(s.nodeId);
          } else {
            // Update with new quantity
            next.set(s.nodeId, s.quantity);
          }
        }
        workingStockQuantities.value = next;
      } else if (Array.isArray(result.updatedStockOverrides)) {
        // No existing working copy, create new one from result
        const next = new Map<NodeId, number>();
        const EPS = 0.000_001;
        for (const s of result.updatedStockOverrides) {
          if (!s?.nodeId) continue;
          if (typeof s.quantity !== "number" || !Number.isFinite(s.quantity) || s.quantity < 0) continue;
          if (s.quantity > EPS) {
            next.set(s.nodeId, s.quantity);
          }
        }
        workingStockQuantities.value = next;
      }
      
      // Reload max producible with updated stock (prevents infinite production)
      await loadMaxProducible();
      
      // Clamp quantity to new max if it exceeds it
      if (maxQuantity !== null && quantity > maxQuantity) {
        setQuantity(Math.max(1, maxQuantity));
      }
      
      // Production successful - refresh simulation to show updated stock
      await handleSimulate();
      
      // Show success message briefly
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to execute production");
    } finally {
      setProducing(false);
    }
  }
  
  // Always return JSX and read signals in JSX for reactivity
  // Match EntityManager pattern exactly
  return (
    <>
      {productionSimulatorOpen.value && productionSimulatorTargetId.value && (() => {
        const selectedNodeId = productionSimulatorTargetId.value;
        const selectedNode = nodes.find(n => n.id === selectedNodeId);
        if (!selectedNodeId || !selectedNode) return null;
        
        return (
          <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
        zIndex: 20,
      }}
      onClick={(e) => {
        // Close on overlay click
        if (e.target === e.currentTarget) {
          handleClose();
        }
      }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: "8px",
          padding: "1rem",
          maxWidth: "800px",
          width: "100%",
          maxHeight: "90vh",
          overflowY: "auto",
          boxShadow: "0 10px 25px rgba(0,0,0,0.1)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h2 style={{ margin: 0 }}>Production Simulator</h2>
          <button
            class="button button-secondary"
            onClick={(e) => {
              handleClose();
            }}
          >
            Cancel
          </button>
        </div>
        
        {selectedNode && (
          <div style={{ marginBottom: "1rem", padding: "0.75rem", background: "#f9fafb", borderRadius: "4px" }}>
            <div class="info-box-content">
              <div class="info-box-content__label">Product</div>
              <div class="info-box-content__value">{selectedNode.name}</div>
            </div>
          </div>
        )}
        
        {error && <div class="error">{error}</div>}

        {loadingMax ? (
          <div style={{ padding: "1rem", textAlign: "center", color: "#6b7280" }}>
            Loading maximum producible...
          </div>
        ) : maxQuantity !== null ? (
          <>
            <div style={{ marginBottom: "1rem", padding: "0.75rem", background: maxQuantity > 0 ? "#f0fdf4" : "#fef2f2", borderRadius: "4px" }}>
              <div class="info-box-content">
                <div class="info-box-content__label">Maximum Producible</div>
                <div class="info-box-content__value" style={{ color: maxQuantity > 0 ? "#10b981" : "#ef4444" }}>
                  {maxQuantity} {maxQuantity === 1 ? "unit" : "units"}
                </div>
              </div>
              {maxQuantity === 0 && (
                <div style={{ marginTop: "0.5rem", fontSize: "0.875rem", color: "#6b7280" }}>
                  Cannot produce - insufficient ingredients or missing inputs.
                </div>
              )}
            </div>

            {maxQuantity > 0 && (
              <>
                <button
                  class="button"
                  onClick={(e) => {
                    handleSimulate();
                  }}
                  disabled={!selectedNodeId || quantity <= 0 || quantity > maxQuantity || loading}
                  style={{ width: "100%", marginBottom: "1rem" }}
                >
                  {loading ? "Simulating..." : "Simulate Production"}
                </button>
                
                <div class="form-group" style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                  <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.75rem", marginBottom: "0.5rem" }}>
                    <label class="label" style={{ margin: 0, flex: "0 0 auto" }}>Quantity</label>
                    <input
                      type="number"
                      class="input"
                      value={quantity}
                      onInput={(e) => {
                        const val = parseInt((e.target as HTMLInputElement).value, 10) || 0;
                        const clamped = Math.max(1, Math.min(maxQuantity, val));
                        setQuantity(clamped);
                      }}
                      min="1"
                      max={maxQuantity}
                      step="1"
                      style={{ width: "150px", flex: "0 0 auto" }}
                    />
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "#6b7280" }}>
                    Enter a value between 1 and {maxQuantity}
                  </div>
                </div>
              </>
            )}
          </>
        ) : (
          <div style={{ padding: "1rem", textAlign: "center", color: "#6b7280" }}>
            Unable to determine maximum producible
          </div>
        )}
        
        {simulation && (
          <div style={{ marginTop: "1rem" }}>
            <div
              style={{
                padding: "1rem",
                background: simulation.canProduce ? "#f0fdf4" : "#fef2f2",
                borderRadius: "4px",
                marginBottom: "1rem",
              }}
            >
              <h3 style={{ marginTop: 0, marginBottom: "0.5rem" }}>
                {simulation.canProduce ? "✅ Production Possible" : "❌ Production Not Possible"}
              </h3>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.5rem" }}>
                <span>Total Cost:</span>
                <span style={{ fontWeight: 600, color: "#3b82f6" }}>${simulation.totalCost.toFixed(2)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: simulation.canProduce ? "0.5rem" : "0" }}>
                <span>Total Time:</span>
                <span style={{ fontWeight: 600, color: "#10b981" }}>{formatTime(simulation.totalTime)}</span>
              </div>
              {simulation.canProduce && (
                <button
                  class="button"
                  onClick={handleProduce}
                  disabled={producing || loading}
                  style={{ 
                    width: "100%", 
                    marginTop: "0.75rem",
                    background: "#10b981",
                    color: "white",
                    border: "none",
                  }}
                >
                  {producing ? "Producing..." : "Produce"}
                </button>
              )}
            </div>
            
            <div style={{ marginBottom: "1rem" }}>
              <h4 style={{ marginTop: 0, marginBottom: "0.5rem" }}>Required Inputs</h4>
              <div style={{ maxHeight: "200px", overflowY: "auto" }}>
                <table class="table">
                  <thead>
                    <tr>
                      <th>Node</th>
                      <th>Required</th>
                      <th>Available</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const { tree, currentStock } = getInputTree();
                      return tree.map((n) => renderInputTreeNode(n, currentStock));
                    })()}
                  </tbody>
                </table>
              </div>
            </div>
            
            <div>
              <h4 style={{ marginTop: 0, marginBottom: "0.5rem" }}>Stock Outcome</h4>
              <div style={{ maxHeight: "200px", overflowY: "auto" }}>
                <table class="table">
                  <thead>
                    <tr>
                      <th>Node</th>
                      <th>Before</th>
                      <th>After</th>
                      <th>Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {simulation.stockOutcome.map(outcome => {
                      const node = nodes.find(n => n.id === outcome.nodeId);
                      const change = outcome.after - outcome.before;
                      return (
                        <tr key={outcome.nodeId}>
                          <td>{node?.name || outcome.nodeId}</td>
                          <td>{outcome.before.toFixed(2)}</td>
                          <td>{outcome.after.toFixed(2)}</td>
                          <td style={{ color: change >= 0 ? "#10b981" : "#ef4444" }}>
                            {change >= 0 ? "+" : ""}{change.toFixed(2)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
        
        {history.length > 0 && (
          <div style={{ marginTop: "1rem", paddingTop: "1rem", borderTop: "1px solid #e5e7eb" }}>
            <h4 style={{ marginTop: 0, marginBottom: "0.5rem" }}>Simulation History</h4>
            <div style={{ maxHeight: "150px", overflowY: "auto" }}>
              {history.map(item => (
                <div
                  key={item.id}
                  style={{
                    padding: "0.5rem",
                    marginBottom: "0.5rem",
                    background: "#f9fafb",
                    borderRadius: "4px",
                    cursor: "pointer",
                  }}
                  onClick={() => loadFromHistory(item)}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <strong>{nodes.find(n => n.id === item.simulation.targetNodeId)?.name || item.simulation.targetNodeId}</strong>
                      {" "}× {item.simulation.quantity}
                    </div>
                    <div style={{ fontSize: "0.875rem", color: "#6b7280" }}>
                      {item.timestamp.toLocaleTimeString()}
                    </div>
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "#6b7280", marginTop: "0.25rem" }}>
                    ${item.simulation.totalCost.toFixed(2)} / {formatTime(item.simulation.totalTime)}
                    {" "}• {item.simulation.canProduce ? "✓" : "✗"}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
          </div>
        </div>
        );
      })()}
    </>
  );
}
