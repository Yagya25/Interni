"use client";

import { demo } from "@/demo";
import { demoLibrary } from "@/demo/materials";
import { createRoomInterpreter } from "./ai/roomInterpreter";
import { Workspace } from "./Workspace";

/**
 * The demonstration room comes with the room interpreter, which needs the
 * scene as it was opened so that "reset the room" has something to return
 * to. A reconstructed room gets the same interpreter, built on its own scene.
 */
const interpreter = createRoomInterpreter(demo.scene);

/**
 * The demonstration room, opened as a working space.
 *
 * The scene is the one the landing page walks through, so what a visitor
 * watched being understood is exactly what they can now take apart. It is
 * imported here rather than passed down from the route, which keeps the
 * scene out of the server payload and in the one client chunk that needs it.
 */
export function DemoWorkspace() {
  return (
    <Workspace
      scene={demo.scene}
      name={demo.scene.room.label}
      palette={demoLibrary}
      interpreter={interpreter}
    />
  );
}
