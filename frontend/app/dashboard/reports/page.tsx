"use client";

import React from "react";
import MonthlyReportView from "../../../components/psyfos/MonthlyReportView";

// The Monthly / Management Report — the last step of the Psyfos front-desk flow.
export default function MonthlyReportPage() {
  return (
    <MonthlyReportView
      endpoint="/reports/monthly"
      heading="Monthly Report"
      blurb="Sessions, clients, session-status movement, follow-up adherence, services and revenue for the whole clinic — one month at a time."
    />
  );
}
