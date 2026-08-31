import { EmptyState, Shell } from "../shell";

export default function CalendarPage() {
  return (
    <Shell>
      <EmptyState tag="Planning" title="Nothing scheduled yet">
        <p>The calendar shows scheduled Creative Pieces and planned distribution work. It populates when approved pieces are given a publish window or when Work Orders carry a due date.</p>
      </EmptyState>
    </Shell>
  );
}
