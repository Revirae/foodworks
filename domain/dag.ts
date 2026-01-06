/**
 * DAG (Directed Acyclic Graph) logic for production flow
 */

import type { NodeId, GraphEdge, Graph, Node } from "./types.ts";

/**
 * Color states for DFS cycle detection
 */
enum Color {
  WHITE = 0, // Unvisited
  GRAY = 1,  // Currently visiting (in recursion stack)
  BLACK = 2, // Visited and processed
}

/**
 * Detects cycles in a directed graph using DFS with color-coding
 * Returns true if a cycle exists, false otherwise
 */
export function hasCycle(
  graph: Graph,
  startNodeId: NodeId,
  visited: Map<NodeId, Color> = new Map(),
): boolean {
  // Initialize color if not set
  if (!visited.has(startNodeId)) {
    visited.set(startNodeId, Color.WHITE);
  }

  const color = visited.get(startNodeId)!;

  // If already processed (black), no cycle found from this path
  if (color === Color.BLACK) {
    return false;
  }

  // If currently visiting (gray), we found a cycle
  if (color === Color.GRAY) {
    return true;
  }

  // Mark as currently visiting (gray)
  visited.set(startNodeId, Color.GRAY);

  // Check all outgoing edges (nodes this node depends on)
  const outgoingEdges = graph.reverseEdges.get(startNodeId) || [];
  for (const edge of outgoingEdges) {
    if (hasCycle(graph, edge.to, visited)) {
      return true;
    }
  }

  // Mark as fully processed (black)
  visited.set(startNodeId, Color.BLACK);
  return false;
}

/**
 * Checks if adding an edge would create a cycle
 */
export function wouldCreateCycle(
  graph: Graph,
  from: NodeId,
  to: NodeId,
): boolean {
  // Create a temporary graph with the new edge
  const tempGraph: Graph = {
    nodes: new Map(graph.nodes),
    edges: new Map(graph.edges),
    reverseEdges: new Map(graph.reverseEdges),
  };

  // Add the new edge temporarily
  const newEdge: GraphEdge = { from, to, quantity: 1 };
  const existingEdges = tempGraph.edges.get(to) || [];
  tempGraph.edges.set(to, [...existingEdges, newEdge]);

  const existingReverseEdges = tempGraph.reverseEdges.get(from) || [];
  tempGraph.reverseEdges.set(from, [...existingReverseEdges, newEdge]);

  // Check for cycle starting from the 'from' node
  return hasCycle(tempGraph, from);
}

/**
 * Validates that the graph is acyclic
 */
export function validateDAG(graph: Graph): { valid: boolean; cycleNodes?: NodeId[] } {
  const visited = new Map<NodeId, Color>();

  // Check all nodes
  for (const nodeId of graph.nodes.keys()) {
    if (hasCycle(graph, nodeId, visited)) {
      // Find cycle nodes (gray nodes in the visited map)
      const cycleNodes: NodeId[] = [];
      for (const [id, color] of visited.entries()) {
        if (color === Color.GRAY) {
          cycleNodes.push(id);
        }
      }
      return { valid: false, cycleNodes };
    }
  }

  return { valid: true };
}

/**
 * Topological sort of nodes (Kahn's algorithm)
 * Returns nodes in dependency order (dependencies first)
 */
export function topologicalSort(graph: Graph): NodeId[] {
  const inDegree = new Map<NodeId, number>();
  const result: NodeId[] = [];
  const queue: NodeId[] = [];

  // Initialize in-degrees
  for (const nodeId of graph.nodes.keys()) {
    const incomingEdges = graph.edges.get(nodeId) || [];
    inDegree.set(nodeId, incomingEdges.length);
    if (incomingEdges.length === 0) {
      queue.push(nodeId);
    }
  }

  // Process nodes with no dependencies
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    result.push(nodeId);

    // Reduce in-degree of dependent nodes
    const outgoingEdges = graph.reverseEdges.get(nodeId) || [];
    for (const edge of outgoingEdges) {
      const currentInDegree = inDegree.get(edge.to) || 0;
      inDegree.set(edge.to, currentInDegree - 1);
      if (inDegree.get(edge.to) === 0) {
        queue.push(edge.to);
      }
    }
  }

  // If result length doesn't match nodes, there's a cycle
  if (result.length !== graph.nodes.size) {
    throw new Error("Graph contains a cycle, cannot perform topological sort");
  }

  return result;
}

/**
 * Gets all upstream nodes (dependencies) of a given node
 */
export function getUpstreamNodes(
  graph: Graph,
  nodeId: NodeId,
  visited: Set<NodeId> = new Set(),
): Set<NodeId> {
  if (visited.has(nodeId)) {
    return visited;
  }

  visited.add(nodeId);
  const incomingEdges = graph.edges.get(nodeId) || [];

  for (const edge of incomingEdges) {
    getUpstreamNodes(graph, edge.from, visited);
  }

  return visited;
}

