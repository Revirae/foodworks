import { useEffect, useState } from "preact/hooks";
import { useSignalEffect } from "@preact/signals";
import type { Ingredient, Node, NodeId, NodeType, Product, Recipe, Stock } from "../domain/types.ts";
import EntityEditor from "./EntityEditor.tsx";
import { eventBus } from "../events/bus.ts";
import {
  editingEntity,
  editorNodeType,
  isEditorOpen,
  selectedNodeId,
  selectedNodeType,
  productionSimulatorOpen,
  productionSimulatorTargetId,
} from "../state/entitySignals.ts";
import { workingStockQuantities } from "../state/inventorySignals.ts";
import { convertToDisplay } from "../utils/units.ts";

type Tab = "ingredient" | "recipe" | "product";

const tabLabels: Record<Tab, string> = {
  ingredient: "Ingredients",
  recipe: "Recipes",
  product: "Products",
};

const createLabels: Record<Tab, string> = {
  ingredient: "Create Ingredient",
  recipe: "Create Recipe",
  product: "Create Product",
};

export default function EntityManager() {
  const [activeTab, setActiveTab] = useState<Tab>("ingredient");
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [stocks, setStocks] = useState<Map<NodeId, number>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep stock display in sync with StockDashboard's working-copy edits (unsaved changes).
  // When StockDashboard loads stocks or applies +/- adjustments, it updates `workingStockQuantities`.
  useSignalEffect(() => {
    const working = workingStockQuantities.value;
    if (!working) return;
    setStocks(new Map(working));
  });

  useEffect(() => {
    loadAll();
    loadStocks();
    const unsubscribeEntity = eventBus.subscribe("ENTITY_UPDATED", () => loadAll());
    const unsubscribeStock = eventBus.subscribe("STOCK_CHANGED", () => loadStocks());
    const unsubscribeInventory = eventBus.subscribe("INVENTORY_CHANGED", () => loadStocks());
    return () => {
      unsubscribeEntity();
      unsubscribeStock();
      unsubscribeInventory();
    };
  }, []);

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const [ingredientsRes, recipesRes, productsRes] = await Promise.all([
        fetch("/api/ingredients"),
        fetch("/api/recipes"),
        fetch("/api/products"),
      ]);

      if (!ingredientsRes.ok || !recipesRes.ok || !productsRes.ok) {
        throw new Error("Failed to load entities");
      }

      setIngredients(await ingredientsRes.json());
      setRecipes(await recipesRes.json());
      setProducts(await productsRes.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load entities");
    } finally {
      setLoading(false);
    }
  }

  async function loadStocks() {
    try {
      const response = await fetch("/api/stock");
      if (!response.ok) {
        throw new Error("Failed to load stocks");
      }
      
      const stocksList: Stock[] = await response.json();
      const stocksMap = new Map<NodeId, number>();
      for (const stock of stocksList) {
        stocksMap.set(stock.nodeId, stock.quantity);
      }
      setStocks(stocksMap);
    } catch (err) {
      console.error("Failed to load stocks:", err);
    }
  }

  function openCreate(type: Tab) {
    editingEntity.value = null;
    editorNodeType.value = type;
    isEditorOpen.value = true;
  }

  function openEdit(entity: Node) {
    editingEntity.value = entity;
    editorNodeType.value = entity.type;
    isEditorOpen.value = true;
  }

  function handleModalClose() {
    isEditorOpen.value = false;
    editingEntity.value = null;
  }

  function handleSaved(entity: Node) {
    selectedNodeId.value = entity.id;
    selectedNodeType.value = entity.type;
    setActiveTab(entity.type as Tab);
    handleModalClose();
    loadAll();
    loadStocks();
  }

  const list: Node[] =
    activeTab === "ingredient" ? ingredients :
    activeTab === "recipe" ? recipes :
    products;

  return (
    <div class="card">
      <h2>Entity Manager</h2>

      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem" }}>
        {(["ingredient", "recipe", "product"] as Tab[]).map((tab) => (
          <button
            key={tab}
            class={`button ${activeTab === tab ? "" : "button-secondary"}`}
            onClick={() => {
              setActiveTab(tab);
            }}
          >
            {tabLabels[tab]}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button
          class="button icon-button"
          onClick={() => {
            openCreate(activeTab);
          }}
          title={createLabels[activeTab]}
          aria-label={createLabels[activeTab]}
        >
          ＋
        </button>
      </div>

      {error && <div class="error" style={{ marginBottom: "0.75rem" }}>{error}</div>}

      {loading ? (
        <p>Loading...</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {list.length === 0 && <p style={{ color: "#6b7280" }}>No {tabLabels[activeTab].toLowerCase()} yet.</p>}
          {list.map((entity) => {
            // Get current stock from stocks map, fallback to 0 if not found
            const currentStock = stocks.get(entity.id) ?? 0;
            
            // Format title with package size for ingredients
            let titleContent;
            let subtitleContent;
            
            if (entity.type === "ingredient") {
              const ingredient = entity as Ingredient;
              const packageDisplay = convertToDisplay(ingredient.packageSize, ingredient.unit);
              const stockInPackages = ingredient.packageSize > 0 
                ? (currentStock / ingredient.packageSize).toFixed(2)
                : "0";
              
              titleContent = (
                <>
                  {ingredient.name}{" "}
                  <span style={{
                    fontSize: "0.75em",
                    textTransform: "uppercase",
                    color: "#9ca3af",
                    fontWeight: 400,
                  }}>
                    {packageDisplay.value} {packageDisplay.unit}
                  </span>
                </>
              );
              
              subtitleContent = (
                <>
                  ${ingredient.packagePrice.toFixed(2)}/pkg · 
                  Stock: {stockInPackages} pkgs ({currentStock.toFixed(2)} {packageDisplay.unit})
                </>
              );
            } else {
              // For recipes and products, show name only in title
              titleContent = entity.name;
              subtitleContent = `Stock: ${currentStock.toFixed(2)} units`;
            }
            
            return (
              <div
                key={entity.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  padding: "0.5rem 0.75rem",
                  background: selectedNodeId.value === entity.id ? "#eff6ff" : "#f9fafb",
                  borderRadius: "6px",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div class="entity-row-content">
                    <div class="entity-row-content__title">{titleContent}</div>
                    <div class="entity-row-content__meta">
                      <span>{subtitleContent}</span>
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <button
                    class="button icon-button"
                    onClick={() => {
                      openEdit(entity);
                    }}
                    title="Edit"
                    aria-label="Edit"
                  >
                    ✎
                  </button>
                  {activeTab === "product" && (
                    <button
                      class="button icon-button"
                      onClick={() => {
                        productionSimulatorTargetId.value = entity.id;
                        productionSimulatorOpen.value = true;
                      }}
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
      )}

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
        >
          <div
            style={{
              background: "#fff",
              borderRadius: "8px",
              padding: "1rem",
              maxWidth: "640px",
              width: "100%",
              boxShadow: "0 10px 25px rgba(0,0,0,0.1)",
            }}
          >
            <EntityEditor
              initialEntity={editingEntity.value}
              nodeType={(editorNodeType.value as NodeType) || activeTab}
              onSave={handleSaved}
              onCancel={handleModalClose}
              onDelete={(id, type) => {
                if (selectedNodeId.value === id) {
                  selectedNodeId.value = null;
                  selectedNodeType.value = null;
                }
                setActiveTab(type as Tab);
                handleModalClose();
                loadAll();
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

