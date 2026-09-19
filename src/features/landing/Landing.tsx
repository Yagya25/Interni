import { anchors } from "@/config/site";
import { SiteFooter } from "./components/SiteFooter";
import { SiteNav } from "./components/SiteNav";
import { Sequence } from "./sequence/Sequence";

/**
 * The landing page is one continuous piece: a cover that becomes a film.
 * The wrapper (`data-stage-theme`) carries the stage's ink variables so the
 * navigation follows the room's light along with the copy.
 */
export function Landing() {
  return (
    <div id="top" data-stage-theme="">
      <SiteNav />
      <main id={anchors.main} tabIndex={-1}>
        <Sequence />
      </main>
      <SiteFooter />
    </div>
  );
}
