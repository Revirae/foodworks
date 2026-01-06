import { useState, useEffect, useRef } from "preact/hooks";
import type { Node, NodeId, NodeType, Stock, Inventory } from "../domain/types.ts";
import { selectedNodeId, selectedNodeType, editingEntity, editorNodeType, isEditorOpen, productionSimulatorOpen, productionSimulatorTargetId } from "../state/entitySignals.ts";
import { workingStockQuantities } from "../state/inventorySignals.ts";
import { useWorkspaceData, type WorkspaceNodeRow } from "./workspace/useWorkspaceData.ts";
import InventoryPopover from "./workspace/InventoryPopover.tsx";
import EntityEditor from "./EntityEditor.tsx";
import ProductionSimulator from "./ProductionSimulator.tsx";
import CostTimeBreakdown from "./CostTimeBreakdown.tsx";
import { convertToDisplay } from "../utils/units.ts";
import { emitStockChanged } from "../events/bus.ts";

type EntityTab = "ingredient" | "recipe" | "product";

export default function Workspace() {
  const data = useWorkspaceData();
  const [entityTab, setEntityTab] = useState<EntityTab>("ingredient");
  const [searchQuery, setSearchQuery] = useState("");
  const [showInventoryPopover, setShowInventoryPopover] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [stockDraft, setStockDraft] = useState<number>(0);

  // Focus search on mount
  useEffect(() => {
    if (searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, []);

  // When editor opens / selection changes, preload stockDraft from working copy (or loaded stocks)
  useEffect(() => {
    const id = selectedNodeId.value;
    if (!isEditorOpen.value || !id) return;
    const fromWorking = workingStockQuantities.value?.get(id);
    const fromLoaded = data.stocks.get(id)?.quantity;
    const raw = typeof fromWorking === "number" ? fromWorking : (fromLoaded ?? 0);
    const safeRaw = Number.isFinite(raw) ? raw : 0;

    const row = data.rows.find((r) => r.node.id === id);
    if (row?.node.type === "ingredient") {
      const pkgSize = row.node.packageSize || 0;
      const packages = pkgSize > 0 ? safeRaw / pkgSize : 0;
      setStockDraft(Number.isFinite(packages) ? packages : 0);
    } else if (row?.node.type === "recipe") {
      const perUnitWeight = row.node.weight || 0;
      const recipeUnits = perUnitWeight > 0 ? safeRaw / perUnitWeight : 0;
      setStockDraft(Number.isFinite(recipeUnits) ? recipeUnits : 0);
    } else {
      setStockDraft(safeRaw);
    }
  }, [isEditorOpen.value, selectedNodeId.value]);

  // Filter rows based on search query
  const filteredRows = data.rows.filter((row) => {
    if (!searchQuery.trim()) return true;
    const query = searchQuery.toLowerCase();
    return (
      row.node.name.toLowerCase().includes(query) ||
      row.node.id.toLowerCase().includes(query) ||
      row.node.type.toLowerCase().includes(query)
    );
  });

  // Filter by entity type
  const entityFilteredRows = filteredRows.filter((row) => {
    return row.node.type === entityTab;
  });

  const displayRows: WorkspaceNodeRow[] = entityFilteredRows;

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

  function openCreate(type: EntityTab) {
    editingEntity.value = null;
    editorNodeType.value = type;
    isEditorOpen.value = true;
  }

  function openEdit(entity: Node) {
    editingEntity.value = entity;
    editorNodeType.value = entity.type;
    isEditorOpen.value = true;
    selectedNodeId.value = entity.id;
    selectedNodeType.value = entity.type;
  }

  function handleEditorClose() {
    isEditorOpen.value = false;
    editingEntity.value = null;
  }

  function handleEntitySaved(entity: Node) {
    selectedNodeId.value = entity.id;
    selectedNodeType.value = entity.type;
    setEntityTab(entity.type as EntityTab);
    // Commit stock draft to working copy ONLY when entity save succeeds.
    // This keeps stock edits scoped to the entity editor "Save" action.
    if (entity.type === "ingredient") {
      const pkgSize = entity.packageSize || 0;
      const qty = pkgSize > 0 ? stockDraft * pkgSize : 0;
      setWorkingStock(entity.id, qty);
    } else if (entity.type === "recipe") {
      const perUnitWeight = entity.weight || 0;
      const qty = perUnitWeight > 0 ? stockDraft * perUnitWeight : 0;
      setWorkingStock(entity.id, qty);
    } else {
      setWorkingStock(entity.id, stockDraft);
    }
    handleEditorClose();
    // Don't reset working stock edits when saving entity fields
    data.reloadEntities();
  }

  function setWorkingStock(nodeId: NodeId, nextQuantity: number) {
    setLocalError(null);
    const safe = Number.isFinite(nextQuantity) ? nextQuantity : 0;
    const clamped = Math.max(0, safe);

    // Update working copy (the hook will sync it back to stocks state)
    const working = new Map(workingStockQuantities.value || new Map());
    working.set(nodeId, clamped);
    workingStockQuantities.value = working;
  }

  async function handleInventoryChange(inventoryId: string) {
    try {
      const response = await fetch(`/api/inventories/${inventoryId}/activate`, {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error("Failed to activate inventory");
      }

      await data.loadStocks();
      await data.loadInventories();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Failed to switch inventory");
    }
  }

  async function handleSave() {
    if (!data.activeInventory) {
      setLocalError("No active inventory to save");
      return false;
    }

    if (!data.hasUnsavedChanges) {
      return true;
    }

    setLocalError(null);

    try {
      // Persist the WORKING COPY (source of truth for unsaved changes)
      const working = workingStockQuantities.value || new Map<NodeId, number>();
      const previousSaved = new Map(data.savedStocks);
      const payloadStocks = data.nodes
        .map((n) => ({ nodeId: n.id, quantity: working.get(n.id) ?? 0 }))
        .filter((s) => typeof s.quantity === "number" && Number.isFinite(s.quantity) && s.quantity >= 0);

      const response = await fetch(`/api/inventories/${data.activeInventory.id}/save-stocks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stocks: payloadStocks }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to save inventory stocks");
      }

      // Notify listeners once (mirrors old StockDashboard behavior).
      const changedIds = new Set<NodeId>([
        ...previousSaved.keys(),
        ...payloadStocks.map((p) => p.nodeId),
      ]);
      const EPS = 0.000_001;
      for (const nodeId of changedIds) {
        const prev = previousSaved.get(nodeId) ?? 0;
        const next = working.get(nodeId) ?? 0;
        if (Math.abs(next - prev) > EPS) {
          await emitStockChanged(nodeId, next, prev);
          break;
        }
      }

      const newSavedStocks = new Map<NodeId, number>();
      for (const n of data.nodes) {
        newSavedStocks.set(n.id, working.get(n.id) ?? 0);
      }
      data.setSavedStocks(newSavedStocks);
      data.setHasUnsavedChanges(false);
      await data.loadStocks();

      return true;
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Failed to save inventory");
      return false;
    }
  }

  async function handleReload() {
    await data.loadData();
  }

  const error = data.error || localError;
  const selectedRow = data.rows.find((r) => r.node.id === selectedNodeId.value);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: "600px" }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          gap: "1rem",
          alignItems: "center",
          padding: "1rem",
          background: "#fff",
          borderBottom: "1px solid #e5e7eb",
          marginBottom: "0",
        }}
      >
        <input
          ref={searchInputRef}
          type="text"
          class="input"
          placeholder="Search entities..."
          value={searchQuery}
          onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
          style={{ flex: 1, maxWidth: "400px" }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setSearchQuery("");
            } else if (e.key === "Enter" && displayRows.length > 0) {
              openEdit(displayRows[0].node);
            }
          }}
        />

        <div style={{ position: "relative", display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <button
            class="button"
            style={{
              padding: "0.5rem 1rem",
              fontSize: "0.875rem",
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
            }}
            onClick={() => setShowInventoryPopover(!showInventoryPopover)}
          >
            {data.activeInventory?.name || "Inventory"}
            {data.hasUnsavedChanges && (
              <span style={{ width: "8px", height: "8px", background: "#f59e0b", borderRadius: "50%" }} />
            )}
          </button>

          <button
            class="button button-secondary"
            style={{ padding: "0.5rem 0.75rem", fontSize: "0.875rem" }}
            disabled={data.loading}
            onClick={handleReload}
            title="Reload"
            aria-label="Reload"
          >
            ↻
          </button>

          <button
            class="button icon-button"
            style={{ padding: "0.5rem 0.75rem", fontSize: "0.875rem" }}
            disabled={data.loading || !data.activeInventory || !data.hasUnsavedChanges}
            onClick={handleSave}
            title="Save"
            aria-label="Save"
          >
            ⤓
          </button>

          {showInventoryPopover && (
            <InventoryPopover
              isOpen={showInventoryPopover}
              onClose={() => setShowInventoryPopover(false)}
              inventories={data.inventories}
              activeInventory={data.activeInventory}
              hasUnsavedChanges={data.hasUnsavedChanges}
              onInventoryChange={handleInventoryChange}
              onSave={handleSave}
              onReload={handleReload}
              loading={data.loading}
              error={error}
              onError={setLocalError}
            />
          )}
        </div>

        <button
          class="button icon-button"
          onClick={() => openCreate(entityTab)}
          style={{ padding: "0.5rem 1rem", fontSize: "0.875rem", marginLeft: "auto" }}
          title={`New ${entityTab === "ingredient" ? "Ingredient" : entityTab === "recipe" ? "Recipe" : "Product"}`}
          aria-label={`New ${entityTab === "ingredient" ? "Ingredient" : entityTab === "recipe" ? "Recipe" : "Product"}`}
        >
          ＋
        </button>
      </div>

      {/* Type filter */}
      <div
        style={{
          display: "flex",
          gap: "0.25rem",
          padding: "0 1rem",
          borderBottom: "1px solid #e5e7eb",
          background: "#f9fafb",
          alignItems: "center",
        }}
      >
        {(["ingredient", "recipe", "product"] as EntityTab[]).map((type) => (
          <button
            key={type}
            onClick={() => setEntityTab(type)}
            aria-pressed={entityTab === type}
            style={{
              appearance: "none",
              background: "transparent",
              border: "none",
              borderBottom: entityTab === type ? "2px solid #3b82f6" : "2px solid transparent",
              color: entityTab === type ? "#111827" : "#6b7280",
              padding: "0.75rem 0.75rem",
              fontSize: "0.875rem",
              fontWeight: entityTab === type ? 600 : 500,
              cursor: "pointer",
            }}
          >
            {type === "ingredient" ? "Ingredients" : type === "recipe" ? "Recipes" : "Products"}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: "1rem" }}>
        {error && <div class="error" style={{ marginBottom: "1rem" }}>{error}</div>}

        {data.loading && data.rows.length === 0 ? (
          <p>Loading...</p>
        ) : (
          <NodeList
            rows={displayRows}
            onEditEntity={openEdit}
            onProduce={(node) => {
              productionSimulatorTargetId.value = node.id;
              productionSimulatorOpen.value = true;
            }}
          />
        )}
      </div>

      {/* Entity Editor Modal */}
      {isEditorOpen.value && (
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
            if (e.target === e.currentTarget) {
              handleEditorClose();
            }
          }}
        >
          <div
            style={{
              background: "#fff",
              borderRadius: "8px",
              padding: "1rem",
              maxWidth: "640px",
              width: "100%",
              maxHeight: "90vh",
              overflowY: "auto",
              boxShadow: "0 10px 25px rgba(0,0,0,0.1)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Stock controls live in the same modal as entity edit */}
            {selectedNodeId.value && (
              <div
                style={{
                  marginBottom: "0.75rem",
                  padding: "0.75rem",
                  border: "1px solid #e5e7eb",
                  borderRadius: "8px",
                  background: "#f9fafb",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.04em", color: "#6b7280" }}>
                      Stock (draft)
                    </div>
                    <div style={{ fontSize: "0.875rem", color: "#111827" }}>
                      Draft is committed when you click <strong>Save</strong> in the editor. Persist via <strong>Inventory → Save</strong>.
                    </div>
                  </div>

                  {selectedRow?.node?.type === "product" && (
                    <button
                      class="button icon-button"
                      onClick={() => {
                        // Open production interface as modal
                        productionSimulatorTargetId.value = selectedNodeId.value;
                        productionSimulatorOpen.value = true;
                        // Avoid stacking modals
                        handleEditorClose();
                      }}
                      title="Produce"
                      aria-label="Produce"
                    >
                      ▶
                    </button>
                  )}
                </div>

                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "0.75rem", flexWrap: "wrap" }}>
                  <input
                    type="number"
                    class="input"
                    value={stockDraft}
                    onInput={(e) => setStockDraft(parseFloat((e.target as HTMLInputElement).value) || 0)}
                    min="0"
                    step={selectedRow?.node.type === "ingredient" ? "1" : "0.01"}
                    style={{ width: "160px" }}
                  />
                  {selectedRow?.node.type === "ingredient" && (
                    <div style={{ fontSize: "0.875rem", color: "#6b7280" }}>
                      packages
                    </div>
                  )}
                  {selectedRow?.node.type === "recipe" && (
                    <div style={{ fontSize: "0.875rem", color: "#6b7280" }}>
                      {(() => {
                        const recipe = selectedRow.node;
                        const perUnitWeight = recipe.weight || 0;
                        const totalWeight = stockDraft * perUnitWeight;
                        const display = convertToDisplay(totalWeight, recipe.unit);
                        return `${display.value.toFixed(2)} ${display.unit}`;
                      })()}
                    </div>
                  )}
                  <button
                    class="button"
                    onClick={() => {
                      setStockDraft((prev) => prev + 1);
                    }}
                  >
                    +1
                  </button>
                  <button
                    class="button button-secondary"
                    onClick={() => {
                      setStockDraft((prev) => Math.max(0, prev - 1));
                    }}
                    disabled={stockDraft <= 0}
                  >
                    -1
                  </button>
                  <div style={{ marginLeft: "auto", fontSize: "0.875rem", color: "#6b7280" }}>
                    {selectedRow?.node.type === "ingredient"
                      ? (() => {
                        const pkgSize = selectedRow.node.packageSize || 0;
                        const currentUnits = selectedRow.stock ?? 0;
                        const currentPkgs = pkgSize > 0 ? currentUnits / pkgSize : 0;
                        const display = convertToDisplay(pkgSize, selectedRow.node.unit);
                        return (
                          <>
                            Current: <strong>{currentPkgs.toFixed(2)}</strong> pkgs{" "}
                            <span style={{ color: "#9ca3af" }}>
                              ({currentUnits.toFixed(2)} {display.unit})
                            </span>
                          </>
                        );
                      })()
                      : (
                        <>
                          Current: <strong>{(selectedRow?.stock ?? 0).toFixed(2)}</strong>
                        </>
                      )}
                  </div>
                </div>
              </div>
            )}

            <EntityEditor
              initialEntity={editingEntity.value}
              nodeType={(editorNodeType.value as NodeType) || entityTab}
              onSave={handleEntitySaved}
              onCancel={handleEditorClose}
              onDelete={(id, type) => {
                if (selectedNodeId.value === id) {
                  selectedNodeId.value = null;
                  selectedNodeType.value = null;
                }
                setEntityTab(type as EntityTab);
                handleEditorClose();
                // Don't reset working stock edits
                data.reloadEntities();
              }}
            />
          </div>
        </div>
      )}

      {/* Production Simulator (already a modal) */}
      <ProductionSimulator />
    </div>
  );
}

interface NodeListProps {
  rows: WorkspaceNodeRow[];
  onEditEntity: (node: Node) => void;
  onProduce: (node: Node) => void;
}

function NodeList({
  rows,
  onEditEntity,
  onProduce,
}: NodeListProps) {
  if (rows.length === 0) {
    return <p style={{ color: "#6b7280" }}>No entities found.</p>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      {rows.map((row) => {
        const isSelected = selectedNodeId.value === row.node.id;
        const isIngredient = row.node.type === "ingredient";
        const isRecipeOrProduct = row.node.type === "recipe" || row.node.type === "product";

        // Display rules:
        // - Ingredients: show "No stock" only when stock is 0; otherwise show no status tag.
        // - Recipes/Products: show "Craftable" iff we can produce +1 more from inputs; otherwise "Not craftable".
        const hasAnyStock = row.stock > 0.000_001;
        const craftable = !!row.craftable;

        let statusLabel: string | null = null;
        let statusColor: string = "#6b7280";
        let statusBg: string | null = null;

        if (isIngredient) {
          if (!hasAnyStock) {
            statusLabel = "No stock";
            statusColor = "#ef4444";
            statusBg = "#fef2f2";
          }
        } else if (isRecipeOrProduct) {
          const maxProducible = row.maxProducible ?? 0;

          // Clarify units to avoid ambiguity: show units and weight for recipes when available.
          if (craftable) {
            if (maxProducible > 0) {
              if (row.node.type === "recipe") {
                const recipe = row.node as any;
                const perUnitWeight = typeof recipe.weight === "number" ? recipe.weight : 0;
                const unit = recipe.unit;
                if (perUnitWeight > 0 && unit) {
                  const display = convertToDisplay(perUnitWeight * maxProducible, unit);
                  statusLabel = `Craftable (${maxProducible} units ≈ ${display.value.toFixed(2)} ${display.unit})`;
                } else {
                  statusLabel = `Craftable (${maxProducible} units)`;
                }
              } else {
                statusLabel = `Craftable (${maxProducible} units)`;
              }
            } else {
              statusLabel = "Craftable";
            }
          } else {
            statusLabel = "Not craftable";
          }

          statusColor = craftable ? "#10b981" : "#ef4444";
          statusBg = craftable ? null : "#fef2f2";
        }

        let titleContent: preact.JSX.Element | string;
        let subtitleContent: preact.JSX.Element | string;

        if (row.node.type === "ingredient") {
          const ingredient = row.node as any;
          if (row.packageDisplay) {
            titleContent = (
              <>
                {ingredient.name}{" "}
                <span style={{ fontSize: "0.75em", textTransform: "uppercase", color: "#9ca3af", fontWeight: 400 }}>
                  {row.packageDisplay.value} {row.packageDisplay.unit}
                </span>
              </>
            );
            subtitleContent = (
              <>
                ${ingredient.packagePrice?.toFixed(2) || "0.00"}/pkg · Stock: {row.stockInPackages} pkgs ({row.stock.toFixed(2)} {row.packageDisplay.unit})
              </>
            );
          } else {
            titleContent = ingredient.name;
            subtitleContent = `Stock: ${row.stock.toFixed(2)} units`;
          }
        } else if (row.node.type === "recipe") {
          const recipe = row.node as any;
          const perUnitWeight = typeof recipe.weight === "number" ? recipe.weight : 0;
          const totalWeight = row.stock * perUnitWeight;
          const display = convertToDisplay(totalWeight, recipe.unit);
          titleContent = row.node.name;
          subtitleContent = `Stock: ${display.value.toFixed(2)} ${display.unit}`;
        } else {
          titleContent = row.node.name;
          subtitleContent = `Stock: ${row.stock.toFixed(2)} units`;
        }

        return (
          <div
            key={row.node.id}
            style={{
              display: "flex",
              alignItems: "center",
              padding: "0.75rem",
              background: isSelected ? "#eff6ff" : (statusBg ?? "#f9fafb"),
              borderRadius: "6px",
              border: isSelected ? "1px solid #3b82f6" : "1px solid transparent",
            }}
          >
            <div style={{ flex: 1, cursor: "pointer", minWidth: 0 }} onClick={() => onEditEntity(row.node)}>
              <div class="entity-row-content">
                <div class="entity-row-content__title">{titleContent}</div>
                <div class="entity-row-content__meta">
                  <span>{subtitleContent}</span>
                  {statusLabel && (
                    <>
                      <span class="entity-row-content__separator">·</span>
                      <span class="entity-row-content__status" style={{ color: statusColor }}>
                        {statusLabel}
                      </span>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button
                class="button icon-button"
                onClick={() => onEditEntity(row.node)}
                style={{ padding: "0.5rem 0.75rem", fontSize: "0.875rem" }}
                title="Edit"
                aria-label="Edit"
              >
                ✎
              </button>
              {row.node.type === "product" && (
                <button
                  class="button icon-button"
                  onClick={() => onProduce(row.node)}
                  style={{ padding: "0.5rem 0.75rem", fontSize: "0.875rem" }}
                  title="Produce"
                  aria-label="Produce"
                >
                  ▶
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
