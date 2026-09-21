"use client";

import { useEffect, type RefObject } from "react";
import { findById } from "@/scene/model/queries";
import type { CameraRig } from "./scene/camera";
import { removeObject } from "./state/edits";
import type { WorkspaceStore } from "./state/store";

/**
 * Keyboard.
 *
 * Nothing here takes a shortcut the browser already owns, and nothing
 * fires while the caret is in a field — a name being typed can contain the
 * letter F, and a backspace in the command bar must delete a character
 * rather than the sofa.
 */
export function useShortcuts(store: WorkspaceStore, rigRef: RefObject<CameraRig | null>) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;
      const meta = event.metaKey || event.ctrlKey;

      if (meta && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) store.redo();
        else store.undo();
        return;
      }
      // Windows convention, alongside Ctrl+Shift+Z.
      if (meta && event.key.toLowerCase() === "y") {
        event.preventDefault();
        store.redo();
        return;
      }
      if (meta) return;

      const state = store.getState();

      if (event.key === "Escape") {
        // Back out one layer at a time: a proposal, then the selection,
        // then the open tool.
        if (state.proposal || state.limitation) store.discardProposal();
        else if (state.selection) store.select(null);
        else if (state.tool) store.setTool(null);
        return;
      }

      if (event.key === "Delete" || event.key === "Backspace") {
        const object = state.selection && findById(state.scene.objects, state.selection);
        if (!object) return;
        event.preventDefault();
        store.apply(removeObject(state.scene, object));
        return;
      }

      if (event.key === "f" || event.key === "F") {
        const object = state.selection && findById(state.scene.objects, state.selection);
        const rig = rigRef.current;
        if (!object || !rig) return;
        event.preventDefault();
        rig.goTo(rig.frameObject(object));
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store, rigRef]);
}

function isTyping(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}
