import { useState } from "preact/hooks";
import type { Inventory } from "../../domain/types.ts";
import { emitInventoryChanged } from "../../events/bus.ts";

interface InventoryPopoverProps {
  isOpen: boolean;
  onClose: () => void;
  inventories: Inventory[];
  activeInventory: Inventory | null;
  hasUnsavedChanges: boolean;
  onInventoryChange: (inventoryId: string) => Promise<void>;
  onSave: () => Promise<boolean>;
  onReload: () => Promise<void>;
  loading: boolean;
  error: string | null;
  onError: (error: string | null) => void;
}

export default function InventoryPopover({
  isOpen,
  onClose,
  inventories,
  activeInventory,
  hasUnsavedChanges,
  onInventoryChange,
  onSave,
  onReload,
  loading,
  error,
  onError,
}: InventoryPopoverProps) {
  const [showCreateInventory, setShowCreateInventory] = useState(false);
  const [newInventoryName, setNewInventoryName] = useState("");
  const [copyFromActive, setCopyFromActive] = useState(false);
  const [pendingInventorySwitchId, setPendingInventorySwitchId] = useState<string | null>(null);
  const [showUnsavedSwitchPrompt, setShowUnsavedSwitchPrompt] = useState(false);
  const [pendingDeleteInventoryId, setPendingDeleteInventoryId] = useState<string | null>(null);
  const [showDeleteInventoryConfirm, setShowDeleteInventoryConfirm] = useState(false);
  const [showUnsavedDeleteInventoryPrompt, setShowUnsavedDeleteInventoryPrompt] = useState(false);

  if (!isOpen) return null;

  async function activateInventory(inventoryId: string) {
    try {
      const response = await fetch(`/api/inventories/${inventoryId}/activate`, {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error("Failed to activate inventory");
      }

      await onReload();
      await emitInventoryChanged(inventoryId);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to switch inventory");
    }
  }

  async function handleInventoryChange(inventoryId: string) {
    if (hasUnsavedChanges) {
      setPendingInventorySwitchId(inventoryId);
      setShowUnsavedSwitchPrompt(true);
      return;
    }
    await onInventoryChange(inventoryId);
  }

  async function performDeleteInventory(inventoryId: string) {
    onError(null);
    try {
      const response = await fetch(`/api/inventories/${inventoryId}`, { method: "DELETE" });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to delete inventory");
      }

      await onReload();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to delete inventory");
    }
  }

  function requestDeleteInventory() {
    if (!activeInventory) return;
    if (activeInventory.isDefault) {
      onError("Cannot delete default inventory");
      return;
    }
    setPendingDeleteInventoryId(activeInventory.id);

    if (hasUnsavedChanges) {
      setShowUnsavedDeleteInventoryPrompt(true);
      return;
    }
    setShowDeleteInventoryConfirm(true);
  }

  async function handleCreateInventory() {
    if (!newInventoryName.trim()) {
      onError("Inventory name is required");
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
      setNewInventoryName("");
      setShowCreateInventory(false);
      setCopyFromActive(false);

      await handleInventoryChange(newInventory.id);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to create inventory");
    }
  }

  return (
    <>
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.35)",
          zIndex: 30,
        }}
        onClick={onClose}
      />
      <div
        style={{
          position: "absolute",
          top: "100%",
          right: 0,
          marginTop: "0.5rem",
          background: "#fff",
          borderRadius: "8px",
          padding: "1rem",
          minWidth: "320px",
          boxShadow: "0 10px 25px rgba(0,0,0,0.1)",
          zIndex: 31,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h3 style={{ margin: 0, fontSize: "1rem", fontWeight: 600 }}>Inventory</h3>
          <button
            class="button button-secondary"
            style={{ padding: "0.25rem 0.5rem", fontSize: "0.75rem" }}
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {error && <div class="error" style={{ marginBottom: "0.75rem" }}>{error}</div>}
        {hasUnsavedChanges && (
          <div style={{ marginBottom: "0.75rem", padding: "0.5rem", background: "#fef3c7", borderRadius: "4px", fontSize: "0.875rem" }}>
            Unsaved changes
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <div>
            <label class="label" style={{ marginBottom: "0.25rem" }}>Active Inventory</label>
            <select
              class="input"
              value={activeInventory?.id || ""}
              onChange={(e) => {
                const selectedId = (e.target as HTMLSelectElement).value;
                if (selectedId) {
                  handleInventoryChange(selectedId);
                }
              }}
            >
              {inventories.map(inv => (
                <option key={inv.id} value={inv.id}>
                  {inv.name} {inv.isDefault ? "(Default)" : ""}
                </option>
              ))}
            </select>
          </div>

          {!showCreateInventory ? (
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button
                class="button button-secondary"
                style={{
                  flex: 1,
                  padding: "0.5rem",
                  fontSize: "0.875rem",
                  background: "#ef4444",
                  color: "white",
                  border: "none",
                }}
                onClick={requestDeleteInventory}
                disabled={loading || !activeInventory || activeInventory.isDefault}
              >
                Delete
              </button>
              <button
                class="button"
                style={{ flex: 1, padding: "0.5rem", fontSize: "0.875rem" }}
                onClick={() => setShowCreateInventory(true)}
              >
                Create New
              </button>
            </div>
          ) : (
            <>
              <input
                type="text"
                class="input"
                placeholder="Inventory name"
                value={newInventoryName}
                onInput={(e) => setNewInventoryName((e.target as HTMLInputElement).value)}
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
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button
                  class="button"
                  style={{ flex: 1, padding: "0.5rem", fontSize: "0.875rem" }}
                  onClick={handleCreateInventory}
                  disabled={!newInventoryName.trim()}
                >
                  Create
                </button>
                <button
                  class="button button-secondary"
                  style={{ flex: 1, padding: "0.5rem", fontSize: "0.875rem" }}
                  onClick={() => {
                    setShowCreateInventory(false);
                    setNewInventoryName("");
                    setCopyFromActive(false);
                  }}
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Unsaved switch prompt */}
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
            zIndex: 40,
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
                  const ok = await onSave();
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

      {/* Unsaved delete prompt */}
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
            zIndex: 40,
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
                  const ok = await onSave();
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

      {/* Delete confirm */}
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
            zIndex: 40,
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
            <p style={{ marginTop: 0, marginBottom: "1rem", color: "#4b5563" }}>
              This will permanently delete this inventory and all its stock entries.
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
    </>
  );
}
