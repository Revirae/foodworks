import { useState, useEffect } from "preact/hooks";
import type { ProductionOrder } from "../domain/types.ts";
import { useWorkspaceData } from "./workspace/useWorkspaceData.ts";
import { eventBus } from "../events/bus.ts";

export default function ProductionOrdersPanel() {
  const [orders, setOrders] = useState<ProductionOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data = useWorkspaceData();

  async function loadOrders() {
    if (!data.activeInventory) {
      setOrders([]);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/production/orders");
      if (!response.ok) {
        throw new Error("Failed to load orders");
      }
      const ordersData: ProductionOrder[] = await response.json();
      setOrders(ordersData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load orders");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadOrders();

    const unsubscribe = eventBus.subscribe("STOCK_CHANGED", () => {
      // Small delay to ensure backend has processed the order
      setTimeout(() => {
        loadOrders();
      }, 300);
    });

    return () => {
      unsubscribe();
    };
  }, [data.activeInventory?.id]);

  async function handleRollback(orderId: string) {
    const order = orders.find((o) => o.id === orderId);
    if (!confirm("Are you sure you want to rollback this production order? This will reverse all stock changes.")) {
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/production/orders/${orderId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to rollback order");
      }

      // Reload orders and stocks
      await loadOrders();
      await data.loadStocks();
      // Emit local stock change to refresh simulator max producible (frontend-only bus)
      if (order) {
        eventBus.emit({
          type: "STOCK_CHANGED",
          nodeId: order.targetNodeId,
          newStock: 0,
          previousStock: 0,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rollback order");
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

  function formatDate(date: Date): string {
    const d = new Date(date);
    return d.toLocaleString();
  }

  if (loading && orders.length === 0) {
    return (
      <div style={{ padding: "1rem", textAlign: "center", color: "#6b7280" }}>
        Loading orders...
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ marginBottom: "1rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ margin: 0, fontSize: "1.125rem", fontWeight: 600 }}>Production Orders</h3>
        <button
          class="button button-secondary"
          onClick={loadOrders}
          disabled={loading}
          style={{ padding: "0.5rem 0.75rem", fontSize: "0.875rem" }}
          title="Refresh"
          aria-label="Refresh"
        >
          ↻
        </button>
      </div>

      {error && <div class="error" style={{ marginBottom: "1rem" }}>{error}</div>}

      {orders.length === 0 ? (
        <div style={{ padding: "1rem", textAlign: "center", color: "#6b7280" }}>
          No production orders yet.
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: "auto" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {orders.map((order) => {
              const targetNode = data.rows.find((r) => r.node.id === order.targetNodeId);
              return (
                <div
                  key={order.id}
                  style={{
                    padding: "0.75rem",
                    background: "#f9fafb",
                    borderRadius: "6px",
                    border: "1px solid #e5e7eb",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.5rem" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>
                        {targetNode?.node.name || order.targetNodeId} × {order.quantity}
                      </div>
                      <div style={{ fontSize: "0.875rem", color: "#6b7280" }}>
                        {formatDate(order.createdAt)}
                      </div>
                    </div>
                    <button
                      class="button button-secondary"
                      onClick={() => handleRollback(order.id)}
                      disabled={loading}
                      style={{ padding: "0.5rem 0.75rem", fontSize: "0.875rem" }}
                      title="Rollback"
                      aria-label="Rollback"
                    >
                      ↶
                    </button>
                  </div>
                  <div style={{ fontSize: "0.875rem", color: "#6b7280", display: "flex", gap: "1rem" }}>
                    <span>Cost: <strong>${order.totalCost.toFixed(2)}</strong></span>
                    <span>Time: <strong>{formatTime(order.totalTime)}</strong></span>
                  </div>
                  {order.stockDeltas.length > 0 && (
                    <div style={{ marginTop: "0.5rem", fontSize: "0.75rem", color: "#9ca3af" }}>
                      {order.stockDeltas.length} stock change{order.stockDeltas.length !== 1 ? "s" : ""}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
