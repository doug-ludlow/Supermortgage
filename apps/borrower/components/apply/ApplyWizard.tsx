"use client";
import { useMemo, useState } from "react";
import { api } from "@/lib/api/client";
import type { Door, Tab, TaskId } from "./apply-model";
import { DoorScreens } from "./door";
import "./apply.css";

export function ApplyProduct() {
  const [tab, setTab] = useState<Tab>("apply");
  const [door, setDoor] = useState<Door>("welcome");
  const [accountMode, setAccountMode] = useState<"sign_up" | "sign_in">("sign_up");
  const done = useMemo(
    () =>
      ({
        property: false,
        you: false,
        connect: false,
        details: false,
        questions: true,
        demographics: true,
        review: false,
      }) satisfies Record<TaskId, boolean>,
    [],
  );
  return (
    <div className="sm-proto">
      <div className="sm-phone">
        <header className="sm-top">
          <button className="sm-mark" type="button" onClick={() => { setTab("apply"); setDoor("welcome"); }}>
            <span className="sm-mark-s">s</span>
            <span className="sm-mark-name">Supermortgage</span>
          </button>
        </header>
        <main className="sm-stage">
          <DoorScreens
            tab={tab}
            door={door}
            signedIn={false}
            accountMode={accountMode}
            me={null}
            title="Your mortgage"
            done={done}
            chat={[]}
            setDoor={setDoor}
            setTab={setTab}
            setStep={() => undefined}
            setAccountMode={setAccountMode}
            refresh={async () => api.me()}
            onSignOut={() => undefined}
          />
        </main>
      </div>
    </div>
  );
}
