import { useState, useEffect } from "preact/hooks";
import type { Node, NodeId, CalculationResult } from "../domain/types.ts";
import { eventBus } from "../events/bus.ts";
import type { Event } from "../events/types.ts";

interface CostTimeBreakdownProps {
  nodeId: NodeId | null;
  nodeType?: import("../domain/types.ts").NodeType | null;
}

interface BreakdownNode {
  nodeId: NodeId;
  name: string;
  type: string;
  cost: number;
  time: number;
  quantity: number;
  children: BreakdownNode[];
  percentage: number;
}

export default function CostTimeBreakdown({ nodeId, nodeType }: CostTimeBreakdownProps) {
  const [selectedNodeId, setSelectedNodeId] = useState<NodeId | null>(nodeId);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [breakdown, setBreakdown] = useState<BreakdownNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<Set<NodeId>>(new Set());
  
  useEffect(() => {
    loadNodes();
    
    const unsubscribe = eventBus.subscribe("CALCULATION_INVALIDATED", () => {
      if (selectedNodeId) {
        loadBreakdown(selectedNodeId);
      }
    });
    
    const unsubscribe2 = eventBus.subscribe("ENTITY_UPDATED", () => {
      loadNodes();
      if (selectedNodeId) {
        loadBreakdown(selectedNodeId);
      }
    });
    
    return () => {
      unsubscribe();
      unsubscribe2();
    };
  }, []);
  
  useEffect(() => {
    setSelectedNodeId(nodeId);
    if (nodeId) {
      loadBreakdown(nodeId);
    } else {
      setBreakdown(null);
    }
  }, [nodeId]);
  
  async function loadNodes(): Promise<Node[]> {
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
      return all;
    } catch (err) {
      console.error("Failed to load nodes:", err);
      return [];
    }
  }
  
  async function loadBreakdown(targetNodeId: NodeId) {
    setLoading(true);
    setError(null);
    
    try {
      const response = await fetch(`/api/calculations/${targetNodeId}`);
      if (!response.ok) {
        throw new Error("Failed to load calculation");
      }
      
      const calculation: CalculationResult = await response.json();
      let node = nodes.find(n => n.id === targetNodeId);

      if (!node) {
        const refreshed = await loadNodes();
        node = refreshed.find((n) => n.id === targetNodeId);
      }
      
      if (!node) {
        throw new Error("Node not found");
      }
      
      // Build breakdown tree
      const breakdownTree = await buildBreakdownTree(targetNodeId, 1, calculation);
      // Calculate percentages
      calculatePercentages(breakdownTree, breakdownTree.cost, breakdownTree.time);
      setBreakdown(breakdownTree);
      setExpandedNodes(new Set([targetNodeId]));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load breakdown");
    } finally {
      setLoading(false);
    }
  }
  
  async function buildBreakdownTree(
    nodeId: NodeId,
    quantity: number,
    calculation: CalculationResult
  ): Promise<BreakdownNode> {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not found`);
    }
    
    const children: BreakdownNode[] = [];
    let totalChildCost = 0;
    let totalChildTime = 0;
    
    if (node.type === "recipe") {
      const recipe = node as import("../domain/types.ts").Recipe;
      for (const input of recipe.inputs) {
        const inputCalc = await fetchCalculation(input.nodeId);
        const childBreakdown = await buildBreakdownTree(
          input.nodeId,
          input.quantity * quantity,
          inputCalc
        );
        children.push(childBreakdown);
        totalChildCost += childBreakdown.cost * input.quantity * quantity;
        totalChildTime += childBreakdown.time * input.quantity * quantity;
      }
    } else if (node.type === "product") {
      const product = node as import("../domain/types.ts").Product;
      for (const input of product.inputs) {
        const inputCalc = await fetchCalculation(input.nodeId);
        const childBreakdown = await buildBreakdownTree(
          input.nodeId,
          input.quantity * quantity,
          inputCalc
        );
        children.push(childBreakdown);
        totalChildCost += childBreakdown.cost * input.quantity * quantity;
        totalChildTime += childBreakdown.time * input.quantity * quantity;
      }
    }
    
    const totalCost = calculation.cost * quantity;
    const totalTime = calculation.time * quantity;
    
    return {
      nodeId,
      name: node.name,
      type: node.type,
      cost: totalCost,
      time: totalTime,
      quantity,
      children,
      percentage: 100, // Root node is 100%
    };
  }
  
  async function fetchCalculation(nodeId: NodeId): Promise<CalculationResult> {
    const response = await fetch(`/api/calculations/${nodeId}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch calculation for ${nodeId}`);
    }
    return await response.json();
  }
  
  function calculatePercentages(node: BreakdownNode, parentCost: number, parentTime: number) {
    if (parentCost > 0 && node.cost > 0) {
      node.percentage = (node.cost / parentCost) * 100;
    } else {
      node.percentage = 0;
    }
    
    for (const child of node.children) {
      calculatePercentages(child, node.cost, node.time);
    }
  }
  
  function toggleExpand(nodeId: NodeId) {
    const newExpanded = new Set(expandedNodes);
    if (newExpanded.has(nodeId)) {
      newExpanded.delete(nodeId);
    } else {
      newExpanded.add(nodeId);
    }
    setExpandedNodes(newExpanded);
  }
  
  function renderBreakdownNode(node: BreakdownNode, depth: number = 0): preact.JSX.Element {
    const isExpanded = expandedNodes.has(node.nodeId);
    const hasChildren = node.children.length > 0;
    
    return (
      <div key={node.nodeId} style={{ marginLeft: `${depth * 20}px` }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: "0.5rem",
            background: depth % 2 === 0 ? "#f9fafb" : "#fff",
            borderRadius: "4px",
            marginBottom: "0.25rem",
            cursor: hasChildren ? "pointer" : "default",
          }}
          onClick={() => hasChildren && toggleExpand(node.nodeId)}
        >
          {hasChildren && (
            <span style={{ marginRight: "0.5rem", fontSize: "0.875rem" }}>
              {isExpanded ? "▼" : "▶"}
            </span>
          )}
          {!hasChildren && <span style={{ marginRight: "1.5rem" }}></span>}
          
          <span style={{ fontWeight: depth === 0 ? 600 : 400, flex: 1 }}>
            {node.name} ({node.type})
          </span>
          
          <span style={{ marginRight: "1rem", fontSize: "0.875rem", color: "#6b7280" }}>
            Qty: {node.quantity.toFixed(2)}
          </span>
          
          <span style={{ marginRight: "1rem", fontSize: "0.875rem", color: "#3b82f6" }}>
            ${node.cost.toFixed(2)}
          </span>
          
          <span style={{ marginRight: "1rem", fontSize: "0.875rem", color: "#10b981" }}>
            {node.time.toFixed(1)} min
          </span>
          
          {depth > 0 && (
            <span style={{ fontSize: "0.875rem", color: "#6b7280" }}>
              {node.percentage.toFixed(1)}%
            </span>
          )}
        </div>
        
        {isExpanded && hasChildren && (
          <div>
            {node.children.map(child => renderBreakdownNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  }
  
  const selectedNode = selectedNodeId
    ? nodes.find((n) => n.id === selectedNodeId)
    : null;
  const selectedType = nodeType || selectedNode?.type || null;

  if (!selectedNodeId || selectedType === "ingredient") {
    return null;
  }

  if (loading && !breakdown) {
    return (
      <div class="card">
        <h2>Cost & Time Breakdown</h2>
        <p>Loading...</p>
      </div>
    );
  }
  
  return (
    <div class="card">
      <h2>Cost & Time Breakdown</h2>
      
      {error && <div class="error">{error}</div>}
      
      {breakdown && (
        <div style={{ marginTop: "1rem" }}>
          <div style={{ marginBottom: "1rem", padding: "1rem", background: "#eff6ff", borderRadius: "4px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.5rem" }}>
              <span style={{ fontWeight: 600 }}>Total Cost:</span>
              <span style={{ fontWeight: 600, color: "#3b82f6" }}>${breakdown.cost.toFixed(2)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontWeight: 600 }}>Total Time:</span>
              <span style={{ fontWeight: 600, color: "#10b981" }}>{breakdown.time.toFixed(1)} minutes</span>
            </div>
            {breakdown.type !== "ingredient" && (
              <div style={{ marginTop: "0.5rem", fontSize: "0.875rem", color: "#6b7280" }}>
                Per unit: ${(breakdown.cost / breakdown.quantity).toFixed(4)} / {breakdown.time.toFixed(1)} min
              </div>
            )}
          </div>
          
          <div style={{ maxHeight: "400px", overflowY: "auto" }}>
            {renderBreakdownNode(breakdown)}
          </div>
        </div>
      )}
      
      {!breakdown && selectedNodeId && (
        <p style={{ color: "#6b7280", marginTop: "1rem" }}>
          Click "Load Breakdown" or select a node to view its cost and time breakdown.
        </p>
      )}
    </div>
  );
}