/**
 * Gets all downstream nodes (dependents) of a given node
 */
export function getDownstreamNodes(
  graph: Graph,
  nodeId: NodeId,
  visited: Set<NodeId> = new Set(),
): Set<NodeId> {
  if (visited.has(nodeId)) {
    return visited;
  }

  visited.add(nodeId);
  const outgoingEdges = graph.reverseEdges.get(nodeId) || [];

  for (const edge of outgoingEdges) {
    getDownstreamNodes(graph, edge.to, visited);
  }

  return visited;
}

/**
 * Creates an empty graph
 */
export function createEmptyGraph(): Graph {
  return {
    nodes: new Map(),
    edges: new Map(),
    reverseEdges: new Map(),
  };
}

/**
 * Adds a node to the graph
 */
export function addNode(graph: Graph, node: Node): void {
  graph.nodes.set(node.id, node);
  // Initialize edge maps if needed
  if (!graph.edges.has(node.id)) {
    graph.edges.set(node.id, []);
  }
  if (!graph.reverseEdges.has(node.id)) {
    graph.reverseEdges.set(node.id, []);
  }
}

/**
 * Removes a node from the graph (and all associated edges)
 */
export function removeNode(graph: Graph, nodeId: NodeId): void {
  // Remove incoming edges
  const incomingEdges = graph.edges.get(nodeId) || [];
  for (const edge of incomingEdges) {
    const outgoingEdges = graph.reverseEdges.get(edge.from) || [];
    const filtered = outgoingEdges.filter((e) => e.to !== nodeId);
    graph.reverseEdges.set(edge.from, filtered);
  }

  // Remove outgoing edges
  const outgoingEdges = graph.reverseEdges.get(nodeId) || [];
  for (const edge of outgoingEdges) {
    const incomingEdges = graph.edges.get(edge.to) || [];
    const filtered = incomingEdges.filter((e) => e.from !== nodeId);
    graph.edges.set(edge.to, filtered);
  }

  // Remove node
  graph.nodes.delete(nodeId);
  graph.edges.delete(nodeId);
  graph.reverseEdges.delete(nodeId);
}

/**
 * Adds an edge to the graph with cycle detection
 * Throws an error if the edge would create a cycle
 */
export function addEdge(
  graph: Graph,
  edge: GraphEdge,
): { success: boolean; error?: string } {
  // Validate nodes exist
  if (!graph.nodes.has(edge.from)) {
    return { success: false, error: `Source node ${edge.from} does not exist` };
  }
  if (!graph.nodes.has(edge.to)) {
    return { success: false, error: `Target node ${edge.to} does not exist` };
  }

  // Check for self-loops
  if (edge.from === edge.to) {
    return { success: false, error: "Cannot create self-loop" };
  }

  // Check if edge already exists
  const existingEdges = graph.edges.get(edge.to) || [];
  const edgeExists = existingEdges.some(
    (e) => e.from === edge.from && e.to === edge.to,
  );
  if (edgeExists) {
    return { success: false, error: "Edge already exists" };
  }

  // Check for cycles
  if (wouldCreateCycle(graph, edge.from, edge.to)) {
    return {
      success: false,
      error: `Adding edge would create a cycle`,
    };
  }

  // Add edge
  graph.edges.set(edge.to, [...existingEdges, edge]);

  const existingReverseEdges = graph.reverseEdges.get(edge.from) || [];
  graph.reverseEdges.set(edge.from, [...existingReverseEdges, edge]);

  return { success: true };
}

/**
 * Removes an edge from the graph
 */
export function removeEdge(
  graph: Graph,
  from: NodeId,
  to: NodeId,
): { success: boolean; error?: string } {
  // Remove from incoming edges
  const incomingEdges = graph.edges.get(to) || [];
  const filteredIncoming = incomingEdges.filter((e) => e.from !== from);
  if (filteredIncoming.length === incomingEdges.length) {
    return { success: false, error: "Edge does not exist" };
  }
  graph.edges.set(to, filteredIncoming);

  // Remove from outgoing edges
  const outgoingEdges = graph.reverseEdges.get(from) || [];
  const filteredOutgoing = outgoingEdges.filter((e) => e.to !== to);
  graph.reverseEdges.set(from, filteredOutgoing);

  return { success: true };
}

/**
 * Gets the depth of a node (longest path from any ingredient)
 */
export function getNodeDepth(graph: Graph, nodeId: NodeId): number {
  const incomingEdges = graph.edges.get(nodeId) || [];
  if (incomingEdges.length === 0) {
    return 0; // Ingredient or root node
  }

  let maxDepth = 0;
  for (const edge of incomingEdges) {
    const depth = getNodeDepth(graph, edge.from);
    maxDepth = Math.max(maxDepth, depth);
  }

  return maxDepth + 1;
}

