import { signal } from "@preact/signals";
import type { Node, NodeId, NodeType } from "../domain/types.ts";

export const selectedNodeId = signal<NodeId | null>(null);
export const selectedNodeType = signal<NodeType | null>(null);
export const editingEntity = signal<Node | null>(null);
export const editorNodeType = signal<NodeType | null>(null);
export const isEditorOpen = signal(false);
export const productionSimulatorOpen = signal(false);
export const productionSimulatorTargetId = signal<NodeId | null>(null);
export const activeWorkspaceTab = signal<"ingredient" | "recipe" | "product" | "produce">("ingredient");

