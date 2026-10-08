"use client";

import React from "react";
import MonthlyReportView from "../../../components/psyfos/MonthlyReportView";

// A therapist's own monthly numbers — never anyone else's.
export default function MySessionReportsPage() {
  return (
    <MonthlyReportView
      endpoint="/me/session-report"
      heading="My Session Reports"
      blurb="Your sessions, clients, session statuses, follow-ups and notes for the month. Download or print it for supervision or your own records."
    />
  );
}
