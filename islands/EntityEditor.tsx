import { useState, useEffect } from "preact/hooks";
import type { Ingredient, Recipe, Product, Node, NodeType, Portion } from "../domain/types.ts";
import { eventBus, emitEntityUpdated } from "../events/bus.ts";
import type { Event } from "../events/types.ts";
import { convertToStorage, convertToDisplay, getDefaultDisplayUnit, convertBetweenDisplayUnits, type DisplayUnit, type StorageUnit } from "../utils/units.ts";
import { debug, error as logError } from "../utils/log.ts";

interface EntityEditorProps {
  initialEntity?: Node | null;
  nodeType: NodeType;
  onSave?: (entity: Node) => void;
  onCancel?: () => void;
  onDelete?: (id: string, type: NodeType) => void;
}

interface PortionInput {
  nodeId: string;
  quantity: number;
  error?: string;
}

export default function EntityEditor({ initialEntity, nodeType, onSave, onCancel, onDelete }: EntityEditorProps) {
  // This log runs during SSR
  if (typeof window !== "undefined") {
    debug("EntityEditor", "Component rendered on CLIENT", { initialEntity, nodeType });
  } else {
    debug("EntityEditor", "Component rendered on SERVER", { initialEntity, nodeType });
  }
  
  const [entityType, setEntityType] = useState<NodeType>(nodeType || initialEntity?.type || "ingredient");
  const [name, setName] = useState(initialEntity?.name || "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  
  // Test if component is hydrated on client
  useEffect(() => {
    debug("EntityEditor", "✅ CLIENT HYDRATION SUCCESSFUL - useEffect ran!");
  }, []);
  
  // Ingredient fields
  const ingredientUnit = (initialEntity as Ingredient)?.unit || "unit";
  const ingredientDisplayUnit = getDefaultDisplayUnit(ingredientUnit as StorageUnit);
  const [packageSizeDisplay, setPackageSizeDisplay] = useState<number>(() => {
    const entity = initialEntity as Ingredient;
    if (entity?.packageSize) {
      const converted = convertToDisplay(entity.packageSize, entity.unit || "unit" as StorageUnit);
      return converted.value;
    }
    return 0;
  });
  const [packageSizeUnit, setPackageSizeUnit] = useState<DisplayUnit>(ingredientDisplayUnit);
  const [packagePrice, setPackagePrice] = useState<number>(
    (initialEntity as Ingredient)?.packagePrice || 0
  );
  
  // Recipe fields
  const recipeUnit = (initialEntity as Recipe)?.unit || "unit";
  const recipeDisplayUnit = getDefaultDisplayUnit(recipeUnit as StorageUnit);
  const [description, setDescription] = useState<string>(
    (initialEntity as Recipe)?.description || ""
  );
  const [fabricationTime, setFabricationTime] = useState<number>(
    (initialEntity as Recipe)?.fabricationTime || 0
  );
  const [weightDisplay, setWeightDisplay] = useState<number>(() => {
    const entity = initialEntity as Recipe;
    if (entity?.weight) {
      const converted = convertToDisplay(entity.weight, entity.unit || "unit" as StorageUnit);
      return converted.value;
    }
    return 0;
  });
  const [weightUnit, setWeightUnit] = useState<DisplayUnit>(recipeDisplayUnit);
  const [recipeInputs, setRecipeInputs] = useState<PortionInput[]>(
    (initialEntity as Recipe)?.inputs?.map(p => ({ nodeId: p.nodeId, quantity: p.quantity })) || []
  );
  
  // Product fields
  const productUnit = (initialEntity as Product)?.unit || "unit";
  const productDisplayUnit = getDefaultDisplayUnit(productUnit as StorageUnit);
  const [productionTime, setProductionTime] = useState<number>(
    (initialEntity as Product)?.productionTime || 0
  );
  const [productInputs, setProductInputs] = useState<PortionInput[]>(
    (initialEntity as Product)?.inputs?.map(p => ({ nodeId: p.nodeId, quantity: p.quantity })) || []
  );
  
  // Available nodes for inputs
  const [availableNodes, setAvailableNodes] = useState<Node[]>([]);
  const [searchTerm, setSearchTerm] = useState<Record<number, string>>({});
  
  // Keep entityType in sync with nodeType prop
  useEffect(() => {
    const type = nodeType || initialEntity?.type || "ingredient";
    setEntityType(type);
    if (!initialEntity) {
      resetForm(type);
    }
  }, [nodeType, initialEntity]);

  // Load available nodes when entityType changes
  useEffect(() => {
    debug("EntityEditor", `useEffect triggered - entityType changed to: ${entityType}`);
    loadAvailableNodes(entityType);
  }, [entityType]);

  function resetForm(type: NodeType) {
    setName("");
    setPackageSizeDisplay(0);
    setPackageSizeUnit("unit");
    setPackagePrice(0);
    setDescription("");
    setFabricationTime(0);
    setWeightDisplay(0);
    setWeightUnit("unit");
    setProductionTime(0);
    setRecipeInputs([]);
    setProductInputs([]);
    setEntityType(type);
  }
  
  // Update display values when initialEntity changes
  useEffect(() => {
    if (initialEntity) {
      if (initialEntity.type === "ingredient") {
        const ingredient = initialEntity as Ingredient;
        const storageUnit = (ingredient.unit || "unit") as StorageUnit;
        const displayUnit = getDefaultDisplayUnit(storageUnit);
        const converted = convertToDisplay(ingredient.packageSize || 0, storageUnit);
        setPackageSizeDisplay(converted.value);
        setPackageSizeUnit(displayUnit);
        setPackagePrice(ingredient.packagePrice || 0);
      } else if (initialEntity.type === "recipe") {
        const recipe = initialEntity as Recipe;
        setEntityType("recipe");
        const storageUnit = (recipe.unit || "unit") as StorageUnit;
        const displayUnit = getDefaultDisplayUnit(storageUnit);
        const converted = convertToDisplay(recipe.weight || 0, storageUnit);
        setWeightDisplay(converted.value);
        setWeightUnit(displayUnit);
        setDescription(recipe.description || "");
        setFabricationTime(recipe.fabricationTime || 0);
        setRecipeInputs(recipe.inputs?.map(p => ({ nodeId: p.nodeId, quantity: p.quantity })) || []);
      } else if (initialEntity.type === "product") {
        const product = initialEntity as Product;
        setEntityType("product");
        setProductionTime(product.productionTime || 0);
        setProductInputs(product.inputs?.map(p => ({ nodeId: p.nodeId, quantity: p.quantity })) || []);
      }
      setName(initialEntity.name || "");
    }
  }, [initialEntity]);

  // Subscribe to entity updates
  useEffect(() => {
    const unsubscribe = eventBus.subscribe("ENTITY_UPDATED", (event: Event) => {
      // Reload available nodes when:
      // 1. Editing an existing entity and it was updated
      // 2. Any ingredient is updated (if we're creating/editing a recipe)
      // 3. Any recipe/product is updated (if we're creating/editing a product)
      if (event.type === "ENTITY_UPDATED") {
        if (initialEntity && event.nodeId === initialEntity.id) {
          loadAvailableNodes();
        } else if (entityType === "recipe" && (event.nodeType === "ingredient" || event.nodeType === "recipe")) {
          // Recipe inputs need ingredients and recipes, so reload when any ingredient or recipe is updated
          loadAvailableNodes();
        } else if (entityType === "product" && (event.nodeType === "recipe" || event.nodeType === "product")) {
          // Product inputs need recipes/products, so reload when any recipe/product is updated
          loadAvailableNodes();
        }
      }
    });
    
    return () => {
      unsubscribe();
    };
  }, [initialEntity, entityType]);
  
  async function loadAvailableNodes(type?: NodeType) {
    const currentType = type || entityType;
    try {
      const [ingredientsRes, recipesRes, productsRes] = await Promise.all([
        fetch("/api/ingredients"),
        fetch("/api/recipes"),
        fetch("/api/products"),
      ]);
      
      if (!ingredientsRes.ok || !recipesRes.ok || !productsRes.ok) {
        logError("Failed to fetch nodes:", { ingredientsRes, recipesRes, productsRes });
        return;
      }
      
      const ingredients: Ingredient[] = await ingredientsRes.json();
      const recipes: Recipe[] = await recipesRes.json();
      const products: Product[] = await productsRes.json();
      
      debug("EntityEditor", `Loaded nodes - Ingredients: ${ingredients.length}, Recipes: ${recipes.length}, Products: ${products.length}, Current type: ${currentType}`);
      
      // Filter out the current entity to prevent self-reference
      const currentEntityId = initialEntity?.id;
      
      if (currentType === "recipe") {
        // Recipes can use ingredients and other recipes (but not itself)
        const filteredRecipes = recipes.filter(r => r.id !== currentEntityId);
        setAvailableNodes([...ingredients, ...filteredRecipes]);
        debug("EntityEditor", `Set available nodes for recipe: ${ingredients.length} ingredients, ${filteredRecipes.length} recipes (excluded current entity)`);
      } else if (currentType === "product") {
        // Products can use recipes and products (but not itself)
        const filteredProducts = products.filter(p => p.id !== currentEntityId);
        setAvailableNodes([...recipes, ...filteredProducts]);
        debug("EntityEditor", `Set available nodes for product: ${recipes.length + filteredProducts.length} nodes (excluded current entity)`);
      } else {
        setAvailableNodes([]);
      }
    } catch (err) {
      logError("Failed to load nodes:", err);
    }
  }
  
  function addInput(index: number) {
    if (entityType === "recipe") {
      setRecipeInputs([...recipeInputs, { nodeId: "", quantity: 1 }]);
    } else if (entityType === "product") {
      setProductInputs([...productInputs, { nodeId: "", quantity: 1 }]);
    }
  }
  
  function removeInput(index: number) {
    if (entityType === "recipe") {
      setRecipeInputs(recipeInputs.filter((_, i) => i !== index));
    } else if (entityType === "product") {
      setProductInputs(productInputs.filter((_, i) => i !== index));
    }
  }
  
  function updateInput(index: number, field: "nodeId" | "quantity", value: string | number) {
    if (entityType === "recipe") {
      const newInputs = [...recipeInputs];
      newInputs[index] = { ...newInputs[index], [field]: value };
      setRecipeInputs(newInputs);
    } else if (entityType === "product") {
      const newInputs = [...productInputs];
      newInputs[index] = { ...newInputs[index], [field]: value };
      setProductInputs(newInputs);
    }
  }
  
  function validateForm(): string | null {
    // Read name directly from the input element to avoid stale state issues
    const nameInput = document.querySelector('input[type="text"][placeholder="Entity name"]') as HTMLInputElement;
    const currentName = nameInput?.value.trim() || name.trim();
    
    if (!currentName) return "Name is required";
    
    if (entityType === "ingredient") {
      if (packageSizeDisplay <= 0) return "Package size must be greater than 0";
      if (packagePrice < 0) return "Package price must be non-negative";
    } else if (entityType === "recipe") {
      if (fabricationTime < 0) return "Fabrication time must be non-negative";
      if (weightDisplay <= 0) return "Weight must be greater than 0";
      if (recipeInputs.length === 0) return "Recipe must have at least one input";
      for (const input of recipeInputs) {
        if (!input.nodeId) return "All inputs must have a node selected";
        if (input.quantity <= 0) return "All input quantities must be greater than 0";
      }
    } else if (entityType === "product") {
      if (productionTime < 0) return "Production time must be non-negative";
      if (productInputs.length === 0) return "Product must have at least one input";
      for (const input of productInputs) {
        if (!input.nodeId) return "All inputs must have a node selected";
        if (input.quantity <= 0) return "All input quantities must be greater than 0";
      }
    }
    
    return null;
  }
  
  async function handleSave() {
    debug("EntityEditor", "handleSave called");
    setError(null);
    setSuccess(false);
    
    debug("EntityEditor", "Validating form...", { entityType, name, packageSizeDisplay, packagePrice });
    const validationError = validateForm();
    if (validationError) {
      logError("Validation failed:", validationError);
      setError(validationError);
      alert(`Validation error: ${validationError}`); // Temporary - to ensure user sees it
      return;
    }
    
    debug("EntityEditor", "Validation passed, starting save...");
    setLoading(true);
    debug("EntityEditor", `Starting save for ${entityType}`);
    
    try {
      let entity: Node;
      
      if (entityType === "ingredient") {
        // Read name directly from input to ensure we have the latest value
        const nameInput = document.querySelector('input[type="text"][placeholder="Entity name"]') as HTMLInputElement;
        const currentName = nameInput?.value.trim() || name;
        
        const { value: packageSizeStorage, unit: packageSizeStorageUnit } = convertToStorage(packageSizeDisplay, packageSizeUnit);
        entity = {
          id: initialEntity?.id || "", // Will be generated by API if empty
          name: currentName,
          type: "ingredient",
          packageSize: packageSizeStorage,
          packagePrice,
          unit: packageSizeStorageUnit,
          unitCost: packageSizeStorage > 0 ? packagePrice / packageSizeStorage : 0,
          currentStock: initialEntity?.currentStock || 0,
        } as Ingredient;
      } else if (entityType === "recipe") {
        // Read name directly from input to ensure we have the latest value
        const nameInput = document.querySelector('input[type="text"][placeholder="Entity name"]') as HTMLInputElement;
        const currentName = nameInput?.value.trim() || name;
        
        const { value: weightStorage, unit: weightStorageUnit } = convertToStorage(weightDisplay, weightUnit);
        entity = {
          id: initialEntity?.id || "", // Will be generated by API if empty
          name: currentName,
          type: "recipe",
          description,
          fabricationTime,
          weight: weightStorage,
          unit: weightStorageUnit,
          inputs: recipeInputs.map(p => ({ nodeId: p.nodeId, quantity: p.quantity })),
          currentStock: initialEntity?.currentStock || 0,
          totalCost: 0,
          costPerUnit: 0,
        } as Recipe;
      } else {
        // Read name directly from input to ensure we have the latest value
        const nameInput = document.querySelector('input[type="text"][placeholder="Entity name"]') as HTMLInputElement;
        const currentName = nameInput?.value.trim() || name;
        
        // Products don't have weight/unit in the form, but we need to set a default unit
        entity = {
          id: initialEntity?.id || "", // Will be generated by API if empty
          name: currentName,
          type: "product",
          productionTime,
          inputs: productInputs.map(p => ({ nodeId: p.nodeId, quantity: p.quantity })),
          currentStock: initialEntity?.currentStock || 0,
          totalCost: 0,
          totalProductionTime: 0,
          weight: 0,
          unit: (initialEntity as Product)?.unit || "unit",
        } as Product;
      }
      
      const endpoint = entityType === "ingredient" 
        ? "/api/ingredients"
        : entityType === "recipe"
        ? "/api/recipes"
        : "/api/products";
      
      debug("EntityEditor", `Saving ${entityType}:`, entity);
      
      const method = initialEntity ? "PUT" : "POST";
      debug("EntityEditor", `Making ${method} request to ${endpoint}`);
      const response = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entity),
      });
      
      debug("EntityEditor", `Response status: ${response.status} ${response.statusText}`);
      
      if (!response.ok) {
        let errorData;
        try {
          errorData = await response.json();
        } catch (e) {
          const text = await response.text();
          errorData = { error: text || `HTTP ${response.status}: ${response.statusText}` };
        }
        logError(`Save failed:`, errorData);
        throw new Error(errorData.error || "Failed to save entity");
      }
      
      const savedEntity = await response.json();
      debug("EntityEditor", `Save successful:`, savedEntity);
      setSuccess(true);
      
      // Emit event first (so other islands can update)
      await emitEntityUpdated(savedEntity.id, entityType, savedEntity);
      debug("EntityEditor", `Event emitted for ${savedEntity.id}`);
      
      // Reload available nodes after saving (so new entities appear in inputs)
      // This will update the dropdown if we're currently on recipe/product type
      // Add a small delay to ensure KV write is committed
      await new Promise(resolve => setTimeout(resolve, 100));
      await loadAvailableNodes();
      debug("EntityEditor", `Available nodes reloaded`);
      
      if (onSave) {
        onSave(savedEntity);
      }
      
      // Reset form after a delay
      setTimeout(() => {
        setSuccess(false);
        if (!initialEntity) {
          // Reset form for new entity
          setName("");
          setPackageSizeDisplay(0);
          setPackageSizeUnit("unit");
          setPackagePrice(0);
          setDescription("");
          setFabricationTime(0);
          setWeightDisplay(0);
          setWeightUnit("unit");
          setRecipeInputs([]);
          setProductionTime(0);
          setProductInputs([]);
        }
      }, 2000);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to save entity";
      logError(`Save error:`, err);
      setError(errorMessage);
      alert(`Error saving entity: ${errorMessage}`); // Temporary - to ensure user sees the error
    } finally {
      setLoading(false);
    }
  }
  
  function filteredNodes(index: number): Node[] {
    const term = (searchTerm[index] || "").toLowerCase();
    const usedNodeIds = entityType === "recipe" 
      ? recipeInputs.map(i => i.nodeId).filter(Boolean)
      : productInputs.map(i => i.nodeId).filter(Boolean);
    
    return availableNodes.filter(node => {
      const matchesSearch = !term || node.name.toLowerCase().includes(term) || node.id.toLowerCase().includes(term);
      const notUsed = !usedNodeIds.includes(node.id) || (entityType === "recipe" ? recipeInputs[index]?.nodeId === node.id : productInputs[index]?.nodeId === node.id);
      return matchesSearch && notUsed;
    });
  }
  
  async function handleDelete() {
    if (!initialEntity) return;
    const confirmed = confirm(`Delete ${initialEntity.name}? This cannot be undone.`);
    if (!confirmed) return;

    setError(null);
    setLoading(true);
    try {
      const endpoint = initialEntity.type === "ingredient"
        ? "/api/ingredients"
        : initialEntity.type === "recipe"
        ? "/api/recipes"
        : "/api/products";

      const response = await fetch(`${endpoint}?id=${initialEntity.id}`, { method: "DELETE" });
      if (!response.ok) {
        const data = await response.json().catch(() => ({} as any));
        const baseError = data?.error || "Failed to delete entity";
        const deps = data?.dependencies || {};
        const recipes = deps?.recipes;
        const products = deps?.products;

        const sections: string[] = [];
        if (Array.isArray(recipes) && recipes.length > 0) {
          const list = recipes
            .map((r: any) =>
              `- ${r.name || "(unnamed)"} (${r.id})` +
              (typeof r.quantity === "number" ? `: uses ${r.quantity}` : "")
            )
            .join("\n");
          sections.push(`Recipes:\n${list}`);
        }
        if (Array.isArray(products) && products.length > 0) {
          const list = products
            .map((p: any) =>
              `- ${p.name || "(unnamed)"} (${p.id})` +
              (typeof p.quantity === "number" ? `: uses ${p.quantity}` : "")
            )
            .join("\n");
          sections.push(`Products:\n${list}`);
        }

        if (sections.length > 0) {
          throw new Error(`${baseError}\n\nDependencies:\n${sections.join("\n\n")}`);
        }
        throw new Error(baseError);
      }

      // Notify other islands (StockDashboard, EntityManager, etc.) so they can reload immediately.
      // Note: server-side event bus emits won't reach the browser, so this must happen client-side.
      await emitEntityUpdated(initialEntity.id, initialEntity.type, { id: initialEntity.id, name: "" });

      if (onDelete) {
        onDelete(initialEntity.id, initialEntity.type);
      }

      if (onCancel) {
        onCancel();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete entity";
      setError(message);
      alert(`Error deleting entity: ${message}`);
    } finally {
      setLoading(false);
    }
  }

  debug("EntityEditor", "Rendering with entityType:", entityType);
  
  return (
    <div class="card" key={`entity-editor-${entityType}`}>
      <h2>Entity Editor</h2>
      
      {error && <div class="error">{error}</div>}
      {success && <div class="success">Entity saved successfully!</div>}
      
      <div class="form-group">
        <label class="label">Name</label>
        <input
          type="text"
          class="input"
          value={name}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
          placeholder="Entity name"
        />
      </div>
      
      {entityType === "ingredient" && (
        <>
          <div class="form-group">
            <label class="label">Package Size</label>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <input
                type="number"
                class="input"
                style={{ flex: 1 }}
                value={packageSizeDisplay}
                onInput={(e) => setPackageSizeDisplay(parseFloat((e.target as HTMLInputElement).value) || 0)}
                min="0"
                step="0.01"
              />
              <select
                class="input"
                style={{ width: "120px" }}
                value={packageSizeUnit}
                onChange={(e) => {
                  const newUnit = (e.target as HTMLSelectElement).value as DisplayUnit;
                  // Convert between display units directly
                  const convertedValue = convertBetweenDisplayUnits(packageSizeDisplay, packageSizeUnit, newUnit);
                  setPackageSizeDisplay(convertedValue);
                  setPackageSizeUnit(newUnit);
                }}
              >
                <option value="kg">kg</option>
                <option value="g">g</option>
                <option value="L">L</option>
                <option value="ml">ml</option>
                <option value="unit">unit</option>
              </select>
            </div>
          </div>
          
          <div class="form-group">
            <label class="label">Package Price</label>
            <input
              type="number"
              class="input"
              value={packagePrice}
              onInput={(e) => setPackagePrice(parseFloat((e.target as HTMLInputElement).value) || 0)}
              min="0"
              step="0.01"
            />
          </div>
          
          {packageSizeDisplay > 0 && (() => {
            const { value: storageValue } = convertToStorage(packageSizeDisplay, packageSizeUnit);
            return storageValue > 0 ? (
              <div class="form-group">
                <label class="label">Unit Cost (calculated)</label>
                <input
                  type="text"
                  class="input"
                  value={(packagePrice / storageValue).toFixed(4)}
                  disabled
                />
              </div>
            ) : null;
          })()}
        </>
      )}
      
      {entityType === "recipe" && (
        <>
          <div class="form-group">
            <label class="label">Description</label>
            <textarea
              class="input"
              value={description}
              onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
              rows={3}
            />
          </div>
          
          <div class="form-group">
            <label class="label">Fabrication Time (minutes)</label>
            <input
              type="number"
              class="input"
              value={fabricationTime}
              onInput={(e) => setFabricationTime(parseFloat((e.target as HTMLInputElement).value) || 0)}
              min="0"
              step="0.1"
            />
          </div>
          
          <div class="form-group">
            <label class="label">Weight</label>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <input
                type="number"
                class="input"
                style={{ flex: 1 }}
                value={weightDisplay}
                onInput={(e) => setWeightDisplay(parseFloat((e.target as HTMLInputElement).value) || 0)}
                min="0"
                step="0.01"
              />
              <select
                class="input"
                style={{ width: "120px" }}
                value={weightUnit}
                onChange={(e) => {
                  const newUnit = (e.target as HTMLSelectElement).value as DisplayUnit;
                  // Convert between display units directly
                  const convertedValue = convertBetweenDisplayUnits(weightDisplay, weightUnit, newUnit);
                  setWeightDisplay(convertedValue);
                  setWeightUnit(newUnit);
                }}
              >
                <option value="kg">kg</option>
                <option value="g">g</option>
                <option value="L">L</option>
                <option value="ml">ml</option>
                <option value="unit">unit</option>
              </select>
            </div>
          </div>
          
          <div class="form-group">
            <label class="label">Inputs (Ingredients only)</label>
            {recipeInputs.map((input, index) => (
              <div key={index} style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem", alignItems: "center" }}>
                <select
                  key={`recipe-input-${index}-${availableNodes.length}`}
                  class="input"
                  style={{ flex: 1 }}
                  value={input.nodeId}
                  onChange={(e) => updateInput(index, "nodeId", (e.target as HTMLSelectElement).value)}
                >
                  <option value="">Select ingredient...</option>
                  {filteredNodes(index).map(node => (
                    <option key={node.id} value={node.id}>{node.name} ({node.id})</option>
                  ))}
                </select>
                <input
                  type="number"
                  class="input"
                  style={{ width: "100px" }}
                  value={input.quantity}
                  onInput={(e) => updateInput(index, "quantity", parseFloat((e.target as HTMLInputElement).value) || 0)}
                  min="0"
                  step="0.01"
                  placeholder="Qty"
                />
                <button
                  class="button button-danger"
                  onClick={() => removeInput(index)}
                  type="button"
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              class="button button-secondary"
              onClick={() => addInput(recipeInputs.length)}
              type="button"
            >
              Add Input
            </button>
          </div>
        </>
      )}
      
      {entityType === "product" && (
        <>
          <div class="form-group">
            <label class="label">Production Time (minutes)</label>
            <input
              type="number"
              class="input"
              value={productionTime}
              onInput={(e) => setProductionTime(parseFloat((e.target as HTMLInputElement).value) || 0)}
              min="0"
              step="0.1"
            />
          </div>
          
          <div class="form-group">
            <label class="label">Inputs (Recipes or Products)</label>
            {productInputs.map((input, index) => (
              <div key={index} style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem", alignItems: "center" }}>
                <select
                  key={`product-input-${index}-${availableNodes.length}`}
                  class="input"
                  style={{ flex: 1 }}
                  value={input.nodeId}
                  onChange={(e) => updateInput(index, "nodeId", (e.target as HTMLSelectElement).value)}
                >
                  <option value="">Select recipe/product...</option>
                  {filteredNodes(index).map(node => (
                    <option key={node.id} value={node.id}>{node.name} ({node.id})</option>
                  ))}
                </select>
                <input
                  type="number"
                  class="input"
                  style={{ width: "100px" }}
                  value={input.quantity}
                  onInput={(e) => updateInput(index, "quantity", parseFloat((e.target as HTMLInputElement).value) || 0)}
                  min="0"
                  step="0.01"
                  placeholder="Qty"
                />
                <button
                  class="button button-danger"
                  onClick={() => removeInput(index)}
                  type="button"
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              class="button button-secondary"
              onClick={() => addInput(productInputs.length)}
              type="button"
            >
              Add Input
            </button>
          </div>
        </>
      )}
      
      <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
        <button
          class={`button ${loading ? "" : "icon-button"}`}
          onClick={(e) => {
            debug("EntityEditor", "🖱️ PREACT onClick handler fired!");
            e.preventDefault();
            e.stopPropagation();
            handleSave();
          }}
          disabled={loading}
          id="save-button"
          title="Save"
          aria-label="Save"
        >
          {loading ? "Saving..." : "⤓"}
        </button>
        {initialEntity && (
          <button
            class="button button-danger"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              handleDelete();
            }}
            disabled={loading}
          >
            Delete
          </button>
        )}
        {onCancel && (
          <button
            class="button button-secondary"
            onClick={onCancel}
            disabled={loading}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

