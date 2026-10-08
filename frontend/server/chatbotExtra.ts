// Appended to the chatbot's knowledge base: the Psyfos therapist / receptionist screens.
export const CHATBOT_PSYFOS = `

# Psyfos Workflow (Therapist and Receptionist)
## Therapist dashboard
- /dashboard/schedule -> Schedule: today's and upcoming appointments; open the client, then Complete session.
- /dashboard/patients -> My Clients: the therapist's own caseload (switch to all clinic clients if needed).
- /dashboard/case-history -> Case History: one timeline per client with sessions, SOAP notes, session-status changes and follow-ups.
- /dashboard/session-notes -> Session Notes: write notes for completed sessions; lists sessions still missing notes.
- /dashboard/follow-ups -> Follow-up: clients due back; the therapist sets a date, the front desk books the time.
- /dashboard/my-reports -> My Session Reports: the therapist's own monthly numbers (CSV / print).
## Session status
Every client has one of five session statuses: New Case, Ongoing, Periodic Follow-up, Terminated, Dropped. It is set when completing a session or from the client's profile.
## Receptionist flow
Enquiry (Leads or the public booking page) -> client details -> select service (Counselling / Therapy / Assessment / Career) -> select therapist -> schedule date and time -> payment or confirmation. Use "New Booking" on the Appointments page. Payments still to collect are under Pending Payments. The Monthly Report (/dashboard/reports) gives the management summary for any month.
`;
