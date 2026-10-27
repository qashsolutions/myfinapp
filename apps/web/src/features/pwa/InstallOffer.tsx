import { useEffect, useState } from "react";
import { shouldOfferInstall } from "../../pwa/install.ts";
import { InstallGuide } from "./InstallGuide.tsx";

/** Offers the install guide on its own after the second visit (never inside the installed app). */
export function InstallOffer() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (shouldOfferInstall()) setOpen(true);
  }, []);
  return <InstallGuide open={open} onClose={() => setOpen(false)} />;
}
