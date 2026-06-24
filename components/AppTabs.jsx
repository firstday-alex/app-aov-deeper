"use client";

import { useState } from "react";
import Dashboard from "@/components/Dashboard";
import UptDiagnosis from "@/components/UptDiagnosis";

const TABS = [
  { id: "explorer", label: "Metrics Explorer" },
  { id: "upt-diagnosis", label: "UPT Diagnosis" },
];

export default function AppTabs() {
  const [tab, setTab] = useState("explorer");

  return (
    <>
      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`tab ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "explorer" ? <Dashboard /> : <UptDiagnosis />}
    </>
  );
}
