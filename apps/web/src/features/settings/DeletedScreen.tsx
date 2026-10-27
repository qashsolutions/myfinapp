import "../auth/auth.css";

import { buttonClass, Card } from "@stackd/ui";
import { Link } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";

/** After deletion: public, nothing to load. */
export function DeletedScreen() {
  return (
    <main className="auth" id="main">
      <ScreenHeader title="Your account is deleted" actions={null} />
      <Card>
        <p>
          This device's copy of your data is gone, every signed-in device is signed out, and your
          account is scheduled for removal on our side. Group members will see "Former member".
        </p>
        <p className="auth__hint">
          If you change your mind, signing in with the same email starts a fresh account.
        </p>
      </Card>
      <Link to="/welcome" className={buttonClass({ block: true, variant: "secondary" })}>
        Back to the start
      </Link>
    </main>
  );
}
